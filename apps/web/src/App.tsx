import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LoginGate } from "./features/auth/LoginGate";
import { ProjectRail } from "./features/rail/ProjectRail";
import { ResearchBoard } from "./features/board/ResearchBoard";
import { Workbench } from "./features/workbench/Workbench";
import { useT } from "./i18n/useT";
import { useUiStore } from "./store/ui";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Frame() {
  const { t, lang } = useT();
  const selectedProjectId = useUiStore((state) => state.selectedProjectId);
  return (
    <div className="app-frame" data-lang={lang}>
      <ProjectRail />
      {selectedProjectId ? (
        <>
          <Workbench projectId={selectedProjectId} />
          <ResearchBoard projectId={selectedProjectId} />
        </>
      ) : (
        <div className="center-placeholder" style={{ gridColumn: "2 / 4" }}>
          {t("workbench.pickProject")}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LoginGate>
        <Frame />
      </LoginGate>
    </QueryClientProvider>
  );
}
