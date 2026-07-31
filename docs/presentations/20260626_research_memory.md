# Research Memory 模块 — 汇报材料

> 负责人：廖子兴
> 2026-06-26

---

## 一、模块定位

**Research Memory 是投研系统的记忆层。** 每次研究问答后，系统自动记录：原文、结构化事实、引用出处、审计轨迹。让研究员能精确回溯"我之前研究过什么、当时依据是什么、观点有没有变化"。

**不是聊天记录备份**，是研究过程资产。

## 二、特殊需求：过往对话的精确管理

单纯的"记住聊过什么"对私募投研不够，我们有 5 层特殊需求：

### 1. 跨 Session 实体追踪

```
周一 session: "极氪2024年毛利率多少？" → "15.2%"
周五 session: "上次那个数有没有更新？" 
```

记忆要能跨 session 识别"上次那个数"="极氪2024年毛利率"，而不是当新问题处理。

**手段：** facts 表按 entity/metric/period 精确匹配，不管来自哪个 session。

### 2. 带出处的精确召回

不能只返回"我记得你问过极氪毛利率"，必须返回：

```
📌 精确匹配 (score=1.0)
   来源: session_zk_001 (2026-06-24)
   问题: 极氪2024年毛利率变化怎么看？
   回答: 15.2%，同比+1.8pct
   证据: 年报.pdf p92
```

**手段：** citations 表记录每个事实的来源文件+页码，不因为记忆而丢失出处。

### 3. 事实版本演进

事实不能被覆盖，旧版本必须保留：

```
fact_001: entity=极氪, metric=毛利率, value=15.2%, period=FY2024
          来源: 年报.pdf p92, 版本=1, 创建时间=2026-06-24
          
fact_002: entity=极氪, metric=毛利率, value=14.8%, period=FY2024
          来源: 中报.pdf p45, 版本=2, supersedes=fact_001
```

研究员可以查"这个数字有没有被修正过"，新结论不会抹掉旧判断。

**手段：** facts 表不 UPDATE，只 INSERT，旧版本通过 superseded_at 标记。

### 4. 研究成果的跨模块复用

记忆不仅给 QA 用，还要喂给 Memo 生成模块：

```
研究员写极氪 memo:
  "财务表现" section → 自动拉取所有关于极氪毛利率/收入/利润的历史 QA fact
  "风险" section → 自动关联历史讨论中的风险判断
  每个引用自动绑定 citations → 可追溯
```

**手段：** memory_items 表（P1）统一管理所有可被语义检索的研究资产。

### 5. 话题链接

一次检索召回所有相关讨论，不局限于单次 session：

```
查"毛利率" → 返回:
  - 极氪毛利率讨论 (session_zk_001, 2026-06-24)
  - 蔚来毛利率对比 (session_zk_002, 2026-06-25)
  - 行业中毛利率趋势分析 (session_zk_003, 2026-06-26)
```

**手段：** entity 标签 + FTS5 + OpenViking 语义检索，三层配合召回。

---

## 三、当前进展

| 阶段 | 状态 |
|------|------|
| 设计文档初版 | ✅ 已完成 |
| 修订版（v2） | ✅ 已写入（加架构图/API/验收表/P0-P1分层） |
| 代码实现 | 🔧 本周启动 |
| OpenViking 接入验证 | ✅ 文件系统 API（write/read/mkdir/ls）已验证通过 |

## 四、架构方案

**SQLite 为主存 + OpenViking 只读检索。**

```
每次问答完成后:
  ResearchMemory.record_turn()
    ├── messages.jsonl + content.md   ← 完整原文 (文件系统)
    ├── facts (结构化事实)              ← SQLite (精确检索)
    ├── citations (引用出处)            ← SQLite (溯源)
    ├── audit_trail (审计)              ← SQLite (可复盘)
    └── .md → add_resource()           → OpenViking (语义索引)

研究员提问时:
  ResearchMemory.retrieve(query)
    ├── facts 表 (entity/metric)       ← 精确1.0
    ├── FTS5 (消息全文)                 ← 精确0.95
    ├── OpenViking search(内容)        ← 语义0.x
    └── 合并排序 → 注入 prompt
```

**选型原因：** OpenViking 文件系统 API 全部可用，但 session 管理 API 被 embedding 503 阻塞。SQLite 存储无依赖，embedding 修好前 FTS5 能顶上。

## 五、P0 交付范围

| 模块 | 内容 | 依赖 |
|------|------|------|
| SQLite 表 | qa_sessions / qa_messages / facts / citations / audit_trail | 无 |
| 写入链路 | record_turn() 写入全部 5 类数据 | 无 |
| 检索链路 | retrieve() FTS5 精确 + 语义混合 | embedding 注入 |
| REST API | /memory/turn /retrieve /facts /audit /citations | FastAPI |
| 长会话管理 | 每 5 轮 checkpoint 压缩 | LLM 注入 |
| OpenViking 语义 | add_resource + search | embedding 修好后自动生效 |

**P1 预留（字段已设计，先不实现）：**
- memory_items 统一记忆表
- analyst_id 多用户
- viewpoint_versions 观点版本

## 六、与其它模块的关系

```
程景逸 (Evidence Schema)       廖 (Research Memory)        朝龙 (Memo Generation)
  ┌──────────────┐               ┌────────────┐             ┌─────────────┐
  │ evidence 表  │──citations──→│ facts 表   │──memory──→│ memo 草稿   │
  │ evidence_id │               │ citations  │ 复用       │ citation 引用│
  │ location    │               │ audit      │             │             │
  └──────────────┘               └────────────┘             └─────────────┘
                                        │
                                        ↓
                                 雷雷 (Project DB)
                                 analyst.db ↔ collection.db
```

## 七、待讨论问题

| # | 问题 | 建议 |
|---|------|------|
| 1 | **代码目录**：新代码放哪？ | 建议 `FinSagent/src/core/ResearchMemory.py`，继承现有 MemoryManager |
| 2 | **OpenViking 503 问题**：0.3.3 openai 库调 BGE-M3 返回 503，是否升级？ | 语义非 P0 阻塞，可后修 |
| 3 | **事实版本**：facts 表用 INSERT 还是 UPDATE？ | INSERT 保留历史，旧版本标记 superseded |
| 4 | **ChatService 集成时机** | 建议 P0 代码写完后再联调 |

## 八、验收标准

1. record_turn() → messages.jsonl / content.md / facts / citations / audit 都有数据
2. get_facts("极氪", "毛利率") → 返回历次讨论的所有事实，带版本
3. retrieve("毛利率") → 跨 session 召回所有相关讨论
4. 重启后数据不丢
5. /memory/retrieve?q=xxx → 200 + JSON
6. /memory/citations?source_type=qa_message&source_id=msg_002 → 返回引用出处

---

**文档：** `docs/research_memory_design.md`（v2 修订版）
**测试：** `test/research_memory/`
**代码（本周启动）：** `FinSagent/src/core/ResearchMemory.py`
