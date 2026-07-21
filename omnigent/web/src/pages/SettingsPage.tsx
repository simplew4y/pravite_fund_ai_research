/**
 * Settings page (``/settings``).
 *
 * Renders into the AppShell chat outlet (see App.tsx) so the conversations
 * sidebar stays put when you enter settings — only the main area swaps to
 * this view. Inside, a section nav (left) drives a content panel (right),
 * modeled on a desktop-app settings window; a "← Back to finsagent" link
 * returns to the composer.
 *
 * Sections:
 *
 * - **Appearance** — theme mode (System / Light / Dark). This is the new
 *   home of the theme control that used to sit in the sidebar header.
 * - **Keyboard shortcuts** — the full shortcuts reference, shown inline.
 * - **Account** — only when the accounts auth provider is active. Absorbs
 *   the old sidebar AccountMenu: signed-in identity, admin-only Members /
 *   Policies links, change password, and sign out.
 * - **Archived sessions** — archived sessions, moved out of the sidebar
 *   list. Not clickable; each row reveals Delete / Unarchive on hover.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircleIcon,
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCogIcon,
  UsersIcon,
} from "lucide-react";
import { LaptopMinimalIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Link } from "@/lib/routing";
import { PageScroll } from "@/components/PageScroll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyboardShortcutsList } from "@/components/KeyboardShortcutsDialog";
import { changePassword, type CurrentAccount, getMe, logout } from "@/lib/accountsApi";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import {
  type Conversation,
  useArchiveConversation,
  useConversations,
  useStopAndDeleteConversation,
} from "@/hooks/useConversations";
import { conversationDisplayLabel } from "@/shell/sidebarNav";
import { absoluteTime } from "@/lib/relativeTime";
import { useSettingsRoute } from "@/shell/settingsNav";
import { type ThemeMode, normalizeThemeMode } from "@/components/theme/themeMode";
import { useIsEmbedded } from "@/lib/embedded";
import {
  type CliStatus,
  type LlmConnectionTestResult,
  type LlmApplyStatus,
  type LlmProviderInput,
  type LlmProviderPreset,
  getCliStatus,
  getLlmApplyStatus,
  isElectronShell,
  resetCliPath,
  saveLlmConfig,
  testLlmConfig,
} from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";
import { useLlmConfiguration } from "@/lib/LlmConfigContext";

/**
 * Settings content panel. The section nav lives in the sidebar card
 * (SettingsSidebarBody); this renders only the selected section into the
 * AppShell main outlet. The active section is read from the URL so the two
 * stay in sync. PageScroll handles clearing the shell's absolute header and
 * the iOS native bars, matching the Inbox / Members pages.
 */
export function SettingsPage() {
  const info = useServerInfo();
  const accountsEnabled = info !== "loading" && info.accounts_enabled;
  const { section } = useSettingsRoute();

  return (
    <PageScroll contentClassName="px-8" extraBottom="2.5rem">
      {section === "appearance" && <AppearanceSection />}
      {section === "shortcuts" && <ShortcutsSection />}
      {section === "account" && accountsEnabled && <AccountSection />}
      {section === "archived" && <ArchivedSection />}
      {section === "cli" && isElectronShell() && <LocalCliSection />}
      {section === "llm" && isElectronShell() && <LlmProviderSection />}
    </PageScroll>
  );
}

const LLM_PRESETS: Record<
  LlmProviderPreset,
  { label: string; baseUrl: string; defaultModel: string }
> = {
  dashscope: {
    label: "通义千问（DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-max",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "" },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", defaultModel: "" },
  custom: { label: "自定义 OpenAI-compatible", baseUrl: "", defaultModel: "" },
};

function llmResultMessage(result: LlmConnectionTestResult): string {
  if (result.ok) return "连接成功，模型服务可以正常使用。";
  const prefix: Record<string, string> = {
    authentication: "API Key 验证失败",
    connection: "无法连接模型服务",
    model: "模型名称不可用",
    timeout: "连接测试超时",
    validation: "配置不完整",
    busy: "当前不能修改模型配置",
    apply: "模型配置应用失败",
  };
  return `${prefix[result.error ?? ""] ?? "模型服务请求失败"}${result.detail ? `：${result.detail}` : ""}`;
}

function LlmProviderSection() {
  const { config, applyStatus, loading, refresh } = useLlmConfiguration();
  const [form, setForm] = useState<LlmProviderInput>({
    preset: "dashscope",
    baseUrl: LLM_PRESETS.dashscope.baseUrl,
    model: LLM_PRESETS.dashscope.defaultModel,
    apiKey: "",
  });
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<LlmConnectionTestResult | null>(null);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [activity, setActivity] = useState<LlmApplyStatus>(applyStatus);

  useEffect(() => {
    if (!config) return;
    setForm({
      preset: config.preset,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: "",
    });
    setEditingApiKey(!config.hasApiKey);
  }, [config]);

  useEffect(() => {
    setActivity(applyStatus);
  }, [applyStatus]);

  useEffect(() => {
    let active = true;
    const refreshActivity = async () => {
      const next = await getLlmApplyStatus();
      if (active) setActivity(next);
    };
    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const runTest = async () => {
    setBusy("test");
    const next = await testLlmConfig(form);
    setResult(next);
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    const next = await saveLlmConfig(form);
    setBusy(null);
    setResult(next);
    if (!next.ok) return;
    await refresh();
    setForm((current) => ({ ...current, apiKey: "" }));
    setEditingApiKey(false);
  };

  const apiKeyRequired = (!config?.hasApiKey || editingApiKey) && !(form.apiKey ?? "").trim();

  return (
    <Section title="模型服务" description="配置工作台用于投研问答和内容生成的模型 API。">
      <div className="flex max-w-2xl flex-col gap-5">
        {activity.busy && (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>{activity.applying ? "正在应用模型配置" : "暂时不能保存"}</AlertTitle>
            <AlertDescription>
              {activity.detail || "当前有回答正在生成，请等待完成后修改。"}
            </AlertDescription>
          </Alert>
        )}

        <label className="flex flex-col gap-2 text-sm font-medium">
          模型供应商
          <Select
            value={form.preset}
            onValueChange={(value) => {
              const preset = value as LlmProviderPreset;
              const definition = LLM_PRESETS[preset];
              setForm((current) => ({
                ...current,
                preset,
                baseUrl: definition.baseUrl,
                model: definition.defaultModel,
              }));
              setResult(null);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(LLM_PRESETS).map(([value, definition]) => (
                <SelectItem key={value} value={value}>
                  {definition.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          Base URL
          <Input
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) =>
              setForm((current) => ({ ...current, baseUrl: event.target.value }))
            }
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          模型名称
          <Input
            value={form.model}
            placeholder="例如 qwen3-max"
            onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-medium">
          API Key
          <div className="flex items-center gap-2">
            {config?.hasApiKey && !editingApiKey ? (
              <Input
                type="text"
                readOnly
                value={config.maskedApiKey}
                className="cursor-text bg-background text-foreground"
                onClick={() => {
                  setEditingApiKey(true);
                  setForm((current) => ({ ...current, apiKey: "" }));
                }}
              />
            ) : (
              <Input
                autoFocus={Boolean(config?.hasApiKey)}
                type="password"
                autoComplete="new-password"
                value={form.apiKey ?? ""}
                placeholder="请输入完整的新 API Key"
                onChange={(event) =>
                  setForm((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            )}
            {config?.hasApiKey && editingApiKey && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditingApiKey(false);
                  setForm((current) => ({ ...current, apiKey: "" }));
                }}
              >
                取消
              </Button>
            )}
          </div>
        </label>

        {result && (
          <Alert variant={result.ok ? "default" : "destructive"}>
            {result.ok ? <CheckCircle2Icon /> : <AlertCircleIcon />}
            <AlertTitle>{result.ok ? "成功" : "未完成"}</AlertTitle>
            <AlertDescription>{llmResultMessage(result)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy !== null || loading || apiKeyRequired}
            onClick={() => void runTest()}
          >
            {busy === "test" && <Loader2Icon className="size-4 animate-spin" />}
            测试连接
          </Button>
          <Button
            disabled={busy !== null || loading || activity.busy || apiKeyRequired}
            onClick={() => void save()}
          >
            {busy === "save" && <Loader2Icon className="size-4 animate-spin" />}
            保存配置
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Shared section shell: a title + optional description above the body. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

const themeCards: { mode: ThemeMode; label: string; icon: typeof SunIcon }[] = [
  { mode: "system", label: "System", icon: LaptopMinimalIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
];

function AppearanceSection() {
  // Embedded: the host owns the theme (embed.tsx forces light), so the
  // selector would be a no-op — match ThemeModeMenu and hide it.
  const isEmbedded = useIsEmbedded();
  const { theme, setTheme } = useTheme();
  const mode = normalizeThemeMode(theme);

  return (
    <Section title="Appearance" description="Choose how Omnigent looks on this device.">
      {isEmbedded ? (
        <p className="text-sm text-muted-foreground">
          Appearance is controlled by the host application.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Theme">
          {themeCards.map(({ mode: cardMode, label, icon: Icon }) => {
            const selected = mode === cardMode;
            return (
              <button
                key={cardMode}
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`theme-${cardMode}`}
                onClick={() => setTheme(cardMode)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors hover:bg-muted",
                  selected ? "border-primary bg-primary/5" : "border-border",
                )}
              >
                <Icon className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function ShortcutsSection() {
  return (
    <Section title="Keyboard shortcuts" description="Speed up common actions with the keyboard.">
      <KeyboardShortcutsList />
    </Section>
  );
}

/**
 * Desktop-only: shows which Omnigent CLI binary the shell resolved
 * (auto-detected or a custom override). Read-only — setting a custom path is
 * done on the connect/setup screen (the trusted surface that allows free-text
 * entry); the SPA exposes no path setter. A safe "reset to auto-detected" stays
 * here since it chooses no path.
 */
function LocalCliSection() {
  const [status, setStatus] = useState<CliStatus | null | "loading">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getCliStatus().then(setStatus);
  }, []);

  const onReset = useCallback(async () => {
    setBusy(true);
    const next = await resetCliPath();
    setBusy(false);
    if (next) setStatus(next); // null only when the bridge is missing (old shell)
  }, []);

  if (status === "loading") {
    return (
      <Section title="Local CLI">
        <p className="text-sm text-muted-foreground">Checking…</p>
      </Section>
    );
  }

  return (
    <Section
      title="Local CLI"
      description="The Omnigent command-line tool this app uses to run a local server and connect this machine as a runner."
    >
      {status === null ? (
        <p className="text-sm text-muted-foreground">CLI status is unavailable.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                status.installed ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span>
              {status.installed
                ? `Found${status.version ? ` · ${status.version}` : ""}`
                : "Not found"}
            </span>
          </div>

          {status.path ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {status.source === "configured" ? "Path (custom)" : "Path (auto-detected)"}
              </span>
              <code className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                {status.path}
              </code>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                The Omnigent CLI wasn't found. Install it, then set its path from the connect
                screen:
              </p>
              {status.installCommand && (
                <code className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                  {status.installCommand}
                </code>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            For security, a custom path can only be set from the connect screen — this prevents a
            connected server from pointing the app at a different binary. Open it from the Server
            menu (Change Server…) and use the settings gear.
          </p>

          {status.source === "configured" && (
            <div>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void onReset()}>
                Reset to auto-detected
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function AccountSection() {
  const [me, setMe] = useState<CurrentAccount | null | "unknown">("unknown");

  // Change-password dialog state (lifted verbatim from the old AccountMenu).
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    void (async () => setMe(await getMe()))();
  }, []);

  const onSignOut = useCallback(async () => {
    await logout();
    // Hard navigation so the chat store / react-query cache reset.
    window.location.href = "/login";
  }, []);

  const resetPwForm = useCallback(() => {
    setOldPw("");
    setNewPw("");
    setConfirmPw("");
    setPwError(null);
    setPwDone(false);
    setPwBusy(false);
  }, []);

  const onSubmitPassword = useCallback(async () => {
    if (newPw !== confirmPw) {
      setPwError("New passwords don't match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    const result = await changePassword({ old_password: oldPw, new_password: newPw });
    setPwBusy(false);
    if (result.ok) {
      setPwDone(true);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
    } else {
      setPwError(result.error);
    }
  }, [oldPw, newPw, confirmPw]);

  if (me === "unknown" || me === null) {
    return <Section title="Account">{null}</Section>;
  }

  return (
    <Section title="Account">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border">
            <UserCogIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium">
              {me.id}
              {me.is_admin && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(admin)</span>
              )}
            </div>
          </div>
        </div>

        {me.is_admin && (
          <div className="flex flex-col gap-1">
            <Button asChild variant="ghost" className="w-full justify-start gap-2">
              <Link to="/members">
                <UsersIcon className="size-4" /> Members
              </Link>
            </Button>
            <Button asChild variant="ghost" className="w-full justify-start gap-2">
              <Link to="/policies">
                <ShieldCheckIcon className="size-4" /> Policies
              </Link>
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => {
              resetPwForm();
              setPwOpen(true);
            }}
          >
            <KeyRoundIcon className="size-4" /> Change password
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => void onSignOut()}
          >
            <LogOutIcon className="size-4" /> Sign out
          </Button>
        </div>
      </div>

      <Dialog
        open={pwOpen}
        onOpenChange={(open) => {
          setPwOpen(open);
          if (!open) resetPwForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              {pwDone
                ? "Your password has been changed."
                : "Enter your current password and choose a new one."}
            </DialogDescription>
          </DialogHeader>

          {!pwDone && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void onSubmitPassword();
              }}
            >
              <Input
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                disabled={pwBusy}
                required
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="New password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                disabled={pwBusy}
                required
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="Confirm new password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                disabled={pwBusy}
                required
              />
              {pwError !== null && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {pwError}
                </div>
              )}
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    pwBusy || oldPw.length === 0 || newPw.length === 0 || confirmPw.length === 0
                  }
                >
                  {pwBusy ? "Changing…" : "Change password"}
                </Button>
              </DialogFooter>
            </form>
          )}

          {pwDone && (
            <DialogFooter>
              <Button onClick={() => setPwOpen(false)}>Done</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function ArchivedSection() {
  // includeArchived:true is the only way to load archived rows; the
  // default sidebar query no longer surfaces them.
  const query = useConversations("", true);
  const archived = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.data).filter((c) => c.archived === true),
    [query.data],
  );

  return (
    <Section
      title="Archived sessions"
      description="Sessions you've archived. Restore one to the sidebar, or delete it for good."
    >
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : archived.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived sessions.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {archived.map((conv) => (
            <ArchivedRow key={conv.id} conversation={conv} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * One archived-session row. Not clickable (archived sessions aren't a
 * navigation target here); the title + timestamp read as a record, and the
 * Delete / Unarchive controls reveal on hover (always visible on touch).
 */
function ArchivedRow({ conversation }: { conversation: Conversation }) {
  const archive = useArchiveConversation();
  const del = useStopAndDeleteConversation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const label = conversationDisplayLabel(conversation);
  const busy = archive.isPending || del.isPending;

  return (
    <li
      data-testid="archived-row"
      className="group relative flex items-center gap-2 rounded-md px-3 py-2 hover:bg-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={label}>
          {label}
        </div>
        <div className="text-xs text-muted-foreground">
          {absoluteTime(conversation.updated_at * 1000)}
        </div>
      </div>
      {/* Actions reveal on hover (desktop) / always shown on touch. */}
      <div className="flex shrink-0 items-center gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete session"
          data-testid="delete-archived"
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2Icon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // No background in light mode (ghost). Dark mode needs a fill so the
          // button reads against the dark row — borrow the secondary tokens
          // there only, without touching the text color.
          className="gap-1.5 dark:bg-secondary dark:hover:bg-secondary/80"
          data-testid="unarchive-conversation"
          disabled={busy}
          onClick={() => archive.mutate({ id: conversation.id, archived: false })}
        >
          <ArchiveRestoreIcon className="size-3.5" />
          Unarchive
        </Button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              <span className="font-medium break-all">{label}</span> and all of its history will be
              removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={del.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                // Fire-and-forget: the row drops out once the conversations
                // cache refreshes after the delete settles.
                del.mutate({ id: conversation.id });
                setDeleteOpen(false);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
