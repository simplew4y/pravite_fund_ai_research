import { create } from "zustand";

import type { Lang } from "../i18n/dict";

const LANG_KEY = "pf.web.lang";
const PROJECT_KEY = "pf.web.activeProject";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode) — state stays in memory
  }
}

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

export const useUiStore = create<UiState>((set) => ({
  lang: readStored(LANG_KEY) === "en" ? "en" : "zh",
  selectedProjectId: readStored(PROJECT_KEY),
  expandedSessionId: null,
  boardTab: "documents",
  setLang: (lang) => {
    writeStored(LANG_KEY, lang);
    set({ lang });
  },
  toggleLang: () =>
    set((state) => {
      const lang = state.lang === "zh" ? "en" : "zh";
      writeStored(LANG_KEY, lang);
      return { lang };
    }),
  selectProject: (selectedProjectId) => {
    writeStored(PROJECT_KEY, selectedProjectId);
    set({ selectedProjectId, expandedSessionId: null });
  },
  expandSession: (expandedSessionId) => set({ expandedSessionId }),
  setBoardTab: (boardTab) => set({ boardTab }),
}));
