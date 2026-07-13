import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
} from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import {
  ChartLine,
  Database,
  Flag,
  GitFork,
  Lightbulb,
  Scale,
  Search,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useTheme } from "next-themes";

import "@xyflow/react/dist/style.css";

export type ResearchGraphNodeKind =
  | "source"
  | "analysis"
  | "assumption"
  | "scenario"
  | "defensive"
  | "base"
  | "growth"
  | "valuation"
  | "conclusion";

export type ResearchGraphNodeTone = "sage" | "mist" | "sand" | "coral" | "blue" | "lilac";

export type ResearchGraphNodeData = {
  eyebrow: string;
  title: string;
  summary: string;
  kind: ResearchGraphNodeKind;
  tone: ResearchGraphNodeTone;
  status: "pending" | "ready" | "running" | "completed" | "stale" | "failed";
  versionNo: number;
  contentTypes?: string[];
  previewMetrics?: Array<{ label: string; value: string; unit?: string }>;
  isCurrent?: boolean;
  isContext?: boolean;
  contextPending?: boolean;
  onToggleContext?: (nodeId: string) => void;
};

export type ResearchGraphNode = Node<ResearchGraphNodeData, "research">;

export type ResearchGraphCanvasProps = {
  workflowNodes: ResearchGraphNode[];
  workflowEdges: Edge[];
  selectedNodeId?: string;
  currentPathNodeId?: string;
  contextNodeIds?: string[];
  contextPending?: boolean;
  onToggleContextNode?: (nodeId: string) => void;
  onSelectNode?: (nodeId: string) => void;
  className?: string;
};

const nodeWidth = 216;
const EMPTY_CONTEXT_NODE_IDS: string[] = [];

const mutedEdgeStyle = { stroke: "var(--pf-line-strong)", strokeWidth: 1.5 } as const;

const toneStyles: Record<
  ResearchGraphNodeTone,
  { background: string; border: string; icon: string; ink: string }
> = {
  sage: {
    background: "var(--pf-panel-raised)",
    border: "var(--pf-line)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
  mist: {
    background: "var(--pf-panel-raised)",
    border: "var(--pf-line)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
  sand: {
    background: "var(--pf-panel-raised)",
    border: "var(--pf-line)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
  coral: {
    background: "var(--pf-panel-raised)",
    border: "var(--pf-line)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
  blue: {
    background: "var(--pf-accent-soft)",
    border: "var(--pf-accent)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
  lilac: {
    background: "var(--pf-panel-raised)",
    border: "var(--pf-line)",
    icon: "var(--pf-accent-ink)",
    ink: "var(--pf-ink)",
  },
};

const iconsByKind: Record<ResearchGraphNodeKind, LucideIcon> = {
  source: Database,
  analysis: Search,
  assumption: Lightbulb,
  scenario: GitFork,
  defensive: ShieldCheck,
  base: Scale,
  growth: TrendingUp,
  valuation: ChartLine,
  conclusion: Flag,
};

const ResearchNodeCard = ({ id, data, selected }: NodeProps<ResearchGraphNode>) => {
  const tone = toneStyles[data.tone];
  const Icon = iconsByKind[data.kind];

  return (
    <div
      data-testid={`research-node-${id}`}
      aria-current={data.isCurrent ? "step" : undefined}
      className="group relative rounded-xl px-3.5 py-3 text-left transition-[box-shadow,transform] duration-200"
      style={{
        width: nodeWidth,
        minHeight: 104,
        background: tone.background,
        border: `1px solid ${selected ? "var(--pf-accent)" : tone.border}`,
        boxShadow: selected
          ? "0 0 0 3px color-mix(in srgb, var(--pf-accent) 18%, transparent), var(--pf-shadow)"
          : "var(--pf-shadow)",
        color: tone.ink,
        transform: selected ? "translateY(-2px)" : undefined,
      }}
    >
      <Handle
        className="!h-2 !w-2 !border-2 !border-[var(--pf-panel)] !bg-[var(--pf-line-strong)]"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />

      <div className="mb-3 flex items-center justify-between gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--pf-accent-soft)]"
          style={{ color: tone.icon }}
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[10px] font-semibold tracking-[0.12em] opacity-65">
            {data.eyebrow} · {data.status}
          </span>
          <label
            className="nodrag nopan inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[var(--pf-panel-subtle)] px-1.5 py-1 text-[9px] font-semibold"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={data.isContext ?? false}
              disabled={data.contextPending}
              onChange={() => data.onToggleContext?.(id)}
              aria-label={`将${data.title}加入上下文`}
              className="size-3 cursor-pointer accent-[var(--pf-accent)] disabled:cursor-wait"
            />
            上下文
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 tracking-[-0.01em]">
          {data.title}
        </div>
        {data.isCurrent ? (
          <span className="shrink-0 rounded-full bg-[var(--pf-accent-soft)] px-2 py-0.5 text-[9px] font-semibold tracking-wide text-[var(--pf-accent-ink)]">
            当前路径
          </span>
        ) : null}
        {data.versionNo > 0 ? (
          <span className="shrink-0 text-[9px] font-semibold opacity-55">v{data.versionNo}</span>
        ) : null}
      </div>
      <div className="mt-1.5 text-[11px] leading-[1.55] opacity-70">{data.summary}</div>
      {data.previewMetrics?.length ? (
        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-[var(--pf-line)]">
          {data.previewMetrics.slice(0, 2).map((item) => (
            <div className="min-w-0 bg-[var(--pf-panel-subtle)] px-2 py-1.5" key={item.label}>
              <div className="truncate text-[8px] opacity-55">{item.label}</div>
              <div className="mt-0.5 truncate font-mono text-[11px] font-semibold">
                {item.value}
                {item.unit ? (
                  <span className="ml-0.5 text-[8px] opacity-60">{item.unit}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : data.contentTypes?.length ? (
        <div className="mt-2.5 text-[9px] font-medium opacity-55">
          {data.contentTypes.join(" / ")}
        </div>
      ) : null}

      <Handle
        className="!h-2 !w-2 !border-2 !border-[var(--pf-panel)] !bg-[var(--pf-line-strong)]"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </div>
  );
};

const researchNodeTypes = { research: ResearchNodeCard };

const collectPathEdgeIds = (selectedNodeId: string, edges: Edge[]) => {
  const parentEdgeByTarget = new Map(edges.map((edge) => [edge.target, edge] as const));
  const pathEdgeIds = new Set<string>();
  let currentNodeId: string | undefined = selectedNodeId;

  while (currentNodeId) {
    const parentEdge = parentEdgeByTarget.get(currentNodeId);
    if (!parentEdge) {
      break;
    }
    pathEdgeIds.add(parentEdge.id);
    currentNodeId = parentEdge.source;
  }

  return pathEdgeIds;
};

export const ResearchGraphCanvas = ({
  workflowNodes,
  workflowEdges,
  selectedNodeId,
  currentPathNodeId = "source-review",
  contextNodeIds = EMPTY_CONTEXT_NODE_IDS,
  contextPending = false,
  onToggleContextNode,
  onSelectNode,
  className,
}: ResearchGraphCanvasProps) => {
  const { resolvedTheme } = useTheme();
  const activeNodeId = selectedNodeId ?? currentPathNodeId;
  const allNodes = workflowNodes;
  const allEdges = workflowEdges;

  const nodes = useMemo(
    () =>
      allNodes.map((node) => ({
        ...node,
        selected: node.id === activeNodeId,
        data: {
          ...node.data,
          isCurrent: node.id === currentPathNodeId,
          isContext: contextNodeIds.includes(node.id),
          contextPending,
          onToggleContext: onToggleContextNode,
        },
      })),
    [
      activeNodeId,
      allNodes,
      contextNodeIds,
      contextPending,
      currentPathNodeId,
      onToggleContextNode,
    ],
  );

  const edges = useMemo(() => {
    const highlightedEdgeIds = collectPathEdgeIds(currentPathNodeId, allEdges);

    return allEdges.map((edge) => {
      const isHighlighted = highlightedEdgeIds.has(edge.id);
      const color = isHighlighted ? "var(--pf-accent)" : mutedEdgeStyle.stroke;

      return {
        ...edge,
        animated: isHighlighted,
        markerEnd: { type: MarkerType.ArrowClosed, color },
        style: {
          stroke: color,
          strokeWidth: isHighlighted ? 2.15 : mutedEdgeStyle.strokeWidth,
        },
      };
    });
  }, [allEdges, currentPathNodeId]);

  return (
    <section
      aria-label="研究路径图"
      className={`relative min-h-[540px] overflow-hidden rounded-xl border border-[var(--pf-line)] bg-[var(--pf-canvas)] ${className ?? ""}`}
    >
      <ReactFlow<ResearchGraphNode, Edge>
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        edges={edges}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        maxZoom={1.35}
        minZoom={0.42}
        nodeTypes={researchNodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        panOnDrag
        panOnScroll
        proOptions={{ hideAttribution: true }}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
      >
        <Background
          bgColor="var(--pf-canvas)"
          color="var(--pf-line)"
          gap={24}
          size={1.1}
          variant={BackgroundVariant.Dots}
        />
        <Controls
          className="!overflow-hidden !rounded-xl !border !border-[var(--pf-line)] !bg-[var(--pf-panel-raised)] !shadow-[var(--pf-shadow)]"
          position="bottom-left"
          showInteractive={false}
        />
        <MiniMap
          maskColor="color-mix(in srgb, var(--pf-canvas) 76%, transparent)"
          nodeBorderRadius={18}
          nodeColor={(node) => {
            const data = node.data as ResearchGraphNodeData;
            return toneStyles[data.tone].background;
          }}
          pannable
          position="bottom-right"
          style={{
            width: 124,
            height: 74,
            border: "1px solid var(--pf-line)",
            borderRadius: 12,
            background: "var(--pf-panel-raised)",
            boxShadow: "var(--pf-shadow)",
          }}
          zoomable
        />
      </ReactFlow>
    </section>
  );
};

export default ResearchGraphCanvas;
