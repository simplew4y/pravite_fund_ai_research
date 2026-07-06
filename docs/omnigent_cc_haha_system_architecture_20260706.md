# Omnigent + Claude Code Haha 私募研究系统架构

日期：2026-07-06

## 1. 当前系统目标

当前系统把 Omnigent 的网页会话、Claude Code Haha 的 Claude Code 兼容运行时、本地 LiteLLM 模型代理、DashScope 模型、本地 PDF evidence demo 和 Memo PDF 生成串成一条可演示的私募研究链路。

目标不是先建设完整资料库索引，而是先跑通：

```text
单聊天框提问
-> Claude Code 工具调用
-> 本地 PDF evidence 检索
-> 带 citation 的回答
-> 点击来源打开右侧 PDF 原文
-> 生成 Memo PDF
```

## 2. 仓库边界

当前机器上有三个相关代码边界：

```text
/Users/Admin/project/private_fund_ai_research
  主业务仓库，提交到 simplew4y/pravite_fund_ai_research。

/Users/Admin/project/private_fund_ai_research/omnigent
  独立 clone：omnigent-ai/omnigent。
  当前有本地改动，但不直接作为子目录提交进主业务仓库。
  本分支用 patches/omnigent_private_fund_integration_20260706.patch 保存集成补丁。

/Users/Admin/project/private_fund_ai_research/cc-haha
  独立 clone：NanmiCoder/cc-haha。
  当前没有业务改动，只作为 Claude Code 兼容 CLI 运行时使用。
```

不把 `omnigent/` 和 `cc-haha/` 整个提交进主仓库的原因：

- 二者都是独立 git 仓库。
- `cc-haha` 带有大量 `node_modules` 与桌面端依赖。
- `omnigent` 体积较大，直接嵌入会污染主业务仓库历史。
- 当前主业务仓库只需要保存业务代码、运行脚本、测试、架构文档和 Omnigent 补丁。

## 3. 总体运行拓扑

```text
Browser / Omnigent Web UI
        |
        v
Omnigent Server / Runner
        |
        v
Claude Native Executor
        |
        v
tmux terminal with Claude Code TUI
        |
        v
cc-haha/bin/claude-haha
        |
        v
Anthropic-compatible API request
        |
        v
LiteLLM proxy on 127.0.0.1:4000
        |
        v
DashScope qwen3-max
        |
        v
Claude Code transcript / hooks / MCP
        |
        v
Omnigent transcript forwarder
        |
        v
Browser chat + right-side PDF source panel
```

## 4. 启动链路

主启动脚本：

```bash
scripts/run_omnigent_cc_haha.sh
```

启动时做以下事情：

1. 从 `FinSagent/config/production.yaml` 读取 `llm_base_url` 和 `llm_api_key`。
2. 确认或启动 LiteLLM proxy，默认地址为 `http://127.0.0.1:4000`。
3. 生成 Omnigent 侧临时 LiteLLM 配置：

```text
omnigent/.tmp-litellm-dashscope.yaml
```

4. 把 Claude / Anthropic 模型名映射到 DashScope：

```text
qwen3-max             -> dashscope/qwen3-max
claude-sonnet-4-6    -> dashscope/qwen3-max
claude-sonnet-4-5    -> dashscope/qwen3-max
claude-opus-4-6      -> dashscope/qwen3-max
claude-haiku-4-6     -> dashscope/qwen3-max
```

5. 设置 Claude Code Haha 运行环境：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4000
ANTHROPIC_MODEL=qwen3-max
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3-max
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3-max
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3-max
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_EFFORT_LEVEL=low
```

6. 启动 Omnigent Claude native：

```bash
cd omnigent
uv run omnigent claude \
  --command ../cc-haha/bin/claude-haha \
  --use-native-config \
  --append-system-prompt-file CLAUDE.md
```

## 5. Claude Code Haha 角色

`cc-haha/bin/claude-haha` 是 Claude Code 兼容 CLI 的启动入口。它内部运行：

```text
bun ./src/entrypoints/cli.tsx
```

对本系统来说，cc-haha 的职责是：

- 提供 Claude Code TUI。
- 支持 Claude Code 工具调用、MCP、skills、权限审批等能力。
- 使用 Anthropic-compatible 请求形态调用模型。
- 通过环境变量把模型请求转到 LiteLLM，而不是直连 Anthropic。

当前没有改动 cc-haha 代码。

## 6. Omnigent Claude Native 角色

Omnigent 不是直接调用模型，而是把浏览器会话和 Claude Code TUI 绑定起来。

核心代码位置：

```text
omnigent/omnigent/claude_native.py
omnigent/omnigent/inner/claude_native_executor.py
omnigent/omnigent/claude_native_bridge.py
omnigent/omnigent/claude_native_hook.py
omnigent/omnigent/claude_native_forwarder.py
```

关键职责：

- 创建 Omnigent conversation。
- 创建 runner terminal resource。
- 在 tmux 中运行 `cc-haha/bin/claude-haha`。
- 准备 bridge directory。
- 注入 Claude Code MCP config。
- 安装 Claude Code hooks。
- 将网页发来的用户消息注入 Claude Code 输入框。
- 监听 Claude transcript，把回答、工具调用、权限请求同步回 Omnigent 前端。

## 7. 网页消息到 Claude Code 的链路

用户在 Omnigent 网页输入问题后：

```text
Omnigent Web UI
-> Omnigent conversation API
-> claude-native harness
-> ClaudeNativeExecutor.run_turn()
-> inject_user_message()
-> tmux load-buffer / paste-buffer / send-keys Enter
-> Claude Code TUI 收到输入
```

这个设计意味着：

- Claude Code 自己保留上下文和工具执行状态。
- Omnigent 不直接拼模型消息，也不接管 Claude Code 的模型调用。
- Omnigent 只负责会话编排、输入注入、输出转发和前端展示。

当前修复了一个关键启动问题：某些 Claude Code Haha 分发版启动时会显示公告页并等待 `Press Enter to continue`。Omnigent bridge 现在会检测这个提示并自动发送 Enter，然后继续等待真正的 Claude 输入提示符出现，避免第一条网页消息丢失。

## 8. 私募研究系统提示词

Omnigent Claude Code 启动时会追加：

```text
omnigent/CLAUDE.md
```

该提示词把 Claude Code 会话限定为私募研究模式：

- 研究公司、PDF、Memo、尽调问题时，扮演 evidence-first private fund analyst。
- 默认中文回答。
- 本地 PDF evidence 优先。
- 不编造事实、页码、文件名、citation id。
- 关键投研结论必须可追溯。
- 遇到 PDF QA 或 Memo 请求时，应先调用工具，而不是只输出计划。
- 前端体验保持一个聊天框，不新增独立 Private Fund PDF 面板。

## 9. Private Fund Memo Skill

Omnigent clone 里新增了 Claude Code skill：

```text
omnigent/.claude/skills/private-fund-memo/SKILL.md
```

触发范围：

```text
私募研究
PDF 问答
本地 PDF
投资 memo
research memo
可溯源回答
Tesla 投资逻辑
生成 memo
```

Skill 的标准执行方式：

```bash
cd /Users/Admin/project/private_fund_ai_research
python scripts/run_pdf_research_demo.py \
  --pdf "<pdf_path>" \
  --company "<company>" \
  --ticker "<ticker>" \
  --question "<question>"
```

输出 JSON 包含：

```text
qa.answer
qa.citations
memo.memo_id
memo.pdf_path
first_trace
```

## 10. 本地 PDF Evidence Demo

主业务仓库中新增：

```text
src/pdf_research_demo/
```

当前实现的是 direct native-PDF flow：

```text
PDF / cached text
-> Document
-> DocumentVersion
-> page / paragraph Evidence
-> Citation
-> QA answer
-> Memo section
-> trace_citation()
```

它不构建持久 chunk index，也不写正式 Project DB。当前 evidence store 是内存态，用于验证最小闭环。

关键模块：

```text
models.py     Document / DocumentVersion / Evidence / EvidenceLocation / Citation
store.py      PDF 提取、paragraph evidence、简单检索、citation trace
demo.py       QA、固定结构 Memo、LLM/fallback 综合
llm.py        OpenAI-compatible chat client
memo_pdf.py   Memo PDF 渲染
web_app.py    本地 FastAPI demo 页面和 API
```

## 11. FinSagent 接入

FinSagent 主页面也被改成 Research Chat 模式。

主要改动：

```text
FinSagent/deploy/app.py
FinSagent/deploy/session_routes.py
FinSagent/deploy/frontend/chat.js
FinSagent/deploy/frontend/index.html
FinSagent/deploy/frontend/session_sidebar.js
FinSagent/deploy/frontend/ui.js
```

新增后端 API：

```text
GET  /pdf-research/health
POST /pdf-research/ask
POST /pdf-research/memo
GET  /pdf-research/trace/{citation_id}
```

前端变化：

- 页面品牌从通用 `FinSagent Chat` 调整为 `FinSagent Research`。
- 主输入框直接调用 `/pdf-research/ask`。
- 回答下方展示 citation buttons。
- 点击 citation 可展示 trace 信息。
- 保留左侧 session 管理。
- 当主 RAG 未初始化时，可以用 `FINSAGENT_SKIP_CHAT_INIT=1` 启动 research fallback。

## 12. Omnigent PDF Source Panel

Omnigent clone 的前端新增了来源点击与右侧 PDF 渲染。

关键代码：

```text
omnigent/web/src/components/blocks/BlockRenderer.tsx
omnigent/web/src/shell/FileViewerContext.tsx
omnigent/web/src/shell/AppShell.tsx
omnigent/web/src/shell/WorkspacePanel.tsx
omnigent/web/src/shell/PdfSourcePanel.tsx
```

链路：

```text
回答文本出现 [p.113] 或 10-K p.113, para.1
-> BlockRenderer linkify
-> #private-fund-pdf-source?page=113&quote=...
-> usePdfSourceViewer()
-> AppShell 选中 Sources tab
-> PdfSourcePanel 请求 /v1/private-fund/pdf/source/page
-> 后端 pdftoppm 渲染 PDF 页面
-> 后端 pdftotext -bbox 尝试定位 quote
-> 前端展示 PDF PNG 并高亮区域
```

## 13. Omnigent Private Fund API

Omnigent clone 中新增：

```text
omnigent/omnigent/server/routes/private_fund_pdf.py
```

接口：

```text
POST /v1/private-fund/pdf/register
POST /v1/private-fund/pdf/ask
POST /v1/private-fund/memo/generate
GET  /v1/private-fund/memo/{memo_id}/pdf
GET  /v1/private-fund/pdf/source/page
```

这些接口复用主业务仓库的 `src/pdf_research_demo`：

- 注册或默认加载本地 PDF。
- 调用 `PdfResearchDemo.answer_question()`。
- 调用 `PdfResearchDemo.generate_memo()`。
- 调用 `render_memo_pdf()`。
- 渲染 PDF 页面和高亮区域。

## 14. 当前不是完整生产形态

当前已经跑通体验闭环，但还不是最终生产架构：

```text
已跑通：
- 本地 PDF QA
- citation_id
- trace_citation
- Memo PDF
- Omnigent 单聊天框调用
- 来源点击右侧 PDF 渲染
- cc-haha -> LiteLLM -> DashScope 模型链路

尚未完成：
- 正式 Project DB / Analyst Space SQLite schema
- 持久 Evidence Repository
- 多文件 chunk / index pipeline
- Excel / PPT / Word 多格式统一 Evidence
- QA / Memo 全量写入 Personal Memory
- Memo citation gate 的生产级校验
```

## 15. 主要运行命令

启动 Omnigent + cc-haha：

```bash
scripts/run_omnigent_cc_haha.sh
```

直接跑 PDF QA + Memo：

```bash
python scripts/run_pdf_research_demo.py \
  --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf \
  --text tmp/pdfs/tesla_text/20260129_10-K_0001628280-26-003952.txt \
  --company "Tesla, Inc." \
  --ticker TSLA \
  --question "基于本地 Tesla PDF，概括 Tesla 当前的核心投资逻辑"
```

启动独立 PDF workbench：

```bash
python scripts/run_pdf_research_web_app.py --host 127.0.0.1 --port 8765
```

启动 FinSagent Research fallback：

```bash
cd FinSagent/deploy
FINSAGENT_SKIP_CHAT_INIT=1 python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## 16. 验证项

推荐验证：

```bash
python -m pytest test/memo_generation/test_pdf_research_demo.py -q
python -m pytest test/memo_generation/test_pdf_research_web_app.py -q
python -m py_compile src/pdf_research_demo/*.py scripts/run_pdf_research_demo.py scripts/run_pdf_research_web_app.py
node --check FinSagent/deploy/frontend/chat.js
node --check FinSagent/deploy/frontend/session_sidebar.js
node --check FinSagent/deploy/frontend/ui.js
```

Omnigent 前端相关验证应在 `omnigent/` clone 内执行：

```bash
npm test -- BlockRenderer WorkspacePanel
npm run type-check
npm run build
```

## 17. 本分支提交方式

GitHub 分支只提交主业务仓库内容：

```text
src/pdf_research_demo/
scripts/run_pdf_research_demo.py
scripts/run_pdf_research_web_app.py
scripts/start_litellm_dashscope.sh
scripts/run_omnigent_cc_haha.sh
FinSagent/deploy/*
test/memo_generation/*
docs/*
patches/omnigent_private_fund_integration_20260706.patch
```

不提交：

```text
omnigent/        独立 clone，用 patch 记录改动
cc-haha/         独立 clone，无业务改动
tesla_extracted/ 本地资料
output/          运行产物
node_modules/    依赖目录
__pycache__/     运行缓存
```
