import type { Lang } from "../i18n/dict";
export type BoardTab = "documents" | "memo" | "valuation" | "risks";
interface UiState {
    lang: Lang;
    selectedProjectId: string | null;
    expandedSessionId: string | null;
    boardTab: BoardTab;
    setLang: (lang: Lang) => void;
    toggleLang: () => void;
    selectProject: (projectId: string | null) => void;
    expandSession: (sessionId: string | null) => void;
    setBoardTab: (tab: BoardTab) => void;
}
export declare const useUiStore: import("zustand").UseBoundStore<import("zustand").StoreApi<UiState>>;
export {};
//# sourceMappingURL=ui.d.ts.map