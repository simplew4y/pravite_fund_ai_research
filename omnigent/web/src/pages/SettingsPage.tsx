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
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
import { LanguageSelector } from "@/components/LanguageSelector";
import { formatCny, formatLocalizedDate, formatLocalizedNumber } from "@/lib/localeFormat";

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
      {section === "language" && <LanguageSection />}
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

function llmResultMessage(result: LlmConnectionTestResult, t: TFunction): string {
  if (result.ok) return t("model.connectionSuccess");
  const prefix: Record<string, string> = {
    authentication: t("model.errorAuthentication"),
    connection: t("model.errorConnection"),
    model: t("model.errorModel"),
    timeout: t("model.errorTimeout"),
    validation: t("model.errorValidation"),
    busy: t("model.errorBusy"),
    apply: t("model.errorApply"),
    provider: t("model.errorProvider"),
  };
  return `${prefix[result.error ?? ""] ?? t("model.errorRequest")}${result.detail ? `: ${result.detail}` : ""}`;
}

function LlmProviderSection() {
  const { t } = useTranslation();
  const { cloudAccounts, config, modelService, applyStatus, loading, refresh, setSource } =
    useLlmConfiguration();
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
        detail: error instanceof Error ? error.message : t("model.sourceSwitchFailed"),
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
    ? t("model.available")
    : modelService?.reason === "insufficient_balance"
      ? t("model.insufficientBalance")
      : modelService?.reason === "platform_access_required"
        ? t("model.preparing")
        : t("model.unavailable");

  return (
    <Section title={t("settings.modelService")} description={t("model.description")}>
      <div className="flex max-w-2xl flex-col gap-5">
        {cloudAccounts && (
          <div
            role="radiogroup"
            aria-label={t("model.source")}
            className="grid w-full max-w-sm grid-cols-2 rounded-md bg-muted p-1"
          >
            {(
              [
                ["platform", t("model.platform")],
                ["byok", t("model.custom")],
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
                        {t("common.enabled")}
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
                  {selectedPlatformModel?.displayName ||
                    modelService.activeLabel ||
                    t("model.platform")}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {t("model.platformDescription")}
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
                <div className="text-xs text-muted-foreground">{t("model.balance")}</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(modelService.platform.balanceCny || 0).toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t("model.inputPrice")}</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(selectedPlatformModel?.inputPriceCnyPerMillion || 0).toFixed(2)} /{" "}
                  {t("model.perMillionTokens")}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t("model.outputPrice")}</div>
                <div className="mt-1 font-medium tabular-nums">
                  ¥{Number(selectedPlatformModel?.outputPriceCnyPerMillion || 0).toFixed(2)} /{" "}
                  {t("model.perMillionTokens")}
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
                <Link to="/settings/platform-usage">{t("model.viewUsage")}</Link>
              </Button>
              {modelService.reason === "insufficient_balance" && (
                <Button variant="ghost" onClick={() => void switchSource("byok")}>
                  {t("model.switchCustom")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            {activity.busy && (
              <Alert>
                <AlertCircleIcon />
                <AlertTitle>
                  {activity.applying ? t("model.applying") : t("model.cannotSave")}
                </AlertTitle>
                <AlertDescription>
                  {activity.detail || t("model.waitForGeneration")}
                </AlertDescription>
              </Alert>
            )}

            <label className="flex flex-col gap-2 text-sm font-medium">
              {t("model.provider")}
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
                      {value === "custom"
                        ? t("model.customCompatible")
                        : value === "dashscope"
                          ? t("model.qwenDashScope")
                          : definition.label}
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
              {t("model.name")}
              <Input
                value={form.model}
                placeholder={t("model.namePlaceholder")}
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
                    placeholder={t("model.apiKeyPlaceholder")}
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
                    {t("common.cancel")}
                  </Button>
                )}
              </div>
            </label>

            {result && (
              <Alert variant={result.ok ? "default" : "destructive"}>
                {result.ok ? <CheckCircle2Icon /> : <AlertCircleIcon />}
                <AlertTitle>{result.ok ? t("model.success") : t("model.incomplete")}</AlertTitle>
                <AlertDescription>{llmResultMessage(result, t)}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={busy !== null || loading || apiKeyRequired}
                onClick={() => void runTest()}
              >
                {busy === "test" && <Loader2Icon className="size-4 animate-spin" />}
                {t("model.testConnection")}
              </Button>
              <Button
                disabled={busy !== null || loading || activity.busy || apiKeyRequired}
                onClick={() => void save()}
              >
                {busy === "save" && <Loader2Icon className="size-4 animate-spin" />}
                {t("model.saveConfiguration")}
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

const themeCards: { mode: ThemeMode; labelKey: string; icon: typeof SunIcon }[] = [
  { mode: "system", labelKey: "settings.system", icon: LaptopMinimalIcon },
  { mode: "light", labelKey: "settings.light", icon: SunIcon },
  { mode: "dark", labelKey: "settings.dark", icon: MoonIcon },
];

function AppearanceSection() {
  const { t } = useTranslation();
  // Embedded: the host owns the theme (embed.tsx forces light), so the
  // selector would be a no-op — match ThemeModeMenu and hide it.
  const isEmbedded = useIsEmbedded();
  const { theme, setTheme } = useTheme();
  const mode = normalizeThemeMode(theme);

  return (
    <Section title={t("settings.appearance")} description={t("settings.appearanceDescription")}>
      {isEmbedded ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "settings.hostControlsAppearance",
            "Appearance is controlled by the host application.",
          )}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Theme">
          {themeCards.map(({ mode: cardMode, labelKey, icon: Icon }) => {
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
                <span className="text-sm font-medium">{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function LanguageSection() {
  const { t } = useTranslation();
  const info = useServerInfo();

  return (
    <Section title={t("language.label")} description={t("language.description")}>
      <LanguageSelector
        persistAccount={info !== "loading" && info.cloud_accounts_enabled === true}
      />
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
  const { t } = useTranslation();
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
    setProfileMessage({ kind: "ok", text: t("account.nicknameSaved") });
  }, [nickName, t]);

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
      setPwError(t("auth.passwordMismatch"));
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
  }, [oldPw, pwCode, newPw, confirmPw, cloudAccounts, t]);

  if (me === "unknown" || me === null) {
    return <Section title={t("settings.account")}>{null}</Section>;
  }

  return (
    <Section title={t("settings.account")}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border">
            <UserCogIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            {cloudAccounts && editingProfile ? (
              <div className="flex max-w-xl items-center gap-1.5">
                <Input
                  aria-label={t("auth.nickname")}
                  value={nickName}
                  maxLength={120}
                  disabled={profileBusy}
                  placeholder={me.email || t("account.nicknamePlaceholder")}
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
                  aria-label={t("account.saveNickname")}
                  title={t("account.saveNickname")}
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
                  aria-label={t("account.cancelNickname")}
                  title={t("common.cancel")}
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
                      ({t("account.platformAdmin")})
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
                    aria-label={t("account.editNickname")}
                    title={t("account.editNickname")}
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
            <KeyRoundIcon className="size-4" /> {t("account.changePassword")}
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => void onSignOut()}
          >
            <LogOutIcon className="size-4" /> {t("auth.signOut")}
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
            <DialogTitle>{t("account.changePassword")}</DialogTitle>
            <DialogDescription>
              {pwDone
                ? t("account.passwordChanged")
                : cloudAccounts
                  ? t("account.codeWillBeSent", { email: me.email ?? t("account.currentEmail") })
                  : t("account.enterCurrentPassword")}
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
                    <Input value={me.email ?? ""} readOnly aria-label={t("account.email")} />
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      disabled={pwSendingCode || pwBusy || pwResendSeconds > 0}
                      onClick={() => void onSendPasswordCode()}
                    >
                      {pwSendingCode
                        ? t("account.sending")
                        : pwResendSeconds > 0
                          ? `${pwResendSeconds}s`
                          : pwCodeSent
                            ? t("auth.resendCode")
                            : t("auth.sendCode")}
                    </Button>
                  </div>
                  {pwCodeSent && (
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder={t("auth.sixDigitEmailCode")}
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
                  placeholder={t("account.currentPassword")}
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  disabled={pwBusy}
                  required
                />
              )}
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t("auth.newPassword")}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                minLength={8}
                disabled={pwBusy}
                required
              />
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t("auth.confirmNewPassword")}
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
                  {pwBusy ? t("account.changing") : t("account.changePassword")}
                </Button>
              </DialogFooter>
            </form>
          )}

          {pwDone && (
            <DialogFooter>
              <Button onClick={() => setPwOpen(false)}>{t("common.confirm")}</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

const BALANCE_PERIODS: BalanceRecordPeriod[] = ["all", "week", "month"];

function PlatformUsageSection() {
  const { t } = useTranslation();
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
      setError(t("usage.loadFailed"));
    }
    setLoading(false);
  }, [page, period, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (me === "unknown") {
    return <Section title={t("settings.platformUsage")}>{null}</Section>;
  }

  const currentPage = records?.page ?? page;
  const totalPages = records?.total_pages ?? 0;
  const items = records?.items ?? [];

  return (
    <Section title={t("settings.platformUsage")}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col justify-between gap-3 border-b border-border pb-5 sm:flex-row sm:items-end">
          <div>
            <div className="text-sm text-muted-foreground">{t("usage.balance")}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {formatCny(Number(me?.balance_cny ?? 0))}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">{t("usage.byokNotCharged")}</div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b border-border pb-5 text-sm sm:grid-cols-5">
          <PlatformMetric
            label={t("usage.calls")}
            value={formatInteger(usage?.summary.request_count)}
          />
          <PlatformMetric
            label={t("usage.inputTokens")}
            value={formatInteger(usage?.summary.prompt_tokens)}
          />
          <PlatformMetric
            label={t("usage.outputTokens")}
            value={formatInteger(usage?.summary.completion_tokens)}
          />
          <PlatformMetric
            label={t("usage.totalTokens")}
            value={formatInteger(usage?.summary.total_tokens)}
          />
          <PlatformMetric
            label={t("usage.totalCost")}
            value={formatCny(Number(usage?.summary.charged_amount_cny ?? 0))}
          />
        </div>

        <div>
          <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <div className="text-sm font-medium">{t("usage.balanceChanges")}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("usage.settledOnly")}</div>
            </div>
            <div className="inline-flex w-fit items-center rounded-md border border-border p-0.5">
              {BALANCE_PERIODS.map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={period === item ? "secondary" : "ghost"}
                  className="h-7 px-3"
                  onClick={() => {
                    setPeriod(item);
                    setPage(1);
                  }}
                >
                  {t(`usage.period.${item}`)}
                </Button>
              ))}
            </div>
          </div>

          {error && (
            <Alert className="mb-3">
              <AlertCircleIcon />
              <AlertTitle>{t("usage.unableToLoad")}</AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  {t("common.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <div className="min-h-36 divide-y divide-border border-y border-border">
            {loading && items.length === 0 ? (
              <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">
                {t("usage.empty")}
              </div>
            ) : (
              items.map((record) => (
                <div
                  key={record.id}
                  className="flex min-h-16 items-center justify-between gap-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{balanceRecordLabel(record, t)}</div>
                    {balanceRecordDetail(record, t) && (
                      <div className="text-xs text-muted-foreground">
                        {balanceRecordDetail(record, t)}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {formatLocalizedDate(record.created_at, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className={Number(record.amount_cny) >= 0 ? "text-emerald-600" : ""}>
                      {Number(record.amount_cny) >= 0 ? "+" : "-"}¥
                      {Math.abs(Number(record.amount_cny)).toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("usage.balanceAfter", {
                        value: formatCny(Number(record.balance_after_cny)),
                      })}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t("usage.totalRecords", { count: records?.total ?? 0 })}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                aria-label={t("common.previous")}
                disabled={loading || currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <span className="min-w-20 text-center tabular-nums">
                {t("usage.page", {
                  current: totalPages === 0 ? 0 : currentPage,
                  total: totalPages,
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                aria-label={t("common.next")}
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
  return formatLocalizedNumber(value ?? 0);
}

function balanceRecordLabel(record: BalanceRecord, t: TFunction): string {
  if (record.record_type === "usage") {
    return t("usage.modelCall", { model: record.model_display_name || t("model.platform") });
  }
  if (record.record_type === "initial_grant") return t("usage.initialGrant");
  if (record.record_type === "admin_adjustment") return record.note || t("usage.adjustment");
  return record.note || t("usage.balanceChanges");
}

function balanceRecordDetail(record: BalanceRecord, t: TFunction): string | null {
  if (record.record_type !== "usage") return null;
  if (record.prompt_tokens == null || record.completion_tokens == null) return null;
  return t("usage.tokenDetail", {
    input: formatInteger(record.prompt_tokens),
    output: formatInteger(record.completion_tokens),
  });
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
  const { t } = useTranslation();
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
          setMessage({ kind: "error", text: t("feedbackUi.tooManyFiles") });
          return;
        }
        const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (!FEEDBACK_ATTACHMENT_EXTENSIONS.has(extension)) {
          setMessage({
            kind: "error",
            text: t("feedbackUi.invalidFileType"),
          });
          return;
        }
        if (file.size === 0) {
          setMessage({ kind: "error", text: t("feedbackUi.emptyFile", { name: file.name }) });
          return;
        }
        if (file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
          setMessage({ kind: "error", text: t("feedbackUi.fileTooLarge", { name: file.name }) });
          return;
        }
        next.push(file);
      }
      const totalBytes = next.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > FEEDBACK_ATTACHMENT_MAX_TOTAL_BYTES) {
        setMessage({ kind: "error", text: t("feedbackUi.totalTooLarge") });
        return;
      }
      setAttachments(next);
    },
    [attachments, t],
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
    setMessage({
      kind: "ok",
      text: t("feedbackUi.submitted", { number: result.feedback.feedback_number }),
    });
    await loadHistory();
  }, [attachments, contactAllowed, content, feedbackType, info, loadHistory, rating, t, title]);

  return (
    <Section title={t("settings.feedback")} description={t("feedbackUi.description")}>
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
                {t("feedbackUi.type")}
              </label>
              <Select
                value={feedbackType}
                onValueChange={(value) => setFeedbackType(value as typeof feedbackType)}
              >
                <SelectTrigger id="feedback-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="experience">{t("feedbackUi.types.experience")}</SelectItem>
                  <SelectItem value="bug">{t("feedbackUi.types.bug")}</SelectItem>
                  <SelectItem value="feature">{t("feedbackUi.types.feature")}</SelectItem>
                  <SelectItem value="answer_quality">
                    {t("feedbackUi.types.answerQuality")}
                  </SelectItem>
                  <SelectItem value="other">{t("feedbackUi.types.other")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="feedback-title">
                {t("feedbackUi.title")}
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
              {t("feedbackUi.content")}
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
              <span className="text-sm font-medium">{t("feedbackUi.attachments")}</span>
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
                {t("feedbackUi.upload")}
              </Button>
            </div>
            <p id="feedback-attachment-help" className="text-sm text-muted-foreground">
              {t("feedbackUi.attachmentHelp")}
            </p>
            {attachments.length > 0 && (
              <div className="grid gap-2" aria-label={t("feedbackUi.selectedAttachments")}>
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
                      aria-label={t("feedbackUi.removeAttachment", { name: file.name })}
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
              <span className="text-sm text-muted-foreground">{t("feedbackUi.rating")}</span>
              {[1, 2, 3, 4, 5].map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="icon"
                  variant={rating === value ? "default" : "outline"}
                  className="size-8"
                  aria-label={t("feedbackUi.ratingValue", { value })}
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
              {t("feedbackUi.contactAllowed")}
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
            {t("feedbackUi.submit")}
          </Button>
        </form>

        <div>
          <h3 className="mb-2 text-sm font-medium">{t("feedbackUi.history")}</h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : historyError ? (
            <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
              <span>{historyError}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadHistory()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("feedbackUi.empty")}</p>
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
                            title={t("feedbackUi.download", { name: attachment.original_filename })}
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
                    <div>{feedbackStatusLabel(entry.status, t)}</div>
                    <div>{formatLocalizedDate(entry.created_at)}</div>
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

function feedbackStatusLabel(status: string, t: TFunction): string {
  return (
    (
      {
        open: t("feedbackUi.status.open"),
        processing: t("feedbackUi.status.processing"),
        resolved: t("feedbackUi.status.resolved"),
        closed: t("feedbackUi.status.closed"),
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
