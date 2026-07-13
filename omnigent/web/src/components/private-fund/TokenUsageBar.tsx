import type { TokenUsageBreakdown } from "@/lib/tokenUsage";
import { cachedTokenCount } from "@/lib/tokenUsage";
import { cn } from "@/lib/utils";

export function TokenUsageBar({
  usage,
  className,
  testId,
}: {
  usage: TokenUsageBreakdown;
  className?: string;
  testId?: string;
}) {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = cachedTokenCount(usage) ?? 0;
  const known = input + output + cached;
  const total = usage.totalTokens ?? (known > 0 ? known : 0);
  const visualTotal = Math.max(total, known, 1);
  const other = Math.max(0, total - known);
  const segments = [
    { key: "input", value: input, color: "bg-[var(--pf-accent)]" },
    { key: "cache", value: cached, color: "bg-[var(--pf-accent)] opacity-70" },
    { key: "output", value: output, color: "bg-[var(--pf-accent)] opacity-45" },
    { key: "other", value: other, color: "bg-[var(--pf-accent)] opacity-25" },
  ].filter((segment) => segment.value > 0);

  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={cn(
        "flex h-1.5 min-w-10 overflow-hidden rounded-full bg-[var(--pf-line)]",
        className,
      )}
    >
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={segment.color}
          style={{ width: `${(segment.value / visualTotal) * 100}%` }}
        />
      ))}
    </span>
  );
}
