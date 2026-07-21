/**
 * Context-aware prompt suggestions for private-fund research chat.
 *
 * Design (common agent UX patterns: ChatGPT starters + follow-ups,
 * Cursor/workspace empty-states, research copilots):
 * 1. Detect the *situation* from project docs, notes, and recent turns.
 * 2. Prefer *dynamic* chips that name real files / notes / last topics.
 * 3. Fall back to ranked templates so cold projects still have guidance.
 * 4. Deprioritize recently asked intents; diversify stages.
 *
 * Pure client-side rules — no network, sub-ms, deterministic for tests.
 */

import type { PrivateFundAsset, PrivateFundFile } from "./privateFundApi";

export type PrivateFundPromptSuggestionStage =
  | "plan"
  | "understand"
  | "compare"
  | "verify"
  | "risk"
  | "output"
  | "follow_up";

export type PrivateFundSituation =
  | "empty"
  | "docs_only"
  | "mid_conversation"
  | "has_notes"
  | "has_memo"
  | "context_selected";

export interface PrivateFundPromptSuggestion {
  id: string;
  title: string;
  prompt: string;
  stage: PrivateFundPromptSuggestionStage;
  /** Why this chip appeared — for UI/debug, optional. */
  reason?: string;
}

export interface PrivateFundPromptSuggestionContext {
  companyName?: string | null;
  files: PrivateFundFile[];
  assets: PrivateFundAsset[];
  recentUserMessages?: string[];
  /** Last assistant message texts (markdown ok); used for follow-ups. */
  recentAssistantMessages?: string[];
  /** Asset ids currently in the research context chips. */
  contextAssetIds?: string[];
  limit?: number;
}

type DocumentType =
  | "financial_valuation_data"
  | "meeting_third_party"
  | "financial_report"
  | "earnings_release"
  | "meeting_minutes"
  | "valuation_model"
  | "research_report"
  | "investor_presentation"
  | "regulatory_announcement"
  | "financial_dataset"
  | "company_material"
  | "other"
  | "unknown";

type ScoredSuggestion = PrivateFundPromptSuggestion & {
  priority: number;
  source: "dynamic" | "template";
};

const PRIMARY_DOCUMENT_TYPES = new Set<DocumentType>([
  "financial_valuation_data",
  "meeting_third_party",
  "financial_report",
  "earnings_release",
  "meeting_minutes",
  "valuation_model",
  "research_report",
  "investor_presentation",
  "regulatory_announcement",
  "financial_dataset",
  "company_material",
  "other",
  "unknown",
]);

const DOCUMENT_TYPE_ALIASES: Record<string, DocumentType> = {
  annual_report: "financial_report",
  interim_report: "financial_report",
  quarterly_report: "financial_report",
  preliminary_results: "earnings_release",
  results_announcement: "earnings_release",
  earnings_call: "meeting_minutes",
  research_meeting: "meeting_minutes",
  expert_interview: "meeting_minutes",
  internal_meeting: "meeting_minutes",
  meeting_transcript: "meeting_minutes",
  research_qa_note: "meeting_minutes",
  dcf_model: "valuation_model",
  comparable_company_model: "valuation_model",
  financial_forecast_model: "valuation_model",
  integrated_valuation_model: "valuation_model",
  structured_table: "financial_dataset",
  research_presentation: "investor_presentation",
  research_document: "company_material",
  research_note: "other",
  document: "other",
};

const UNUSABLE_FILE_STATUSES = new Set(["failed", "unsupported", "removed", "superseded"]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

function companyLabel(companyName: string | null | undefined): string {
  return companyName?.trim() || "当前公司";
}

function shortName(name: string, max = 22): string {
  const base = name.replace(/\.[^.]+$/, "").trim() || name;
  return base.length <= max ? base : `${base.slice(0, max - 1)}…`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDocumentType(file: PrivateFundFile): DocumentType {
  const rawSubtype = String(file.docSubtype || "").toLowerCase();
  if (DOCUMENT_TYPE_ALIASES[rawSubtype]) return DOCUMENT_TYPE_ALIASES[rawSubtype];

  const rawType = String(file.docType || "").toLowerCase();
  if (DOCUMENT_TYPE_ALIASES[rawType]) return DOCUMENT_TYPE_ALIASES[rawType];
  if (PRIMARY_DOCUMENT_TYPES.has(rawType as DocumentType)) return rawType as DocumentType;

  const name = normalizeText(file.name);
  if (/年度报告|年报|季度报告|季报|半年度报告|半年报|annualreport|10k|10q/.test(name)) {
    return "financial_report";
  }
  if (/业绩预告|业绩快报|业绩公告|earningsrelease|resultsannouncement/.test(name)) {
    return "earnings_release";
  }
  if (/会议纪要|交流会|调研纪要|电话会|问答|访谈|transcript|meetingminutes/.test(name)) {
    return "meeting_minutes";
  }
  if (/估值|模型|dcf|wacc|targetprice|valuation/.test(name)) return "valuation_model";
  if (/研报|研究报告|researchreport/.test(name)) return "research_report";
  if (/路演|投资者演示|investorday|roadshow|presentation/.test(name)) {
    return "investor_presentation";
  }
  if (/公告|监管|announcement|filing/.test(name)) return "regulatory_announcement";
  if (["csv"].includes(file.fileType.toLowerCase())) return "financial_dataset";
  if (["xlsx", "xls", "xlsm"].includes(file.fileType.toLowerCase())) {
    return "financial_dataset";
  }
  return "unknown";
}

function usableFiles(files: PrivateFundFile[]): PrivateFundFile[] {
  return files.filter((file) => !UNUSABLE_FILE_STATUSES.has(file.status));
}

function filesOfType(files: PrivateFundFile[], type: DocumentType): PrivateFundFile[] {
  return files.filter((file) => normalizeDocumentType(file) === type);
}

function analysisAssets(assets: PrivateFundAsset[]): PrivateFundAsset[] {
  return assets.filter(
    (asset) =>
      !["document", "memo", "report"].includes(asset.assetType) && asset.status !== "failed",
  );
}

function memoAssets(assets: PrivateFundAsset[]): PrivateFundAsset[] {
  return assets.filter((asset) => ["memo", "report"].includes(asset.assetType));
}

function detectSituation(ctx: {
  files: PrivateFundFile[];
  assets: PrivateFundAsset[];
  recentUserMessages: string[];
  contextAssetIds: string[];
}): PrivateFundSituation {
  if (ctx.files.length === 0) return "empty";
  if (ctx.contextAssetIds.length > 0) return "context_selected";
  if (memoAssets(ctx.assets).length > 0) return "has_memo";
  if (analysisAssets(ctx.assets).length > 0) return "has_notes";
  if (ctx.recentUserMessages.length > 0) return "mid_conversation";
  return "docs_only";
}

/** Pull a short topic phrase from the last user turn. */
function topicFromUserMessage(message: string): string | null {
  const clean = stripMarkdown(message)
    .replace(/^当前会话必须基于[\s\S]*?禁止[^\n]*\n?/g, "")
    .replace(/dataset_id:\s*\S+/gi, "")
    .trim();
  if (!clean) return null;
  // Prefer first non-meta sentence / clause.
  const parts = clean.split(/[。！？\n]/).filter(Boolean);
  const clause = (parts[0] ?? clean).trim() || clean;
  if (clause.length < 4) return null;
  if (clause.length <= 36) return clause;
  return `${clause.slice(0, 35)}…`;
}

/** Open questions often appear as bullet lines in assistant answers. */
function openQuestionsFromAssistant(text: string): string[] {
  const clean = stripMarkdown(text);
  if (!clean) return [];
  const lines = text.split(/\n+/);
  const found: string[] = [];
  for (const line of lines) {
    const m = line.match(
      /^(?:[-*•]|\d+[.)、])\s*(?:待验证|待核实|待确认|下一步|需要|风险|疑问)?[：:]?\s*(.+)$/,
    );
    if (m?.[1]) {
      const q = stripMarkdown(m[1])
        .replace(/[。；;]+$/, "")
        .trim();
      if (q.length >= 6 && q.length <= 48) found.push(q);
    }
    if (found.length >= 3) break;
  }
  // Fallback: sentences containing 待验证 / 不确定
  if (found.length === 0) {
    const hits = clean.match(/[^。！？]{4,40}(?:待验证|待核实|资料未覆盖|不确定)[^。！？]{0,20}/g);
    if (hits) {
      for (const h of hits.slice(0, 2)) found.push(h.trim());
    }
  }
  return found;
}

function recentlyAsked(terms: string[], messages: string[]): boolean {
  const normalizedTerms = terms.map(normalizeText).filter(Boolean);
  if (normalizedTerms.length === 0) return false;
  return messages.some((message) => {
    const normalized = normalizeText(message);
    if (!normalized) return false;
    const matchCount = normalizedTerms.filter((term) => normalized.includes(term)).length;
    return matchCount >= Math.min(2, normalizedTerms.length);
  });
}

function buildDynamicSuggestions(
  company: string,
  files: PrivateFundFile[],
  assets: PrivateFundAsset[],
  recentUserMessages: string[],
  recentAssistantMessages: string[],
  contextAssetIds: string[],
  situation: PrivateFundSituation,
): ScoredSuggestion[] {
  const out: ScoredSuggestion[] = [];
  const types = new Set(files.map(normalizeDocumentType));
  types.delete("unknown");

  const lastUser = recentUserMessages[recentUserMessages.length - 1] ?? "";
  const topic = topicFromUserMessage(lastUser);
  const lastAssistant = recentAssistantMessages[recentAssistantMessages.length - 1] ?? "";
  const openQs = openQuestionsFromAssistant(lastAssistant);

  // --- Conversation follow-ups (highest priority mid-chat) ---
  if (topic && recentUserMessages.length > 0) {
    out.push({
      id: "dyn_continue_topic",
      title: "继续刚才的问题",
      prompt: `继续围绕「${topic}」深入分析${company}：补充关键证据、量化口径，并明确仍缺少的资料。`,
      stage: "follow_up",
      priority: 160,
      source: "dynamic",
      reason: "基于最近用户提问",
    });
    if (!recentlyAsked(["反证", "风险", "反方"], recentUserMessages)) {
      out.push({
        id: "dyn_counter_topic",
        title: "找反证与风险",
        prompt: `针对刚才关于「${topic}」的讨论，列出${company}最重要的反证、风险情景和需要再核验的数字。`,
        stage: "risk",
        priority: 148,
        source: "dynamic",
        reason: "对话跟进",
      });
    }
  }

  for (const [index, q] of openQs.slice(0, 2).entries()) {
    out.push({
      id: `dyn_open_q_${index}`,
      title: q.length > 14 ? `${q.slice(0, 13)}…` : q,
      prompt: `请优先回答并核验证据：${q}（公司：${company}）。资料不足时明确标注“资料未覆盖/待复核”。`,
      stage: "follow_up",
      priority: 155 - index,
      source: "dynamic",
      reason: "来自上一轮回答中的待办/风险",
    });
  }

  // --- Real document chips ---
  const report =
    filesOfType(files, "financial_report")[0] ?? filesOfType(files, "earnings_release")[0];
  const meeting = filesOfType(files, "meeting_minutes")[0];
  const model = filesOfType(files, "valuation_model")[0];
  const research = filesOfType(files, "research_report")[0];

  if (report) {
    out.push({
      id: "dyn_read_report",
      title: `精读「${shortName(report.name, 12)}」`,
      prompt: `精读资料「${report.name}」，总结${company}最新业绩的核心变化（收入、利润、毛利率、现金流）及驱动因素，关键数字必须带 citation。`,
      stage: "understand",
      priority: situation === "docs_only" ? 140 : 120,
      source: "dynamic",
      reason: "项目中有财报/业绩资料",
    });
  }
  if (meeting) {
    out.push({
      id: "dyn_read_meeting",
      title: `提炼「${shortName(meeting.name, 12)}」`,
      prompt: `从「${meeting.name}」提取${company}的经营指引、量化目标、时间节点与管理层风险提示，并与已有财务数据对照。`,
      stage: "understand",
      priority: situation === "docs_only" ? 138 : 118,
      source: "dynamic",
      reason: "项目中有会议纪要",
    });
  }
  if (model) {
    out.push({
      id: "dyn_read_model",
      title: `检查「${shortName(model.name, 12)}」`,
      prompt: `解读估值模型「${model.name}」的关键假设、历史拟合与目标价敏感变量；指出与最新资料可能不一致之处。`,
      stage: "verify",
      priority: 134,
      source: "dynamic",
      reason: "项目中有估值模型",
    });
  }
  if (report && meeting) {
    out.push({
      id: "dyn_compare_report_meeting",
      title: "会议 vs 财报口径",
      prompt: `对比${company}「${meeting.name}」中的管理层口径与「${report.name}」中的财务数据，标出新增信息、口径变化和待验证点。`,
      stage: "compare",
      priority: 145,
      source: "dynamic",
      reason: "同时具备会议与财报",
    });
  }
  if (report && model) {
    out.push({
      id: "dyn_check_model_vs_report",
      title: "模型 vs 财报核对",
      prompt: `用「${report.name}」核对${company}「${model.name}」中的历史数据与预测是否合理，列出需要修正的假设。`,
      stage: "verify",
      priority: 143,
      source: "dynamic",
      reason: "同时具备财报与模型",
    });
  }
  if (meeting && model) {
    out.push({
      id: "dyn_guidance_into_model",
      title: "用指引校准模型",
      prompt: `根据「${meeting.name}」的最新指引，检查${company}「${model.name}」中收入、毛利率、费用与估值假设是否需要调整。`,
      stage: "verify",
      priority: 141,
      source: "dynamic",
      reason: "同时具备会议与模型",
    });
  }
  if (research) {
    out.push({
      id: "dyn_research_view",
      title: `对照「${shortName(research.name, 12)}」`,
      prompt: `整理「${research.name}」对${company}的盈利预测、评级与目标价逻辑，并与本地其他资料交叉验证分歧点。`,
      stage: "compare",
      priority: 112,
      source: "dynamic",
      reason: "项目中有研报",
    });
  }

  // --- Notes / memo / context chips ---
  const notes = analysisAssets(assets);
  const memos = memoAssets(assets);
  const contextAssets = assets.filter((a) => contextAssetIds.includes(a.assetId));

  if (notes.length > 0) {
    const latest = notes[0]!;
    out.push({
      id: "dyn_deepen_note",
      title: `深化「${shortName(latest.title, 12)}」`,
      prompt: `在已有研究笔记「${latest.title}」基础上继续深挖：补充证据链、量化表，并列出仍缺资料的问题。`,
      stage: "verify",
      priority: situation === "has_notes" ? 150 : 125,
      source: "dynamic",
      reason: "已有研究笔记",
    });
    out.push({
      id: "dyn_verify_notes",
      title: "复核已有结论",
      prompt: `复核${company}已有研究笔记中的关键结论，区分证据充分、存在反证与资料未覆盖三类，并给出下一步核验动作。`,
      stage: "risk",
      priority: 136,
      source: "dynamic",
      reason: "已有分析产出",
    });
  }

  if (memos.length > 0) {
    const latestMemo = memos[0]!;
    out.push({
      id: "dyn_update_memo",
      title: `更新「${shortName(latestMemo.title, 12)}」`,
      prompt: `结合最新资料更新 Memo「${latestMemo.title}」，说明结论变化、新增证据和仍未解决的问题。`,
      stage: "output",
      priority: situation === "has_memo" ? 152 : 128,
      source: "dynamic",
      reason: "已有 Memo",
    });
  } else if (files.length >= 2) {
    out.push({
      id: "dyn_gen_memo",
      title: "生成投资 Memo",
      prompt: `基于当前资料生成${company}投资 Memo，覆盖投资逻辑、财务表现、估值、催化剂、风险和待验证问题。`,
      stage: "output",
      priority: 122,
      source: "dynamic",
      reason: "资料较全且尚无 Memo",
    });
  }

  if (contextAssets.length > 0) {
    const titles = contextAssets
      .slice(0, 3)
      .map((a) => `「${shortName(a.title, 14)}」`)
      .join("、");
    out.push({
      id: "dyn_use_context",
      title: "基于已选上下文",
      prompt: `仅基于我勾选的问题上下文（${titles}${contextAssets.length > 3 ? " 等" : ""}）回答：提炼可行动结论，并指出上下文仍不足的部分。`,
      stage: "follow_up",
      priority: 158,
      source: "dynamic",
      reason: "用户已选择问题上下文",
    });
    out.push({
      id: "dyn_context_table",
      title: "上下文对比表",
      prompt: `把已选上下文整理成一张对比表（期间/指标/口径/来源），无法核验的格子标“待复核”。`,
      stage: "compare",
      priority: 146,
      source: "dynamic",
      reason: "已选上下文适合结构化输出",
    });
  }

  // --- Coverage gaps ---
  if (files.length > 0) {
    const missing: string[] = [];
    if (!types.has("financial_report") && !types.has("earnings_release"))
      missing.push("最新财报/业绩");
    if (!types.has("meeting_minutes")) missing.push("会议纪要");
    if (!types.has("valuation_model")) missing.push("估值模型");
    if (missing.length > 0 && missing.length < 3) {
      out.push({
        id: "dyn_coverage_gap",
        title: "指出资料缺口",
        prompt: `在现有资料下评估${company}的研究完整度：当前缺${missing.join("、")}时，哪些结论仍可成立、哪些必须补充资料后才能下判断？`,
        stage: "plan",
        priority: 108,
        source: "dynamic",
        reason: "资料类型不完整",
      });
    }
  }

  if (situation === "empty") {
    out.push({
      id: "dyn_empty_framework",
      title: "制定研究框架",
      prompt: `为${company}建立投资研究框架，列出财务、业务、估值、风险四条线的关键问题，以及建议优先上传的资料清单。`,
      stage: "plan",
      priority: 170,
      source: "dynamic",
      reason: "项目尚无资料",
    });
    out.push({
      id: "dyn_empty_priority_q",
      title: "五个优先问题",
      prompt: `假设只能先回答五个问题，为${company}列出最能影响投资决策的五个问题，并说明每个问题需要什么证据。`,
      stage: "plan",
      priority: 165,
      source: "dynamic",
      reason: "空项目引导",
    });
  }

  if (files.length >= 1 && types.size >= 2) {
    out.push({
      id: "dyn_full_view",
      title: "形成完整投资判断",
      prompt: `综合当前全部可用资料，形成${company}的核心投资逻辑、关键催化剂、主要风险和待验证问题；无证据处标注待复核。`,
      stage: "understand",
      priority: 132,
      source: "dynamic",
      reason: "多类型资料可用",
    });
  }

  return out;
}

function buildTemplateFallbacks(
  company: string,
  files: PrivateFundFile[],
  assets: PrivateFundAsset[],
  recentUserMessages: string[],
): ScoredSuggestion[] {
  const types = new Set(files.map(normalizeDocumentType));
  types.delete("unknown");
  const hasMemo = memoAssets(assets).length > 0;
  const hasNotes = analysisAssets(assets).length > 0;
  const n = files.length;

  const templates: Array<
    ScoredSuggestion & {
      requiresAll?: DocumentType[];
      requiresAny?: DocumentType[];
      minDocuments?: number;
      minDocumentTypes?: number;
      requiresAnalysis?: boolean;
      requiresMemo?: boolean;
      forbidsMemo?: boolean;
      historyTerms: string[];
    }
  > = [
    {
      id: "full_investment_view",
      title: "形成完整投资判断",
      prompt: `综合财报、会议纪要和估值模型，形成${company}当前的核心投资逻辑、关键催化剂、主要风险和待验证问题。`,
      stage: "understand",
      priority: 100,
      source: "template",
      requiresAll: ["financial_report", "meeting_minutes", "valuation_model"],
      historyTerms: ["投资逻辑", "催化剂", "风险"],
    },
    {
      id: "financial_meeting_compare",
      title: "对比会议口径与财报",
      prompt: `对比${company}最新会议纪要中的管理层口径与财报数据，找出新增信息、口径变化和需要继续验证的问题。`,
      stage: "compare",
      priority: 96,
      source: "template",
      requiresAll: ["financial_report", "meeting_minutes"],
      historyTerms: ["会议", "财报", "对比"],
    },
    {
      id: "financial_model_check",
      title: "核对模型与财报",
      prompt: `核对${company}估值模型中的历史数据与最新财报是否一致，并评估未来收入、利润率和现金流预测是否合理。`,
      stage: "verify",
      priority: 95,
      source: "template",
      requiresAll: ["financial_report", "valuation_model"],
      historyTerms: ["模型", "财报", "核对"],
    },
    {
      id: "meeting_model_update",
      title: "用最新指引检查模型",
      prompt: `根据${company}最新会议纪要中的经营指引，检查估值模型需要调整的收入、毛利率、费用率和估值假设。`,
      stage: "verify",
      priority: 94,
      source: "template",
      requiresAll: ["meeting_minutes", "valuation_model"],
      historyTerms: ["会议", "模型", "指引"],
    },
    {
      id: "cross_document_conflicts",
      title: "检查资料冲突",
      prompt: `检查${company}当前资料之间是否存在数据冲突、统计口径差异或前后表述不一致，并判断哪些问题需要人工复核。`,
      stage: "risk",
      priority: 90,
      source: "template",
      minDocuments: 2,
      minDocumentTypes: 2,
      historyTerms: ["冲突", "口径", "不一致"],
    },
    {
      id: "update_existing_memo",
      title: "更新现有 Memo",
      prompt: `结合最新资料和已有研究成果，更新${company}投资 Memo，重点说明新增证据、结论变化和仍未解决的问题。`,
      stage: "output",
      priority: 93,
      source: "template",
      minDocuments: 1,
      requiresMemo: true,
      historyTerms: ["更新", "memo"],
    },
    {
      id: "generate_investment_memo",
      title: "生成投资 Memo",
      prompt: `基于当前资料生成${company}投资 Memo，覆盖投资逻辑、财务表现、估值、催化剂、风险和待验证问题。`,
      stage: "output",
      priority: 92,
      source: "template",
      minDocuments: 2,
      forbidsMemo: true,
      historyTerms: ["生成", "memo"],
    },
    {
      id: "financial_summary",
      title: "梳理最新财报变化",
      prompt: `总结${company}最新财报的核心变化，重点分析收入、利润、毛利率、经营现金流及其主要驱动因素。`,
      stage: "understand",
      priority: 80,
      source: "template",
      requiresAny: ["financial_report", "earnings_release"],
      historyTerms: ["财报", "收入", "利润"],
    },
    {
      id: "meeting_guidance",
      title: "提炼会议新增信息",
      prompt: `提取${company}最新会议纪要中的经营指引、量化目标、时间节点、管理层判断和风险提示。`,
      stage: "understand",
      priority: 81,
      source: "template",
      requiresAny: ["meeting_minutes"],
      historyTerms: ["会议", "指引", "管理层"],
    },
    {
      id: "valuation_assumptions",
      title: "检查估值模型假设",
      prompt: `解释${company}估值模型的核心假设和目标价计算过程，并找出对估值结果最敏感的变量。`,
      stage: "verify",
      priority: 82,
      source: "template",
      requiresAny: ["valuation_model"],
      historyTerms: ["估值", "假设", "目标价"],
    },
    {
      id: "research_report_consensus",
      title: "提取研报分歧",
      prompt: `整理关于${company}的盈利预测、评级和目标价假设，并识别不同研究观点之间的关键分歧。`,
      stage: "compare",
      priority: 79,
      source: "template",
      requiresAny: ["research_report"],
      historyTerms: ["研报", "目标价", "分歧"],
    },
    {
      id: "verify_existing_findings",
      title: "继续验证已有结论",
      prompt: `复核${company}已有研究结论，区分已经获得充分支持的判断、存在反证的判断和仍缺少资料的判断。`,
      stage: "risk",
      priority: 88,
      source: "template",
      requiresAnalysis: true,
      historyTerms: ["复核", "结论", "反证"],
    },
    {
      id: "project_overview",
      title: "建立项目资料概览",
      prompt: `梳理${company}当前项目中的资料和已有研究成果，给出最值得优先回答的五个投资问题。`,
      stage: "plan",
      priority: 70,
      source: "template",
      minDocuments: 1,
      historyTerms: ["资料", "投资问题"],
    },
    {
      id: "empty_project_plan",
      title: "制定研究框架",
      prompt: `为${company}建立一套投资研究框架，并列出完成财务、业务、估值和风险分析还需要补充的资料。`,
      stage: "plan",
      priority: 75,
      source: "template",
      historyTerms: ["研究框架", "补充", "资料"],
    },
  ];

  return templates
    .filter((template) => {
      if (template.id === "empty_project_plan") return n === 0;
      if (n === 0) return false;
      if (template.requiresAll?.some((type) => !types.has(type))) return false;
      if (template.requiresAny && !template.requiresAny.some((type) => types.has(type))) {
        return false;
      }
      if ((template.minDocuments ?? 0) > n) return false;
      if ((template.minDocumentTypes ?? 0) > types.size) return false;
      if (template.requiresAnalysis && !hasNotes) return false;
      if (template.requiresMemo && !hasMemo) return false;
      if (template.forbidsMemo && hasMemo) return false;
      return true;
    })
    .map((template) => {
      let priority = template.priority;
      if (recentlyAsked(template.historyTerms, recentUserMessages)) priority -= 100;
      return {
        id: template.id,
        title: template.title,
        prompt: template.prompt,
        stage: template.stage,
        priority,
        source: "template" as const,
        reason: "通用研究模板",
      };
    });
}

function recentlyAskedTerms(terms: string[], messages: string[]): boolean {
  const normalizedTerms = terms.map(normalizeText).filter(Boolean);
  if (!normalizedTerms.length) return false;
  return messages.some((message) => {
    const normalized = normalizeText(message);
    if (!normalized) return false;
    const matchCount = normalizedTerms.filter((term) => normalized.includes(term)).length;
    return matchCount >= Math.min(2, normalizedTerms.length);
  });
}

function pickDiverse(candidates: ScoredSuggestion[], limit: number): ScoredSuggestion[] {
  const sorted = [...candidates].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const selected: ScoredSuggestion[] = [];
  const stages = new Set<string>();
  const ids = new Set<string>();

  const stageCount = new Map<string, number>();
  const maxPerStage = (stage: string) => (stage === "follow_up" ? 2 : 1);

  // Pass 1: prefer dynamic + diversify stages (allow 2 follow-ups)
  for (const c of sorted) {
    if (selected.length >= limit) break;
    if (ids.has(c.id)) continue;
    const count = stageCount.get(c.stage) ?? 0;
    if (count >= maxPerStage(c.stage) && c.source === "template") continue;
    if (count >= maxPerStage(c.stage) && c.source === "dynamic") continue;
    selected.push(c);
    stages.add(c.stage);
    stageCount.set(c.stage, count + 1);
    ids.add(c.id);
  }
  // Pass 2: fill remaining by score
  for (const c of sorted) {
    if (selected.length >= limit) break;
    if (ids.has(c.id)) continue;
    selected.push(c);
    ids.add(c.id);
  }
  return selected;
}

export function detectPrivateFundSituation(
  ctx: PrivateFundPromptSuggestionContext,
): PrivateFundSituation {
  const files = usableFiles(ctx.files ?? []);
  return detectSituation({
    files,
    assets: ctx.assets ?? [],
    recentUserMessages: ctx.recentUserMessages ?? [],
    contextAssetIds: ctx.contextAssetIds ?? [],
  });
}

export function generatePrivateFundPromptSuggestions({
  companyName,
  files,
  assets,
  recentUserMessages = [],
  recentAssistantMessages = [],
  contextAssetIds = [],
  limit = 4,
}: PrivateFundPromptSuggestionContext): PrivateFundPromptSuggestion[] {
  if (limit <= 0) return [];

  const company = companyLabel(companyName);
  const filesOk = usableFiles(files);
  const situation = detectSituation({
    files: filesOk,
    assets,
    recentUserMessages,
    contextAssetIds,
  });

  const dynamic = buildDynamicSuggestions(
    company,
    filesOk,
    assets,
    recentUserMessages,
    recentAssistantMessages,
    contextAssetIds,
    situation,
  ).map((item) => {
    // Soft-deprioritize if user already asked something similar
    const terms = [item.title, ...item.prompt.slice(0, 40)].join(" ");
    if (recentlyAskedTerms([item.title], recentUserMessages)) {
      return { ...item, priority: item.priority - 90 };
    }
    if (recentlyAskedTerms(item.prompt.slice(0, 12).split(/\s+/), recentUserMessages)) {
      return { ...item, priority: item.priority - 40 };
    }
    void terms;
    return item;
  });

  const templates = buildTemplateFallbacks(company, filesOk, assets, recentUserMessages);

  // Prefer dynamic; templates only fill gaps / known high-value combos
  const merged = [...dynamic, ...templates];
  const picked = pickDiverse(merged, limit);

  return picked.map(({ id, title, prompt, stage, reason }) => ({
    id,
    title,
    prompt,
    stage,
    reason,
  }));
}

/** Exported for UI/debug — human label of situation. */
export function privateFundSituationLabel(situation: PrivateFundSituation): string {
  switch (situation) {
    case "empty":
      return "空项目";
    case "docs_only":
      return "仅有资料";
    case "mid_conversation":
      return "对话进行中";
    case "has_notes":
      return "已有研究笔记";
    case "has_memo":
      return "已有 Memo";
    case "context_selected":
      return "已选上下文";
    default:
      return situation;
  }
}

// Keep type export used elsewhere
export type { DocumentType };
