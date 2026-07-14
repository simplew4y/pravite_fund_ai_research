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

### 📝 对话回复 HTML 内嵌预览（2026-07-14）

主对话消息现在会识别两类 Agent HTML 输出：规范的 `html` fenced code block，以及模型实际常见的“单独一行 `html` + 完整 `<!DOCTYPE html>... </html>` 文档”。说明文字仍按 Markdown 展示，HTML 文档则在同一个回答气泡内替换为可滚动预览；非 HTML 代码块、内联标签和尚未闭合的流式文档不会被误提升。

对话预览使用无同源权限的 `sandbox="allow-scripts"` iframe。生成文档会被重新装入带 CSP 的隔离页，保留内联 CSS、JavaScript、SVG、Canvas 和 data/blob 媒体，同时禁止网络请求、外部 frame、worker、对象、表单提交和父页面访问；刷新跳转元数据会在装载前移除。

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
| `private_fund_history_compare` | 比较两个 Memo 版本，或读取观点、假设、风险、催化剂的版本时间线 |
| `private_fund_tracking_list` | 读取当前风险、催化剂、提醒、规则和异步任务状态 |
| `private_fund_watch_upsert` | 新建或更新风险/催化剂追踪规则 |
| `private_fund_alert_acknowledge` | 确认、忽略或稍后提醒一条追踪告警 |

## 📝 历史观点与风险催化剂持续追踪（2026-07-14）

历史追踪不依赖 Claude Code/cc-haha 交互会话常驻。Omnigent API 继续负责项目、页面、工具和鉴权；资料解析仍由 FinSagent pipeline 完成；新增 `private_fund_tracking_worker` 是独立、可恢复的后台 worker，直接复用现有 OpenAI-compatible LLM 客户端，LLM 不可用时退化为确定性提取。任务和结果都保存在项目自己的 `meta/collection.sqlite3`，服务重启不会丢失。

触发分为三类：

1. 资料 pipeline 成功后，按每个当前文档版本写入 `document_ingested` 任务；worker 每个轮询周期也会核对当前文档快照，因此绕过 Omnigent API 的 FinSagent 导入同样会被发现。任务去重键包含 `doc_id + extractor_version`，同一版本重复回调或快照扫描不会重复提取或提醒。
2. Memo 成功生成后，Markdown、HTML、PDF 作为同一个 `memo_version` 登记，并写入 `memo_version_created` 任务。相同主题进入同一 series，显式 `revision_of` 优先决定版本谱系。
3. Worker 每小时写入一次确定性 `scheduled_scan`，用于检查风险/催化剂的预期时间窗口、恢复超时任务和补发到期提醒。页面“立即更新”只写入 `manual_scan`，HTTP 返回 `202 + job_id`，由页面轮询状态，不在请求内等待模型。

Worker 默认每 5 秒轮询队列，每个 dataset 每轮最多处理 5 项；新资料的实际延迟通常是 pipeline 完成后的一个轮询周期。小时任务不是每小时重新处理全部文档，而是扫描当前台账和到期窗口。失败任务带 `attempt_count/max_attempts`，使用 30 秒、2 分钟、10 分钟退避；运行超时的任务会回到 queued。`scripts/manage_omnigent_services.sh start` 会同时启动 `tracking` tmux window。

研究对象按稳定 canonical key 合并，类型包含 `thesis / assumption / risk / catalyst / metric / question`。只有内容、立场、状态、数值、期间、概率、影响或预期窗口实质变化时才创建不可变新版本；每次观察单独保存来源和 `evidence_id`。新资料没有再次提到旧观点只记为“未提及”，不会自动生成 `removed/invalidated`，避免把信息缺省误判为观点反转。

风险与催化剂提醒由 watch rule 决定，内置“全部风险变化”和“全部催化剂变化”两条 event 规则。提醒状态为 `new / acknowledged / dismissed / snoozed`，以 `rule + item + change_event + alert_type` 去重。前端新增“历史变化”和“追踪提醒”工作区：前者支持同系列 Memo 的逐章节比较与观点/假设时间线，后者展示异步任务、当前事项、提醒处理和规则开关。

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

### 📝 研究区右侧资产栏收敛（2026-07-14）

研究工作区右侧默认只保留最近资产列表，并将栏目统一命名为“资产”。旧“研究检查器”和“分析资产”分区不再显示，避免与资料、研究成果和 Memo 工作区中的资产选择入口重复；点击资产继续进入原有详情视图。用于分析的选择能力和底层上下文关系保持不变，仍从资料或研究成果工作区管理。

### 📝 右侧资产筛选、上下文选择与删除（2026-07-14）

本条更新上方右栏决策：研究区右侧“资产”栏目复用统一资产库的紧凑布局，不再限制为 8 项。右栏支持标题/摘要/标签搜索、资产类型筛选、业务文档类型筛选，以及最近更新、最早更新、标题、类型和溯源数量排序。文档资产接口把 pipeline 已有的 `doc_type / doc_subtype / doc_type_confidence / classification_status` 投影到资产 `metadata`，因此可直接按年报、会议纪要、估值模型等受控类型筛选，无需再次分类。

资产复选框恢复为 `research_asset_context` 的唯一选择真源：勾选即加入下一轮对话和资产生成上下文，取消即移出。删除按钮直接作用于当前工作区内已勾选的资产，并继续要求不可撤销二次确认；筛选后全选只改变当前可见结果，同时保留其他类型中已勾选的上下文资产。

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

### 📝 入库业务文档分类与公司核验（2026-07-14）

文件进入增量 pipeline 后，在正式解析和建立索引前先生成有界预览，并区分物理格式 `file_type` 与业务类型 `doc_type / doc_subtype`。受控 taxonomy 当前覆盖财报、业绩公告、会议纪要、估值模型、研究报告、投资者演示、监管公告、财务数据、公司资料、其他和未知；模型不能生成枚举外类型。

分类采用确定性规则优先、LLM 兜底：PDF 读取前五页与最后两页，Excel 读取 Sheet、有限单元格和公式统计，Office/文本格式复用现有 adapter；规则置信度不足、公司缺失或公司冲突时，Omnigent 与 FinSagent API worker 才通过现有 OpenAI-compatible 客户端请求结构化复核。LLM 返回仍由服务端校验 taxonomy，非法输出降级为 `unknown / needs_review`，LLM 不可用时不阻断解析。

`documents` 同步保存子类型、类型置信度、分类状态、方法、taxonomy/classifier 版本、分类证据、公司置信度和公司识别方法。同 checksum 文档只有在分类器版本变化时重新分类，不重复解析正文。高置信度识别出的公司若与当前项目公司冲突，原文件和文档版本继续保留，但状态改为 `classification_review_required` 且不写入检索 chunks，避免跨公司资料污染。左侧资料来源显示业务类型、公司、置信度和待复核状态。

### 📝 对话区动态研究提示（2026-07-14）

私募研究项目首次进入、尚未创建会话时，以及已有研究会话的输入框为空时，都会展示最多四条可点击的研究问题。两个入口复用同一个提示组件与受控模板生成器，不在页面渲染时额外调用 LLM；输入包括项目公司、已入库文件的受控 `doc_type / doc_subtype`、已有分析或 Memo 资产，以及已有会话最近八条用户问题。

排序优先组合当前项目真实具备的资料类型，例如财报与会议纪要对比、估值模型与财报核对、跨资料冲突检查和 Memo 生成或更新。已有 Memo 时不再提示重复生成；最近已经问过的方向会降权；新建空项目直接提示先制定研究框架。点击提示只把完整问题填入当前输入框并聚焦，用户可以继续修改后再发送，界面不显示内部匹配依据，也不会因为点击提示提前创建会话。

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

Skills 存放在 `omnigent/omnigent/resources/private_fund_skills/`，服务启动时打包进 `claude-native-ui`。📝 当前 bundle 显式声明十三个 `private_fund_*` 业务工具；加上按 spec 自动注册的框架工具，`omnigent` MCP Server 在活动回合的完整工具面为 41 个。详细清单见 [`private_fund_skills_and_mcp_tools.md`](private_fund_skills_and_mcp_tools.md)。自定义第三方 API Agent 只有在自己的 spec 中声明对应 builtins 时才会得到相同业务工具面。

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
| `research_memo_series` / `research_memo_versions` / `research_memo_sections` | Memo 系列、不可变版本、章节与版本谱系 |
| `research_items` / `research_item_versions` | 观点、假设、风险、催化剂、指标和问题的稳定实体及不可变版本 |
| `research_item_evidence` / `research_tracking_observations` | 版本证据和每次来源观察记录 |
| `research_change_events` | 可去重的新增、内容、状态、数值与时间窗口变化事件 |
| `research_watch_rules` / `research_alerts` | 持久化追踪规则和提醒生命周期 |
| `research_tracking_jobs` | 事件、手动与小时扫描共用的可恢复异步任务队列 |

新版工作流类型仍为 `agentic_research_graph_v2`，以兼容已有工具和报告版本；产品主界面已升级为资产工作台。旧的固定流程数据不会删除。

## 报告与回溯

报告版本汇总当前图谱节点，并记录使用的每个 `node_version_id` 和文档版本。重新生成报告会创建新版本，不会覆盖旧版本。

### 📝 HTML 资产错位字段兼容（2026-07-14）

图表资产的规范存储位置仍是 `structured_output_json.content_blocks[].html`。考虑到模型可能把完整 HTML/JS 文档误写入 `output_markdown`，保存节点时会识别直接 HTML 与 `html` fenced code block，并自动提升为 `type: html` 内容块；读取历史节点时也会执行同样的非破坏性兼容，不要求迁移已有数据库记录。前端保留第二层兜底：结构化内容块为空、且 Markdown 字段整体是 HTML 文档时，改用带 `allow-scripts` 的 sandbox iframe 渲染。iframe 的 CSP 禁止联网、表单、对象、父页面访问与导航，只允许内联样式、内联脚本和 data URL 图片。
