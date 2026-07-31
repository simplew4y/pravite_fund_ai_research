## 语义检索方案说明

### 当前实现 (v0.5.0)

**方案：** 直接调用 BGE-M3 (vLLM, 端口 5433)，绕过 OpenViking 内置 embedder。

```
set_embedding_fn(fn)  ← fn 直接调 BGE-M3 API
  ↓
_update_embedding(session_id)
  → content.md[:1000] → BGE-M3 → 1024维向量 → 存 memory_index.embedding
  ↓
_search_semantic(query)
  → BGE-M3(query) → 与所有存储的 embedding 余弦相似度 → 返回 score>0.3 的结果
```

**优点：**
- 零依赖，直接调 vLLM API，200ms 内返回
- 1024 维 dense embedding，同义词/近义词召回可靠
- 不依赖 OpenViking 的 LLM/VLM 通路（当前不可用）

**缺点：**
- 纯 embedding 检索，不做 LLM 语义理解
  - "我之前对这家公司的核心担忧是什么" 不会理解"担忧"="风险"
  - "管理层对未来怎么看" 不会关联"业绩展望"
- 长文本直接 embedding 会丢失重点（截断到 1000 chars）
- 不支持 query 与 document 的非对称编码

### 为什么没有走 OpenViking + LLM

需要实际可用的 API key。OpenViking 的 LLM/VLM 通路初始化时需要有效的 API key，当前 ov.conf 中配置的是占位符，导致 semantic processor 初始化失败。打通 OpenViking + LLM 需要先配置真实可用的 LLM 端点（如本地 Qwen 在 8000 端口）及对应的 API key。

当前 BGE-M3 直接调用是占位方案，后续待 OpenViking LLM 通路就绪后，可以用 LLM 做语义摘要增强意图理解。

### 后续计划

| 阶段 | 方案 | 优先级 |
|------|------|--------|
| P0 (当前) | BGE-M3 直接调用，纯 embedding 语义检索 | ✅ 已实现 |
| P1 | Bypass OpenViking embedder，自定义 embedding 层：直接调 BGE-M3，存 SQLite，自实现余弦检索 | ✅ 已实现 (Phase 5) |
| P2 | **修复 OpenViking 通路或自建 LLM 语义增强管线** | 🔜 待评估 |

P2 的两个方向：

**方向 A: 修复 OpenViking**
- 升级 OpenViking 到 0.3.24（可能已修复此 bug）
- 或在 `lotusenv` 中 patch `openai_embedders.py`，跳过 `dimensions` 参数
- 或配置 VLM 使 semantic processor 可用

**方向 B: 自建 LLM 语义增强**
- 写入时：LLM 提取关键实体/观点/风险 → BGE-M3 嵌入摘要 → 存两份 embedding
- 检索时：BGE-M3 嵌入 query → 分别匹配全文 embedding 和摘要 embedding → 合并
- 需要 LLM 服务可用（当前服务器 Qwen 在 8000 端口）
