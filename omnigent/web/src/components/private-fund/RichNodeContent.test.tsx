import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RichNodeContent } from "./RichNodeContent";

afterEach(cleanup);

describe("RichNodeContent", () => {
  it("renders HTML misplaced in the Markdown fallback as a sandboxed document", () => {
    const html =
      '<section><h2>跨行业财务对比</h2><div id="chart"></div><script>document.querySelector("#chart").textContent="rendered"</script></section>';

    render(<RichNodeContent blocks={[]} fallbackMarkdown={html} />);

    const frame = screen.getByTitle("HTML 图文预览");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("跨行业财务对比");
    expect(frame.getAttribute("srcdoc")).toContain("document.querySelector");
    expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'");
  });

  it("renders fenced HTML as a sandboxed document", () => {
    render(
      <RichNodeContent
        blocks={[]}
        fallbackMarkdown={'```html\n<div class="chart">HTML 图表</div>\n```'}
      />,
    );

    expect(screen.getByTitle("HTML 图文预览").getAttribute("srcdoc")).toContain("HTML 图表");
  });

  it("keeps ordinary Markdown in the Markdown renderer", () => {
    render(
      <RichNodeContent
        blocks={[]}
        fallbackMarkdown={`## 投资结论

维持审慎乐观。`}
      />,
    );

    expect(screen.queryByTitle("HTML 图文预览")).not.toBeInTheDocument();
    expect(screen.getByText("投资结论")).toBeInTheDocument();
  });

  it("keeps table headers visible and separates chart source notes", () => {
    render(
      <RichNodeContent
        blocks={[
          {
            type: "table",
            title: "盈利能力对比",
            columns: [
              { key: "period", label: "期间" },
              { key: "margin", label: "毛利率", align: "right" },
            ],
            rows: [{ period: "2026Q1", margin: "31.2%" }],
          },
          {
            type: "chart",
            title: "毛利率趋势",
            chart_type: "line",
            x_key: "period",
            series: [{ key: "margin", label: "毛利率" }],
            data: [{ period: "2026Q1", margin: 31.2 }],
            y_unit: "%",
            source_note: "来源：经营数据.xlsx Chart!B2:C6",
          },
        ]}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "期间" }).closest("thead")).toHaveClass(
      "sticky",
    );
    expect(screen.getByText("数据来源")).toBeInTheDocument();
    expect(screen.getByText("来源：经营数据.xlsx Chart!B2:C6")).toBeInTheDocument();
  });
});
