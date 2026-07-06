# Memo Generation Tests

负责人：朝龙

本目录用于存放 Memo Generation 相关测试。

建议内容：

```text
fixtures/                     evidence pack、historical memory、expected sections
outputs/                      生成的 memo.md 和 citation gate 报告
test_evidence_pack.py          evidence pack 构建测试
test_section_generation.py     memo section 生成测试
test_citation_gate.py          unsupported claim / needs_review 测试
test_markdown_export.py        memo.md 导出测试
```

最低验收：

```text
输入 company_id，能生成一版带 citation 的 memo.md；无证据核心结论必须标记 needs_review。
```

## 当前最小 Demo

PDF-only 集成 demo 已落在：

```text
src/pdf_research_demo/
scripts/run_pdf_research_demo.py
scripts/run_pdf_research_web_app.py
FinSagent/deploy/frontend/chat.js
FinSagent/deploy/frontend/session_sidebar.js
test/memo_generation/test_pdf_research_demo.py
test/memo_generation/test_pdf_research_web_app.py
test/memo_generation/outputs/tesla/pdf_demo_memo.md
```

能力边界：

```text
PDF + cached text 入库
-> page / paragraph evidence
-> QA answer with citation_id
-> fixed-section memo with citation_id
-> trace_citation(citation_id) 回到 PDF 文件、version、page、paragraph
-> local Web QA / memo / provenance viewer
-> optional OpenAI-compatible LLM synthesis after local evidence retrieval
-> FinSagent main Research Chat input plus left session management
```

验证方式：

```bash
python -m pytest test/memo_generation/test_pdf_research_demo.py -q
python -m pytest test/memo_generation/test_pdf_research_web_app.py -q

python scripts/run_pdf_research_demo.py \
  --pdf tesla_extracted/20260129_10-K_0001628280-26-003952.pdf \
  --text tmp/pdfs/tesla_text/20260129_10-K_0001628280-26-003952.txt \
  --question "What does Tesla say about Robotaxi and FSD?" \
  --memo-out test/memo_generation/outputs/tesla/pdf_demo_memo.md

python scripts/run_pdf_research_web_app.py \
  --host 127.0.0.1 \
  --port 8765

cd FinSagent/deploy
FINSAGENT_SKIP_CHAT_INIT=1 python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Web 启动后访问：

```text
http://127.0.0.1:8765/
```

说明：当前 demo 的检索和 citation 仍由本地 PDF evidence 系统完成；Web 启动脚本默认读取 `FinSagent/config/production.yaml` 中的 `llm_model_name`、`llm_base_url`、`llm_api_key`，用兼容 OpenAI 的 `/chat/completions` 接口做回答和 memo 的自然语言综合。需要回到纯抽取式 fallback 时，启动命令加 `--no-llm`。

FinSagent 主 UI 接入说明：本地缺少主 RAG 依赖或索引时可用 `FINSAGENT_SKIP_CHAT_INIT=1` 启动静态 UI、左侧会话管理和 Research Chat；生产/完整环境依赖齐全时可按原方式启动。主输入框直接调用 research QA，`/pdf-research/*` 保留为内部 API。
