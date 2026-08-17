import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useProjects } from "./api/queries";
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
  const selectProject = useUiStore((state) => state.selectProject);
  const projects = useProjects();

  // localStorage 里可能残留其他租户/已删除项目的选中态（例如 development 与
  // cloud 模式切换后）；项目列表加载后校验，不存在就清掉，避免整版 404。
  useEffect(() => {
    if (
      projects.data !== undefined &&
      selectedProjectId !== null &&
      !projects.data.some((project) => project.id === selectedProjectId)
    ) {
      selectProject(null);
    }
  }, [projects.data, selectedProjectId, selectProject]);
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
