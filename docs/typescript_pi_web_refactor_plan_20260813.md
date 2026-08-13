# 私募投研工作台 TypeScript + Pi 传统 Web 架构改造方案

> 状态：待评审 / 可执行设计稿
>
> 日期：2026-08-13
>
> 基线：`main@4e576f5`
>
> 实施分支：`codex/ts-pi-web-refactor-20260813`

## 1. 文档目的

本文定义私募投研工作台从 Omnigent Meta-Harness 架构迁移到传统 Web
应用架构的完整方案。目标是在保留当前产品 UI 和核心投研能力的前提下，把运行时
收敛为 React/TypeScript 前端、TypeScript API、TypeScript 后台任务以及受控的
Pi Agent SDK。Python 只保留在 PDF、Office、Excel、行情适配和报告渲染等
TypeScript 不具备明显优势的纯计算边界。

本文同时作为以下工作的共同依据：

- 架构评审与范围确认；
- API、数据库和事件协议设计；
- 前后端和 Agent Worker 实施；
- 旧数据迁移与能力对账；
- 测试、灰度、切换和旧运行时退役；
- 后续任务拆分和验收。

## 2. 执行结论

改造在技术上可行，且仓库历史中已有一套 TypeScript + Pi 迁移原型可供恢复和校验。
最终产品不再是“通用 Agent 平台套私募业务”，而是“私募投研 Web 产品按需调用
Pi Agent”。

核心决策如下：

1. 前端保持当前视觉设计、信息架构和主要交互，不整体重写 UI。
2. TypeScript API 成为唯一 HTTP 控制面和业务权限边界。
3. Pi 通过 Node SDK 嵌入独立 Agent Worker，不通过 CLI、tmux、TUI 或通用
   Harness 路由工作。
4. 项目、资料、证据、资产、Memo、报告、追踪和估值均由确定性服务与数据库管理；
   Agent 不成为业务真值源。
5. Pi 只能调用服务端注册的白名单业务工具，默认不开放任意 shell、裸文件系统、
   数据库或网络访问。
6. 所有长任务进入持久化任务队列，支持幂等、租约、重试、取消和崩溃恢复。
7. Python 收敛为无 HTTP、无鉴权、无业务事务的单请求计算 Sidecar。
8. 迁移采用渐进替换，不在第一阶段删除 Omnigent 源码或不可逆清理旧数据。

## 3. 背景与现状

### 3.1 当前运行架构

当前主链路以 Omnigent 为应用壳和编排层：

```text
Browser / Omnigent Web UI
          |
          v
Omnigent FastAPI Server
          |
          v
Omnigent Host / Runner
          |
          v
Native Harness / Agent Bundle
          |
          +--> Claude / Codex / Pi / OpenCode / ...
          |
          +--> MCP Bridge / Tool Relay / terminal / policies
```

私募业务能力又分散在 FastAPI 路由、Runner、本地 MCP tools、多个 Python Worker、
FinSagent 入库流水线、前端适配器以及 Skills 中。该架构提供了多 Agent、终端、
沙箱和通用编排能力，但产品当前真正需要的是更窄的私募投研能力面。

### 3.2 当前产品核心能力

迁移必须保留的产品能力包括：

- 账号、登录、注册、密码与多租户数据隔离；
- 项目创建、编辑、切换和删除；
- 全局上传、项目上传、资料目录与文档版本；
- PDF、XLSX/XLSM、DOCX、PPTX、CSV、Markdown 和文本入库；
- Evidence 搜索、来源详情、PDF 页图和 Excel 单元格定位；
- 对话、流式回答、停止、继续引导、压缩、恢复和会话分支；
- 研究笔记、研究节点、上下文选择和富内容块；
- Memo、专业报告、历史版本、引用门禁和产物下载；
- 风险与催化剂事项、规则、扫描、时间线和提醒；
- 估值模型系列、版本、对比、Agent 分析和安全派生模型；
- Obsidian 知识投影；
- Skills 的产品级管理能力；
- 中英文界面、桌面打包和本地优先运行。

### 3.3 当前架构的主要问题

1. 产品依赖通用 Server、Host、Runner、Harness、终端、MCP Bridge 多层转发，
   部署和排错成本高。
2. 通用 Agent 能力面大于业务需求，权限边界和故障面随之扩大。
3. 相同业务语义在 API、tool schema、forwarder 和前端事件中重复映射。
4. 业务长任务和 Agent 回合的生命周期容易耦合。
5. Python 同时承担 HTTP、编排、数据和计算职责，不利于统一类型和事务边界。
6. 前端包含大量多 Harness、终端、环境和审批逻辑，但私募产品并不需要完整暴露。
7. Omnigent 上游演进会持续带来与私募定制代码的合并成本。

## 4. 改造目标与非目标

### 4.1 目标

- 将产品重构为标准浏览器前端 + HTTP API + 后台 Worker 架构；
- 让前后端接口、Worker 协议和领域对象尽可能使用共享 TypeScript 类型；
- 将 Pi 限定为少量需要推理、综合和语言生成的功能组件；
- 保留现有 UI 观感和用户工作流；
- 保留本地优先、证据优先、版本不可覆盖和人工复核边界；
- 缩短启动链路，减少常驻服务和运行依赖；
- 建立可恢复、可审计、可测试的业务任务与 Agent 会话；
- 支持未来从 SQLite 单机部署平滑演进到 PostgreSQL 多实例部署。

### 4.2 非目标

- 不重建一个新的通用多 Agent 平台；
- 不追求兼容 Omnigent 的所有公开 API；
- 不保留通用终端、任意代码执行、环境管理和多 Harness 切换 UI；
- 不让 Pi 直接决定数据库事务、租户身份、文件授权或任务最终状态；
- 不在第一阶段全面用 TypeScript 重写成熟的 PDF/Office/Excel 解析算法；
- 不在迁移完成前删除旧数据库、原始文件或可验证的历史产物；
- 不同时进行大规模视觉重设计。

## 5. 架构原则

### 5.1 业务应用优先，Agent 从属

页面动作优先调用明确 API。只有开放式研究、跨证据综合、结构化观点提炼、Memo
草拟和估值解释等问题进入 Pi。CRUD、状态切换、文件上传、规则设置和版本比较不
应绕道 Agent。

### 5.2 权威数据与生成内容分离

原始资料、Document Version、Evidence、Research Asset、Memo Version、估值版本、
追踪事项和任务状态是数据库中的权威事实。Pi session 文件和 Agent 记忆只是生成
过程记录，不能替代业务数据。

### 5.3 最小权限工具面

Pi 不读取客户端传入的租户 ID，不直接打开任意路径，不直接连接数据库，也不获得
环境中的账号密钥。工具调用由 API 使用当前 session 对应的服务端上下文执行。

### 5.4 确定性外壳

所有 Agent 输入和输出都经过 schema、边界和引用校验。Agent 可以建议，但最终写入、
版本创建、任务完成和文件发布由确定性代码执行。

### 5.5 持久化优先

会话事件、operation、job、outbox 和产物登记必须先持久化再对外报告完成。进程内
队列只负责通知，不能成为完成状态的唯一来源。

### 5.6 渐进式替换

前端通过 API Adapter 逐模块切换。迁移期间旧服务可以用于只读对照或影子测试，
但同一业务写操作不能双写两个权威系统。

## 6. 目标总体架构

```text
                         +----------------------+
                         |   React / TypeScript |
                         |   Existing Workbench |
                         +----------+-----------+
                                    |
                         REST / upload / SSE
                                    |
                         +----------v-----------+
                         | TypeScript API / BFF |
                         | Fastify + Zod        |
                         +--+------+-----+------+
                            |      |     |
              +-------------+      |     +----------------+
              |                    |                      |
     +--------v--------+   +-------v---------+   +--------v---------+
     | Control DB      |   | Project Stores |   | Pi Agent Worker  |
     | users/sessions/ |   | evidence/assets|   | AgentSession SDK |
     | events/jobs     |   | workflow/...   |   | allowlist tools  |
     +--------+--------+   +-------+---------+   +------------------+
              |                    |
        durable queue          outbox/events
              |                    |
     +--------v--------+   +-------v----------+
     | TS Job Worker   |   | Obsidian Worker |
     +--------+--------+   +------------------+
              |
       NDJSON over stdio
              |
     +--------v--------------------+
     | Python Compute Sidecar      |
     | PDF/Office/Excel/market/PDF |
     +-----------------------------+
```

### 6.1 运行进程

建议常驻三个 Node 进程：

| 进程 | 职责 |
|---|---|
| `api` | HTTP、鉴权、租户、SSE、业务服务、Agent Worker 监督 |
| `job-worker` | 消费持久化任务、调用计算 Sidecar、投影业务结果 |
| `obsidian-worker` | 消费 outbox、生成和协调受管 Markdown |

按需进程：

| 进程 | 所有者 | 生命周期 |
|---|---|---|
| `pi-agent-worker` | API | 首次会话需要时启动；API 停止时退出 |
| `python-compute-worker --once` | API 或 Job Worker | 单请求、单响应，完成即退出 |

如初期不需要 Obsidian，可把投影合入 Job Worker，进一步减少一个进程；但为了隔离
Vault 文件系统故障，长期仍建议独立。

## 7. 建议代码组织

```text
apps/
  web/                    # 从 omnigent/web 迁移或保留原目录后逐步改名
  api/                    # Fastify API / BFF
  agent-worker/           # Pi SDK 会话进程
  job-worker/             # durable jobs
  obsidian-worker/        # knowledge projection
  desktop/                # Electron 壳，仅负责拉起本地 Web 服务

packages/
  contracts/              # Zod schema、API DTO、event、worker protocol
  core/                   # ID、Clock、错误、路径与 TenantContext
  auth/                   # cloud/development auth
  db/                     # Control DB、session/event/job repositories
  research-store/         # Document/Evidence/Asset/Source Folder
  workflow-store/         # workflow/tracking/valuation/Obsidian outbox
  agent-runtime/          # Pi adapter、event mapper、tool registry
  job-queue/              # lease/retry/idempotency
  compute-client/         # Python stdio client
  compute-projector/      # compute result -> TS transaction
  legacy-migrator/        # 只读旧库迁移

python/
  compute-worker/         # 纯计算 Sidecar
```

### 7.1 Monorepo 规则

- npm workspaces + TypeScript project references；
- Node 版本统一锁定，建议 `>=22.19`，以便使用稳定的 `node:sqlite`；
- 所有跨进程消息在 `packages/contracts` 定义；
- 包之间禁止通过相对路径读取彼此源码；
- API 不 import 前端实现，前端不复制后端 schema；
- Python 协议生成 JSON Schema，并由 TS/Python 双方校验；
- `dist/`、`.build/`、虚拟环境和发布包不作为源码提交。

## 8. 前端改造方案

### 8.1 保留内容

优先保留以下现有 UI：

- 视觉主题、CSS variables、字体和响应式布局；
- 左侧项目、资料、会话与上传区域；
- 中央对话流、输入框、生成控制和建议问题；
- 右侧来源、笔记、Memo、估值、历史和追踪面板；
- 文档预览、PDF 页定位、Excel 单元格定位；
- 富内容块、指标、表格和图表渲染；
- 登录、注册、设置和中英文文案；
- 当前风险/催化剂瀑布流和估值工作流界面。

### 8.2 需要替换的内部层

- `privateFundApi`：改为 canonical TS API client；
- `chatStore`：从 Omnigent conversation/item 模型收敛为 session/event/operation；
- SSE：统一使用 `/v1/sessions/:id/events`，支持 `Last-Event-ID`；
- capability：改为产品功能标志，不再以 Harness 能力推导页面；
- session 创建：只创建 Pi session，不展示 Agent picker；
- source panel：读取 canonical evidence/document endpoint；
- upload：使用统一 multipart 与 durable job 状态；
- Skills 页面：保留业务 Skill 管理，不暴露通用 Agent bundle 概念。

### 8.3 应删除或隐藏的 UI

- 多 Agent/Harness 选择；
- Host、Runner、环境、终端、worktree 和文件浏览器；
- Claude/Codex/Pi TUI 镜像；
- 通用 MCP Server 配置；
- Harness-specific model/mode/approval UI；
- 通用子 Agent 树，除非后续明确设计成产品级研究任务。

### 8.4 前端事件模型

统一 envelope：

```ts
interface SessionEvent {
  sessionId: string;
  sequence: number;
  type: string;
  timestamp: string;
  operationId: string | null;
  payload: Record<string, unknown>;
}
```

首期需要渲染的事件：

| 类型 | 用途 |
|---|---|
| `operation.started` | 回合开始 |
| `assistant.text.delta` | 文本流 |
| `assistant.reasoning.status` | 仅显示简短思考状态，不持久化 CoT |
| `tool.started` | 产品级工具状态 |
| `tool.completed` | 工具摘要及引用 |
| `citation.added` | 来源卡片 |
| `artifact.created` | Memo/报告/表格等产物 |
| `operation.completed` | 回合完成 |
| `operation.failed` | 可恢复错误 |
| `operation.interrupted` | 用户停止 |
| `session.compacted` | 上下文压缩完成 |

前端必须能够先 REST replay 再接 SSE，并根据 `sequence` 去重和补洞。

## 9. TypeScript API 设计

### 9.1 技术选择

- Fastify：HTTP、插件、multipart 和结构化日志；
- Zod：请求、响应、事件和数据库 JSON 字段校验；
- `node:sqlite`：首期本地/桌面 Control DB 与 Project DB；
- 原生 `fetch`：Cloud Account 和模型网关；
- SSE：会话流和任务状态增量；
- OpenAPI：从路由 schema 生成文档，但共享 Zod contract 是源码事实来源。

### 9.2 API 领域划分

建议 canonical 路由如下：

```text
/auth/*
/v1/me
/v1/account/*

/v1/projects
/v1/projects/:projectId
/v1/projects/:projectId/documents
/v1/projects/:projectId/source-folders
/v1/projects/:projectId/evidence
/v1/projects/:projectId/assets
/v1/projects/:projectId/workflow
/v1/projects/:projectId/tracking
/v1/projects/:projectId/valuation

/v1/uploads
/v1/uploads/batches
/v1/uploads/items

/v1/sessions
/v1/sessions/:sessionId
/v1/sessions/:sessionId/messages
/v1/sessions/:sessionId/events
/v1/sessions/:sessionId/operations
/v1/sessions/:sessionId/steer
/v1/sessions/:sessionId/interrupt
/v1/sessions/:sessionId/compact
/v1/sessions/:sessionId/fork
/v1/sessions/:sessionId/resources
/v1/sessions/:sessionId/attachments

/v1/jobs
/v1/jobs/:jobId
/v1/jobs/:jobId/cancel
```

### 9.3 API 错误模型

所有错误返回稳定结构：

```json
{
  "error": "session_busy",
  "message": "The session already has an active operation",
  "requestId": "req_...",
  "details": {}
}
```

核心状态码：

- `400` schema 或业务输入错误；
- `401` 未认证；
- `403` 已认证但不允许；
- `404` 不存在，跨租户资源也返回 404；
- `409` 版本冲突、同会话并发或幂等冲突；
- `413` 上传/内容超限；
- `422` 文件已接收但无法安全处理；
- `499` 客户端取消的内部状态，可对外映射 409/200；
- `503` Agent/Compute 暂不可用。

### 9.4 幂等性

- 会话消息要求 `clientMessageId`；
- job enqueue 要求 `idempotencyKey`；
- 上传批次要求 `Idempotency-Key`；
- 业务写工具携带显式 idempotency key；
- 同一 key + 同一请求返回已有结果；
- 同一 key + 不同请求返回 `409 idempotency_conflict`。

## 10. Pi Agent 集成

### 10.1 集成方式

使用 `@earendil-works/pi-coding-agent` 或迁移时确认的官方兼容包，通过
`createAgentSession()` 在 Node Worker 内创建 session。禁止将 Pi TUI 作为产品
运行时，也不使用 `pi --mode rpc` 作为默认集成。

采用 SDK 的原因：

- 直接获得 TypeScript 类型；
- 能订阅结构化事件；
- 能显式注入 model、session manager、system prompt、skills 和 tools；
- 不需要解析终端输出；
- 可关闭默认工具和资源自动发现；
- 便于实现 session 隔离、停止、压缩和恢复。

### 10.2 Worker 模型

推荐一个共享 Agent Worker 进程、每个产品 session 一个独立 Pi `AgentSession`：

```text
API process
   |
   +-- child_process.fork(agent-worker)
             |
             +-- Map<sessionId, PiAgentSession>
```

为什么不直接把 Pi 放在 API 进程：

- Pi 或 provider SDK 崩溃不应终止 API；
- 可限制 Agent 子进程环境变量；
- 可统一中断与超时；
- 可在 worker 崩溃后把活跃 operation 收敛为失败并干净重启。

为什么不每个 session 一个 OS 进程：

- 内存和启动成本更高；
- 本地桌面多会话时进程管理复杂；
- Pi `AgentSession` 本身已经提供会话隔离。

若真实压测证明单 Worker 成为瓶颈，再按一致性 hash 扩展成小型 Worker Pool。

### 10.3 Pi 会话能力映射

| 产品动作 | Pi SDK |
|---|---|
| 发送消息 | `session.prompt()` |
| 运行中引导 | `session.steer()` |
| 停止 | `session.abort()` |
| 压缩 | `session.compact()` / `abortCompaction()` |
| 流式事件 | `session.subscribe()` |
| 恢复 | `SessionManager.open()` |
| 释放 | `session.dispose()` |

### 10.4 默认关闭的 Pi 能力

- 默认 coding tools；
- bash、任意 read/write/edit；
- 自动加载用户全局 extensions；
- 自动加载未知 context files；
- 自动加载未知 skills；
- 浏览器传入 provider endpoint 或 API key；
- Agent 直接创建任意子 Agent。

### 10.5 白名单工具

首期工具：

| Tool | 权限 | 说明 |
|---|---|---|
| `evidence.search` | 只读 | 当前项目候选证据搜索 |
| `evidence.get` | 只读 | 批量读取限定长度的来源详情 |
| `workspace.list` | 只读 | 列出授权的逻辑资源集合 |
| `workspace.read` | 只读 | 读取指定资源的有界内容 |
| `research.save` | 写 | 保存结构化研究资产/节点 |
| `job.enqueue` | 写 | 创建允许类型的长任务 |
| `job.get` | 只读 | 查询当前项目任务 |

可在后续加入：

- `tracking.list`、`tracking.watch.upsert`；
- `valuation.get`、`valuation.analysis.save`；
- `memo.history.compare`；
- `skills.load`。

不应为了兼容旧 MCP 名称而复制 42 个工具。页面可直接完成的动作不进入 Pi 工具面。

### 10.6 工具 RPC 安全边界

工具消息只携带：

```ts
interface AgentToolRequest {
  requestId: string;
  sessionId: string;
  operationId: string;
  toolCallId: string;
  tool: AllowedToolName;
  arguments: unknown;
}
```

API 根据 `sessionId` 查出内部 `TenantContext` 和 `projectId`。任何客户端、prompt
或 Agent arguments 中的 `userId/dataNamespace/projectId` 都不能覆盖服务端绑定。

### 10.7 Skills 策略

Skills 仍可保留，但定位改为产品提示模板，不承担数据权限或事务逻辑：

- 内置 Skills 由应用版本管理；
- 用户 Skills 先通过 metadata/schema/大小校验，再注入专属 session；
- 每个 Skill 显式声明允许工具集合；
- Skill 文本不能扩大服务端工具权限；
- Skill 更新要记录版本和 checksum；
- Memo、Report、Tracking、Valuation 的强制规则仍在服务端校验。

## 11. 会话、Operation 与事件持久化

### 11.1 三个不同概念

- `session`：长期对话容器；
- `operation`：一次 prompt、compact 或后台 Agent 动作；
- `event`：operation 产生的有序事实。

### 11.2 并发规则

- 同一 session 同时只允许一个活跃 prompt/compact operation；
- 不同 session 可以并发；
- `steer` 只能发送到运行中的 prompt；
- `interrupt` 幂等；
- 同 session 运行中发送另一普通消息返回 409，不静默排队；
- UI 可以明确提供“运行中追加指令”，映射到 steer。

### 11.3 崩溃恢复

- API 启动时将遗留 `running` operation 标记为 `failed/control_plane_restart`；
- Agent Worker 退出时，API 标记其已确认但未完成的 operation 为失败；
- Pi session 文件保留，下一次消息可重新打开；
- 已持久化 assistant delta 可以标记为 partial，但不能冒充完成答案；
- SSE 断线不影响 Agent 回合；客户端按 sequence 恢复。

### 11.4 事件写入顺序

```text
Pi event
  -> normalize and validate
  -> append session_events transaction
  -> update operation/session projection
  -> publish in-memory notification
  -> SSE subscriber receives event
```

内存通知丢失时，客户端依然可以从数据库 replay。

## 12. 数据库与领域模型

### 12.1 首期存储策略

保持当前本地优先模型：

- 一个 Control DB：用户 namespace、项目目录、session、operation、event、job、upload；
- 每租户/项目一个 Project DB：documents、evidence、assets、workflow、tracking、
  valuation、memo、outbox；
- 原始文件和产物保存在项目受管目录；
- SQLite 开启 WAL、foreign keys、busy timeout 和 trusted schema off。

### 12.2 未来云部署

如果需要多 API 实例或跨机器 Worker：

- Control DB 迁移 PostgreSQL；
- Project DB 可先继续按租户单写，或整体迁入 PostgreSQL；
- SSE fanout 使用 Redis/NATS/Postgres LISTEN；
- job claim 使用数据库行锁/skip locked；
- 文件转对象存储；
- Pi Worker 单独部署并通过内部 RPC 通信。

首期不要为了潜在云规模牺牲本地部署简单性，但 repository 接口不能泄漏 SQLite
特有类型给业务层。

### 12.3 核心不变量

1. `dataNamespace` 是稳定的本地数据目录身份，邮箱不是目录名。
2. 所有项目级表都能追溯到唯一项目和租户 namespace。
3. 文档新内容创建新 version，绝不覆盖旧 version。
4. Evidence ID 必须绑定 document version 和 locator。
5. Memo/report/derived model 创建不可变版本和 checksum。
6. 任务只有持有当前 lease token 的 Worker 才能提交完成。
7. 任何 Project DB 写入与 outbox 写入处于同一事务。

## 13. 文档、Evidence 和计算 Sidecar

### 13.1 Python 保留范围

建议保留：

- PyMuPDF PDF 文本与页面图；
- openpyxl XLSX/XLSM 抽取和安全派生；
- DOCX/PPTX 解析中稳定的 Python 实现；
- ReportLab 等 PDF 生成；
- AKShare 等行情适配器。

建议迁到 TypeScript：

- 上传控制面；
- 类型识别与任务提交；
- 文档/version/evidence 数据库事务；
- 搜索 API 和分页；
- checksum、路径和响应校验；
- 任务状态与错误映射。

### 13.2 Sidecar 协议

```text
Node spawn(worker.py --once)
  stdin:  one ComputeRequest NDJSON
  stdout: one ComputeResponse NDJSON
  stderr: bounded diagnostic log
```

要求：

- 输入和输出目录必须为绝对路径且属于授权项目目录；
- 拒绝符号链接逃逸；
- 设置超时、stdout/stderr 上限和产物大小上限；
- Python 不接收 Cookie、租户 token、模型 API key 或 DB 凭证；
- Node 校验产物路径、checksum 和 schema 后再提交数据库事务；
- Sidecar 不直接把任务标记为完成。

### 13.3 Evidence contract

统一 locator：

```ts
type EvidenceLocator =
  | { kind: "pdf_page"; page: number; bbox?: number[] }
  | { kind: "excel_cell"; sheet: string; cell: string; formula?: string }
  | { kind: "excel_range"; sheet: string; range: string }
  | { kind: "document_heading"; heading: string; paragraph?: number }
  | { kind: "slide"; slide: number }
  | { kind: "text_lines"; start: number; end: number };
```

Pi 回答中的引用必须解析到当前项目允许的 Evidence ID；不存在、历史版本不允许或
locator 无效的引用不能渲染成已验证来源。

## 14. 持久化任务系统

### 14.1 Job 类型

- `document.ingest`；
- `memo.generate`；
- `report.generate`；
- `tracking.scan`；
- `valuation.extract`；
- `valuation.compare`；
- `valuation.derive`；
- `market.refresh`；
- `obsidian.project`。

### 14.2 状态机

```text
queued -> running -> completed
                  -> failed -> queued (retry)
queued/running -> cancelled
```

字段至少包括：

- `attempt/maxAttempts`；
- `availableAt`；
- `leaseOwner/leaseExpiresAt/leaseToken`；
- `idempotencyKey`；
- `payload/result/error`；
- `createdAt/startedAt/completedAt/updatedAt`。

### 14.3 可靠性要求

- claim 原子化；
- Worker 周期 heartbeat；
- lease 过期后可由其他 Worker 重新领取；
- retry 使用有界指数退避；
- handler 必须能以同一个 job 重放；
- 产物使用临时文件 + fsync/rename 或等效原子写；
- 数据库投影按 job ID/产物 checksum 幂等。

## 15. 业务模块归属

| 模块 | 确定性服务 | Pi 参与 |
|---|---|---|
| 项目与资料 | API/Repository | 不参与 |
| 文档分类 | 规则 + 可选结构化模型调用 | 只在规则不明确时 |
| Evidence 搜索 | Search service | 选择搜索词和复核来源 |
| 普通问答 | 会话服务 | 检索、综合、回答 |
| 研究资产 | Asset service | 生成候选结构，服务端校验保存 |
| Memo | Job + renderer + citation gate | 证据综合和草拟 |
| 专业报告 | Job + renderer | 章节草拟和研究综合 |
| 历史比较 | Deterministic diff | 解释变化，可选 |
| Tracking | Repository + scheduled job | 新资料变化归纳 |
| 估值抽取 | Deterministic compute first | 异常解释和影响分析 |
| 派生模型 | Safe workbook transformer | 提出修改建议，不直接写原模型 |
| Obsidian | Outbox projector | 不参与文件同步 |

## 16. 鉴权、租户与安全

### 16.1 身份来源

- production/cloud：服务端通过 Cloud Account 验证 Cookie；
- development：显式配置固定本地用户和 UUID namespace；
- 禁止根据 Cloud 服务不可达自动降级为本地用户；
- 禁止客户端提交 `dataNamespace` 决定访问目录。

### 16.2 Cookie

- `HttpOnly`；
- `SameSite=Lax`；
- production 使用 `Secure`；
- refresh token 加密存储；
- logout 后服务端和本地 session 同时失效。

### 16.3 文件安全

- 所有路径先 lexical resolve，再 realpath 校验；
- 拒绝 NUL、`..` 逃逸、绝对路径注入和 symlink 越界；
- 上传采用流式限额，不把整文件读入内存；
- ZIP/Office 检查压缩炸弹边界；
- 文件下载设置准确 content type、disposition 和 nosniff；
- HTML 产物 sandbox 展示，不执行脚本、表单或远程资源。

### 16.4 Agent 安全

- 子进程环境使用 allowlist，而不是继承全部 `process.env`；
- Cloud cookie secret、refresh token 不传给 Pi；
- 模型访问使用与 user/project/session 绑定的短期 lease；
- tool arguments 做 schema 与业务授权双校验；
- tool 超时、取消和最大并发受控；
- 日志不得输出 prompt 中的秘密或 provider token；
- 高风险写操作仍由 UI 直接调用 API 并要求用户确认。

## 17. 可观测性

### 17.1 结构化日志

统一字段：

```text
timestamp, level, service, requestId, userIdHash, tenantNamespaceHash,
projectId, sessionId, operationId, jobId, event, durationMs, errorCode
```

原始文件内容、完整 prompt、Cookie、token 和密钥禁止进入普通日志。

### 17.2 指标

- HTTP latency/error/active requests；
- SSE connections/reconnect/backlog；
- active Pi sessions/turn duration/tool calls/provider failures；
- job queue depth/lease expiration/retry/dead jobs；
- compute duration/output size/failure kind；
- ingest throughput/evidence count；
- citation pass/repair/review ratio；
- tracking/valuation scan freshness；
- Obsidian outbox lag/conflict count。

### 17.3 健康检查

- `/health/live`：进程事件循环可响应；
- `/health/ready`：数据库、必要目录和 schema 可用；
- API ready 不应依赖当前有可用模型；
- Worker ready 应验证数据库和 Compute Worker health；
- provider 状态单独暴露，避免模型故障触发 API 无限重启。

## 18. 数据迁移方案

### 18.1 原则

- 迁移器只读旧库，写新库；
- 迁移前创建文件与 SQLite 一致性备份；
- 迁移有 manifest、checkpoint、dry-run 和 resume；
- 每张表记录源行数、目标行数、checksum 和 quarantine 数；
- 二次执行必须幂等；
- 旧文件不移动、不覆盖；
- Evidence ID 如需转换，保存完整映射表。

### 18.2 迁移对象

- 用户 namespace 与账号映射；
- 项目注册、当前项目和目录；
- documents、versions、chunks/pages/cells/facts；
- research assets、versions、evidence relations 和 context selection；
- sessions、messages、可恢复的引用与产物；
- Memo/report series 与 versions；
- workflow nodes、assumptions 和报告；
- tracking items/versions/rules/alerts/jobs；
- valuation series/versions/metrics/diffs/analyses/derived models；
- Obsidian outbox、registry 和冲突；
- 上传批次和仍有业务价值的任务记录。

### 18.3 不直接迁移的运行时对象

- Host/Runner 状态；
- tmux terminal；
- native harness bridge；
- MCP tool relay；
- 临时 approval/elicitation；
- provider 内部 session 状态，除非能够稳定转换为只读聊天历史；
- 无业务引用的临时缓存。

### 18.4 对账报告

每个 namespace/project 生成：

```json
{
  "source": {},
  "target": {},
  "rowCounts": {},
  "checksums": {},
  "evidenceMappings": {},
  "missingArtifacts": [],
  "quarantinedRows": [],
  "warnings": []
}
```

任何不可解释的丢行、Evidence 断链或当前版本指针变化都阻止切换。

## 19. 现有 TS/Pi 原型的使用策略

仓库历史中存在 `codex/ts-pi-full-migration` 和保存在 Git stash 第三个父提交中的
未跟踪源码快照。它包含 `apps/*`、`packages/*`、Python compute worker、React TS
API adapter、兼容矩阵和大量测试。

正确使用方式：

1. 将该快照视为可复用实现来源和测试资产，不视为可直接发布的最终分支；
2. 在独立临时 worktree 中恢复，禁止直接对当前脏工作区执行 `stash pop`；
3. 按模块 cherry-pick/拷贝源码，而不是把整个旧 Omnigent retirement 改动一次合并；
4. 先恢复 contracts/core/db/agent-runtime，再恢复 API 和 Worker；
5. 以当前 `main` 的 UI、账号、Skills 市场、i18n、追踪和估值功能为产品真值；
6. 重新运行全部测试，不能沿用旧文档中的“已完成”声明代替当前验证。

特别注意：当前工作区未跟踪的 `apps/`、`packages/` 和 `python/` 中主要是编译产物和
依赖，不是完整源码。实施前需要决定将其归档还是在确认可重建后清理，但不能把它们
误作为源码提交。

## 20. 分阶段实施计划

### Phase 0：恢复、冻结与审计（3–5 天）

交付物：

- 在临时 worktree 恢复 TS/Pi 原型完整源码；
- 冻结当前 `main` API、SQLite schema、关键页面和黄金资料；
- 列出当前能力与目标 disposition：替代、保留、主动退役；
- 生成旧原型与当前 main 的重叠文件和功能差异；
- 确认 Node、Pi SDK、SQLite 和 Python 版本；
- 形成可执行 backlog。

退出条件：

- 无未分类关键路由、表和页面能力；
- 原型可以独立安装、typecheck，或有明确的修复清单；
- 数据备份与测试 fixture 可用。

### Phase 1：平台骨架（1 周）

交付物：

- npm workspaces、contracts、core、db；
- Fastify API、development auth、错误模型和 request ID；
- Project CRUD；
- session/operation/event 基础表；
- React API runtime adapter；
- 服务启停脚本和健康检查。

退出条件：

- 前端能通过 TS API 创建/切换项目；
- A/B 租户隔离测试通过；
- API 重启不损坏数据。

### Phase 2：Pi 会话最小闭环（1 周）

交付物：

- Agent Worker 和 IPC；
- Pi SDK session create/resume/prompt/steer/interrupt/compact；
- 持久化 event + SSE replay；
- 最小 `evidence.search/get` 假实现或 fixture；
- 前端聊天适配。

退出条件：

- 16 个不同 session 并发不串流；
- 同一 session 背压正确；
- SSE 断线恢复无重复显示；
- Worker crash 后 operation 收敛并可新建回合。

### Phase 3：资料与 Evidence（1–2 周）

交付物：

- multipart upload、document/version/source folder；
- durable job queue；
- Python compute protocol；
- 多格式 ingest；
- evidence search/detail、PDF page、Excel cell/range；
- 当前资料 UI 和来源面板接线。

退出条件：

- 黄金 PDF/XLSX/XLSM 和其他格式对账通过；
- 跨租户文件不可探测；
- Pi 回答中的引用可点击到原位置。

### Phase 4：研究资产、Memo 与报告（1 周）

交付物：

- asset/version/context；
- Memo/report jobs；
- citation gate；
- HTML/PDF/JSON artifact；
- 版本与比较 API；
- 对应 UI 全量切换。

退出条件：

- 旧版本不覆盖；
- 事实句引用校验可重复；
- job 重放不生成重复 current version。

### Phase 5：Tracking、Valuation、Obsidian（1–2 周）

交付物：

- tracking items/versions/rules/alerts；
- valuation series/version/diff/analysis/derive；
- scheduled jobs；
- Obsidian outbox/projector；
- 当前三类 UI 完整接线。

退出条件：

- stale lease 恢复与幂等通过；
- 派生模型永不覆盖源 workbook；
- Obsidian 手写 USER 区保持不变。

### Phase 6：账号、Skills、i18n 和桌面发布（1 周）

交付物：

- Cloud Account proxy；
- Skills 市场/安装/启用的产品化实现；
- 中英文文案对齐；
- Electron 启停 API/Worker；
- macOS/Windows 打包与 smoke test。

退出条件：

- 云账号和本地 development 模式均通过；
- 打包产物不依赖 Omnigent/cc-haha/tmux；
- 用户数据目录升级与卸载边界明确。

### Phase 7：数据迁移、灰度和退役（1 周）

交付物：

- offline migrator；
- 逐项目 reconciliation report；
- 影子读与回归；
- 切换 runbook；
- Omnigent runtime 退役清单。

退出条件：

- 关键能力验收全部通过；
- 生产数据备份验证成功；
- 新入口不启动 Server/Host/Runner/tmux bridge；
- 观察期内无需要回退的数据问题。

## 21. 测试策略

### 21.1 单元测试

- Zod contract；
- ID、路径、TenantContext；
- repositories 和事务；
- Pi event mapper；
- tool allowlist；
- job 状态机和租约；
- compute response 校验；
- citation gate；
- deterministic diff。

### 21.2 集成测试

- Fastify inject 路由；
- API + SQLite；
- API + fake Agent Worker；
- API + real Pi session with fake model；
- Job Worker + fake/real compute；
- upload -> ingest -> evidence -> preview；
- Memo/report/tracking/valuation projection；
- Obsidian outbox/reconcile。

### 21.3 安全测试

- A/B/C tenant isolation；
- path traversal 和 symlink；
- upload size、zip bomb、恶意文件名；
- Client 伪造 project/namespace；
- Agent tool 越权和 schema bypass；
- Cookie flags、refresh/logout；
- token/log 泄漏扫描；
- HTML artifact sandbox。

### 21.4 可靠性测试

- API 重启；
- Agent Worker crash；
- Job Worker crash/lease expiry；
- Compute hang/large stdout/invalid JSON；
- SSE 5000+ backlog 与重连；
- 16/32 session 并发；
- 同 session 重复消息和 interrupt race；
- 磁盘满、只读 Vault、损坏 Project DB 的明确失败。

### 21.5 UI 回归

- 关键页面截图对比；
- 创建项目、上传、提问、引用、保存节点、生成 Memo；
- Tracking/Valuation 主路径；
- 中文/英文；
- Desktop packaged smoke；
- 浏览器刷新、跨页导航和错误恢复。

## 22. 验收标准

### 22.1 功能

- 当前高优先级产品功能均有 canonical TS API；
- Pi 问答能搜索、复核并展示真实 Evidence；
- Memo、报告、追踪、估值和 Obsidian 具备可恢复任务；
- 当前 UI 核心布局和工作流没有明显退化；
- 不再需要用户选择通用 Harness。

### 22.2 架构

- 浏览器只访问 TS API；
- API 是唯一身份和租户边界；
- Pi 无直接 DB、任意 FS 和任意网络权限；
- Python 不监听 HTTP、不持有业务事务；
- 长任务不依赖 Pi 会话常驻；
- Omnigent Server/Host/Runner/tmux/MCP Bridge 不在新进程清单。

### 22.3 数据

- 迁移行数、checksum、当前版本指针和 Evidence 引用闭合；
- 原始文件、旧版本和产物未被覆盖；
- 二次迁移幂等；
- 跨租户不可枚举、不可读取、不可下载。

### 22.4 性能建议值

- 常规 API p95 < 300 ms；
- 本地 Evidence search p95 < 800 ms；
- SSE 首事件 < 1 s（不含 provider 首 token）；
- UI 首屏不因 Pi Worker 未启动而阻塞；
- 16 并发 session 不串流、不丢 durable event；
- 1000 个排队 job 下 claim 延迟可控且不全表锁死。

### 22.5 发布

- typecheck、unit、integration、security 和 packaged smoke 全绿；
- 新机器安装不依赖 uv 管理整个主服务、tmux 或 cc-haha；
- macOS/Windows 数据目录和升级策略通过；
- 回滚不会要求把新库直接交给旧运行时写入。

## 23. 灰度、切换和回滚

### 23.1 灰度

推荐顺序：

1. 新 API 读取迁移副本，前端内部测试；
2. 用冻结问题集比较 Evidence、回答和产物；
3. 内部用户使用新系统写入新库；
4. 观察 job、citation、provider、SSE 和资源指标；
5. 冻结旧系统写入，执行最终增量迁移；
6. 切换正式入口；
7. 保留旧数据只读备份，不保留双写。

### 23.2 回滚边界

安全回滚是把入口切回旧应用并恢复切换前旧库快照。不能让旧运行时继续写已经被新
schema 升级过的数据库，也不能把新系统写入的产物目录直接交给旧服务继续修改。

回滚触发条件建议包括：

- 数据对账出现不可解释差异；
- Evidence 链接大面积失效；
- 跨租户或路径安全问题；
- job 大规模无法恢复；
- provider 正常但 Agent Worker 系统性失败；
- 关键页面阻塞核心研究流程。

## 24. 旧运行时退役清单

迁移验收完成后才执行：

- 从默认启动清单移除 LiteLLM（若模型网关已由云端统一提供）；
- 移除 Omnigent Server、Host、Runner；
- 移除 Claude/Codex/Pi native bridge 和 transcript forwarder；
- 移除 tmux 运行依赖；
- 移除 cc-haha 运行依赖；
- 关闭通用 terminal/environment/MCP/policy routes；
- 前端删除 Harness picker 和 terminal UI；
- 桌面壳只管理 TS 服务；
- 更新 README、部署脚本、CI、安装包和故障手册；
- 保留旧源码/基线用于审计一段时间，再决定归档方式。

不要在同一提交中同时完成数据迁移、运行时切换和旧源码物理删除。应至少拆成：

1. 新架构可用；
2. 入口切换；
3. 退役验证；
4. 旧代码归档/删除。

## 25. 工作量估算

在复用历史 TS/Pi 原型的前提下：

| 范围 | 双人估算 | 单人估算 |
|---|---:|---:|
| 恢复、审计、骨架 | 1–1.5 周 | 2–3 周 |
| Pi、会话、SSE | 1 周 | 1.5–2 周 |
| 资料、Evidence、计算 | 1–2 周 | 2–3 周 |
| Memo/Report/Tracking/Valuation | 1.5–2 周 | 3–4 周 |
| 前端适配、账号、Skills、桌面 | 1–1.5 周 | 2–3 周 |
| 迁移、灰度、退役 | 1 周 | 1.5–2 周 |

综合：双人约 4–7 周，单人约 8–12 周。估算不包含新的产品功能和大规模 UI
重设计，也不包含生产云基础设施从零建设。

## 26. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 历史原型与当前 main 漂移 | 高 | 高 | 模块化恢复，当前 UI/业务为真值，重新验收 |
| 数据迁移遗漏隐式关系 | 中 | 高 | 冻结 schema、逐表矩阵、引用闭合和 checksum |
| 前端过度绑定旧 event/item | 高 | 中 | 先做 Adapter/Event Mapper，不直接散改组件 |
| Pi SDK 升级破坏接口 | 中 | 中 | 固定版本并封装 `AgentPort`，契约测试 |
| Agent 工具权限扩大 | 中 | 高 | no default tools + allowlist + server binding |
| SQLite 多 Worker 锁竞争 | 中 | 中 | WAL、短事务、单写 Worker、压测；云端再迁 PG |
| Python Sidecar 性能不足 | 中 | 中 | job 并发池、超时、请求粒度、基准测试 |
| Skills 规则只存在 prompt | 高 | 高 | 强约束下沉到服务端 validator/citation gate |
| 一次性切换范围过大 | 中 | 高 | 纵向切片、影子读、分阶段退出条件 |
| 旧运行时被当作永久 fallback | 中 | 中 | 明确退役门和回滚数据边界 |

## 27. 关键架构决策记录

### ADR-001：使用传统 BFF，而不是新的通用 Agent Server

状态：建议接受。业务路由直接表达产品领域，减少无用抽象和转发层。

### ADR-002：Pi 使用 SDK + 子进程 Worker

状态：建议接受。SDK 提供结构化控制，子进程提供故障和秘密隔离。

### ADR-003：Agent 仅使用白名单业务工具

状态：建议接受。拒绝默认 shell/FS/network，权限由 API session context 决定。

### ADR-004：长任务与 Agent 回合解耦

状态：建议接受。Agent 只 enqueue/query job，Job Worker 负责可靠执行。

### ADR-005：Python 作为计算 Sidecar 保留

状态：建议接受。避免为追求语言统一重写成熟解析库，同时保持主控制面 TS 化。

### ADR-006：保留现有 UI，替换数据与会话适配层

状态：建议接受。减少迁移变量，优先获得架构收益。

### ADR-007：首期继续 SQLite，接口为 PostgreSQL 留边界

状态：建议接受。符合本地优先和桌面部署；多实例需求出现后再迁移。

## 28. 开工前必须确认的问题

以下问题不阻止 Phase 0，但应在 Phase 1 结束前定稿：

1. 首个正式目标是本地桌面、单机 Web，还是多实例云服务？
2. 模型访问统一走现有云网关，还是需要保留本地 provider 配置？
3. Skills 市场是首发必需，还是可以在核心迁移后补齐？
4. 是否需要保留会话 fork，以及保留到什么语义层级？
5. Obsidian 是默认常驻能力还是可选插件？
6. 是否保留旧聊天记录，还是只迁移业务资产和最近会话？
7. 现有未跟踪 TS 编译产物是否可归档后清理？
8. 迁移原型 stash 是否需要建立永久只读 tag，避免被 Git 清理？

## 29. 第一批建议任务

1. 给迁移 stash 建立只读备份引用，并在临时 worktree 恢复源码。
2. 将 `packages/contracts/core/db/agent-runtime` 迁入当前分支。
3. 更新依赖到经验证的 Pi SDK 固定版本，建立最小 fake-model 测试。
4. 建立当前 main 的 route/table/UI capability 基线。
5. 实现 `/health`、Project CRUD、session/event/operation 和 SSE。
6. 在现有前端加入 canonical API adapter，不更改视觉组件。
7. 打通 project -> session -> Pi -> fake evidence -> citation 的最小闭环。
8. 评审最小工具集合，禁止在评审前增加 shell 或任意文件工具。

## 30. 完成定义

本次改造只有同时满足以下条件才算完成：

- 用户通过现有 UI 完成核心私募投研工作流；
- 浏览器、桌面壳和后台任务均不依赖 Omnigent 运行时；
- TypeScript API 是唯一业务控制面；
- Pi 是可替换、受限、可恢复的智能组件，而非应用框架；
- Python 只承担可审计的纯计算；
- 数据、Evidence、版本和引用无损；
- 新架构通过功能、安全、可靠性、迁移和发布验收；
- 旧系统只保留为可恢复备份或历史源码，不再作为生产写入路径。
