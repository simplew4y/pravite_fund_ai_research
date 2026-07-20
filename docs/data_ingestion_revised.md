# Data Ingestion — 最终结论

## 现状

`private_fund_directory_ingest.py` 已经处理所有格式：

```
SUPPORTED_EXTENSIONS = {.pdf, .xlsx, .xlsm, .docx, .pptx, .csv, .md, .markdown, .txt}
```

每个格式都有对应的 `ingest_xxx()` 函数：
- `.pdf` → `ingest_pdf()` — pdftotext 提取
- `.xlsx/.xlsm` → `ingest_excel()` — openpyxl 双通道解析
- `.docx/.pptx/.csv/.md/.txt` → `ingest_adapted_document()` — `private_fund_format_adapters.py` 使用 Python 标准库解析

## 缺口

**SQLite → Chroma 的增量写入不存在。** 所有数据存储在 `collection.sqlite3` 的 `chunks` 表中，标注 "ready for later Chroma/BM25 indexing step"。

## 唯一需要补充的代码

`src/data_ingestion/chroma_bridge.py`（已完成）

```python
from data_ingestion.chroma_bridge import sync_chunks_to_chroma
sync_chunks_to_chroma(rag_manager, "path/to/collection.sqlite3", "default")
```

功能：
1. 读 SQLite 中 `chroma_synced_at IS NULL` 的 chunks
2. 调 `chroma._collection.add()` 增量写入（不做 reset）
3. 标记已同步的 chunks

## 集成到上传流程

在 `_project_pipeline_worker` 末尾，`ingest_directory()` 执行完后调用：

```python
# 在 omnigent/private_fund_pdf.py 的 _project_pipeline_worker 末尾
from data_ingestion.chroma_bridge import sync_chunks_to_chroma
try:
    sync_chunks_to_chroma(rag_manager, collection_db_path)
except Exception as e:
    logger.warning("Chroma sync failed (non-fatal): %s", e)
```

## 不需要改动的文件

- `private_fund_directory_ingest.py` — 已经完整
- `private_fund_format_adapters.py` — 已经完整  
- `load_data.py` — 保留用于全量重建场景
- `load_table_chroma.py` — 保留

## 新增文件

```
src/data_ingestion/__init__.py
src/data_ingestion/chroma_bridge.py    ← 唯一需要写的代码（已完成）
```

## 删除的文件

```
src/data_ingestion/parsers/            ← 已删除（全是重复的）
src/data_ingestion/models.py           ← 已删除（不再需要）
src/data_ingestion/pipeline.py         ← 已删除（整合到 chroma_bridge）
```
