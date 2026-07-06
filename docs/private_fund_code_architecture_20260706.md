# 私募 PDF Research Demo 代码架构

日期：2026-07-06

## 1. 代码目标

这套代码服务于一个最小但完整的私募研究 demo：

```text
本地 PDF
-> 原生文本抽取
-> evidence 单元
-> citation
-> QA
-> Memo draft
-> Memo PDF
-> Web / FinSagent / Omnigent 展示
```

当前设计刻意不依赖 chunk index 和数据库，目的是先验证：

- 单文件本地 PDF 能否问答。
- 回答和 Memo 是否都有稳定 citation。
- citation 是否能回到原始文件、版本、页码、段落。
- 前端能否点击来源并查看 PDF 原文。

## 2. Python 核心模块

目录：

```text
src/pdf_research_demo/
```

### 2.1 `models.py`

定义最小 evidence 数据模型：

```text
Document
DocumentVersion
EvidenceLocation
Evidence
Citation
```

设计含义：

- `Document` 表示逻辑文件。
- `DocumentVersion` 表示带 checksum 的具体文件版本。
- `EvidenceLocation` 记录 PDF 文件、页码和段落号。
- `Evidence` 是可引用的最小证据单元。
- `Citation` 是回答或 Memo section 对 Evidence 的引用关系。

这套模型是未来正式 Evidence Schema 的最小子集。

### 2.2 `store.py`

负责 PDF 入库、证据切分、简单检索和 trace。

主要流程：

```text
ingest_pdf(pdf_path, text_path?)
  -> 校验 PDF 文件
  -> 计算 checksum
  -> 生成 doc_id / version_id
  -> 使用 cached text 或 pdftotext / pypdf 抽取页面文本
  -> page text 分段
  -> 生成 Evidence(evidence_type="pdf_page_paragraph")
```

检索方式：

- 当前是轻量关键词检索。
- 支持中文问题扩展，例如“投资逻辑”“风险”“自动驾驶”“储能”等会映射到英文 filing 关键词。
- 不构建持久索引。

trace 方式：

```text
citation_id
-> Citation
-> Evidence
-> Document
-> DocumentVersion
-> EvidenceLocation
-> original_file
```

### 2.3 `demo.py`

负责业务编排：

```text
PdfResearchDemo.ingest_pdf()
PdfResearchDemo.answer_question()
PdfResearchDemo.generate_memo()
PdfResearchDemo.trace_citation()
```

QA 链路：

```text
question
-> search evidence
-> store.cite(evidence)
-> LLM answer if configured
-> extractive fallback if LLM unavailable
-> QaResult(answer, citations, needs_review)
```

Memo 链路：

```text
company/ticker
-> 固定四个 section
   - Company Overview
   - Core Thesis
   - Financial Performance
   - Risks
-> 每个 section 独立 search evidence
-> 每个 section 绑定 citations
-> LLM section drafting 或 fallback bullets
-> MemoDraft
```

LLM 输出后会做 citation 检查：

- 如果没有引用任何允许的 citation，会自动补 citation。
- 如果引用了未知 citation，会标记 `needs_review`。

### 2.4 `llm.py`

提供 OpenAI-compatible `/chat/completions` 客户端。

配置来源：

```text
环境变量：
PDF_RESEARCH_LLM_MODEL
PDF_RESEARCH_LLM_BASE_URL
PDF_RESEARCH_LLM_API_KEY

或：
FinSagent/config/production.yaml
  llm_model_name
  llm_base_url
  llm_api_key
```

它不绑定某个具体厂商，只要接口兼容 OpenAI chat completions 即可。

### 2.5 `memo_pdf.py`

把 `MemoDraft` 渲染成 PDF。

当前优先走图片式 renderer：

- 使用 PIL 绘制页面。
- 输出 PDF。
- 包含标题、section、指标卡、证据摘要、sources appendix。

fallback：

- 如果高级渲染失败，可退到 reportlab 或 basic PDF。

默认输出目录：

```text
output/pdf/
```

### 2.6 `web_app.py`

本地独立 FastAPI workbench。

接口：

```text
GET  /
GET  /api/health
POST /api/ask
POST /api/memo
GET  /api/memo/{memo_id}/pdf
GET  /api/trace/{citation_id}
```

作用：

- 独立验证 PDF QA / Memo / Trace。
- 不依赖 Omnigent 或 FinSagent 主服务。
- 可注入 fake LLM 做测试。

## 3. 脚本层

### 3.1 `scripts/run_pdf_research_demo.py`

命令行一键跑：

```text
PDF ingest
-> QA
-> Memo
-> Memo PDF
-> JSON output
```

典型命令：

```bash
python scripts/run_pdf_research_demo.py \
  --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf \
  --company "Tesla, Inc." \
  --ticker TSLA \
  --question "What does Tesla say about Robotaxi and FSD?"
```

### 3.2 `scripts/run_pdf_research_web_app.py`

启动独立 PDF workbench。

```bash
python scripts/run_pdf_research_web_app.py --host 127.0.0.1 --port 8765
```

支持：

```text
--pdf
--text
--company
--ticker
--no-llm
```

### 3.3 `scripts/start_litellm_dashscope.sh`

启动 LiteLLM proxy，并把 Claude / Anthropic 模型名映射到 DashScope qwen3-max。

生成：

```text
omnigent/.tmp-litellm-dashscope.yaml
omnigent/.tmp-litellm.log
```

### 3.4 `scripts/run_omnigent_cc_haha.sh`

完整启动链路：

```text
读取 FinSagent LLM 配置
-> 确保 LiteLLM 健康
-> 设置 ANTHROPIC_* 环境变量
-> 启动 omnigent claude
-> 指定 cc-haha/bin/claude-haha
-> 追加 omnigent/CLAUDE.md 私募系统提示词
```

## 4. FinSagent 接入代码

### 4.1 后端

文件：

```text
FinSagent/deploy/app.py
FinSagent/deploy/session_routes.py
```

新增能力：

- lazy 初始化 `PdfResearchDemo`。
- 支持主 ChatService 依赖缺失时 fallback 到 PDF Research。
- 新增 `/pdf-research/health`、`/pdf-research/ask`、`/pdf-research/memo`、`/pdf-research/trace/{citation_id}`。
- 会话管理可以使用 fallback SQLite store。
- `/chat/stream` 和 `/chat/preview` 在主 RAG 不可用时可回退到 PDF research。

### 4.2 前端

文件：

```text
FinSagent/deploy/frontend/index.html
FinSagent/deploy/frontend/chat.js
FinSagent/deploy/frontend/session_sidebar.js
FinSagent/deploy/frontend/ui.js
```

新增能力：

- 页面定位改成 `FinSagent Research`。
- 取消预览模式开关展示。
- 主输入框直接调用 `/pdf-research/ask`。
- 展示 citation buttons。
- 点击 citation 后展示 trace box。
- execution panel 增加 `pdf_research` 步骤。

## 5. Omnigent 集成补丁内容

主业务仓库不直接提交 `omnigent/` clone，而是保存补丁：

```text
patches/omnigent_private_fund_integration_20260706.patch
```

补丁包含四类改动：

### 5.1 Claude native 注入修复

文件：

```text
omnigent/claude_native_bridge.py
tests/test_claude_native_bridge.py
```

解决：

- Claude Code Haha 启动公告页出现 `Press Enter to continue` 时，Omnigent 自动发送 Enter。
- 等真正输入提示符出现后再注入用户消息，避免网页第一条消息丢失。

### 5.2 私募系统提示词与 skill

文件：

```text
CLAUDE.md
.claude/skills/private-fund-memo/SKILL.md
```

作用：

- 把 Claude Code 会话设为 private fund research mode。
- 定义本地 PDF QA / Memo 的标准工具调用流程。

### 5.3 Private Fund PDF 后端 routes

文件：

```text
omnigent/server/routes/private_fund_pdf.py
omnigent/server/app.py
```

新增接口：

```text
POST /v1/private-fund/pdf/register
POST /v1/private-fund/pdf/ask
POST /v1/private-fund/memo/generate
GET  /v1/private-fund/memo/{memo_id}/pdf
GET  /v1/private-fund/pdf/source/page
```

### 5.4 前端来源点击与 PDF 面板

文件：

```text
web/src/components/blocks/BlockRenderer.tsx
web/src/shell/FileViewerContext.tsx
web/src/shell/AppShell.tsx
web/src/shell/WorkspacePanel.tsx
web/src/shell/PdfSourcePanel.tsx
web/src/shell/railTabs.ts
```

能力：

- 自动识别 `[p.113]`、`10-K p.113, para.1`。
- 点击来源后打开右侧 Sources tab。
- 右侧渲染 PDF page image。
- 根据 quote 尝试高亮对应区域。

## 6. 测试结构

新增测试：

```text
test/memo_generation/test_pdf_research_demo.py
test/memo_generation/test_pdf_research_web_app.py
```

覆盖：

- PDF QA 返回 citation。
- `trace_citation()` 能回到 evidence / document / version / page。
- 中文投资问题能通过 query expansion 命中 evidence。
- Memo sections 有可追溯 citations。
- 无 cached text 时可直接抽取 native PDF。
- Memo 可以渲染为 PDF。
- Web API 可跑 QA / Memo / Trace。
- 注入 fake LLM 后 citation 不丢失。

推荐运行：

```bash
python -m pytest test/memo_generation/test_pdf_research_demo.py -q
python -m pytest test/memo_generation/test_pdf_research_web_app.py -q
```

## 7. 后续演进方向

当前 demo 的关键价值是“先把体验闭环跑通”。下一步应把临时 evidence store 升级为正式架构：

```text
PDF-only in-memory evidence
-> Project DB / Company Collection
-> Evidence Repository
-> Citation Repository
-> Personal Memory
-> Multi-format ingest pipeline
-> Memo Citation Gate
```

优先级：

1. 把 `Document / Evidence / Citation` 对齐 `docs/evidence_schema_design.md`。
2. 把 PDF evidence 写入 SQLite repository。
3. 把 QA / Memo 引用写入 Personal Memory。
4. 把 Omnigent source panel 从页码/quote 临时参数升级为 `citation_id`。
5. 接入多文件 index 开关，但保留 direct PDF fallback。
