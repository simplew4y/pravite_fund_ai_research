# Web UI

现有私募投研 Web UI，使用 Vite、React 和 TypeScript。UI 的布局、组件结构与交互保持不变；当前开发和部署目标是 TypeScript API/BFF，而不是旧运行时入口。

## Runtime contract

浏览器通过 HTTP 和 SSE 调用 TypeScript API。Vite 开发服务器代理以下路径：

- `/v1`
- `/api`
- `/auth`
- `/health`

代理目标由 `PRIVATE_FUND_API_URL` 控制，默认是 `http://localhost:6768`。该变量只配置开发代理地址；模型凭据、账号 Token 和服务端环境变量不得进入浏览器 bundle。

## Develop

先在仓库根目录构建并启动 TypeScript 服务：

```bash
npm run build
npm start
npm run services:status
```

默认常驻拓扑包括 TypeScript API、Job Worker 和 Obsidian Worker。Pi Worker 由 API 在 Agent Session 需要时按需创建，不需要手工常驻启动。

再启动 Vite 开发服务器，默认端口为 `5173`：

```bash
cd omnigent/web
npm install
npm run dev
```

默认情况下无需设置代理变量。连接其他 TypeScript API 实例时使用：

```bash
PRIVATE_FUND_API_URL=http://localhost:9000 npm run dev
```

前端页面地址：

```text
http://localhost:5173
```

API 默认地址及健康检查：

```text
http://localhost:6768
http://localhost:6768/health
```

## Production build

```bash
cd omnigent/web
npm run build
```

构建包含 TypeScript project references 校验和 Vite bundle。输出目录由 `vite.config.ts` 定义。若由 TypeScript API 提供静态文件，应在服务端用 `PRIVATE_FUND_WEB_ROOT` 指向该构建目录；不要在前端写死 API 地址或服务端凭据。

## Lint and format

```bash
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run type-check
```

`npm run type-check` 会执行 TypeScript project references 检查。修改 `web/` 下的代码后，至少运行 type-check、测试和格式检查。

## Test

```bash
npm run test
npm run test:watch
```

从仓库根目录也可以执行：

```bash
npm --prefix omnigent/web run type-check
npm --prefix omnigent/web run test
npm --prefix omnigent/web run format:check
```

前端兼容验收应覆盖现有路由、可见文案、关键 DOM role、会话创建、消息流、Tool/approval、停止、恢复、错误重试和 SSE 重连。后端迁移不得借机修改 CSS、布局、组件结构或既有交互。

## Reducer parity

`src/lib/blockStream.ts` 与现有事件流语义保持一致。相关映射如下：

| TypeScript file | Corresponding behavior |
|---|---|
| `src/lib/blocks.ts` | block definitions |
| `src/lib/events.ts` | streamed event definitions |
| `src/lib/types.ts` | shared client-side types |
| `src/lib/sse.ts` | SSE parsing and reconnect behavior |
| `src/lib/blockStream.ts` | event-to-block reduction |
| `src/lib/blockStream.test.ts` | reducer regression coverage |

当服务端事件类型、去重规则或终态语义变化时：

1. 先更新共享 wire contract 和 fixture。
2. 更新对应 reducer 行为。
3. 在 `blockStream.test.ts` 或相关 store 测试中固定新行为。
4. 运行 `npm run type-check` 与 `npm run test`。

Web 端有意保留以下客户端特性：

- `UserMessageBlock` 让持久化的用户消息参与统一 bubble 渲染。
- `BlockContext.responseId` 与 `BlockContext.itemId` 用于关联服务端事件来源。
- `chatStore.blocks` 使用扁平存储，并在渲染时按 `responseId` 分组。

这些特性属于现有 UI 兼容面，不应在服务端迁移中删除。

## Stack

- Vite
- React + TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Zustand
- React Router
- Vitest
- oxlint
- Prettier
