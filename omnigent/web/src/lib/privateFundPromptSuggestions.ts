import type { PrivateFundAsset, PrivateFundFile } from "./privateFundApi";

export type PrivateFundPromptSuggestionStage =
  | "plan"
  | "understand"
  | "compare"
  | "verify"
  | "risk"
  | "output";

export interface PrivateFundPromptSuggestion {
  id: string;
  title: string;
  prompt: string;
  stage: PrivateFundPromptSuggestionStage;
}

export interface PrivateFundPromptSuggestionContext {
  companyName?: string | null;
  files: PrivateFundFile[];
  assets: PrivateFundAsset[];
  recentUserMessages?: string[];
  limit?: number;
}

type DocumentType =
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

type SuggestionTemplate = PrivateFundPromptSuggestion & {
  priority: number;
  requiresAll?: DocumentType[];
  requiresAny?: DocumentType[];
  minDocuments?: number;
  minDocumentTypes?: number;
  requiresAnalysis?: boolean;
  requiresMemo?: boolean;
  forbidsMemo?: boolean;
  historyTerms: string[];
};

const PRIMARY_DOCUMENT_TYPES = new Set<DocumentType>([
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

function normalizeDocumentType(file: PrivateFundFile): DocumentType {
  const rawType = String(file.docType || file.docSubtype || "").toLowerCase();
  if (PRIMARY_DOCUMENT_TYPES.has(rawType as DocumentType)) return rawType as DocumentType;
  if (DOCUMENT_TYPE_ALIASES[rawType]) return DOCUMENT_TYPE_ALIASES[rawType];

  const rawSubtype = String(file.docSubtype || "").toLowerCase();
  if (DOCUMENT_TYPE_ALIASES[rawSubtype]) return DOCUMENT_TYPE_ALIASES[rawSubtype];

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

function companyLabel(companyName: string | null | undefined): string {
  return companyName?.trim() || "当前公司";
}

function suggestionTemplates(company: string): SuggestionTemplate[] {
  return [
    {
      id: "full_investment_view",
      title: "形成完整投资判断",
      prompt: `综合财报、会议纪要和估值模型，形成${company}当前的核心投资逻辑、关键催化剂、主要风险和待验证问题。`,
      stage: "understand",
      priority: 130,
      requiresAll: ["financial_report", "meeting_minutes", "valuation_model"],
      historyTerms: ["投资逻辑", "催化剂", "风险"],
    },
    {
      id: "financial_meeting_compare",
      title: "对比会议口径与财报",
      prompt: `对比${company}最新会议纪要中的管理层口径与财报数据，找出新增信息、口径变化和需要继续验证的问题。`,
      stage: "compare",
      priority: 116,
      requiresAll: ["financial_report", "meeting_minutes"],
      historyTerms: ["会议", "财报", "对比"],
    },
    {
      id: "financial_model_check",
      title: "核对模型与财报",
      prompt: `核对${company}估值模型中的历史数据与最新财报是否一致，并评估未来收入、利润率和现金流预测是否合理。`,
      stage: "verify",
      priority: 115,
      requiresAll: ["financial_report", "valuation_model"],
      historyTerms: ["模型", "财报", "核对"],
    },
    {
      id: "meeting_model_update",
      title: "用最新指引检查模型",
      prompt: `根据${company}最新会议纪要中的经营指引，检查估值模型需要调整的收入、毛利率、费用率和估值假设。`,
      stage: "verify",
      priority: 112,
      requiresAll: ["meeting_minutes", "valuation_model"],
      historyTerms: ["会议", "模型", "指引"],
    },
    {
      id: "cross_document_conflicts",
      title: "检查资料冲突",
      prompt: `检查${company}当前资料之间是否存在数据冲突、统计口径差异或前后表述不一致，并判断哪些问题需要人工复核。`,
      stage: "risk",
      priority: 109,
      minDocuments: 2,
      minDocumentTypes: 2,
      historyTerms: ["冲突", "口径", "不一致"],
    },
    {
      id: "update_existing_memo",
      title: "更新现有 Memo",
      prompt: `结合最新资料和已有研究成果，更新${company}投资 Memo，重点说明新增证据、结论变化和仍未解决的问题。`,
      stage: "output",
      priority: 114,
      minDocuments: 1,
      requiresMemo: true,
      historyTerms: ["更新", "memo"],
    },
    {
      id: "generate_investment_memo",
      title: "生成投资 Memo",
      prompt: `基于当前资料生成${company}投资 Memo，覆盖投资逻辑、财务表现、估值、催化剂、风险和待验证问题。`,
      stage: "output",
      priority: 113,
      minDocuments: 2,
      forbidsMemo: true,
      historyTerms: ["生成", "memo"],
    },
    {
      id: "financial_summary",
      title: "梳理最新财报变化",
      prompt: `总结${company}最新财报的核心变化，重点分析收入、利润、毛利率、经营现金流及其主要驱动因素。`,
      stage: "understand",
      priority: 92,
      requiresAny: ["financial_report", "earnings_release"],
      historyTerms: ["财报", "收入", "利润"],
    },
    {
      id: "meeting_guidance",
      title: "提炼会议新增信息",
      prompt: `提取${company}最新会议纪要中的经营指引、量化目标、时间节点、管理层判断和风险提示。`,
      stage: "understand",
      priority: 94,
      requiresAny: ["meeting_minutes"],
      historyTerms: ["会议", "指引", "管理层"],
    },
    {
      id: "valuation_assumptions",
      title: "检查估值模型假设",
      prompt: `解释${company}估值模型的核心假设和目标价计算过程，并找出对估值结果最敏感的变量。`,
      stage: "verify",
      priority: 96,
      requiresAny: ["valuation_model"],
      historyTerms: ["估值", "假设", "目标价"],
    },
    {
      id: "research_report_consensus",
      title: "提取研报分歧",
      prompt: `整理关于${company}的盈利预测、评级和目标价假设，并识别不同研究观点之间的关键分歧。`,
      stage: "compare",
      priority: 91,
      requiresAny: ["research_report"],
      historyTerms: ["研报", "目标价", "分歧"],
    },
    {
      id: "verify_existing_findings",
      title: "继续验证已有结论",
      prompt: `复核${company}已有研究结论，区分已经获得充分支持的判断、存在反证的判断和仍缺少资料的判断。`,
      stage: "risk",
      priority: 103,
      requiresAnalysis: true,
      historyTerms: ["复核", "结论", "反证"],
    },
    {
      id: "project_overview",
      title: "建立项目资料概览",
      prompt: `梳理${company}当前项目中的资料和已有研究成果，给出最值得优先回答的五个投资问题。`,
      stage: "plan",
      priority: 68,
      minDocuments: 1,
      historyTerms: ["资料", "投资问题"],
    },
    {
      id: "empty_project_plan",
      title: "制定研究框架",
      prompt: `为${company}建立一套投资研究框架，并列出完成财务、业务、估值和风险分析还需要补充的资料。`,
      stage: "plan",
      priority: 80,
      historyTerms: ["研究框架", "补充", "资料"],
    },
  ];
}

function wasRecentlyAsked(template: SuggestionTemplate, messages: string[]): boolean {
  const terms = template.historyTerms.map(normalizeText).filter(Boolean);
  return messages.some((message) => {
    const normalized = normalizeText(message);
    if (!normalized) return false;
    const matchCount = terms.filter((term) => normalized.includes(term)).length;
    return matchCount >= Math.min(2, terms.length);
  });
}

export function generatePrivateFundPromptSuggestions({
  companyName,
  files,
  assets,
  recentUserMessages = [],
  limit = 4,
}: PrivateFundPromptSuggestionContext): PrivateFundPromptSuggestion[] {
  if (limit <= 0) return [];

  const usableFiles = files.filter((file) => !UNUSABLE_FILE_STATUSES.has(file.status));
  const documentTypes = new Set(usableFiles.map(normalizeDocumentType));
  documentTypes.delete("unknown");
  const hasMemo = assets.some((asset) => ["memo", "report"].includes(asset.assetType));
  const hasAnalysis = assets.some(
    (asset) => !["document", "memo", "report"].includes(asset.assetType),
  );
  const templates = suggestionTemplates(companyLabel(companyName));

  const candidates = templates
    .filter((template) => {
      if (template.id === "empty_project_plan") return usableFiles.length === 0;
      if (usableFiles.length === 0) return false;
      if (template.requiresAll?.some((type) => !documentTypes.has(type))) return false;
      if (template.requiresAny && !template.requiresAny.some((type) => documentTypes.has(type))) {
        return false;
      }
      if ((template.minDocuments ?? 0) > usableFiles.length) return false;
      if ((template.minDocumentTypes ?? 0) > documentTypes.size) return false;
      if (template.requiresAnalysis && !hasAnalysis) return false;
      if (template.requiresMemo && !hasMemo) return false;
      if (template.forbidsMemo && hasMemo) return false;
      return true;
    })
    .map((template, index) => {
      let score = template.priority;
      if (template.requiresAll && template.requiresAll.length >= 2) score += 8;
      if (hasAnalysis && ["risk", "output"].includes(template.stage)) score += 6;
      if (wasRecentlyAsked(template, recentUserMessages)) score -= 100;
      return { template, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: typeof candidates = [];
  const selectedStages = new Set<PrivateFundPromptSuggestionStage>();

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selectedStages.has(candidate.template.stage)) continue;
    selected.push(candidate);
    selectedStages.add(candidate.template.stage);
  }
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selected.some((item) => item.template.id === candidate.template.id)) continue;
    selected.push(candidate);
  }

  return selected
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ template }) => ({
      id: template.id,
      title: template.title,
      prompt: template.prompt,
      stage: template.stage,
    }));
}
