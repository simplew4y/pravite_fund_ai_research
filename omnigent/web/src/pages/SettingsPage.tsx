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
  MessageSquareTextIcon,
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
import { Textarea } from "@/components/ui/textarea";
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
import {
  accountDisplayName,
  changePassword,
  clearUserScopedBrowserState,
  createFeedback,
  type BalanceRecord,
  type CurrentAccount,
  type FeedbackEntry,
  getBalanceRecords,
  getFeedback,
  getMe,
  getPlatformUsage,
  logout,
  maskedAccountEmail,
  type PlatformUsageResponse,
} from "@/lib/accountsApi";
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
import { type CliStatus, getCliStatus, isElectronShell, resetCliPath } from "@/lib/nativeBridge";
import { cn } from "@/lib/utils";
import {
  getLlmApplyStatus,
  saveLlmConfig,
  testLlmConfig,
  type LlmApplyStatus,
  type LlmConnectionTestResult,
  type LlmProviderInput,
  type LlmProviderPreset,
} from "@/lib/llmConfigApi";
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
  const { enabled: llmEnabled } = useLlmConfiguration();
  const { section } = useSettingsRoute();

  return (
    <PageScroll contentClassName="px-8" extraBottom="2.5rem">
      {section === "appearance" && <AppearanceSection />}
      {section === "shortcuts" && <ShortcutsSection />}
      {section === "account" && accountsEnabled && <AccountSection />}
      {section === "feedback" && info !== "loading" && info.cloud_accounts_enabled && (
        <FeedbackSection />
      )}
      {section === "archived" && <ArchivedSection />}
      {section === "cli" && isElectronShell() && <LocalCliSection />}
      {section === "llm" && llmEnabled && <LlmProviderSection />}
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
    defaultModel: "",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "",
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
    provider: "模型接口不兼容",
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

  const formForPreset = useCallback(
    (preset: LlmProviderPreset): LlmProviderInput => {
      const isSavedPreset = config?.preset === preset;
      return {
        preset,
        baseUrl: isSavedPreset ? config.baseUrl : LLM_PRESETS[preset].baseUrl,
        model: isSavedPreset ? config.model : "",
        apiKey: "",
      };
    },
    [config],
  );

  useEffect(() => {
    if (!config) return;
    setForm(formForPreset(config.preset));
    setEditingApiKey(!config.hasApiKey);
  }, [config, formForPreset]);

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

  const usingSavedApiKey =
    config?.preset === form.preset && config.hasApiKey && !editingApiKey;
  const apiKeyRequired = !usingSavedApiKey && !(form.apiKey ?? "").trim();

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
              const isSavedPreset = config?.preset === preset;
              setForm(formForPreset(preset));
              setEditingApiKey(!(isSavedPreset && config.hasApiKey));
              setResult(null);
            }}
          >
            <SelectTrigger className="w-full" data-testid="llm-provider-select">
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
            {config?.preset === form.preset && config.hasApiKey && !editingApiKey ? (
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
                autoFocus={Boolean(config?.preset === form.preset && config.hasApiKey)}
                type="password"
                autoComplete="new-password"
                value={form.apiKey ?? ""}
                placeholder="请输入完整的新 API Key"
                onChange={(event) =>
                  setForm((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            )}
            {config?.preset === form.preset && config.hasApiKey && editingApiKey && (
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
  const info = useServerInfo();
  const cloudAccounts = info !== "loading" && info.cloud_accounts_enabled;
  const [me, setMe] = useState<CurrentAccount | null | "unknown">("unknown");
  const [usage, setUsage] = useState<PlatformUsageResponse | null>(null);
  const [balanceRecords, setBalanceRecords] = useState<BalanceRecord[]>([]);

  // Change-password dialog state (lifted verbatim from the old AccountMenu).
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    void (async () => {
      const account = await getMe();
      setMe(account);
      if (cloudAccounts && account !== null) {
        const [nextUsage, nextRecords] = await Promise.all([
          getPlatformUsage(),
          getBalanceRecords(),
        ]);
        setUsage(nextUsage);
        setBalanceRecords(nextRecords);
      }
    })();
  }, [cloudAccounts]);

  const onSignOut = useCallback(async () => {
    await logout();
    clearUserScopedBrowserState();
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
      if (cloudAccounts) {
        window.location.href = "/login?password=changed";
        return;
      }
      setPwDone(true);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
    } else {
      setPwError(result.error);
    }
  }, [oldPw, newPw, confirmPw, cloudAccounts]);

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
              {accountDisplayName(me)}
              {me.is_platform_admin && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (平台管理员)
                </span>
              )}
              {!cloudAccounts && me.is_admin && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(admin)</span>
              )}
            </div>
            {me.email && me.nick_name && (
              <div className="truncate text-sm text-muted-foreground">
                {maskedAccountEmail(me.email)}
              </div>
            )}
          </div>
        </div>

        {cloudAccounts && (
          <div className="space-y-4 border-y border-border py-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-xs text-muted-foreground">平台账户余额</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  ¥{Number(me.balance_cny ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                本机 BYOK 模型调用不扣除此余额
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <PlatformMetric label="平台调用" value={formatInteger(usage?.summary.request_count)} />
              <PlatformMetric label="输入 Token" value={formatInteger(usage?.summary.prompt_tokens)} />
              <PlatformMetric label="输出 Token" value={formatInteger(usage?.summary.completion_tokens)} />
              <PlatformMetric
                label="累计费用"
                value={`¥${Number(usage?.summary.charged_amount_cny ?? 0).toFixed(2)}`}
              />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">最近余额变动</div>
              {balanceRecords.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无余额变动</p>
              ) : (
                <div className="divide-y divide-border border-y border-border">
                  {balanceRecords.slice(0, 5).map((record) => (
                    <div key={record.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate">{record.note || record.record_type}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(record.created_at).toLocaleString()}
                        </div>
                      </div>
                      <div className="shrink-0 text-right tabular-nums">
                        <div className={Number(record.amount_cny) >= 0 ? "text-emerald-600" : ""}>
                          {Number(record.amount_cny) >= 0 ? "+" : ""}
                          ¥{Number(record.amount_cny).toFixed(2)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          余额 ¥{Number(record.balance_after_cny).toFixed(2)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {!cloudAccounts && me.is_admin && (
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

function formatInteger(value: number | undefined): string {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function PlatformMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums">{value}</div>
    </div>
  );
}

function FeedbackSection() {
  const info = useServerInfo();
  const [feedbackType, setFeedbackType] = useState<
    "bug" | "experience" | "feature" | "answer_quality" | "other"
  >("experience");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [contactAllowed, setContactAllowed] = useState(true);
  const [history, setHistory] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setHistory(await getFeedback());
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setMessage(null);
    const result = await createFeedback({
      feedback_type: feedbackType,
      title: title.trim(),
      content: content.trim(),
      rating,
      contact_allowed: contactAllowed,
      client_platform: navigator.platform || "web",
      client_version: info === "loading" ? undefined : info.server_version ?? undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error });
      return;
    }
    setTitle("");
    setContent("");
    setRating(null);
    setMessage({ kind: "ok", text: `反馈 #${result.feedback.feedback_number} 已提交` });
    await loadHistory();
  }, [contactAllowed, content, feedbackType, info, loadHistory, rating, title]);

  return (
    <Section
      title="用户反馈"
      description="告诉我们哪里不顺手，或你希望工作台下一步支持什么。"
    >
      <div className="flex max-w-3xl flex-col gap-7">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="feedback-type">反馈类型</label>
              <Select value={feedbackType} onValueChange={(value) => setFeedbackType(value as typeof feedbackType)}>
                <SelectTrigger id="feedback-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="experience">使用体验</SelectItem>
                  <SelectItem value="bug">问题报告</SelectItem>
                  <SelectItem value="feature">功能建议</SelectItem>
                  <SelectItem value="answer_quality">回答质量</SelectItem>
                  <SelectItem value="other">其他</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="feedback-title">标题</label>
              <Input
                id="feedback-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={240}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="feedback-content">详细内容</label>
            <Textarea
              id="feedback-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="min-h-32 resize-y"
              maxLength={20_000}
              required
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">评分（可选）</span>
              {[1, 2, 3, 4, 5].map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="icon"
                  variant={rating === value ? "default" : "outline"}
                  className="size-8"
                  aria-label={`${value} 分`}
                  onClick={() => setRating(rating === value ? null : value)}
                >
                  {value}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={contactAllowed}
                onChange={(event) => setContactAllowed(event.target.checked)}
                className="size-4"
              />
              允许通过账户邮箱联系我
            </label>
          </div>
          {message && (
            <div
              role="status"
              className={cn(
                "rounded-md border px-3 py-2 text-sm",
                message.kind === "ok"
                  ? "border-emerald-500/40 text-emerald-700"
                  : "border-destructive/40 text-destructive",
              )}
            >
              {message.text}
            </div>
          )}
          <Button
            type="submit"
            disabled={submitting || title.trim().length < 2 || content.trim().length < 2}
            className="gap-2"
          >
            {submitting ? <Loader2Icon className="size-4 animate-spin" /> : <MessageSquareTextIcon className="size-4" />}
            提交反馈
          </Button>
        </form>

        <div>
          <h3 className="mb-2 text-sm font-medium">我的反馈</h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">正在加载...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有提交过反馈</p>
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {history.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      #{entry.feedback_number} {entry.title}
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {entry.content}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <div>{feedbackStatusLabel(entry.status)}</div>
                    <div>{new Date(entry.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function feedbackStatusLabel(status: string): string {
  return ({
    open: "待处理",
    processing: "处理中",
    resolved: "已解决",
    closed: "已关闭",
  } as Record<string, string>)[status] ?? status;
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
