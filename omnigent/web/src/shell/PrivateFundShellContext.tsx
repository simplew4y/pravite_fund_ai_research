import { createContext, type ReactNode, useContext } from "react";

export type PrivateFundShellContextValue = {
  sidebarOpen: boolean;
  openSidebar: () => void;
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
