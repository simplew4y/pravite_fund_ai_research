import { createContext, type ReactNode, useContext } from "react";

export type PrivateFundGenerationRequest =
  | { kind: "message"; prompt: string }
  | { kind: "skill"; name: "private-fund-memo" | "private-fund-report"; args: string };

export type PrivateFundGenerationHandler = (request: PrivateFundGenerationRequest) => void;

export type PrivateFundShellContextValue = {
  sidebarOpen: boolean;
  openSidebar: () => void;
  registerGenerationHandler: (handler: PrivateFundGenerationHandler | null) => void;
  requestGeneration: (request: PrivateFundGenerationRequest) => boolean;
};

const PrivateFundShellContext = createContext<PrivateFundShellContextValue | null>(null);

export function PrivateFundShellContextProvider({
  value,
  children,
}: {
  value: PrivateFundShellContextValue;
  children: ReactNode;
}) {
  return (
    <PrivateFundShellContext.Provider value={value}>{children}</PrivateFundShellContext.Provider>
  );
}

export function usePrivateFundShell(): PrivateFundShellContextValue | null {
  return useContext(PrivateFundShellContext);
}
