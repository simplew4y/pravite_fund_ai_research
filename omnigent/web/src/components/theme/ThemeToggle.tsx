import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { nextThemeMode, normalizeThemeMode } from "@/components/theme/themeMode";
import { cn } from "@/lib/utils";

const modeLabels = {
  light: "亮色",
  dark: "暗色",
  system: "跟随系统",
} as const;

/** Compact app-wide light, dark, and system theme control. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, systemTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const mode = normalizeThemeMode(theme);
  const nextMode = nextThemeMode(mode, systemTheme);
  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  const label = mounted ? modeLabels[mode] : modeLabels.system;

  return (
    <Button
      aria-label={`当前主题：${label}。切换为${modeLabels[nextMode]}`}
      className={cn("rounded-lg text-muted-foreground hover:text-foreground", className)}
      disabled={!mounted}
      onClick={() => setTheme(nextMode)}
      size="icon-sm"
      title={`主题：${label}`}
      type="button"
      variant="ghost"
    >
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  );
}
