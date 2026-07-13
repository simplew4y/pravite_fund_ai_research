# 📝 Agent 驱动的私募研究资产工作台

## 设计原则

系统采用“重 Agent、轻流程”的研究方式：

```text
资料问答
-> 用户勾选重要信息
-> Agent 使用 Skills / MCP 检索和核验
-> 勾选内容立即保存为重要信息资产
-> Agent 决定输出类型与结构
-> MCP 保存不可变分析资产版本
-> 用户从资产库勾选下一轮上下文
-> 继续分析并自然形成长期资产与报告
```

系统不预设经营分析、核心假设、变量分析、情景分析或估值等固定步骤。主界面不再以 Canvas 为中心：中间区域固定负责 Agent 输入与输出，右侧资产库负责长期管理。关系图只应作为后续可选的溯源视图。

## 信息选择

用户可以通过两种方式选择信息：

- 在一条 AI 回答下点击“保存为资产”。
- 直接选中回答中的一段文字，在浮层点击“保存为资产”。

选中的信息立即写入 `research_saved_assets`，成为可筛选、可回溯的“重要信息”资产；同时进入本次待生成集合。

## Agent 生成资产

点击“Agent 生成资产”后，系统向当前 Agent 发送生成任务。底层仍通过版本化研究节点保存分析产物，但在产品层统一呈现为资产。

### 📝 任意上下文生成门槛（2026-07-14）

普通研究资产不再要求必须从 AI 回答中勾选“重要信息”。用户选择资产输出类型后，只要存在任意一种上下文即可生成：当前会话中的用户问题、`@raw` / `[Attached:]` 文件和已有回答，AI 重要信息，或资产库中勾选的文档、分析节点、信息、图表、Memo、研报等资产。只有新会话没有内容且没有任何选择时才阻止提交。

当前会话上下文会沿用同一 Agent session 的历史，生成提示词同时带入已选 AI 信息和已选资产的标题、类型与正文摘要；其中分析节点继续映射为父节点关系，其他资产也作为实际内容上下文传给 Agent。页面当前四类生成结果——文本、表格、图表和 Memo——采用同一门槛。所有事实和数字仍必须通过数据集工具重新检索、核验并绑定 `evidence_id`，对话或勾选上下文本身不等同于完成证据核验。

- 用户勾选的回答或文字片段。
- 当前对话中已经发送的用户问题、附件和 Agent 回答。
- 用户在统一资产库勾选的任意类型资产。
- 当前 `dataset_id`。
- 私募资料检索和 source detail MCP。

Agent 根据内容自行决定：

- 标题和摘要。
- `node_type`：`insight`、`hypothesis`、`question`、`risk`、`catalyst`、`comparison` 或 `decision`。
- 父节点关系。
- 标签和置信度。
- 是否需要补充检索或核验资料。

Agent 必须调用 `private_fund_research_node_save`，不能只在聊天中返回节点草稿。

每个重大事实、日期、事件、金额、比例、估值输入和可视化数值都必须绑定可解析的 `evidence_id`。Agent 需先通过 `private_fund_dataset_search` 找到证据，再用 `private_fund_source_detail` 核验真实文件位置；正文中的关键陈述紧跟可点击引用，节点和富内容块同时保存所使用的 `evidence_ids`。无法定位到真实文件与页码、Sheet/单元格、幻灯片或标题位置的内容必须标记为“资料未覆盖/待复核”。

勾选的历史节点只是研究上下文，不自动等同于原始证据。`private_fund_research_context` 会返回节点的 `evidence_sources`、未核验节点列表和引用契约；没有 evidence 的历史节点必须重新检索后才能复述事实。聊天回答禁止复制没有定义的 `[^1]` 裸脚注，必须输出完整的 `[文件名 页码或 Sheet!单元格](内部来源链接)`。

节点正文统一包含：

1. 结论。
2. 支持信息和可点击引用。
3. 不确定性、反证或资料缺口。
4. 下一步值得研究的问题。

节点版本还可以包含 `content_blocks`。Agent 根据内容决定是否使用，不要求每个节点套用同一种模板：

| Block | 适用内容 | 渲染方式 |
|---|---|---|
| `markdown` | 结论、推理、引用和清单 | 安全 Markdown |
| `metrics` | 少量关键指标 | 指标矩阵 |
| `table` | 跨期、跨区域、跨公司的精确比较 | 可横向滚动表格 |
| `chart` | 有可比数值支持的趋势或对比 | 折线图或柱状图 |
| `html` | 模型自主选择图形的图文可视化 | 允许内联 JS、但禁止联网和父页面访问的 sandbox iframe |

`content_markdown` 始终保留，作为长期报告、上下文注入和旧客户端的文本回退。结构化块保存在同一个 `research_node_versions.structured_output_json` 中，因此每次更新仍然可按节点版本回溯，无需新增旁路文件。

“Agent 生成资产”旁提供单选的“资产输出形式”下拉框，第一项和默认项为“普通文本”。其余模式为“Agent 自主判断、关键指标、对比表格、折线趋势、柱状对比、综合图文”。“综合图文”允许 Agent 按证据组合指标、表格、图表、Markdown 或安全静态 HTML；下拉框旁的设置按钮可补充 X 轴、指标、对比对象、时间范围、单位等要求。选择和补充要求只影响本次生成，提交后恢复“普通文本”。指定结构缺少可靠资料时，Agent 必须说明缺少的数据，不得补造数值。

旧节点的折线图和柱状图继续由 Recharts 渲染以保持兼容。新“图表”入口生成自包含 HTML/CSS/JavaScript 图文资产，由模型根据证据关系自主选择折线、柱状、饼图/环形图、面积、散点、雷达、瀑布或热力图，并使用原生 SVG/Canvas 绘制。iframe 只开放内联脚本，CSP 和 sandbox 同时禁止联网、表单、导航、远程资源、存储与父页面访问。

节点详情底部固定显示高对比度的“溯源资料”区域。每条来源都是带“点击查看真实文档位置”提示的按钮；点击后的小弹窗显示真实文件名、PDF 页码或 Excel Sheet/单元格、幻灯片/标题位置、实际文件路径和证据原文。没有绑定可解析证据的旧节点会显示醒目的“尚未绑定可核验来源”警告，而不是让用户误认为内容已经核验。

聊天正文和节点正文中的绿色来源标签使用独立的就地来源弹窗，不复用右侧 Memo/Sources 工作区。点击链接不会改变右侧面板或页面 hash；弹窗锚定在引用附近，自行请求并展示 PDF 原页与高亮，或 Excel Sheet/单元格原始值和公式。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `private_fund_dataset_search` | 检索项目证据 |
| `private_fund_source_detail` | 获取证据完整上下文 |
| `private_fund_research_context` | 读取用户勾选的历史节点 |
| `private_fund_research_node_save` | 保存 Agent 生成的结构化节点 |
| `private_fund_equity_report_generate` | 复用 FinRobot 专业模板和图表生成版本化研报包 |
| `private_fund_equity_report_status` | 查询研报生成 run、错误和产物路径 |
| `private_fund_equity_report_get` | 读取完整研报包、证据索引与版本信息 |

## 📝 FinRobot 对齐架构（2026-07-12）

最终研报采用领域层直接复用：调用仓库内 FinRobot 的 `html_template_professional.py` 和 `chart_generator.py`，生成专业 HTML、Revenue/EBITDA 图、EPS/PE 图，并使用 PyMuPDF Story 输出 PDF。Omnigent 不复用 FinRobot 的 Web 搜索和子进程编排，继续作为数据集检索、`evidence_id`、文档版本、研究节点和报告版本的唯一事实来源。

一次成功生成会在数据集 `reports/` 下写入 Markdown、HTML、PDF、JSON 和图表文件，同时写入 `research_reports`、`research_report_versions` 与 `research_equity_report_runs`。生成前先预留版本；失败 run 保留错误但不会升级当前成功版本；成功后原子提交报告版本、文档快照、节点快照、证据索引和产物清单。

## 📝 页面生成入口与 Skill 路由（2026-07-13）

工作台右上角下拉框统一命名为“生成结果”。原有普通文本、指标、表格和图表选项继续生成研究节点；新增“研究 Memo”和“专业研报”两个确定性文档入口。

- 选择“研究 Memo”后，设置弹窗中的主题与具体要求会作为 `/private-fund-memo` 参数发送，确定调用 `private_fund_dataset_memo`。
- 选择“专业研报”后，同一输入会作为 `/private-fund-report` 参数发送，确定调用 `private_fund_equity_report_generate` 并产出 FinRobot 对齐报告包。
- Memo/研报可以使用用户勾选的回答和资产上下文；若没有任何上下文，必须至少填写主题或具体要求。
- 页面根据 runner 类型选择 Skill 传输方式：in-process runner 发送 `slash_command`，Native runner 保留 `/skill args` 明文交给原生 harness 解析。
- 对话输入框仍支持直接输入 `/private-fund-memo <要求>` 或 `/private-fund-report <要求>`。

### 📝 Skill 可见文本与隐藏上下文边界（2026-07-13）

页面生成 Memo/研报时，聊天气泡只显示 `/private-fund-memo <用户要求>` 或 `/private-fund-report <用户要求>`。`dataset_id`、MCP 调用约束、勾选信息全文和资产上下文必须由 `wrapPrivateFundPromptContext` 包裹后发送；消息渲染通过 `stripPrivateFundPromptContext` 移除该区段。禁止把内部研究上下文直接拼入可见 Skill 参数。

对修复前已持久化的无标记消息，渲染层只在连续匹配 `dataset_id`、`必须调用 private_fund_*`、`所有重大事实和数字必须通过数据集工具核验` 三项契约时移除其后内部区段，从而清理历史回显且避免误删普通用户文本。

### 📝 四类生成结果与自主图表（2026-07-14）

工作台右上角“生成结果”仅保留“文本、表格、图表、Memo”四项。“Agent 自主判断、关键指标、折线趋势、柱状对比、综合图文、专业研报”不再作为页面选项；底层旧资产和 `/private-fund-report` Skill 仍保留兼容，不删除历史产物。

- “文本”生成只有 Markdown 回退正文的分析节点。
- “表格”生成分析节点和一个带证据绑定的 table block。
- “图表”由模型根据内容自主选择图形，生成一个自包含 HTML/CSS/JavaScript 的 html block，同时包含标题、结论、图例、单位、口径、来源说明和可读数据回退。
- “Memo”确定调用 `/private-fund-memo`，产出 Markdown、HTML 和 PDF。

图表脚本只能使用内联已核验数据与原生 SVG/Canvas，不得引用 CDN、外部库或远程资源，不得发起网络请求、访问父页面、提交表单、导航、下载或使用本地存储。所有图中数值仍须通过数据集搜索与 source detail 核验，并在 html block 上绑定直接支持它的 `evidence_ids`。

## 统一资产库与上下文

资产库统一投影原始文档、重要信息、Agent 分析、指标、表格、图表、信息图和 Memo，不复制原始数据。默认列表视图支持全文搜索、类型筛选、最近更新时间/标题/类型/溯源数量排序，并可切换卡片视图。

每行资产的复选框是“加入上下文”操作。统一选择结果写入 `research_asset_context`；分析节点同时同步到兼容表 `research_workflow_context`。下一次普通提问会携带选中资产的标题、类型、正文和可用引用。原始文档资产只传递身份和位置，具体事实仍由 Agent 通过数据集工具检索核验。

父子关系只表达“这个新判断使用了哪些已有节点作为上下文”，不是预设执行顺序。一个节点可以引用多个父节点，图谱因此自然形成 DAG。

## 📝 资产详情 Markdown 渲染（2026-07-12）

重要信息、Markdown Memo 等通用资产不再使用原始 `<pre>` 文本展示。资产详情统一复用 Streamdown 渲染栈，并保留 GFM 表格、标题、列表、引用、代码块、链接安全策略、工作区文件链接和私募溯源弹窗。富内容节点仍通过 `RichNodeContent` 渲染结构化指标、表格、图表和安全 HTML。

### 📝 Memo 文件型资产预览（2026-07-12）

PDF Memo 在资产详情中通过项目 Memo 文件接口直接嵌入浏览器 PDF 预览，接口使用 `Content-Disposition: inline`；HTML Memo 使用无权限 sandbox iframe；Markdown Memo 继续使用 Streamdown。文件系统路径只作为溯源元数据展示，不再替代内容预览。

### 📝 通用文件资产预览（2026-07-12）

文件资产统一按可用能力渲染：PDF 使用完整内嵌阅读器；XLSX/XLS/XLSM/CSV 使用 pipeline 结构化工作簿视图，展示 Sheet、使用区域、单元格与公式信息；DOCX/PPTX/TXT/Markdown 使用 pipeline 已提取的文本片段并交给 Streamdown。路径仅作为溯源元数据，不再作为文件资产的主要内容。

### 📝 宽屏资产详情与 Excel 下钻（2026-07-12）

资产栏默认宽度改为响应式 `620–920px`，详情页可一键展开为整个工作区宽度，适合阅读 PDF 和宽表。Excel 结构化预览支持从工作簿点击 Sheet、从 Sheet 点击区域，再进入真实单元格值与公式表格，并提供逐级返回。

### 📝 资料来源上传与拖入（2026-07-12）

左侧栏项目的“资料来源”标题行提供项目级“上传”按钮；右侧资产库不提供上传入口。点击后在弹窗中选择或拖入多个文件，支持 PDF、XLSX/XLSM、DOCX、PPTX、CSV、Markdown 和 TXT。页面先过滤不支持的格式，再调用项目文件上传接口；上传成功后自动启动增量 pipeline。新资料会先以待处理资产出现，索引完成后自动刷新为可检索资料。

### 📝 上传入口位置纠正（2026-07-12）

上传属于项目原始资料管理能力，因此入口固定在左侧“资料来源”，与现有资料勾选、全选和项目切换保持同一信息架构；右侧继续只负责统一资产浏览、筛选、加入上下文和详情渲染。

### 📝 统一工作台新建项目（2026-07-12）

左侧“研究项目”标题行提供“新建”按钮，不再依赖已删除的项目管理页。弹窗要求项目名称，可选填写 dataset_id、公司名称和股票代码；提交后调用项目创建接口并激活新 dataset，随后直接导航到 `/?private_fund_project=<dataset_id>` 的统一工作台。新项目可立即从左侧“资料来源”上传文档并建立索引。

### 📝 上传索引受控弹窗（2026-07-12）

点击“上传文档”会打开统一上传弹窗，弹窗内支持多文件选择和拖入。上传后页面持续轮询 pipeline job，明确展示上传、排队、解析索引和完成状态。在 `uploading / queued / running / failed` 状态下，右上角关闭、Esc、遮罩点击和底部关闭按钮均被锁定；只有后端返回 `completed` 后才解锁“完成并关闭”。失败时保留弹窗并提供重新选择文件重试，防止未索引资料被误认为可检索。

### 📝 统一研究工作台入口（2026-07-12）

旧 `ResearchProjectsPage` 项目管理 UI 已删除，侧栏“管理 / Research projects”和新会话项目选择器中的旧页面入口一并移除。用户点击研究项目只进入 `/?private_fund_project=<dataset_id>` 或该项目最近会话承载的统一 Agent 研究工作台。历史 `/research-projects` 与 `/research-projects/:datasetId` URL 仅保留兼容重定向，不再渲染旧页面。

### 📝 脚注回链降噪（2026-07-12）

聊天与资产详情保留脚注内容和真实来源链接，但不渲染 Markdown 插件自动生成的 `↩`、`↩2`、`↩3` 返回正文控件。这些回链不属于研究内容，在来源密集的回答中会造成 emoji 式视觉噪音。

### 📝 脚注数字页内定位（2026-07-12）

正文右上角的脚注数字属于当前回答内部导航。点击数字只在当前页面平滑定位到对应来源条目，不再使用普通链接的新标签页行为；来源条目中的 PDF/Excel 链接仍打开就地原文弹窗。

### 📝 脚注数字完全隐藏（2026-07-12）

根据最终交互要求，正文右上角脚注数字也不再展示。主内容只保留研究正文，回复末尾继续保留合并后的来源条目及可点击原文链接。

## 输出 Skills

Claude Native 内置 Agent bundle 携带四个正式 Skill：

| Skill | 触发场景 | 主要产物 |
|---|---|---|
| `private-fund-memo` | 针对单一主题生成或修订短报告 | Markdown、HTML、PDF |
| `private-fund-node` | 把用户勾选的信息生成可复用节点 | 不可变节点版本、证据关系、父节点关系 |
| `private-fund-report` | 把勾选节点汇总为 FinRobot 对齐的长期研究基线 | Markdown、HTML、PDF、JSON、图表和证据索引 |
| `private-fund-report-update` | 用新节点滚动更新已有长期报告 | 新报告版本、`revision_of`、变更日志 |

Skills 存放在 `omnigent/omnigent/resources/private_fund_skills/`，服务启动时打包进 `claude-native-ui`。📝 当前 bundle 显式声明九个 `private_fund_*` 业务工具；加上按 spec 自动注册的框架工具，`omnigent` MCP Server 在活动回合的完整工具面为 37 个。详细清单见 [`private_fund_skills_and_mcp_tools.md`](private_fund_skills_and_mcp_tools.md)。自定义第三方 API Agent 只有在自己的 spec 中声明对应 builtins 时才会得到相同业务工具面。

## SQLite

工作流保存在项目的 `meta/collection.sqlite3`：

| 表 | 作用 |
|---|---|
| `research_workflows` | Agentic 图谱实例 |
| `research_nodes` | Agent 生成的节点元数据和位置 |
| `research_node_dependencies` | 节点的上下文父子关系 |
| `research_node_versions` | 不可变正文、输入资料和结构化字段 |
| `research_node_evidence` | 节点版本与 evidence 的关系 |
| `research_workflow_context` | 用户勾选的下一轮上下文节点 |
| `research_saved_assets` | 用户从回答中长期保存的重要信息和其他轻量资产 |
| `research_asset_context` | 文档、信息、分析、图表和 Memo 共用的上下文选择篮 |
| `research_reports` | 长期报告实体 |
| `research_report_versions` | 报告与节点、文档版本快照 |
| `research_equity_report_runs` | FinRobot 对齐研报的生成状态、错误、版本和产物清单 |

新版工作流类型仍为 `agentic_research_graph_v2`，以兼容已有工具和报告版本；产品主界面已升级为资产工作台。旧的固定流程数据不会删除。

## 报告与回溯

报告版本汇总当前图谱节点，并记录使用的每个 `node_version_id` 和文档版本。重新生成报告会创建新版本，不会覆盖旧版本。
