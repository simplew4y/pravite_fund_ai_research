import { FilePathAwareMessageResponse } from "@/components/blocks/BlockRenderer";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PrivateFundEvidenceSource, PrivateFundRichContentBlock } from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";
import { FileSearch, MapPin, MousePointerClick } from "lucide-react";
import { useTheme } from "next-themes";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function BlockFrame({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)]",
        className,
      )}
    >
      {title ? (
        <h4 className="border-b border-[var(--pf-line)] px-4 py-3 text-xs font-semibold text-[var(--pf-ink)]">
          {title}
        </h4>
      ) : null}
      {children}
    </section>
  );
}

function MetricBlock({
  block,
}: {
  block: Extract<PrivateFundRichContentBlock, { type: "metrics" }>;
}) {
  return (
    <BlockFrame title={block.title}>
      <div className="grid grid-cols-2 gap-px bg-[var(--pf-line)] md:grid-cols-3">
        {block.items.map((item, index) => (
          <div className="min-w-0 bg-[var(--pf-panel)] px-4 py-3.5" key={`${item.label}-${index}`}>
            <p className="truncate text-[11px] text-[var(--pf-ink-secondary)]">{item.label}</p>
            <p className="mt-1.5 font-mono text-lg font-semibold tracking-[-0.03em] text-[var(--pf-ink)]">
              {item.value}
              {item.unit ? (
                <span className="ml-1 text-[11px] font-medium text-[var(--pf-ink-secondary)]">
                  {item.unit}
                </span>
              ) : null}
            </p>
            {item.delta ? (
              <p
                className={cn(
                  "mt-1 text-[10px] font-medium",
                  item.sentiment === "positive" && "text-[var(--pf-success-ink)]",
                  item.sentiment === "negative" && "text-[var(--pf-danger-ink)]",
                  (!item.sentiment || item.sentiment === "neutral") && "text-[var(--pf-ink-muted)]",
                )}
              >
                {item.delta}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </BlockFrame>
  );
}

function TableBlock({ block }: { block: Extract<PrivateFundRichContentBlock, { type: "table" }> }) {
  return (
    <BlockFrame title={block.title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-xs">
          <thead className="bg-[var(--pf-panel-subtle)] text-[var(--pf-ink-secondary)]">
            <tr>
              {block.columns.map((column) => (
                <th
                  className={cn(
                    "px-3 py-2.5 font-medium",
                    column.align === "right" ? "text-right" : "text-left",
                  )}
                  key={column.key}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-[var(--pf-ink-secondary)]">
            {block.rows.map((row, rowIndex) => (
              <tr className="border-t border-[var(--pf-line)]" key={rowIndex}>
                {block.columns.map((column) => (
                  <td
                    className={cn(
                      "px-3 py-2.5 align-top",
                      column.align === "right" && "text-right font-mono tabular-nums",
                    )}
                    key={column.key}
                  >
                    {row[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}

function ChartBlock({ block }: { block: Extract<PrivateFundRichContentBlock, { type: "chart" }> }) {
  const Chart = block.chart_type === "bar" ? BarChart : LineChart;
  return (
    <BlockFrame title={block.title}>
      <div className="h-[280px] px-2 pt-4" role="img" aria-label={block.title ?? "研究数据图表"}>
        <ResponsiveContainer height="100%" width="100%">
          <Chart data={block.data} margin={{ top: 4, right: 14, left: -12, bottom: 8 }}>
            <CartesianGrid stroke="var(--pf-line)" strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey={block.x_key}
              fontSize={10}
              stroke="var(--pf-ink-muted)"
              tickLine={false}
            />
            <YAxis
              fontSize={10}
              stroke="var(--pf-ink-muted)"
              tickFormatter={(value) => `${value}${block.y_unit ?? ""}`}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "var(--pf-panel-raised)",
                border: "1px solid var(--pf-line)",
                borderRadius: 10,
                color: "var(--pf-ink)",
                fontSize: 11,
              }}
              formatter={(value) => `${String(value)}${block.y_unit ?? ""}`}
            />
            {block.series.length > 1 ? (
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 10 }} />
            ) : null}
            {block.series.map((series, index) =>
              block.chart_type === "bar" ? (
                <Bar
                  dataKey={series.key}
                  fill={CHART_COLORS[index % CHART_COLORS.length]}
                  key={series.key}
                  name={series.label}
                  radius={[4, 4, 0, 0]}
                />
              ) : (
                <Line
                  activeDot={{ r: 4 }}
                  dataKey={series.key}
                  dot={false}
                  key={series.key}
                  name={series.label}
                  stroke={CHART_COLORS[index % CHART_COLORS.length]}
                  strokeWidth={2}
                  type="monotone"
                />
              ),
            )}
          </Chart>
        </ResponsiveContainer>
      </div>
      {block.source_note ? (
        <p className="px-4 pb-3 text-[10px] leading-4 text-[var(--pf-ink-muted)]">
          {block.source_note}
        </p>
      ) : null}
    </BlockFrame>
  );
}

function HtmlBlock({ block }: { block: Extract<PrivateFundRichContentBlock, { type: "html" }> }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const srcDoc = `<!doctype html><html data-theme="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--asset-bg:${dark ? "#15181e" : "#ffffff"};--asset-panel:${dark ? "#1d2128" : "#f7f8fa"};--asset-text:${dark ? "#f0f2f5" : "#171a20"};--asset-muted:${dark ? "#a8b0bd" : "#5f6978"};--asset-line:${dark ? "#2c313a" : "#dfe4eb"};--asset-accent:${dark ? "#8aa8ff" : "#2457d6"}}html,body{margin:0;padding:0;background:var(--asset-bg);color:var(--asset-text);font:13px/1.55 system-ui,-apple-system,sans-serif;color-scheme:${dark ? "dark" : "light"}}body{padding:16px;box-sizing:border-box}*{box-sizing:border-box}a{pointer-events:none;color:var(--asset-accent)}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid var(--asset-line);text-align:left}canvas,svg{max-width:100%}</style></head><body>${block.html}</body></html>`;
  return (
    <BlockFrame title={block.title}>
      <iframe
        className="block w-full border-0 bg-[var(--pf-panel)]"
        height={block.height ?? 320}
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={block.title ?? "Agent 生成的图文可视化"}
      />
    </BlockFrame>
  );
}

function evidenceLocation(source: PrivateFundEvidenceSource): string {
  if (source.pageStart) {
    return source.pageEnd && source.pageEnd !== source.pageStart
      ? `PDF 第 ${source.pageStart}-${source.pageEnd} 页`
      : `PDF 第 ${source.pageStart} 页`;
  }
  if (source.sheetName) {
    return source.cellRange
      ? `工作表 ${source.sheetName} · ${source.cellRange}`
      : `工作表 ${source.sheetName}`;
  }
  if (source.slideStart) {
    return source.slideEnd && source.slideEnd !== source.slideStart
      ? `幻灯片 ${source.slideStart}-${source.slideEnd}`
      : `幻灯片 ${source.slideStart}`;
  }
  return source.headingPath || "文档内位置未细分";
}

function EvidenceSources({ sources }: { sources: PrivateFundEvidenceSource[] }) {
  if (sources.length === 0) {
    return (
      <section className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-warning-soft)] px-4 py-3">
        <div className="flex items-start gap-2 text-[var(--pf-warning-ink)]">
          <FileSearch className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="text-xs font-semibold">该节点尚未绑定可核验来源</p>
            <p className="mt-1 text-[10px] leading-4">
              其中的事实与数字应视为待复核，不应直接作为投资判断依据。
            </p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-success-soft)] p-3">
      <div className="flex items-center gap-2 text-[var(--pf-success-ink)]">
        <FileSearch className="size-4" />
        <p className="text-xs font-semibold">溯源资料 · {sources.length} 条</p>
      </div>
      <p className="mt-1 flex items-center gap-1 text-[10px] text-[var(--pf-ink-secondary)]">
        <MousePointerClick className="size-3" />
        点击下方来源，查看真实文档位置和证据原文
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sources.map((source, index) => (
          <Popover key={source.evidenceId}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--pf-line-strong)] bg-[var(--pf-panel-raised)] px-2.5 py-1.5 text-left text-[10px] font-semibold text-[var(--pf-accent-ink)] shadow-sm transition-colors hover:border-[var(--pf-accent)] hover:bg-[var(--pf-panel-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pf-accent)]"
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded bg-[var(--pf-accent-soft)] text-[9px]">
                  {index + 1}
                </span>
                <span className="truncate">{source.citation}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[360px] p-4">
              <PopoverHeader>
                <PopoverTitle className="flex items-center gap-2">
                  <FileSearch className="size-4 text-[var(--pf-accent-ink)]" />
                  真实文档位置
                </PopoverTitle>
                <PopoverDescription>{source.citation}</PopoverDescription>
              </PopoverHeader>
              <dl className="mt-3 space-y-2 text-xs">
                <div>
                  <dt className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">文档</dt>
                  <dd className="mt-0.5 break-words font-medium text-[var(--pf-ink)]">
                    {source.documentName}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-1 text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                    <MapPin className="size-3" />
                    文档内位置
                  </dt>
                  <dd className="mt-0.5 font-medium text-[var(--pf-accent-ink)]">
                    {evidenceLocation(source)}
                  </dd>
                </div>
                {source.sourcePath || source.storedPath ? (
                  <div>
                    <dt className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                      真实文件路径
                    </dt>
                    <dd className="mt-1 max-h-20 overflow-auto rounded-lg bg-[var(--pf-panel-subtle)] px-2 py-1.5 font-mono text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
                      {source.sourcePath || source.storedPath}
                    </dd>
                  </div>
                ) : null}
                {source.excerpt ? (
                  <div>
                    <dt className="text-[10px] font-semibold text-[var(--pf-ink-muted)]">
                      证据原文
                    </dt>
                    <dd className="mt-1 max-h-36 overflow-auto rounded-lg border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] px-2.5 py-2 text-[11px] leading-5 text-[var(--pf-ink-secondary)]">
                      {source.excerpt}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </PopoverContent>
          </Popover>
        ))}
      </div>
    </section>
  );
}

export function RichNodeContent({
  blocks,
  fallbackMarkdown,
  evidenceSources = [],
}: {
  blocks: PrivateFundRichContentBlock[];
  fallbackMarkdown?: string | null;
  evidenceSources?: PrivateFundEvidenceSource[];
}) {
  if (blocks.length === 0) {
    return (
      <div className="space-y-3">
        {fallbackMarkdown ? (
          <FilePathAwareMessageResponse className="text-xs leading-5 text-[var(--pf-ink-secondary)]">
            {fallbackMarkdown}
          </FilePathAwareMessageResponse>
        ) : null}
        <EvidenceSources sources={evidenceSources} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "markdown") {
          return (
            <BlockFrame key={key} title={block.title}>
              <FilePathAwareMessageResponse className="px-4 py-3 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                {block.markdown}
              </FilePathAwareMessageResponse>
            </BlockFrame>
          );
        }
        if (block.type === "metrics") return <MetricBlock block={block} key={key} />;
        if (block.type === "table") return <TableBlock block={block} key={key} />;
        if (block.type === "chart") return <ChartBlock block={block} key={key} />;
        return <HtmlBlock block={block} key={key} />;
      })}
      <EvidenceSources sources={evidenceSources} />
    </div>
  );
}
