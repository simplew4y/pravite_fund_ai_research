import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, buttonVariants } from "./button";

const TRANSLATE_UTILITY = /(^|:)-?translate-/;
const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const SIZES = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;

describe("buttonVariants translate/transform composition", () => {
  it.each(VARIANTS.flatMap((variant) => SIZES.map((size) => ({ variant, size }))))(
    "emits no translate-* utility for variant=$variant size=$size",
    ({ variant, size }) => {
      const classes = buttonVariants({ variant, size }).split(/\s+/);
      expect(classes.filter((className) => TRANSLATE_UTILITY.test(className))).toEqual([]);
    },
  );

  it("keeps the pressed-state nudge on the transform property", () => {
    expect(buttonVariants({})).toMatch(/active:[^\s]*\[transform:translateY\(/);
  });

  it("preserves a caller's -translate-y-1/2 centering class through the merge", () => {
    const merged = buttonVariants({
      variant: "ghost",
      size: "icon-sm",
      className: "absolute top-1/2 -translate-y-1/2 right-9",
    });
    expect(merged).toContain("-translate-y-1/2");
  });
});

describe("Button disabled feedback", () => {
  it("gives every disabled shared button an actionable default explanation", () => {
    render(<Button disabled>开始研究</Button>);
    expect(screen.getByRole("button", { name: "开始研究" })).toHaveAttribute(
      "title",
      "当前操作暂不可用，请先完成必要条件。",
    );
  });

  it("supports a control-specific disabled explanation", () => {
    render(
      <Button disabled disabledReason="请先选择资料">
        生成 Memo
      </Button>,
    );
    expect(screen.getByRole("button", { name: "生成 Memo" })).toHaveAttribute(
      "title",
      "请先选择资料",
    );
  });
});
