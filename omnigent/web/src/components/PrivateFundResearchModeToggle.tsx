import { cn } from "@/lib/utils";
import type { PrivateFundResearchMode } from "@/lib/privateFundApi";

interface PrivateFundResearchModeToggleProps {
  value: PrivateFundResearchMode;
  onChange: (mode: PrivateFundResearchMode) => void;
  className?: string;
  testId?: string;
}

const OPTIONS: ReadonlyArray<{ value: PrivateFundResearchMode; label: string }> = [
  { value: "standard", label: "常规研究" },
  { value: "deep", label: "深度研究" },
];

export function PrivateFundResearchModeToggle({
  value,
  onChange,
  className,
  testId = "private-fund-research-mode",
}: PrivateFundResearchModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="私募研究级别"
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border border-border/60 bg-background/50 p-0.5",
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            data-testid={`${testId}-${option.value}`}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] leading-4 transition-colors",
              selected
                ? "bg-foreground text-background shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
