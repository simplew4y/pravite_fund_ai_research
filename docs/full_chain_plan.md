# 全链路实现方案

## 现状：现有链路完整度

读取现有代码后发现，**系统的 RAG 检索链路已经完整**，不存在 "DCI vs RAG 切换" 的问题：

```
用户上传 → ingest_directory() → SQLite (已有)
                                   ↓
question → agents → retrieve_evidence()
                      → RAG.retrieve(query)
                          → EnsembleRetriever (Chroma + BM25 + table_chroma)
                          → BGE reranker
                          → final_chunks
                      → agent drafts answer
                      → synthesis (已有)
                                   ↓
memo/answer → save_asset() → asset/资料 (已有)
```

现有的 `ChatService` 只初始化了 `RAG` 类（基于 Chroma），不存在别的检索后端。之前提到的 "DCI" 是过时的信息。

## 缺口：只剩两个

### 缺口 1：SQLite → Chroma 从未在服务器上运行过

- `chroma_bridge.py` 已写好，但没在真实环境跑过
- 需要手动触发一次 `sync_chunks_to_chroma()` 确认：
  - RAGManager 能初始化
  - Chroma collection 配置正确（collection_name 在 production.yaml 里是 "lotus"）
  - Chunks 能写入并检索到

### 缺口 2：上传后的自动同步需要确认配置

- 集成的钩子代码已写在 `FinSagent/deploy/app.py` 和 `private_fund_pdf.py`
- 但服务器上跑的是 `lzx_memo` 分支旧代码
- 需要确定服务器部署的入口是：

  | 入口 | 位置 | 需要确认 |
  |------|------|---------|
  | FinSagent API | `deploy/app.py` | 有没有跑最新的 `codex/valuation-model-tracking-mvp` 代码 |
  | Omnigent pipeline | `/v1/private-fund/projects/{id}/pipeline` | `_project_pipeline_worker` 里调不调用 chroma sync |

## 实施步骤

### Step 1：确认服务器代码版本

```bash
cd /root/autodl-tmp/dir_lzx/pravite_fund_ai_research
git log --oneline -3          # 检查是否在 codex/valuation-model-tracking-mvp
git stash && git pull         # 拉到最新
```

### Step 2：手动跑一次 chroma_bridge

用最少的依赖测试 SQLite → Chroma 能否走通：

```python
cd FinSagent && python3 -c "
import sys; sys.path.insert(0, 'src')
from core.RAGManager import RAGManager
from data_ingestion.chroma_bridge import sync_chunks_to_chroma

rm = RAGManager()  # 读 production.yaml
# 假设已有入库过的 dataset
r = sync_chunks_to_chroma(rm, '/path/to/collection.sqlite3', collection_name='lotus')
print(r)  # {'text_chunks': N, 'table_chunks': M}
"
```

### Step 3：测试检索

```python
# 在 ChatService 环境里
rag = RAG(rag_manager, reranker, lock, topk, ..., collection_name='lotus')
result = rag.retrieve('阳光电源2024年营收多少')
for chunk in result['final_chunks']:
    print(chunk['content'][:200])
```

### Step 4：如果全链路正常

- 确认 `deploy/app.py` 中 `_sync_collection_to_chroma` 在 `_private_fund_ingest_worker` 末尾被调用
- 确认 `private_fund_pdf.py` 中 `_sync_chunks_to_chroma_optional` 在 `_project_pipeline_worker` 末尾被调用

### Step 5：确认配置

- `production.yaml` 的 `collection_name: "lotus"` 对应 `chroma_bridge` 用的 `"default"`
- 如果不同，需要同步

## 不需要做的

- ❌ DCI vs RAG 路由判断——系统只有 RAG 后端
- ❌ 新的 parser 或 adapter——format_adapters 已经完整
- ❌ 前端改动——上传流程已有，不需要改
