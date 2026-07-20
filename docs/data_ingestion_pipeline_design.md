# Data Ingestion Pipeline 设计

## 背景

用户上传的文件需要进 RAG，但系统里目前有两种检索方式：

- **RAG**：文件 → chunk → embedding → Chroma → 语义检索 + reranker
- **DCI（grep）**：直接对 JSON 文件执行 ripgrep 全文搜索

两种方式并存，适用场景不同。目前生产配置使用 DCI（`retrieval_backend: "dci"`）。

---

## 什么时候用 grep，什么时候用 RAG

判断依据：数据量、查询类型、格式。

### 用 grep 的场景（维持现状）

- **文件已经是结构化的 JSON**——比如服务端已有的数据集文件（SEC filings 转换后的 JSON），字段固定，直接用 grep 按 key 搜比走一遍 embedding 更快
- **数据量小（单文件 < 10MB）**——grep 的 O(n) 扫描在文件较小时基本无感
- **查询关键词明确**——公司名、股票代码、年份这类精确匹配，grep 不会比 embedding 差
- **不需要语义相似度**——用户问的是"给我看第 X 页原文"这类定位查询

### 用 RAG 的场景（新增）

- **用户上传的文件**——PDF、Excel、Markdown、Word，非 JSON，无法直接 grep
- **数据量大**——文件超过几十 MB 或数量上百，grep 的线性扫描跟不上
- **查询是自然语言问题**——"毛利率为什么下降了"这类问题，grep 搜"毛利率"三个字会漏掉"profit margin""毛利下滑"等表述，embedding 不会
- **需要跨文件/跨段落关联**——embedding 能找到语义相关但不含相同关键词的内容

### 实际切换策略

对于同一类数据的查询，不混合使用两种方式。具体来说：

```
服务端已有 JSON 数据集       → DCI（grep），不动
用户通过 Omnigent 上传的文件  → RAG，走本管线
```

两类数据分别检索，结果合并后返回给 synthesis 层。

---

## 整体流程

```
用户上传文件
    │
    ▼
data_ingestion/pipeline.py
    │
    ├── PDF → 复用现有 file2chunk2data_pipeline（MinerU + file2chunk v5）
    │              → Chroma（文本）+ table_chroma（表格）
    │
    ├── Excel → openpyxl → markdown 表格
    │              → 复用 load_table_chroma.py 写入 table_chroma
    │              → sheet 标题+列名文本描述 → 复用 load_data.py 写入 Chroma
    │
    ├── Markdown → 直接读文本 → 按标题分割
    │              → 复用 load_data.py 写入 Chroma
    │
    └── Word → python-docx → 按标题样式分割
                   → 复用 load_data.py 写入 Chroma
                   → 含表格则 → 复用 load_table_chroma.py 写入 table_chroma
```

查询侧：EnsembleRetriever（`src/utils/EnsembleRetriever.py`）同时查 Chroma 和 table_chroma，结果经 BGE reranker 排序后合并。新增数据写入后自动进入检索范围，无需改动查询代码。

---

## 格式处理

### PDF

走 `data_pipeline/file2chunk2data_pipeline.py`，该脚本串联六步：
1. MinerU 做 OCR + 版面分析（`mineru -p <pdf> -o <out_dir> -b hybrid-auto-engine`）
2. file2chunk v5（`main_pipeline_v5_20260426.py`）做语义分块、LSH 去重
3. 表格图片处理（`process_table.py`），还原为结构化的 markdown 表
4. 写入 Chroma（`load_data.py` 的 `import_collection_from_dir`）
5. 写入 table_chroma（`load_table_chroma.py` 的 `import_tables_into_chroma`）
6. 构建 PageIndex

配置项见 `config/production.yaml`，`mineru_bin` 已被注释，启用时取消注释即可。

### Excel

用 openpyxl 解析，关键函数：

```python
import openpyxl

wb = openpyxl.load_workbook(file_path, data_only=True)
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    # 处理合并单元格
    for merged_range in ws.merged_cells.ranges:
        val = ws.cell(merged_range.min_row, merged_range.min_col).value
        for row in range(merged_range.min_row, merged_range.max_row + 1):
            for col in range(merged_range.min_col, merged_range.max_col + 1):
                if ws.cell(row, col).value is None:
                    ws.cell(row, col).value = val
    # 读全部数据
    rows = list(ws.iter_rows(values_only=True))
```

输出两样东西：
- markdown 格式的表格 → `import_tables_into_chroma()` → table_chroma
- sheet 标题 + 列名 + 行名的文本描述 → `import_collection_from_dir()` → Chroma

公式处理：先用 `data_only=True` 读取缓存值。如果关键格返回 None（通常是程序生成的 xlsx 从未被 Excel 打开过），回退 `data_only=False` 读取公式原文作为文本描述记录。

### Markdown

直接读 UTF-8，按标题分割：

```python
import re

def split_md_by_heading(text: str):
    # 匹配 #、##、### 标题行
    pattern = r'(^#+\s+.*$)'
    chunks = re.split(pattern, text, flags=re.MULTILINE)
    # chunks 是交错排列的 [text, heading, text, heading, ...]
    return chunks
```

### Word

用 python-docx：

```python
from docx import Document

doc = Document(file_path)
for para in doc.paragraphs:
    # para.style.name 可以判断标题层级（'Heading 1', 'Heading 2', 'Normal'）
    pass
for table in doc.tables:
    # table 转 markdown
    pass
```

按标题样式（Heading 1/2/3）作为分割点。没有标题样式则按段落边界分割，上限 512 tokens。含表格的段落提出来走 table_chroma。

---

## 分块规则

| 内容类型 | 分割方式 | 写入目标 | 大小上限 |
|---------|---------|---------|---------|
| PDF | file2chunk v5 管线 | text Chroma + table_chroma | 管线自定 |
| Excel 小表（≤15 行） | 整表一个 chunk | table_chroma | 512 tokens |
| Excel 大表 | 按行组分（营收组/费用组/利润组） | table_chroma + 文本摘要 | 每行组 512 tokens |
| Markdown | 按标题（#、##）分割 | text Chroma | 512 tokens |
| Markdown（无标题） | 按空行分段 | text Chroma | 512 tokens |
| Word | 按标题样式（Heading 1/2）分割 | text Chroma | 512 tokens |
| Word（无样式） | 按段落边界 | text Chroma | 512 tokens |
| Word/MD 内含表格 | 独立提取 | table_chroma | 512 tokens |

---

## 增量更新

用户重新上传同名文件时：

1. 计算文件 checksum（SHA256）
2. 对比已有记录。checksum 没变则跳过
3. 变了则从 Chroma 查 `source_file = 文件名` 的旧 chunk，逐个删除
4. 执行完整入库流程

触发时机：上传完成即触发，后台异步执行。用户在前端可以看到"索引中→已完成"状态。

---

## 与现有 RAG 查询的衔接

入库后不需要改查询代码。现有检索链路：
```
用户问题
  → RAG.retrieve(query) → EnsembleRetriever（Chroma + BM25）
  → 同时 retrieve_tables(query) → table_chroma
  → 合并 → reranker → final_chunks
```

EnsembleRetriever（`src/utils/EnsembleRetriever.py`）在初始化时加载所有 collection 的数据到内存。新区块在写入 Chroma 后，需要调用 `rag.rebuild_retriever()` 或重启服务才能生效。这是当前实现的一个限制——后续可以改为写入后自动 reload。

---

## 新增文件清单

```
src/data_ingestion/
├── pipeline.py              # 格式识别 + 分发
├── parsers/
│   ├── excel_parser.py      # openpyxl，含 merged_cells 填充
│   ├── md_parser.py         # 标题分割
│   └── docx_parser.py       # python-docx，标题样式检测
```

所有入库操作（embedding、Chroma 写入、FTS5 写入）复用现有代码：
- `data_pipeline/load_data.py` 的 `import_collection_from_dir()`
- `data_pipeline/load_table_chroma.py` 的 `import_tables_into_chroma()`
- `data_pipeline/file2chunk2data_pipeline.py`（PDF 整条管线）
