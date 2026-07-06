# Private Fund AI Research

本仓库是一套本地私募投研 demo：把 Omnigent 网页会话、Claude Code Haha、LiteLLM、DashScope、本地 PDF evidence、可点击溯源和 Memo PDF 生成串成一个可部署系统。

当前目标是先跑通最小闭环：

```text
本地 PDF
-> 证据抽取
-> 单聊天框问答
-> citation / trace
-> 右侧 PDF 原文复核
-> Memo PDF 生成
```

它不是自动投资决策系统，也不是完整生产级资料库；它定位是“私募投研资料证据化与研究辅助 demo”。

## 系统架构

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
tmux terminal running Claude Code TUI
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

核心文档：

| 文档 | 内容 |
|---|---|
| [Omnigent + Claude Code Haha 系统架构](docs/omnigent_cc_haha_system_architecture_20260706.md) | Omnigent、cc-haha、LiteLLM、DashScope、本地 PDF QA、Memo PDF、来源点击面板的完整运行链路 |
| [私募 PDF Research Demo 代码架构](docs/private_fund_code_architecture_20260706.md) | `src/pdf_research_demo`、FinSagent 接入、脚本、测试和 Omnigent 补丁的代码结构 |
| [Omnigent 私募研究集成补丁](patches/omnigent_private_fund_integration_20260706.patch) | 对 `omnigent` submodule 应用的私募研究改动 |

## 代码组成

| 路径 | 说明 |
|---|---|
| `src/pdf_research_demo/` | PDF-only evidence、QA、Memo、citation trace、PDF renderer、FastAPI workbench |
| `scripts/run_pdf_research_demo.py` | 命令行一键跑 PDF QA + Memo PDF |
| `scripts/run_pdf_research_web_app.py` | 独立 PDF Evidence Workbench |
| `scripts/start_litellm_dashscope.sh` | 启动 LiteLLM，将 Claude / Anthropic 模型名映射到 DashScope qwen3-max |
| `scripts/run_omnigent_cc_haha.sh` | 启动完整 Omnigent + Claude Code Haha 链路 |
| `scripts/setup_full_system.sh` | 新机器部署脚本：初始化 submodule、应用 Omnigent patch、安装依赖 |
| `FinSagent/deploy/` | FinSagent Research Chat fallback 接入 |
| `omnigent/` | submodule，Omnigent 主体；setup 时应用私募研究补丁 |
| `cc-haha/` | submodule，Claude Code Haha 运行时 |
| `test/memo_generation/` | PDF QA、Memo、Web API、trace 测试 |

## 新机器部署

### 1. 准备依赖

需要：

```text
git
python3
uv
bun
tmux
curl
Poppler: pdftotext / pdftoppm
```

macOS 可参考：

```bash
brew install git uv bun tmux poppler
```

### 2. Clone 仓库和 submodule

```bash
git clone --recurse-submodules \
  -b codex/private-fund-system-architecture-20260706 \
  https://github.com/simplew4y/pravite_fund_ai_research.git

cd pravite_fund_ai_research
```

如果已经 clone 但没有 submodule：

```bash
git submodule update --init --recursive omnigent cc-haha
```

### 3. 初始化完整系统

```bash
scripts/setup_full_system.sh
```

这个脚本会：

- 拉取 `omnigent` 和 `cc-haha` submodule。
- 给 `omnigent` 应用私募研究补丁。
- 给 `cc-haha` 执行 `bun install`。
- 给 `omnigent` 执行 `uv sync`。
- 检查 `tmux`、`uv`、`bun`、`pdftotext`、`pdftoppm` 等依赖。

### 4. 配置模型

不要把真实 key 提交到仓库。部署机器上用环境变量：

```bash
export DASHSCOPE_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export DASHSCOPE_API_KEY="<your-key>"
```

也可以用本地配置文件：

```text
FinSagent/config/production.yaml
```

需要包含：

```yaml
llm_model_name: qwen3-max
llm_base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
llm_api_key: <your-key>
```

### 5. 启动完整 Omnigent + Claude Code Haha 链路

```bash
scripts/run_omnigent_cc_haha.sh
```

启动后脚本会：

1. 检查或启动 LiteLLM proxy：`http://127.0.0.1:4000`。
2. 把 Anthropic-compatible 环境变量指向 LiteLLM。
3. 用 `cc-haha/bin/claude-haha` 作为 Claude Code command。
4. 启动 `omnigent claude`。
5. 追加 `omnigent/CLAUDE.md` 私募研究系统提示词。

## 本地 PDF QA 和 Memo

不启动 Omnigent，也可以直接跑最小 PDF demo：

```bash
python scripts/run_pdf_research_demo.py \
  --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf \
  --company "Tesla, Inc." \
  --ticker TSLA \
  --question "基于本地 Tesla PDF，概括 Tesla 当前的核心投资逻辑"
```

独立 Web workbench：

```bash
python scripts/run_pdf_research_web_app.py --host 127.0.0.1 --port 8765
```

FinSagent Research Chat fallback：

```bash
cd FinSagent/deploy
FINSAGENT_SKIP_CHAT_INIT=1 python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## Evidence 链路

当前最小实现不构建 chunk index，而是直接将 PDF 页面文本拆成 page / paragraph evidence：

```text
PDF file
-> Document
-> DocumentVersion
-> EvidenceLocation(file, page, paragraph)
-> Evidence
-> Citation
-> QA answer / Memo section
-> trace_citation()
```

这样可以先验证投研体验：

- 每个核心结论都有 citation。
- citation 可以回到 PDF 文件、版本、页码和段落。
- Memo section 也能回到同一套 evidence。

未来正式版本会把这套内存 evidence store 升级为 Project DB / Personal Memory / Evidence Repository。

## Omnigent 私募补丁

`omnigent/` 是 submodule，私募研究相关改动通过 patch 保存：

```text
patches/omnigent_private_fund_integration_20260706.patch
```

补丁内容包括：

- `omnigent/CLAUDE.md` 私募研究系统提示词。
- `.claude/skills/private-fund-memo/SKILL.md`。
- Claude Code 启动公告页 `Press Enter to continue` 自动处理。
- `/v1/private-fund/*` 后端 API。
- 回答中 `[p.113]` / `10-K p.113, para.1` 自动 linkify。
- 右侧 `Sources` PDF 渲染与高亮面板。

手动应用：

```bash
git -C omnigent apply ../patches/omnigent_private_fund_integration_20260706.patch
```

检查是否已经应用：

```bash
git -C omnigent apply --reverse --check ../patches/omnigent_private_fund_integration_20260706.patch
```

## 测试

推荐验证：

```bash
python -m pytest \
  test/memo_generation/test_pdf_research_demo.py \
  test/memo_generation/test_pdf_research_web_app.py \
  -q

python -m py_compile \
  src/pdf_research_demo/*.py \
  scripts/run_pdf_research_demo.py \
  scripts/run_pdf_research_web_app.py \
  FinSagent/deploy/app.py \
  FinSagent/deploy/session_routes.py

node --check FinSagent/deploy/frontend/chat.js
node --check FinSagent/deploy/frontend/session_sidebar.js
node --check FinSagent/deploy/frontend/ui.js
```

Omnigent 前端测试在 submodule 中执行：

```bash
cd omnigent
npm test -- BlockRenderer WorkspacePanel
npm run type-check
npm run build
```

## 不进入仓库的内容

这些内容属于部署机器本地状态，不应该提交：

```text
真实 API key
tesla_extracted/     本地 PDF 资料
tesla.zip            本地资料压缩包
output/              生成的 PDF、PNG、HTML
node_modules/        依赖目录
__pycache__/         Python 缓存
FinSagent/deploy/.memory/
```

## 当前边界

已跑通：

- Omnigent + cc-haha + LiteLLM + DashScope 调用链。
- 本地 PDF QA。
- citation_id 和 trace_citation。
- Memo PDF 生成。
- FinSagent Research Chat fallback。
- Omnigent 单聊天框触发私募研究。
- 点击来源打开右侧 PDF source panel。

尚未完成：

- 正式 Project DB / Analyst Space SQLite repository。
- 多文件、多格式 chunk / index pipeline。
- Excel、PPT、Word 等格式的统一 Evidence adapter。
- QA / Memo 全量写入 Personal Memory。
- 生产级 Memo Citation Gate 和审计链。
