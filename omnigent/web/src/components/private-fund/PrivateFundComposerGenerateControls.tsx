/**
 * Mode switches for private-fund note / Memo generation.
 *
 * Buttons only *arm* a generation mode (highlighted). The user types the
 * instruction in the main composer and hits Send — Composer intercepts
 * submit and calls ``generateAsset(mode, instruction)``.
 */

import { useEffect, useMemo } from "react";
import { BarChart3, FileText, NotebookPen, Sparkles, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PRIVATE_FUND_NOTE_OPTIONS,
  type PresentationMode,
  type PrivateFundGenerationMode,
  type WorkbenchActionContextValue,
} from "@/components/private-fund/PrivateFundResearchWorkbench";

const NOTE_ICONS: Record<PresentationMode, typeof FileText> = {
  plain_text: FileText,
  table: Table2,
  chart: BarChart3,
};

/** Shared look for both 生成笔记 / 生成 Memo triggers. */
const MODE_BTN_BASE =
  "h-9 gap-1.5 rounded-full border px-2.5 text-xs font-medium md:h-8 transition-colors";
const MODE_BTN_IDLE =
  "border-[var(--pf-line)] bg-[var(--pf-panel-raised)] text-[var(--pf-ink-secondary)] hover:border-[var(--pf-accent)]/50 hover:bg-[var(--pf-panel-subtle)] hover:text-[var(--pf-ink)]";
const MODE_BTN_ACTIVE =
  "border-[var(--pf-accent)] bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)] hover:bg-[var(--pf-accent-soft)]";

export type PrivateFundComposeIntent = "note" | "memo" | null;

function isNoteMode(mode: PrivateFundGenerationMode): mode is PresentationMode {
  return mode === "plain_text" || mode === "table" || mode === "chart";
}

export function PrivateFundComposerGenerateControls({
  actions,
  disabled,
  intent,
  onIntentChange,
  noteMode,
  onNoteModeChange,
}: {
  actions: WorkbenchActionContextValue;
  disabled: boolean;
  intent: PrivateFundComposeIntent;
  onIntentChange: (intent: PrivateFundComposeIntent) => void;
  noteMode: PresentationMode;
  onNoteModeChange: (mode: PresentationMode) => void;
}) {
  useEffect(() => {
    if (isNoteMode(actions.generationMode) && intent === "note") {
      onNoteModeChange(actions.generationMode);
    }
  }, [actions.generationMode, intent, onNoteModeChange]);

  const activeNote = useMemo(
    () => PRIVATE_FUND_NOTE_OPTIONS.find((option) => option.value === noteMode),
    [noteMode],
  );

  const armNote = () => {
    if (intent === "note") {
      onIntentChange(null);
      return;
    }
    onIntentChange("note");
    actions.setGenerationMode(noteMode);
  };

  const armMemo = () => {
    if (intent === "memo") {
      onIntentChange(null);
      return;
    }
    onIntentChange("memo");
    actions.setGenerationMode("memo");
  };

  const pickNoteMode = (mode: PresentationMode) => {
    onNoteModeChange(mode);
    actions.setGenerationMode(mode);
    if (intent !== "note") onIntentChange("note");
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="private-fund-generate-controls"
    >
      <div
        className={cn(
          "flex items-center overflow-hidden rounded-full border transition-colors",
          intent === "note" ? MODE_BTN_ACTIVE : MODE_BTN_IDLE,
        )}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          aria-pressed={intent === "note"}
          aria-label="生成笔记"
          data-testid="private-fund-generate-note-button"
          onClick={armNote}
          className={cn(
            "h-9 gap-1.5 rounded-none border-0 bg-transparent px-2.5 text-xs font-medium shadow-none md:h-8",
            "hover:bg-transparent",
            intent === "note" ? "text-[var(--pf-accent-ink)]" : "text-[var(--pf-ink-secondary)]",
          )}
        >
          <Sparkles className="size-3.5 shrink-0 opacity-80" />
          <span className="hidden sm:inline">生成笔记</span>
          <span className="sm:hidden">笔记</span>
          {intent === "note" ? (
            <span className="text-[11px] opacity-70">· {activeNote?.label}</span>
          ) : null}
        </Button>

        {intent === "note" ? (
          <div
            className="flex items-center gap-0.5 border-l border-[var(--pf-line)] px-1"
            role="radiogroup"
            aria-label="笔记形态"
          >
            {PRIVATE_FUND_NOTE_OPTIONS.map((option) => {
              const Icon = NOTE_ICONS[option.value];
              const active = noteMode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  title={option.description}
                  onClick={() => pickNoteMode(option.value)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-[var(--pf-panel-raised)] text-[var(--pf-ink)] ring-1 ring-[var(--pf-line)]"
                      : "text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-raised)]/80 hover:text-[var(--pf-ink-secondary)]",
                  )}
                >
                  <Icon className="size-3 opacity-80" />
                  <span className="hidden md:inline">{option.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-pressed={intent === "memo"}
        aria-label="生成 Memo"
        data-testid="private-fund-generate-memo-button"
        onClick={armMemo}
        className={cn(
          MODE_BTN_BASE,
          "shadow-none",
          intent === "memo" ? MODE_BTN_ACTIVE : MODE_BTN_IDLE,
          "hover:bg-[var(--pf-panel-subtle)]",
          intent === "memo" && "hover:bg-[var(--pf-accent-soft)]",
        )}
      >
        <NotebookPen className="size-3.5 shrink-0 opacity-80" />
        <span className="hidden sm:inline">生成 Memo</span>
        <span className="sm:hidden">Memo</span>
      </Button>
    </div>
  );
}

/** Compact banner above the textarea when a generate mode is armed. */
export function PrivateFundComposeIntentBanner({
  intent,
  noteMode,
  onClear,
}: {
  intent: Exclude<PrivateFundComposeIntent, null>;
  noteMode: PresentationMode;
  onClear: () => void;
}) {
  const noteLabel =
    PRIVATE_FUND_NOTE_OPTIONS.find((o) => o.value === noteMode)?.label ?? "文本";
  const title = intent === "memo" ? "生成 Memo 模式" : `生成${noteLabel}笔记模式`;
  const hint =
    intent === "memo"
      ? "在下方输入主题/范围（可留空若已有对话上下文），按发送开始生成"
      : "在下方输入补充要求（可留空），按发送生成研究笔记";

  return (
    <div
      data-testid="private-fund-compose-intent-banner"
      className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--pf-ink-secondary)]"
    >
      {intent === "memo" ? (
        <NotebookPen className="size-3.5 shrink-0 opacity-70" />
      ) : (
        <Sparkles className="size-3.5 shrink-0 opacity-70" />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-[var(--pf-ink)]">{title}</span>
        <span className="mx-1.5 text-[var(--pf-ink-muted)]">·</span>
        <span className="text-[var(--pf-ink-muted)]">{hint}</span>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-raised)] hover:text-[var(--pf-ink)]"
        aria-label="取消生成模式"
        title="取消，恢复普通对话"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
