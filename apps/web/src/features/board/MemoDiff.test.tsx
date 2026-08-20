import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoComparison, MemoSectionChange } from "../../api/insights";
import { renderWithQuery } from "../../test-utils";
import { MemoDiff } from "./MemoDiff";

function section(
  overrides: Pick<MemoSectionChange, "sectionKey" | "changeType"> &
    Partial<MemoSectionChange>,
): MemoSectionChange {
  return {
    title: "",
    similarity: 0,
    oldContent: "",
    newContent: "",
    ...overrides,
  };
}

function comparison(overrides: Partial<MemoComparison>): MemoComparison {
  return {
    fromVersion: { versionNo: 1 },
    toVersion: { versionNo: 2 },
    sectionChanges: [],
    itemChanges: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MemoDiff", () => {
  it("renders change-type tags with the right content and hides unchanged sections", () => {
    renderWithQuery(
      <MemoDiff
        comparison={comparison({
          sectionChanges: [
            section({
              sectionKey: "thesis",
              changeType: "added",
              title: "投资论点",
              oldContent: "added-old-should-not-render",
              newContent: "新增的论点内容",
            }),
            section({
              sectionKey: "valuation",
              changeType: "changed",
              title: "估值",
              oldContent: "旧估值 30x",
              newContent: "新估值 25x",
            }),
            section({
              sectionKey: "risk",
              changeType: "not_mentioned",
              title: "风险",
              oldContent: "被移除的风险描述",
              newContent: "removed-new-should-not-render",
            }),
            section({
              sectionKey: "summary",
              changeType: "unchanged",
              title: "未变化章节",
            }),
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("v1 → v2")).toBeInTheDocument();
    expect(screen.getByText("新增")).toBeInTheDocument();
    expect(screen.getByText("变化")).toBeInTheDocument();
    expect(screen.getByText("移除")).toBeInTheDocument();
    expect(screen.getByText("新增的论点内容")).toBeInTheDocument();
    expect(screen.queryByText("added-old-should-not-render")).not.toBeInTheDocument();
    expect(screen.getByText("旧估值 30x")).toBeInTheDocument();
    expect(screen.getByText("新估值 25x")).toBeInTheDocument();
    expect(screen.getByText("被移除的风险描述")).toBeInTheDocument();
    expect(screen.queryByText("removed-new-should-not-render")).not.toBeInTheDocument();
    expect(screen.queryByText("未变化章节")).not.toBeInTheDocument();
    expect(screen.getByText("未变化章节已折叠 · 1")).toBeInTheDocument();
  });

  it("shows the empty state when every section is unchanged", () => {
    renderWithQuery(
      <MemoDiff
        comparison={comparison({
          sectionChanges: [
            section({ sectionKey: "a", changeType: "unchanged" }),
            section({ sectionKey: "b", changeType: "unchanged" }),
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("暂无数据")).toBeInTheDocument();
    expect(screen.getByText("未变化章节已折叠 · 2")).toBeInTheDocument();
  });

  it("lists item changes with summary and materiality tag", () => {
    renderWithQuery(
      <MemoDiff
        comparison={comparison({
          itemChanges: [
            { itemId: "i-1", summary: "毛利率假设上调", materiality: "high" },
            { itemId: "i-2", title: "新增催化剂" },
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("研究条目")).toBeInTheDocument();
    expect(screen.getByText("毛利率假设上调")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("新增催化剂")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    renderWithQuery(<MemoDiff comparison={comparison({})} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
