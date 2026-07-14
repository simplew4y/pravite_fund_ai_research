import type { PrivateFundPromptSuggestion } from "@/lib/privateFundPromptSuggestions";
import { cn } from "@/lib/utils";

export function PrivateFundPromptSuggestionTray({
  suggestions,
  disabled = false,
  onSelect,
  className,
}: {
  suggestions: PrivateFundPromptSuggestion[];
  disabled?: boolean;
  onSelect: (prompt: string) => void;
  className?: string;
}) {
  return (
    <section aria-label="研究问题建议" className={cn("w-full", className)}>
      <div className="private-fund-suggestion-row flex items-center gap-1.5 overflow-x-auto pb-0.5">
        <span className="shrink-0 pr-1 text-xs font-medium text-[var(--pf-ink-muted)]">
          你可以问
        </span>
        {suggestions.map((suggestion) => (
          <button
            className="h-8 shrink-0 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-3 text-xs font-medium text-[var(--pf-ink-secondary)] transition-[border-color,background-color,color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-[var(--pf-accent)] hover:bg-[var(--pf-accent-soft)] hover:text-[var(--pf-accent-ink)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)] active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            key={suggestion.id}
            onClick={() => onSelect(suggestion.prompt)}
            title={suggestion.prompt}
            type="button"
          >
            {suggestion.title}
          </button>
        ))}
      </div>
    </section>
  );
}
