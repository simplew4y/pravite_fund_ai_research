# Private Fund AI Research

Private Fund AI Research 是一套证据驱动的私募投研工作台。当前默认运行时是传统 Web 架构：现有 React UI 调用 TypeScript API/BFF，后台由独立 Job Worker 和 Obsidian Worker 处理持久任务；只有 Agent 会话需要模型协调时，API 才按需启动 Pi Worker。

项目保留现有前端 UI、交互和 HTTP/SSE 契约。服务端负责会话、证据、研究任务、产物、模型调用、权限和投影，不依赖一个常驻的大型 Agent Harness 作为应用控制面。

## 默认架构

```text
Browser / existing React UI
        |
        | HTTP + SSE
        v
TypeScript API / BFF :6768
        |-- session, auth, research and artifact services
        |-- model gateway and tool boundary
        |-- request-scoped source-preview compute
        `-- Pi Agent Worker (started only for an active Agent session)

Durable Job Worker
        `-- request-scoped Python compute sidecar

Obsidian Worker
        `-- durable outbox projection into the managed Vault area
```

默认常驻服务只有三项：

| 服务 | 入口 | 生命周期 | 职责 |
|---|---|---|---|
| TypeScript API | `apps/api` | 常驻 | HTTP/SSE、会话与业务服务、按需 Agent/预览计算进程的 owner |
| Job Worker | `apps/job-worker` | 常驻 | 持久任务消费、租约、恢复和计算任务调度 |
| Obsidian Worker | `apps/obsidian-worker` | 常驻 | 将 outbox 中的事实幂等投影到受管 Vault 区域 |
| Pi Agent Worker | `apps/agent-worker` | 按 Session 需要启动 | 执行 Agent 协调；由 API 管理启动、取消、drain 和退出 |

机器可读的权威拓扑位于 `scripts/ts-services.manifest.json`。Pi Worker 不应作为第四个常驻服务手工启动。

## 快速启动

### 环境要求

- Node.js `>= 22.19.0`
- npm
- Python 3；文档解析或计算功能建议使用 `python/compute-worker/.venv`

安装并构建：

```bash
npm install
npm run build
```

本地单用户开发至少需要在仓库根目录的 `.env` 中设置：

```dotenv
PRIVATE_FUND_AUTH_MODE=development
PRIVATE_FUND_API_HOST=127.0.0.1
PRIVATE_FUND_API_PORT=6768
PRIVATE_FUND_DATA_ROOT=output/ts-platform
```

不要提交 `.env`、API Key、Token 或其他凭据。模型网关、云账号和部署环境使用的其他变量以 `.env.example` 与各应用的配置 schema 为准。

从仓库根目录启动完整的常驻服务拓扑：

```bash
npm start
```

确认所有服务的 PID ownership 与 readiness：

```bash
npm run services:status
```

默认 API 地址是 `http://localhost:6768`，健康检查为：

```text
http://localhost:6768/health
```

常用运维命令：

```bash
npm run services:logs
npm run services:restart
npm run services:stop
```

运行状态和日志默认保存在 `tmp/ts-services/`；该目录是本地运行状态，不应提交。

## 前端本地开发

先在仓库根目录运行 `npm start`，再启动现有 Vite 前端：

```bash
cd omnigent/web
npm install
npm run dev
```

Vite 使用 `PRIVATE_FUND_API_URL` 选择 TypeScript API，默认值为 `http://localhost:6768`。只有连接其他开发实例时才需要覆盖：

```bash
PRIVATE_FUND_API_URL=http://localhost:9000 npm run dev
```

前端开发、构建与验证的详细说明见 [`omnigent/web/README.md`](omnigent/web/README.md)。本次架构迁移不改变现有 UI 的布局、组件结构或交互语义。

## 分服务开发

需要单独调试服务时，在不同终端运行：

```bash
npm run dev:api
npm run dev:job-worker
npm run dev:obsidian-worker
```

这些命令适用于开发调试；日常整栈启动仍以 `npm start` 为准。Agent 请求到达时，API 会根据 Session 生命周期按需管理 Pi Worker，无需额外执行启动命令。

## 代码组成

| 路径 | 说明 |
|---|---|
| `apps/api/` | TypeScript API/BFF、会话操作、HTTP/SSE 和进程 owner |
| `apps/job-worker/` | 持久任务与计算调度 Worker |
| `apps/obsidian-worker/` | Obsidian outbox 投影 Worker |
| `apps/agent-worker/` | 按需 Pi Agent 进程入口 |
| `packages/contracts/` | 跨应用的版本化契约 |
| `packages/core/` | 生命周期、能力和公共运行时基础 |
| `packages/agent-runtime/` | AgentRuntime 与 Pi 适配 |
| `packages/model-runtime/` | 模型网关与流式规范化 |
| `packages/job-queue/` | 持久任务、租约和 fencing |
| `packages/research-store/` | 私募研究事实与查询存储 |
| `packages/session-projections/` | 会话投影与读取模型 |
| `packages/obsidian-projector/` | Vault managed-region 投影逻辑 |
| `python/compute-worker/` | 被 Node owner 按请求启动的计算 sidecar |
| `omnigent/web/` | 保持现有 UI 的 React + TypeScript 前端 |
| `scripts/manage-ts-services.mjs` | 默认服务启动、状态、日志、停止和重启控制器 |

## 数据与进程所有权

- API、Job Worker 和 Obsidian Worker 共享明确配置的 control database，但各自只处理所属操作和 lease。
- Pi Worker 只拥有当前 Agent Session 的运行时状态，不拥有业务事实或服务启动权。
- Python 计算进程由 API 或 Job Worker 按请求创建；调用结束、取消或超时后必须由 owner 回收。
- Obsidian 是业务事实的投影目标，不是业务数据库的替代品；Worker 只写受管区域并保留用户内容。
- 浏览器只调用 TypeScript API，不直接持有模型 Provider 凭据或选择后端执行器。

## 验证

根工作区：

```bash
npm run typecheck
npm test
npm run test:compute
npm run verify:pi-dependencies
```

前端：

```bash
npm --prefix omnigent/web run type-check
npm --prefix omnigent/web run test
npm --prefix omnigent/web run format:check
```

服务拓扑专项验证：

```bash
npm run test:service-topology
```

## 当前边界

- 项目用于研究辅助与证据核验，不提供自动投资决策。
- 现有前端 UI 是兼容基线；后端替换不授权视觉、布局或交互重设计。
- Agent 能力通过小而明确的运行时接口接入；应用启动、业务事务、任务队列和投影仍由传统服务负责。
- 本地生成的数据、日志、数据库、Vault 内容、模型输出和测试报告不得作为源码提交，除非它们是经过脱敏并明确批准的 fixture。
