import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "@/lib/routing";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useServerInfo } from "@/lib/CapabilitiesContext";
import {
  getLlmApplyStatus,
  getLlmConfig,
  onLlmApplyStatusChanged,
  type LlmApplyStatus,
  type LlmProviderConfig,
} from "@/lib/llmConfigApi";
import {
  getModelServiceState,
  prepareModelService,
  setModelServiceSource,
  type ModelServiceSource,
  type ModelServiceState,
} from "@/lib/modelServiceApi";
import { supportsDesktopLlmConfiguration } from "@/lib/nativeBridge";

const LLM_CONFIG_PROMPT_DISMISSED_PREFIX = "omnigent.llmConfigPrompt.dismissed:";

function promptDismissedKey(userId: string): string {
  return `${LLM_CONFIG_PROMPT_DISMISSED_PREFIX}${userId}`;
}

function readPromptDismissed(userId: string): boolean {
  try {
    return window.sessionStorage.getItem(promptDismissedKey(userId)) === "1";
  } catch {
    return false;
  }
}

interface LlmConfigContextValue {
  enabled: boolean;
  cloudAccounts: boolean;
  serverScoped: boolean;
  config: LlmProviderConfig | null;
  modelService: ModelServiceState | null;
  applyStatus: LlmApplyStatus;
  loading: boolean;
  requireConfiguration: () => Promise<boolean>;
  setSource: (source: ModelServiceSource) => Promise<ModelServiceState | null>;
  refresh: () => Promise<void>;
}

const LlmConfigContext = createContext<LlmConfigContextValue>({
  enabled: false,
  cloudAccounts: false,
  serverScoped: false,
  config: null,
  modelService: null,
  applyStatus: { busy: false, applying: false },
  loading: false,
  requireConfiguration: async () => true,
  setSource: async () => null,
  refresh: async () => {},
});

export function LlmConfigProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const serverInfo = useServerInfo();
  const cloudAccounts = serverInfo !== "loading" && serverInfo.cloud_accounts_enabled === true;
  const serverScoped = serverInfo !== "loading" && serverInfo.accounts_enabled;
  const enabled =
    cloudAccounts ||
    supportsDesktopLlmConfiguration() ||
    (serverInfo !== "loading" && serverInfo.llm_configuration_enabled);
  const [config, setConfig] = useState<LlmProviderConfig | null>(null);
  const [modelService, setModelService] = useState<ModelServiceState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptDismissedRef = useRef(readPromptDismissed("local"));
  const [applyStatus, setApplyStatus] = useState<LlmApplyStatus>({
    busy: false,
    applying: false,
  });
  const navigate = useNavigate();
  const location = useLocation();

  const rememberState = useCallback((state: ModelServiceState) => {
    setModelService(state);
    setConfig(state.byok);
    promptDismissedRef.current = readPromptDismissed(state.userId);
  }, []);

  const maybeOpenAutomaticPrompt = useCallback(
    (state: ModelServiceState) => {
      if (
        !state.ready &&
        !promptDismissedRef.current &&
        !location.pathname.includes("/settings/llm")
      ) {
        setPromptOpen(true);
      }
    },
    [location.pathname],
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setConfig(null);
      setModelService(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (cloudAccounts) {
      try {
        let next = await getModelServiceState();
        if (next.source === "platform" && next.reason === "platform_access_required") {
          const prepared = await prepareModelService();
          if (prepared.state) next = prepared.state;
        }
        rememberState(next);
        maybeOpenAutomaticPrompt(next);
      } catch {
        setModelService(null);
        setConfig(null);
      } finally {
        setLoading(false);
      }
      return;
    }
    const next = await getLlmConfig(serverScoped);
    setConfig(next);
    setModelService(null);
    setLoading(false);
    if (
      next &&
      !next.configured &&
      !promptDismissedRef.current &&
      !location.pathname.includes("/settings/llm")
    ) {
      setPromptOpen(true);
    }
  }, [
    cloudAccounts,
    enabled,
    location.pathname,
    maybeOpenAutomaticPrompt,
    rememberState,
    serverScoped,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || cloudAccounts) return;
    void getLlmApplyStatus(serverScoped).then(setApplyStatus);
    const unsubscribe = onLlmApplyStatusChanged(setApplyStatus, serverScoped);
    return unsubscribe;
  }, [cloudAccounts, enabled, serverScoped]);

  const requireConfiguration = useCallback(async () => {
    if (!enabled) return true;
    if (cloudAccounts) {
      setLoading(true);
      const prepared = await prepareModelService();
      setLoading(false);
      if (prepared.state) rememberState(prepared.state);
      if (prepared.ready) return true;
      setPromptOpen(true);
      return false;
    }
    if ((!loading && config === null) || config?.configured) return true;
    if (loading || applyStatus.applying) return false;
    setPromptOpen(true);
    return false;
  }, [applyStatus.applying, cloudAccounts, config, enabled, loading, rememberState]);

  const setSource = useCallback(
    async (source: ModelServiceSource) => {
      if (!cloudAccounts) return null;
      setLoading(true);
      try {
        const next = await setModelServiceSource(source);
        rememberState(next);
        return next;
      } finally {
        setLoading(false);
      }
    },
    [cloudAccounts, rememberState],
  );

  const dismissPromptForSession = useCallback(() => {
    const userId = modelService?.userId ?? "local";
    try {
      window.sessionStorage.setItem(promptDismissedKey(userId), "1");
    } catch {
      // The in-memory state still suppresses repeat prompts for this login session.
    }
    promptDismissedRef.current = true;
    setPromptOpen(false);
  }, [modelService?.userId]);

  const promptTitle = !cloudAccounts
    ? t("model.prompt.notConfiguredTitle")
    : modelService?.reason === "insufficient_balance"
      ? t("model.prompt.insufficientBalanceTitle")
      : modelService?.reason === "platform_unavailable"
        ? t("model.prompt.platformUnavailableTitle")
        : modelService?.source === "byok"
          ? t("model.prompt.customNotConfiguredTitle")
          : t("model.prompt.notReadyTitle");
  const promptDescription =
    modelService?.reason === "insufficient_balance"
      ? t("model.prompt.insufficientBalanceDescription")
      : modelService?.reason === "platform_unavailable"
        ? t("model.prompt.platformUnavailableDescription")
        : t("model.prompt.defaultDescription");
  const promptTarget =
    modelService?.reason === "insufficient_balance" ? "/settings/platform-usage" : "/settings/llm";
  const promptAction =
    modelService?.reason === "insufficient_balance"
      ? t("model.prompt.viewAccount")
      : t("model.prompt.openSettings");

  const contextValue = useMemo(
    () => ({
      enabled,
      cloudAccounts,
      serverScoped,
      config,
      modelService,
      applyStatus,
      loading,
      requireConfiguration,
      setSource,
      refresh,
    }),
    [
      applyStatus,
      cloudAccounts,
      config,
      enabled,
      loading,
      modelService,
      refresh,
      requireConfiguration,
      serverScoped,
      setSource,
    ],
  );

  return (
    <LlmConfigContext.Provider value={contextValue}>
      {children}
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{promptTitle}</DialogTitle>
            <DialogDescription>{promptDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={dismissPromptForSession}>
              {t("model.prompt.later")}
            </Button>
            <Button
              onClick={() => {
                dismissPromptForSession();
                navigate(promptTarget);
              }}
            >
              {promptAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LlmConfigContext.Provider>
  );
}

export function useLlmConfiguration(): LlmConfigContextValue {
  return useContext(LlmConfigContext);
}
