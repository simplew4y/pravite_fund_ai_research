import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import {
  getLlmApplyStatus,
  getLlmConfig,
  isElectronShell,
  onLlmApplyStatusChanged,
  type LlmApplyStatus,
  type LlmProviderConfig,
} from "@/lib/nativeBridge";

interface LlmConfigContextValue {
  config: LlmProviderConfig | null;
  applyStatus: LlmApplyStatus;
  loading: boolean;
  requireConfiguration: () => boolean;
  refresh: () => Promise<void>;
}

const LlmConfigContext = createContext<LlmConfigContextValue>({
  config: null,
  applyStatus: { busy: false, applying: false },
  loading: false,
  requireConfiguration: () => true,
  refresh: async () => {},
});

export function LlmConfigProvider({ children }: { children: ReactNode }) {
  const desktop = isElectronShell();
  const [config, setConfig] = useState<LlmProviderConfig | null>(null);
  const [loading, setLoading] = useState(desktop);
  const [promptOpen, setPromptOpen] = useState(false);
  const [applyStatus, setApplyStatus] = useState<LlmApplyStatus>({
    busy: false,
    applying: false,
  });
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    const next = await getLlmConfig();
    setConfig(next);
    setLoading(false);
    if (next && !next.configured && !location.pathname.includes("/settings/llm")) {
      setPromptOpen(true);
    }
  }, [desktop, location.pathname]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktop) return;
    void getLlmApplyStatus().then(setApplyStatus);
    return onLlmApplyStatusChanged(setApplyStatus);
  }, [desktop]);

  const requireConfiguration = useCallback(() => {
    if (applyStatus.applying) return false;
    if (!desktop || (!loading && config === null) || config?.configured) return true;
    if (loading) return false;
    setPromptOpen(true);
    return false;
  }, [applyStatus.applying, config, desktop, loading]);
  const contextValue = useMemo(
    () => ({ config, applyStatus, loading, requireConfiguration, refresh }),
    [applyStatus, config, loading, requireConfiguration, refresh],
  );

  return (
    <LlmConfigContext.Provider value={contextValue}>
      {children}
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>尚未配置模型服务</DialogTitle>
            <DialogDescription>
              请先配置模型供应商、API Key 和模型名称，完成后即可开始投研问答。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPromptOpen(false)}>
              稍后
            </Button>
            <Button
              onClick={() => {
                setPromptOpen(false);
                navigate("/settings/llm");
              }}
            >
              前往设置
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
