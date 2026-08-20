import {
  agentToolArgumentsSchemas,
  AGENT_TOOL_PROTOCOL_VERSION,
  type AgentToolRequestMessage,
  type SessionEvent,
} from "@private-fund/contracts";
import { newId } from "@private-fund/core";
import type { SessionEventsRepository } from "@private-fund/db";
import { z } from "zod";

import type {
  AgentEvent,
  AgentToolRequestHandler,
  AgentWorkerPort,
  StartAgentSessionInput,
} from "../agent-supervisor.js";
import type { ModelGatewayCapability } from "../kernel-plugins/model-gateway.js";
import { buildModelRequestDraft } from "./gateway-provider.js";
import {
  streamChatCompletion,
  type ChatMessage,
  type ChatModelEndpoint,
  type ChatToolCall,
  type ChatToolDefinition,
} from "./model-client.js";

const MAX_STEPS = 16;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_HISTORY_EVENTS = 4_000;

const TOOL_DESCRIPTIONS: Record<keyof typeof agentToolArgumentsSchemas, string> = {
  "workspace.list":
    "列出项目工作区中的资源；返回的 resourceId 才能用于 workspace.read，切勿自行拼造。",
  "workspace.read":
    "按 resourceId 读取工作区文件内容；resourceId 必须来自 workspace.list 的返回值。",
  "workspace.search": "在工作区文件内按关键词搜索。",
  "workspace.write": "向项目工作区写入文本文件（会经过审批与审计）。",
  "evidence.search":
    "检索本项目已索引的资料证据，是回答投研问题的首选工具。" +
    "evidenceTypes 为可选过滤器：chunk=文档文本块（PDF/Word），cell=表格单元格（Excel 模型），fact=结构化事实；" +
    "不确定资料形态时务必省略该参数以检索全部类型——传错类型会得到 0 条命中。" +
    "检索是对原文的字面匹配，中文无结果时改用英文或数字关键词重试。",
  "evidence.get":
    "按 evidenceId 取回证据原文与来源定位（文件、页码或单元格），用于引用。",
  "job.enqueue": "排队后台任务（追踪扫描、文档计算等）。",
  "job.get": "查询后台任务的状态与结果。",
};

const DEFAULT_SYSTEM_PROMPT = [
  "你是私募投研工作台的研究 Agent（Researcher-01）。",
  "职责：基于当前项目的资料库回答投研问题，证据优先，引用来源，不编造数据。",
  "可以调用工具检索证据（evidence.search / evidence.get）、读写工作区文件和排队后台任务。",
  "evidence.search 是对资料原文的字面检索：年报与估值模型常为英文或数字，中文检索无结果时",
  "必须改用英文或行业术语重试（如 收入→Revenue/Sales、毛利率→Gross margin、净利润→Net income），",
  "并可用资料标题中的公司名、表名或指标名作为关键词；连续无结果再说明资料库缺少该信息。",
  "引用证据时在句尾用方括号标注完整 evidenceId，例如 [chunk:abc-123] 或 [cell:sheet1-B12]，",
  "工作台会把它渲染成可点击的溯源链接；不要发明不存在的 evidenceId。",
  "工具调用之间不要重复叙述已经说过的计划，直接推进；最后一步给出完整结论。",
  "回答使用与用户一致的语言，结构清晰，量化结论给出区间与假设。",
].join("\n");

export interface HarnessAgentEndpointResolver {
  (session: SessionContext): ChatModelEndpoint;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly tenantNamespace: string;
  readonly projectId: string;
  readonly workspace: string;
  readonly model?: string;
  readonly modelGatewayAccess?: StartAgentSessionInput["modelGatewayAccess"];
}

interface ActiveTurn {
  readonly operationId: string;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

export interface DurableEventRecord {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface HarnessAgentRuntimeOptions {
  readonly sessionEvents: SessionEventsRepository;
  /**
   * Authority-mode context source: read the model-visible event stream from
   * the Session Journal instead of the legacy projection. Falls back to
   * sessionEvents when absent.
   */
  readonly replayEvents?: (
    tenantNamespace: string,
    sessionId: string,
    afterSequence: number,
    limit: number,
  ) => DurableEventRecord[];
  /** Resolves the chat endpoint for a session (cloud gateway or dev env). */
  readonly resolveEndpoint: HarnessAgentEndpointResolver;
  /**
   * Per-session prompt assembly (harness system-prompt phase): returns the
   * project facts and corpus inventory the model must see. Failures here are
   * non-fatal — the base prompt is used instead.
   */
  readonly describeSession?: (session: SessionContext) => string;
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly fetchImplementation?: typeof fetch;
}

/** Convert the compiled tool registry into OpenAI function definitions. */
export function buildToolDefinitions(): ChatToolDefinition[] {
  return (
    Object.keys(agentToolArgumentsSchemas) as (keyof typeof agentToolArgumentsSchemas)[]
  ).map((name) => ({
    type: "function",
    function: {
      name: name.replace(".", "__"),
      description: TOOL_DESCRIPTIONS[name],
      parameters: z.toJSONSchema(agentToolArgumentsSchemas[name], {
        target: "draft-7",
      }) as Record<string, unknown>,
    },
  }));
}

function wireToolName(functionName: string): string {
  return functionName.replace("__", ".");
}

function extractText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * Harness-style deriveMessages(): rebuild the model-visible context purely
 * from the durable session event stream. Compaction summaries replace the
 * events they cover.
 */
export function deriveMessages(
  events: readonly Pick<SessionEvent, "type" | "payload">[],
  systemPrompt: string,
): ChatMessage[] {
  let turns: ChatMessage[] = [];
  for (const event of events) {
    if (event.type === "message.user") {
      const text =
        extractText(event.payload.message) ||
        (typeof event.payload.content === "string" ? event.payload.content : "");
      if (text) turns.push({ role: "user", content: text });
    } else if (event.type === "message.assistant.completed") {
      const text = extractText(event.payload.message);
      if (text) turns.push({ role: "assistant", content: text });
    } else if (
      event.type === "compaction.completed" &&
      typeof event.payload.summary === "string" &&
      event.payload.summary
    ) {
      turns = [
        {
          role: "user",
          content: `（历史对话摘要）\n${event.payload.summary}`,
        },
        { role: "assistant", content: "已了解此前对话的摘要，请继续。" },
      ];
    }
  }
  return [{ role: "system", content: systemPrompt }, ...turns];
}

/**
 * In-process agent loop on the harness architecture: context derives from
 * the durable event stream, tool calls flow through the unified tool
 * pipeline (monotonic guards + intent-before-effect journal appends), and
 * every model-visible step is emitted as durable agent events. Replaces the
 * Pi worker child process.
 */
export class HarnessAgentRuntime implements AgentWorkerPort {
  readonly #sessions = new Map<string, SessionContext>();
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #steering = new Map<string, string[]>();
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #options: HarnessAgentRuntimeOptions;
  #toolHandler: AgentToolRequestHandler | undefined;
  #modelGateway: ModelGatewayCapability | undefined;
  #stopped = false;

  constructor(options: HarnessAgentRuntimeOptions) {
    this.#options = options;
  }

  public setToolHandler(handler: AgentToolRequestHandler | undefined): void {
    this.#toolHandler = handler;
  }

  /**
   * Route every model call through the commit-before-send gateway. Until
   * this is bound the loop falls back to the direct client (kill switch).
   */
  public setModelGateway(gateway: ModelGatewayCapability | undefined): void {
    this.#modelGateway = gateway;
  }

  /** Transport endpoint for a live session; used by the provider adapter. */
  public endpointForSession(sessionId: string): ChatModelEndpoint {
    const session = this.#requireSession(sessionId);
    const endpoint = this.#options.resolveEndpoint(session);
    return { ...endpoint, model: this.#modelFor(session) };
  }

  public async start(input: StartAgentSessionInput): Promise<void> {
    if (this.#stopped) throw new Error("Agent runtime is stopped");
    this.#sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      tenantNamespace: input.tenant.dataNamespace,
      projectId: input.projectId,
      workspace: input.workspace,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.modelGatewayAccess === undefined
        ? {}
        : { modelGatewayAccess: input.modelGatewayAccess }),
    });
  }

  public async prompt(
    sessionId: string,
    operationId: string,
    content: string,
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    if (this.#turns.has(sessionId)) {
      throw new Error("Session already has an active turn");
    }
    const abort = new AbortController();
    const done = this.#runTurn(session, operationId, content, abort.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#turns.delete(sessionId);
      });
    this.#turns.set(sessionId, { operationId, abort, done });
  }

  public async steer(sessionId: string, content: string): Promise<void> {
    this.#requireSession(sessionId);
    const queue = this.#steering.get(sessionId) ?? [];
    queue.push(content);
    this.#steering.set(sessionId, queue);
  }

  public async interrupt(sessionId: string): Promise<void> {
    const turn = this.#turns.get(sessionId);
    if (turn === undefined) return;
    turn.abort.abort();
    await turn.done;
  }

  public async compact(
    sessionId: string,
    customInstructions?: string,
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    this.#emit(sessionId, null, "compaction.started", { reason: "manual" });
    void (async () => {
      try {
        const derived = this.#deriveSessionMessages(session);
        const summaryRequest: ChatMessage[] = [
          ...derived.messages,
          {
            role: "user",
            content:
              customInstructions?.trim() ||
              "请把以上对话压缩成一段忠实的中文摘要，保留全部结论、数字区间与未决事项。只输出摘要。",
          },
        ];
        const { text: summary } = await this.#streamStep({
          session,
          operationId: null,
          turnId: newId("turn"),
          stepId: newId("step"),
          messages: summaryRequest,
          journalThroughSequence: derived.throughSequence,
        });
        this.#emit(sessionId, null, "compaction.completed", { summary });
      } catch (error) {
        this.#emit(sessionId, null, "compaction.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  public async dispose(sessionId: string): Promise<void> {
    await this.interrupt(sessionId);
    this.#sessions.delete(sessionId);
    this.#steering.delete(sessionId);
  }

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    const pending = [...this.#turns.values()];
    for (const turn of pending) turn.abort.abort();
    await Promise.all(pending.map((turn) => turn.done));
    this.#sessions.clear();
    this.#steering.clear();
  }

  /* ---------------- internals ---------------- */

  #requireSession(sessionId: string): SessionContext {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Agent session ${sessionId} is not started`);
    }
    return session;
  }

  #modelFor(session: SessionContext): string {
    return (
      session.modelGatewayAccess?.model.id ??
      session.model ??
      this.#options.resolveEndpoint(session).model
    );
  }

  #deriveSessionMessages(session: SessionContext): {
    messages: ChatMessage[];
    throughSequence: number;
  } {
    const replay =
      this.#options.replayEvents ??
      ((tenantNamespace: string, sessionId: string, after: number, limit: number) =>
        this.#options.sessionEvents.replayForTenant(
          tenantNamespace,
          sessionId,
          after,
          limit,
        ));
    const events: Pick<SessionEvent, "type" | "payload">[] = [];
    let after = 0;
    for (;;) {
      const batch = replay(
        session.tenantNamespace,
        session.sessionId,
        after,
        1_000,
      );
      if (batch.length === 0) break;
      events.push(...batch);
      after = batch[batch.length - 1]!.sequence;
      if (batch.length < 1_000 || events.length >= MAX_HISTORY_EVENTS) break;
    }
    return {
      messages: deriveMessages(events, this.#systemPromptFor(session)),
      throughSequence: after,
    };
  }

  /**
   * One model step. With a gateway bound this is the commit-before-send
   * path: the exact request body is journaled before any network send and
   * every provider event is persisted for replay. Without one it falls
   * back to the direct client.
   */
  async #streamStep(input: {
    session: SessionContext;
    operationId: string | null;
    turnId: string;
    stepId: string;
    messages: readonly ChatMessage[];
    tools?: readonly ChatToolDefinition[];
    journalThroughSequence: number;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<{ text: string; toolCalls: ChatToolCall[] }> {
    const model = this.#modelFor(input.session);
    if (this.#modelGateway === undefined) {
      let text = "";
      let toolCalls: ChatToolCall[] = [];
      for await (const event of streamChatCompletion(
        this.#options.resolveEndpoint(input.session),
        {
          model,
          messages: input.messages,
          ...(input.tools === undefined ? {} : { tools: input.tools }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        this.#options.fetchImplementation,
      )) {
        if (event.type === "delta") {
          text += event.text;
          input.onDelta?.(event.text);
        } else {
          toolCalls = [...event.toolCalls];
        }
      }
      return { text, toolCalls };
    }

    const gateway = this.#modelGateway.forTenant(input.session.tenantNamespace);
    const draft = buildModelRequestDraft({
      sessionId: input.session.sessionId,
      operationId: input.operationId,
      turnId: input.turnId,
      stepId: input.stepId,
      model,
      messages: input.messages,
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      journalThroughSequence: input.journalThroughSequence,
    });
    let text = "";
    const toolCalls: ChatToolCall[] = [];
    for await (const event of gateway.stream(draft, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })) {
      switch (event.type) {
        case "delta":
          if (event.channel === "text") {
            text += event.delta;
            input.onDelta?.(event.delta);
          }
          break;
        case "tool_call":
          toolCalls.push({
            id: event.toolCallId,
            type: "function",
            function: {
              name: event.name,
              arguments: JSON.stringify(event.arguments),
            },
          });
          break;
        case "error":
          throw new Error(`Model provider error (${event.code}): ${event.message}`);
        case "aborted":
          throw new Error(`Model request aborted: ${event.reason}`);
        case "usage":
        case "final":
          break;
      }
    }
    return { text, toolCalls };
  }

  #systemPromptFor(session: SessionContext): string {
    const base = this.#options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    try {
      const description = this.#options.describeSession?.(session);
      return description ? `${base}\n\n${description}` : base;
    } catch {
      return base;
    }
  }

  #emit(
    sessionId: string,
    operationId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const event: AgentEvent = {
      type: "agent.event",
      sessionId,
      operationId,
      eventType,
      payload,
    };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }

  async #runTurn(
    session: SessionContext,
    operationId: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = session.sessionId;
    try {
      // Context = durable event stream (message.user for this prompt was
      // persisted by the session service before prompt(), so drop the tail
      // duplicate if present and re-append the live content).
      const derived = this.#deriveSessionMessages(session);
      const history = derived.messages;
      const last = history[history.length - 1];
      if (last?.role === "user" && last.content === content) history.pop();
      const messages: ChatMessage[] = [...history, { role: "user", content }];
      const tools = buildToolDefinitions();
      const turnId = newId("turn");
      let turnText = "";

      const maxSteps = this.#options.maxSteps ?? MAX_STEPS;
      for (let step = 0; step < maxSteps; step += 1) {
        // Spend the last step answering: withholding the tools forces prose
        // instead of the turn ending mid-investigation.
        const finalStep = step === maxSteps - 1;
        if (finalStep) {
          messages.push({
            role: "user",
            content:
              "工具调用已达上限。请立即基于以上已获得的证据给出完整结论，并引用来源；不要再请求工具。",
          });
        }
        const steering = this.#steering.get(sessionId) ?? [];
        this.#steering.delete(sessionId);
        for (const extra of steering) {
          messages.push({ role: "user", content: extra });
        }

        const { text: stepText, toolCalls } = await this.#streamStep({
          session,
          operationId,
          turnId,
          stepId: newId("step"),
          messages,
          ...(finalStep ? {} : { tools }),
          journalThroughSequence: derived.throughSequence,
          signal,
          onDelta: (delta) => {
            turnText += delta;
            this.#emit(sessionId, operationId, "message.assistant.delta", {
              delta,
            });
          },
        });

        if (toolCalls.length === 0 || finalStep) {
          // The durable answer is the final step's text: intermediate
          // narration already streamed as deltas, and folding it into the
          // completed message would replay it into every later turn.
          this.#emit(sessionId, operationId, "message.assistant.completed", {
            message: {
              role: "assistant",
              content: [{ type: "text", text: stepText || turnText }],
            },
          });
          this.#emit(sessionId, operationId, "session.status", {
            status: "idle",
          });
          return;
        }

        messages.push({
          role: "assistant",
          content: stepText || null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          const toolName = wireToolName(call.function.name);
          let parsedArguments: Record<string, unknown> = {};
          try {
            parsedArguments = JSON.parse(call.function.arguments) as Record<
              string,
              unknown
            >;
          } catch {
            parsedArguments = {};
          }
          this.#emit(sessionId, operationId, "tool.started", {
            toolCallId: call.id,
            toolName,
            arguments: parsedArguments,
          });
          const request: AgentToolRequestMessage = {
            type: "tool.request",
            protocolVersion: AGENT_TOOL_PROTOCOL_VERSION,
            requestId: newId("toolreq"),
            sessionId,
            toolCallId: call.id,
            tool: toolName as AgentToolRequestMessage["tool"],
            arguments: parsedArguments,
            deadlineAt: new Date(Date.now() + 120_000).toISOString(),
          };
          let resultPayload: string;
          try {
            if (this.#toolHandler === undefined) {
              throw new Error("No tool handler installed");
            }
            const result = await this.#toolHandler.execute(request, signal);
            this.#emit(sessionId, operationId, "tool.completed", {
              toolCallId: call.id,
              toolName,
              result: result ?? null,
              isError: false,
            });
            resultPayload = JSON.stringify(result ?? null);
          } catch (error) {
            if (signal.aborted) throw error;
            const message =
              error instanceof Error ? error.message : String(error);
            this.#emit(sessionId, operationId, "tool.failed", {
              toolCallId: call.id,
              toolName,
              result: { error: message },
              isError: true,
            });
            resultPayload = JSON.stringify({ error: message });
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              resultPayload.length > MAX_TOOL_RESULT_CHARS
                ? `${resultPayload.slice(0, MAX_TOOL_RESULT_CHARS)}…(truncated)`
                : resultPayload,
          });
        }
      }

      // Unreachable while the final step answers, kept as a safety net.
      this.#emit(sessionId, operationId, "message.assistant.completed", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: turnText || "（已达到本轮步骤上限）" }],
        },
      });
      this.#emit(sessionId, operationId, "session.status", { status: "idle" });
    } catch (error) {
      if (signal.aborted) {
        this.#emit(sessionId, operationId, "operation.interrupted", {});
        return;
      }
      this.#emit(sessionId, operationId, "operation.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
