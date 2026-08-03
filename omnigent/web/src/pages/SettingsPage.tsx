/**
 * Settings page (``/settings``).
 *
 * Renders into the AppShell chat outlet (see App.tsx) so the conversations
 * sidebar stays put when you enter settings — only the main area swaps to
 * this view. Inside, a section nav (left) drives a content panel (right),
 * modeled on a desktop-app settings window; a "← Back" link
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

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  FileIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogOutIcon,
  MessageSquareTextIcon,
  PencilIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UserCogIcon,
  UsersIcon,
  XIcon,
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
  type BalanceRecordPage,
  type BalanceRecordPeriod,
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
  sendChangePasswordCode,
  type PlatformUsageResponse,
  updateAccountProfile,
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
import { SkillsSettingsSection } from "@/pages/SkillsSettingsSection";

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
      {section === "skills" && <SkillsSettingsSection />}
      {section === "appearance" && <AppearanceSection />}
      {section === "shortcuts" && <ShortcutsSection />}
      {section === "account" && accountsEnabled && <AccountSection />}
      {section === "platform-usage" && info !== "loading" && info.cloud_accounts_enabled && (
        <PlatformUsageSection />
      )}
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
  const {
    cloudAccounts,
    serverScoped,
    config,
    modelService,
    applyStatus,
    loading,
    refresh,
    setSource,
  } = useLlmConfiguration();
  const [form, setForm] = useState<LlmProviderInput>({
    preset: "dashscope",
    baseUrl: LLM_PRESETS.dashscope.baseUrl,
    model: LLM_PRESETS.dashscope.defaultModel,
    apiKey: "",
  });
  const [busy, setBusy] = useState<"test" | "save" | "source" | null>(null);
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
      const next = await getLlmApplyStatus(serverScoped);
      if (active) setActivity(next);
    };
    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [serverScoped]);

  const runTest = async () => {
    setBusy("test");
    const next = await testLlmConfig(form, serverScoped);
    setResult(next);
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    const next = await saveLlmConfig(form, serverScoped);
    setBusy(null);
    setResult(next);
    if (!next.ok) return;
    await refresh();
    setForm((current) => ({ ...current, apiKey: "" }));
    setEditingApiKey(false);
  };

  const switchSource = async (source: "platform" | "byok") => {
    if (!cloudAccounts || modelService?.source === source) return;
    setBusy("source");
    setResult(null);
    try {
      await setSource(source);
    } catch (error) {
      setResult({
        ok: false,
        error: "runtime",
        detail: error instanceof Error ? error.message : "模型来源切换失败。",
      });
    } finally {
      setBusy(null);
    }
  };

  const usingSavedApiKey = config?.preset === form.preset && config.hasApiKey && !editingApiKey;
  const apiKeyRequired = !usingSavedApiKey && !(form.apiKey ?? "").trim();
  const selectedPlatformModel = modelService?.platform.models.find(
    (model) => model.id === modelService.platform.defaultModel,
  );
  const platformStatus = modelService?.ready
    ? "可用"
    : modelService?.reason === "insufficient_balance"
      ? "余额不足"
      : modelService?.reason === "platform_access_required"
        ? "正在准备"
        : "暂不可用";

  return (
    <Section title="模型服务" description="选择平台模型，或配置你自己的模型 API。">
      <div className="flex max-w-2xl flex-col gap-5">
        {cloudAccounts && (
          <div
            role="radiogroup"
            aria-label="模型来源"
            className="grid w-full max-w-sm grid-cols-2 rounded-md bg-muted p-1"
          >
            {(
              [
                ["platform", "平台模型"],
                ["byok", "自定义"],
              ] as const
            ).map(([source, label]) => (
              <button
                key={source}
                type="button"
                role="radio"
                aria-checked={modelService?.source === source}
                disabled={busy !== null || loading}
                onClick={() => void switchSource(source)}
                className={cn(
                  "h-8 rounded px-3 text-sm font-medium transition-colors disabled:opacity-50",
                  modelService?.source === source
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {busy === "source" && modelService?.source !== source ? (
                  <Loader2Icon className="mx-auto size-4 animate-spin" />
                ) : (
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <span>{label}</span>
                    {modelService?.source === source && (
                      <span className="rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-orange-700 dark:text-orange-300">
                        启用
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {cloudAccounts && modelService?.source === "platform" ? (
          <div className="divide-y divide-border border-y border-border">
            <div className="flex items-center justify-between gap-4 py-4">
              <div>
                <div className="font-medium">
                  {selectedPlatformModel?.displayName || modelService.activeLabel || "平台模型"}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  由平台统一提供，密钥不会发送到浏览器。
                </div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded px-2 py-1 text-xs font-medium",
                  modelService.ready
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                {platformStatus}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 py-4 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">账户余额</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(modelService.platform.balanceCny || 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">输入单价</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(selectedPlatformModel?.inputPriceCnyPerMillion || 0).toFixed(2)} / 百万
                  Token
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">输出单价</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(selectedPlatformModel?.outputPriceCnyPerMillion || 0).toFixed(2)} / 百万
                  Token
                </div>
              </div>
            </div>
            {!modelService.ready && modelService.detail && (
              <div className="py-4 text-sm text-amber-700 dark:text-amber-300">
                {modelService.detail}
              </div>
            )}
            <div className="flex flex-wrap gap-2 py-4">
              <Button asChild variant="outline">
                <Link to="/settings/platform-usage">查看平台用量</Link>
              </Button>
              {modelService.reason === "insufficient_balance" && (
                <Button variant="ghost" onClick={() => void switchSource("byok")}>
                  切换到自定义
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
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
                onChange={(event) =>
                  setForm((current) => ({ ...current, model: event.target.value }))
                }
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
          </>
        )}
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
  const [nickName, setNickName] = useState("");
  const [savedNickName, setSavedNickName] = useState("");
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  // Change-password dialog state (lifted verbatim from the old AccountMenu).
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [pwCode, setPwCode] = useState("");
  const [pwCodeSent, setPwCodeSent] = useState(false);
  const [pwSendingCode, setPwSendingCode] = useState(false);
  const [pwResendSeconds, setPwResendSeconds] = useState(0);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    if (pwResendSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setPwResendSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pwResendSeconds]);

  useEffect(() => {
    void (async () => {
      const account = await getMe();
      setMe(account);
      if (account !== null) {
        const nextNickName = account.nick_name?.trim() ?? "";
        setNickName(nextNickName);
        setSavedNickName(nextNickName);
      }
    })();
  }, []);

  const onSaveProfile = useCallback(async () => {
    setProfileBusy(true);
    setProfileMessage(null);
    const normalized = nickName.trim();
    const result = await updateAccountProfile(normalized || null);
    setProfileBusy(false);
    if (!result.ok) {
      setProfileMessage({ kind: "error", text: result.error });
      return;
    }
    setMe(result.account);
    const saved = result.account.nick_name?.trim() ?? "";
    setNickName(saved);
    setSavedNickName(saved);
    setEditingProfile(false);
    setProfileMessage({ kind: "ok", text: "昵称已保存" });
  }, [nickName]);

  const onSignOut = useCallback(async () => {
    await logout();
    clearUserScopedBrowserState();
    // Hard navigation so the chat store / react-query cache reset.
    window.location.href = "/login";
  }, []);

  const resetPwForm = useCallback(() => {
    setOldPw("");
    setPwCode("");
    setPwCodeSent(false);
    setPwSendingCode(false);
    setPwResendSeconds(0);
    setNewPw("");
    setConfirmPw("");
    setPwError(null);
    setPwDone(false);
    setPwBusy(false);
  }, []);

  const onSendPasswordCode = useCallback(async () => {
    if (pwSendingCode) return;
    setPwSendingCode(true);
    setPwError(null);
    const result = await sendChangePasswordCode();
    setPwSendingCode(false);
    if (!result.ok) {
      setPwError(result.error);
      return;
    }
    setPwCodeSent(true);
    setPwResendSeconds(result.resend_after);
  }, [pwSendingCode]);

  const onSubmitPassword = useCallback(async () => {
    if (newPw !== confirmPw) {
      setPwError("New passwords don't match.");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    const result = await changePassword(
      cloudAccounts
        ? { code: pwCode, new_password: newPw }
        : { old_password: oldPw, new_password: newPw },
    );
    setPwBusy(false);
    if (result.ok) {
      if (cloudAccounts) {
        clearUserScopedBrowserState();
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
  }, [oldPw, pwCode, newPw, confirmPw, cloudAccounts]);

  if (me === "unknown" || me === null) {
    return <Section title="账户">{null}</Section>;
  }

  return (
    <Section title="账户">
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border">
            <UserCogIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            {cloudAccounts && editingProfile ? (
              <div className="flex max-w-xl items-center gap-1.5">
                <Input
                  aria-label="昵称"
                  value={nickName}
                  maxLength={120}
                  disabled={profileBusy}
                  placeholder={me.email || "请输入昵称"}
                  autoFocus
                  onChange={(event) => {
                    setNickName(event.target.value);
                    setProfileMessage(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !profileBusy) {
                      event.preventDefault();
                      void onSaveProfile();
                    }
                    if (event.key === "Escape" && !profileBusy) {
                      setNickName(savedNickName);
                      setEditingProfile(false);
                      setProfileMessage(null);
                    }
                  }}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  aria-label="保存昵称"
                  title="保存昵称"
                  disabled={profileBusy || nickName.trim() === savedNickName}
                  onClick={() => void onSaveProfile()}
                >
                  {profileBusy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <CheckIcon className="size-4" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="取消编辑昵称"
                  title="取消"
                  disabled={profileBusy}
                  onClick={() => {
                    setNickName(savedNickName);
                    setEditingProfile(false);
                    setProfileMessage(null);
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-1">
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
                {cloudAccounts && (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="编辑昵称"
                    title="编辑昵称"
                    onClick={() => {
                      setNickName(savedNickName);
                      setEditingProfile(true);
                      setProfileMessage(null);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
            {me.email && <div className="truncate text-sm text-muted-foreground">{me.email}</div>}
            {profileMessage && (
              <div
                role={profileMessage.kind === "error" ? "alert" : "status"}
                className={cn(
                  "mt-1 text-xs",
                  profileMessage.kind === "error" ? "text-destructive" : "text-emerald-600",
                )}
              >
                {profileMessage.text}
              </div>
            )}
          </div>
        </div>

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
            <KeyRoundIcon className="size-4" /> 修改密码
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => void onSignOut()}
          >
            <LogOutIcon className="size-4" /> 退出登录
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
            <DialogTitle>修改密码</DialogTitle>
            <DialogDescription>
              {pwDone
                ? "密码已修改。"
                : cloudAccounts
                  ? `验证码将发送到 ${me.email ?? "当前账户邮箱"}。`
                  : "请输入当前密码，并设置一个新密码。"}
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
              {cloudAccounts ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Input value={me.email ?? ""} readOnly aria-label="账户邮箱" />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={pwSendingCode || pwBusy || pwResendSeconds > 0}
                      onClick={() => void onSendPasswordCode()}
                    >
                      {pwSendingCode
                        ? "发送中..."
                        : pwResendSeconds > 0
                          ? `${pwResendSeconds}s`
                          : pwCodeSent
                            ? "重新发送"
                            : "发送验证码"}
                    </Button>
                  </div>
                  {pwCodeSent && (
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6 位邮箱验证码"
                      value={pwCode}
                      onChange={(event) =>
                        setPwCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      pattern="\d{6}"
                      maxLength={6}
                      disabled={pwBusy}
                      required
                    />
                  )}
                </div>
              ) : (
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="当前密码"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  disabled={pwBusy}
                  required
                />
              )}
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="新密码"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                minLength={8}
                disabled={pwBusy}
                required
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder="确认新密码"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                minLength={8}
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
                    pwBusy ||
                    newPw.length < 8 ||
                    confirmPw.length === 0 ||
                    (cloudAccounts ? !pwCodeSent || pwCode.length !== 6 : oldPw.length === 0)
                  }
                >
                  {pwBusy ? "Changing…" : "Change password"}
                </Button>
              </DialogFooter>
            </form>
          )}

          {pwDone && (
            <DialogFooter>
              <Button onClick={() => setPwOpen(false)}>完成</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

const BALANCE_PERIODS: Array<{ value: BalanceRecordPeriod; label: string }> = [
  { value: "all", label: "全部" },
  { value: "week", label: "近一周" },
  { value: "month", label: "近一月" },
];

function PlatformUsageSection() {
  const [me, setMe] = useState<CurrentAccount | null | "unknown">("unknown");
  const [usage, setUsage] = useState<PlatformUsageResponse | null>(null);
  const [records, setRecords] = useState<BalanceRecordPage | null>(null);
  const [period, setPeriod] = useState<BalanceRecordPeriod>("all");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [account, nextUsage, nextRecords] = await Promise.all([
      getMe(),
      getPlatformUsage(),
      getBalanceRecords(page, period),
    ]);
    setMe(account);
    setUsage(nextUsage);
    setRecords(nextRecords);
    if (account === null || nextUsage === null || nextRecords === null) {
      setError("平台用量加载失败，请稍后重试。");
    }
    setLoading(false);
  }, [page, period]);

  useEffect(() => {
    void load();
  }, [load]);

  if (me === "unknown") {
    return <Section title="平台用量">{null}</Section>;
  }

  const currentPage = records?.page ?? page;
  const totalPages = records?.total_pages ?? 0;
  const items = records?.items ?? [];

  return (
    <Section title="平台用量">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col justify-between gap-3 border-b border-border pb-5 sm:flex-row sm:items-end">
          <div>
            <div className="text-sm text-muted-foreground">平台账户余额</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              ¥{Number(me?.balance_cny ?? 0).toFixed(2)}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">本机 BYOK 模型调用不扣除此余额</div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-border pb-5 text-sm sm:grid-cols-5">
          <PlatformMetric label="平台调用" value={formatInteger(usage?.summary.request_count)} />
          <PlatformMetric label="输入 Token" value={formatInteger(usage?.summary.prompt_tokens)} />
          <PlatformMetric
            label="输出 Token"
            value={formatInteger(usage?.summary.completion_tokens)}
          />
          <PlatformMetric label="总 Token" value={formatInteger(usage?.summary.total_tokens)} />
          <PlatformMetric
            label="累计费用"
            value={`¥${Number(usage?.summary.charged_amount_cny ?? 0).toFixed(2)}`}
          />
        </div>

        <div>
          <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-medium">余额变动</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                仅展示已经结算的真实余额变化
              </div>
            </div>
            <div className="inline-flex w-fit items-center rounded-md border border-border p-0.5">
              {BALANCE_PERIODS.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  size="sm"
                  variant={period === item.value ? "secondary" : "ghost"}
                  className="h-7 px-3"
                  onClick={() => {
                    setPeriod(item.value);
                    setPage(1);
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

          {error && (
            <Alert className="mb-3">
              <AlertCircleIcon />
              <AlertTitle>无法加载平台用量</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <div className="min-h-36 divide-y divide-border border-y border-border">
            {loading && items.length === 0 ? (
              <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                正在加载
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
                当前时间范围内暂无余额变动
              </div>
            ) : (
              items.map((record) => (
                <div
                  key={record.id}
                  className="flex min-h-16 items-center justify-between gap-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{balanceRecordLabel(record)}</div>
                    {balanceRecordDetail(record) && (
                      <div className="text-xs text-muted-foreground">
                        {balanceRecordDetail(record)}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {new Date(record.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className={Number(record.amount_cny) >= 0 ? "text-emerald-600" : ""}>
                      {Number(record.amount_cny) >= 0 ? "+" : "-"}¥
                      {Math.abs(Number(record.amount_cny)).toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      余额 ¥{Number(record.balance_after_cny).toFixed(2)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>共 {records?.total ?? 0} 条</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="上一页"
                disabled={loading || currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="min-w-20 text-center tabular-nums">
                第 {totalPages === 0 ? 0 : currentPage} / {totalPages} 页
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="下一页"
                disabled={loading || totalPages === 0 || currentPage >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function formatInteger(value: number | undefined): string {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function balanceRecordLabel(record: BalanceRecord): string {
  if (record.record_type === "usage") {
    return `${record.model_display_name || "平台模型"} 模型调用`;
  }
  if (record.record_type === "initial_grant") return "初始额度";
  if (record.record_type === "admin_adjustment") return record.note || "余额调整";
  return record.note || "余额变动";
}

function balanceRecordDetail(record: BalanceRecord): string | null {
  if (record.record_type !== "usage") return null;
  if (record.prompt_tokens == null || record.completion_tokens == null) return null;
  return `${formatInteger(record.prompt_tokens)} 输入 Token · ${formatInteger(
    record.completion_tokens,
  )} 输出 Token`;
}

function PlatformMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums">{value}</div>
    </div>
  );
}

const FEEDBACK_ATTACHMENT_EXTENSIONS = new Set(["docx", "pdf", "png", "jpg", "jpeg"]);
const FEEDBACK_ATTACHMENT_MAX_FILES = 3;
const FEEDBACK_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES = 150 * 1024 * 1024;

function formatAttachmentSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
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
  const [attachments, setAttachments] = useState<File[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<FeedbackEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setHistoryError(null);
    const result = await getFeedback();
    if (result.ok) {
      setHistory(result.items);
    } else {
      setHistory([]);
      setHistoryError(result.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const addAttachments = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      setMessage(null);
      const next = [...attachments];
      for (const file of Array.from(fileList)) {
        if (
          next.some(
            (item) =>
              item.name === file.name &&
              item.size === file.size &&
              item.lastModified === file.lastModified,
          )
        ) {
          continue;
        }
        if (next.length >= FEEDBACK_ATTACHMENT_MAX_FILES) {
          setMessage({ kind: "error", text: "附件最多上传 3 个" });
          return;
        }
        const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (!FEEDBACK_ATTACHMENT_EXTENSIONS.has(extension)) {
          setMessage({
            kind: "error",
            text: "仅支持 .docx、.pdf、.png、.jpg 和 .jpeg 文件",
          });
          return;
        }
        if (file.size === 0) {
          setMessage({ kind: "error", text: `${file.name} 是空文件，不能上传` });
          return;
        }
        if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
          setMessage({ kind: "error", text: `${file.name} 超过 50MB` });
          return;
        }
        next.push(file);
      }
      const totalBytes = next.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES) {
        setMessage({ kind: "error", text: "附件总大小不能超过 150MB" });
        return;
      }
      setAttachments(next);
    },
    [attachments],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    setMessage(null);
    const result = await createFeedback(
      {
        feedback_type: feedbackType,
        title: title.trim(),
        content: content.trim(),
        rating,
        contact_allowed: contactAllowed,
        client_platform: navigator.platform || "web",
        client_version: info === "loading" ? undefined : (info.server_version ?? undefined),
      },
      attachments,
    );
    setSubmitting(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: result.error });
      return;
    }
    setTitle("");
    setContent("");
    setRating(null);
    setAttachments([]);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    setMessage({ kind: "ok", text: `反馈 #${result.feedback.feedback_number} 已提交` });
    await loadHistory();
  }, [attachments, contactAllowed, content, feedbackType, info, loadHistory, rating, title]);

  return (
    <Section title="用户反馈" description="告诉我们哪里不顺手，或你希望工作台下一步支持什么。">
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
              <label className="text-sm font-medium" htmlFor="feedback-type">
                反馈类型
              </label>
              <Select
                value={feedbackType}
                onValueChange={(value) => setFeedbackType(value as typeof feedbackType)}
              >
                <SelectTrigger id="feedback-type">
                  <SelectValue />
                </SelectTrigger>
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
              <label className="text-sm font-medium" htmlFor="feedback-title">
                标题
              </label>
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
            <label className="text-sm font-medium" htmlFor="feedback-content">
              详细内容
            </label>
            <Textarea
              id="feedback-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="min-h-32 resize-y"
              maxLength={20_000}
              required
            />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">附件上传：</span>
              <input
                ref={attachmentInputRef}
                type="file"
                className="sr-only"
                accept=".docx,.pdf,.png,.jpg,.jpeg"
                multiple
                disabled={submitting || attachments.length >= FEEDBACK_ATTACHMENT_MAX_FILES}
                aria-describedby="feedback-attachment-help"
                onChange={(event) => {
                  addAttachments(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={submitting || attachments.length >= FEEDBACK_ATTACHMENT_MAX_FILES}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <CloudUploadIcon className="size-4" />
                附件上传
              </Button>
            </div>
            <p id="feedback-attachment-help" className="text-sm text-muted-foreground">
              文件格式（.docx、.pdf、.png、.jpg、.jpeg），单个文件不超过 50MB，最多 3 个
            </p>
            {attachments.length > 0 && (
              <div className="grid gap-2" aria-label="已选择的附件">
                {attachments.map((file) => (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2"
                  >
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm" title={file.name}>
                        {file.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatAttachmentSize(file.size)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={submitting}
                      aria-label={`移除附件 ${file.name}`}
                      onClick={() =>
                        setAttachments((current) => current.filter((item) => item !== file))
                      }
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
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
            {submitting ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <MessageSquareTextIcon className="size-4" />
            )}
            提交反馈
          </Button>
        </form>

        <div>
          <h3 className="mb-2 text-sm font-medium">我的反馈</h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">正在加载...</p>
          ) : historyError ? (
            <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
              <span>{historyError}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadHistory()}>
                重试
              </Button>
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有提交过反馈</p>
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {history.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      #{entry.feedback_number} {entry.title}
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {entry.content}
                    </div>
                    {(entry.attachments?.length ?? 0) > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {entry.attachments?.map((attachment) => (
                          <a
                            key={attachment.id}
                            href={`/v1/account/feedback/${entry.id}/attachments/${attachment.id}`}
                            download={attachment.original_filename}
                            className="inline-flex max-w-full items-center gap-1.5 rounded border px-2 py-1 text-xs text-primary hover:bg-muted"
                            title={`下载 ${attachment.original_filename}`}
                          >
                            <FileIcon className="size-3.5 shrink-0" />
                            <span className="max-w-48 truncate">
                              {attachment.original_filename}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                              {formatAttachmentSize(attachment.size_bytes)}
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
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
  return (
    (
      {
        open: "待处理",
        processing: "处理中",
        resolved: "已解决",
        closed: "已关闭",
      } as Record<string, string>
    )[status] ?? status
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
