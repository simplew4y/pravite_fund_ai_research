# 私募工作台后端重构计划：DeepSeek Harness 内核 + 插件化开发

- 日期：2026-08-18
- 分支：`feat/private-fund-workbench-industry-ui`
- 状态：**implemented**（Phase 0–4 已落地，见 §8 实施记录）
- 本文档**取代** `docs/Private Fund AI Research DeepSeek Harness 插件化重构计划.md`（旧文档结论是"不采用 Cordis 作为生产控制面"；本轮按新决策重写：**以 DeepSeek Harness 为核心，全部后端能力以插件形式开发**）。

---

## 1. 现状与问题

当前 TS 后端（`apps/` + `packages/`，npm workspaces，Node ≥22.19，`tsc -b` project references）已经承载全部私募业务，但装配方式是手工的：

| 现状 | 问题 |
|---|---|
| `apps/api/src/app.ts` ~3000 行单文件注册全部路由 + `dependencies.ts` 手工装配全部服务 | 巨型组合根，边界靠纪律维持，新能力没有标准落点 |
| `packages/blob-store`、`packages/market-data` 已建成但零消费者、不在 tsconfig references 里 | 没有能力注册机制，"建好了接不上" |
| 会话事实分散：`session_events`（API 内）、`model-request-journal.ts`、Pi 自身 JSONL | 没有统一的 append-only 权威日志；"模型看到的内容可重建"不成立 |
| 工具执行入口分散（`agent-tools.ts`、`parent-rpc-tools.ts`、job-worker 各自路径） | 策略/审批/审计无法在唯一入口强制执行 |
| 生命周期分散：HTTP server、DB、Pi 子进程、定时器各自管理启停 | 关闭路径不可证明干净（泄漏 Task/FD 风险） |

前端契约已冻结：`@private-fund/contracts`（zod）+ `omnigent/web` 与新 `apps/web` 两个客户端。**本轮重构 HTTP/SSE 契约不变，前端零感知。**

## 2. 决策

**采用 DeepSeek Harness 的内核（Cordis 插件系统）作为后端控制面**，全部能力以插件形式挂载；业务纯逻辑仍是普通包。

DeepSeek Harness 上游参考（`deepseek-ai/deepseek-harness`，master）：

- **Cordis 内核**：无特权 kernel，插件向共享 Context 贡献 service、typed event、可逆副作用（unload 时全部撤销）。
- **Profile / Bundle**：命名装配清单 + 可分发的插件束（`dsh-base` / `dsh-web-app` / `dsh-headless` 的分层思路）。
- **核心包与 Context key**：`core/session → ctx.sessions`（append-only SessionEvent log）、`core/tools → ctx.tools`、`core/agent → ctx.agents`、`core/agent-loop`、`llm/llm → ctx.llm`、`core/system-prompt`、`core/scope`。
- **Turn/Step 生命周期**：step = 一次模型请求 + 工具调用；turn = 若干 step；事件链 `agent/pre-step → agent/request → llm/stream → assistant/chunk* → tool/call*`。
- **"模型可见即已记录"**：模型可见输入全部可由事件日志 `deriveMessages()` 重建；fork/恢复/transcript/遥测都派生自同一事件流。
- **工具流水线**：`tools/pre-execute`（waterfall，权限/沙箱）→ 单调守卫（只能拒绝或弃权，不得重排）→ `tools/execute` → `tools/post-execute` → `tools/result`（冻结的权威结果）；`tool/call` 在执行前落日志。
- **Seam（能力接缝）**：Service 定义 + Provider 实现 + Consumer 三者一起设计；换 Provider 即换产品形态（如文件系统 Provider 指向远程沙箱）。

采用方式：**vendor 语义、锁定版本**。业务插件不直接 import cordis 类型——内核 API 收敛在自建 `packages/kernel` 一个包里（薄封装 Context/Service/Event/Scope），上游演进只冲击这一个包。

## 3. 目标架构

```
Profile: api / job-worker / obsidian-worker / headless-test   ← 装配清单（每进程一份）
────────────────────────────────────────────────────────────
Kernel  packages/kernel        Cordis Context 封装：inject 声明、拓扑检查、
                               Scope（root/session/request）、Effect disposer
────────────────────────────────────────────────────────────
基础层   plugin-config          配置加载+zod 校验，启动后冻结只读
        plugin-db              连接池（Effect 管理，dispose 可 await）
        plugin-auth            identity/tenant 服务（cloud/development 双模式）
        plugin-blob-store      内容寻址加密 blob（接线现有孤儿包）
────────────────────────────────────────────────────────────
会话事实 plugin-session-journal ctx.sessions：append-only session_events
                               （sequence 严格递增、causation、hash 链、幂等键）
        plugin-projections     transcript / trajectory / search 投影（纯函数 + checkpoint）
────────────────────────────────────────────────────────────
Agent   plugin-model-gateway   ctx.llm：Provider adapter 注册 + commit-before-send Gate
        plugin-agent-runtime   ctx.agents：Pi worker 子进程监督，每会话一个 kernel scope
        plugin-tool-runtime    ctx.tools：唯一工具入口，五阶段流水线 + 单调守卫
────────────────────────────────────────────────────────────
业务域   plugin-research / plugin-workflow / plugin-tracking /
        plugin-valuation / plugin-uploads / plugin-market-data /
        plugin-obsidian-projection / plugin-jobs
        （各自注册路由 + 领域服务；纯算法仍在普通包里）
────────────────────────────────────────────────────────────
接口层   plugin-http            Fastify 实例作为 Effect；域插件向它挂路由
        plugin-sse             订阅 journal 投影推送（不再旁路广播）
```

### 3.1 概念映射

| Harness | 本项目 | 说明 |
|---|---|---|
| Context / Service | `packages/kernel` 的 ctx + `inject` 声明 | 替代 `dependencies.ts` 手工装配 |
| Bundle / Profile | 每进程一份装配清单（api/job-worker/obsidian-worker） | `ts-services.manifest.json` 进程模型不变 |
| `ctx.sessions` | `plugin-session-journal` | 会话域唯一持久权威 |
| `ctx.tools` + tool pipeline | `plugin-tool-runtime` | 收编 agent-tools / parent-rpc-tools |
| `ctx.llm` | `plugin-model-gateway`（包装 `packages/model-runtime`） | DeepSeek/OpenAI/fake adapter 注册 |
| `ctx.agents` / agent-loop | `plugin-agent-runtime`（包装 `packages/agent-runtime` + `apps/agent-worker`） | Pi 仍是推理执行体，harness 管生命周期 |
| Seam | 能力三件套：Definition（contracts）+ Provider（插件）+ Consumer（工具/服务） | blob-store、market-data 首批试点 |
| Scope | root / session / request 三级 | session scope dispose = 取消并 await 该会话全部 in-flight |

### 3.2 安全不变量（内核强制，插件不可绕过）

1. **commit-before-send**：最终模型请求（system/context/tool schema/参数全部变换后）先落 `model.request.snapshot`，写失败则不发送。落点：`plugin-model-gateway` 的唯一发送入口。
2. **intent-before-effect**：工具副作用前先落 `tool/call`（含参数规范化 digest、policy 决议、审批结果）；`tool/result` 为冻结权威结果。落点：`plugin-tool-runtime` 流水线。
3. **单调守卫**：守卫只能拒绝或弃权，DENY 不可被后续守卫撤销；审批缺失或无法回答 = 拒绝（fail closed）。
4. **模型可见即已记录**：任何进入模型上下文的新输入类型，必须先扩展 SessionEvent 类型并落日志，`deriveMessages()` 可完整重建。
5. **大对象走 blob**：事件只存 hash/长度/MIME/分类 + blob 引用，不内联大正文；blob 加密、限权、可保留期治理。
6. **租户隔离**：journal 读写全部经 tenant 过滤，Session ID 单独不构成授权。
7. **可等待关闭**：每个插件的 disposer 幂等、可 await、有超时；关闭顺序 = 依赖图逆拓扑；泄漏检测（Task/FD/子进程）进测试门。

## 4. 迁移路径（strangler，每阶段独立可回滚）

### Phase 0 — 内核 + 首批接缝试点

- 新建 `packages/kernel`（cordis 薄封装）；`apps/api/main.ts` 创建 Context，把 Fastify 注册为 `plugin-http`，现有 `dependencies.ts` 整体包成一个 **legacy 大插件**。对外行为零变化。
- 试点两个 Seam：`plugin-blob-store`、`plugin-market-data`（接线现有孤儿包，补进 tsconfig references）。验证 inject / ready / dispose / 替换语义 + 泄漏检测。
- **Gate**：`verify:all` 全绿；契约对照测试（现有 30 个 api 集成测试）全绿；kill -TERM 后无残留子进程/FD。
- **回滚**：删 Context 创建代码，dependencies.ts 原样即回到现状。

### Phase 1 — Session Journal（ctx.sessions）

- 新建 `packages/session-journal` 插件：`session_events` 表（tenant、session、sequence 单调、event type、turn/step/operation、causation、occurred/recorded time、payload 或 blob ref、幂等键、hash 链）。
- **Shadow Write**：现有会话写路径不动，旁路双写 journal；`deriveMessages()` 回放对比现有 transcript，等价性测试连续通过后才进入下一阶段。现有 `model-request-journal.ts` 并入。
- **Gate**：回放等价（含 fork、interrupt、compact 场景 fixture）；Shadow 开启前后 UI/SSE 输出逐字节一致；journal append P99 延迟纳入基线。
- **回滚**：关 Shadow flag，无任何用户可见影响。

### Phase 2 — Agent 三件套

- `plugin-model-gateway`：包装 model-runtime，adapter 注册制，唯一发送入口实施 commit-before-send。
- `plugin-tool-runtime`：五阶段流水线（pre-execute → 守卫 → execute → post-execute → result），收编 `agent-tools.ts` / `parent-rpc-tools.ts`；审批经 `ctx.approval` 语义（一次性提示，缺失即拒绝）。
- `plugin-agent-runtime`：包装 agent-supervisor + agent-worker；每产品会话一个 session scope；steer/interrupt/compact 走 scope 事件；dispose = 取消 + await + 杀子进程。
- **Gate**：Fake Model / Recorded Tool fixture 跑通全部行为基线（正常、失败、取消、超时、重试、审批拒绝）；journal 中 request snapshot 与 Provider 实收 payload 逐字节一致（集成测试拦截网络层验证）。
- **回滚**：Feature flag 切回 legacy 调用路径（两路共存到 Gate 通过）。

### Phase 3 — 域插件拆分 app.ts

- 逐域搬迁路由 + 服务：uploads → research → workflow → tracking → valuation → sessions（难度递增，sessions 最后）。每域一个 PR、一次 Gate。
- SSE 改为订阅 journal 投影（trajectory 投影同时落地，支持 `?after=`/`Last-Event-ID` 语义不变）。
- **Gate**：每域搬迁后契约对照测试全绿 + `verify:all` + 前端（两个 web）冒烟。
- 完成标志：`app.ts` 只剩装配（~100 行），`dependencies.ts` 删除。

### Phase 4 — 收尾与权威切换

- job-worker / obsidian-worker 换用同一内核（不同 profile 装配清单）；`manage-ts-services.mjs` 进程模型与健康检查不变。
- journal 从 Shadow 转正为会话域权威；旧会话表转为投影/兼容读路径，设兼容窗口后下线。
- 删 legacy 大插件；文档化 profile 清单与插件开发规范（新能力 = 新插件 + Seam 三件套）。
- **Gate**：全量回归 + 历史会话回放抽样 + 关闭/重启/崩溃恢复演练。

## 5. 明确非目标

- 不做插件市场、动态 npm 安装、第三方任意插件加载（编译期 allowlist + 锁版本）。
- 不改任何 HTTP/SSE 契约、不改前端。
- 不把 Pi TUI/RPC 作为产品接口；Pi 仍只做推理与生成，业务事务/租户/审批归应用插件。
- 不对私募业务域（项目/估值/证据/文件）做事件溯源——关系模型 + 版本表不变；事件溯源只覆盖 Agent 会话域。
- 不承诺记录模型未返回的隐藏思维链；reasoning 只记录 Provider 明确返回且政策允许的部分，独立加密限权。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| Cordis/harness 上游 API 演进 | 锁版本；内核 API 只出现在 `packages/kernel`；业务插件零直接依赖 |
| journal 双写期顺序漂移 | Shadow 阶段只读对比不上用户路径；等价性测试作为硬 Gate |
| app.ts 拆分行为漂移 | 逐域搬迁 + 契约对照测试 + 集成测试锁定；一域一 PR 可单独 revert |
| 插件化过度（万物皆插件） | 纪律：纯逻辑/契约/算法/migration 保持普通包；插件准入 = 有生命周期或替换需求 |
| 关闭路径回归 | 每插件 disposer 测试 + 进程级泄漏探针进 CI |

## 7. 验收命令

- 常规门：`npm run verify:all`（typecheck + 全 workspace 测试 + compute + pi 依赖 + omnigent/web 测试）
- 新增门（随 Phase 落地）：`test:journal-replay`（回放等价）、`test:contract-parity`（逐域契约对照）、`test:shutdown-leaks`（泄漏探针）

## 8. 实施记录（2026-08-18）

| Phase | 提交 | 状态 |
|---|---|---|
| 0 内核 + Seam 试点 | `efa9c31` | ✅ `packages/kernel`（cordis 4.0.0-rc.8 封装，上游类型零泄漏）；blob-store/market-data 接线 |
| 1 Session Journal Shadow | `91a069f` | ✅ 惰性对账影子写 + 回放等价/hash 链/幂等/fork Gate 全绿 |
| 2 Agent 三件套 | `ec67104` | ✅ JournaledToolRuntime（单调守卫 + intent-before-effect fail closed）接入全部工具调用；ctx.modelGateway（commit-before-send，能力就绪待 agent loop 迁移后切换）；db/research-stores/agent-runtime 独立插件 |
| 3 域拆分 | `dd3b242` | ✅ app.ts 3289→~220 行；7 个域路由模块 + RouteContext；服务构造拆入 projects-jobs/research/uploads/insights/identity/sessions/api-http 插件；legacy 插件删除 |
| 4 Worker 内核化 | `32ecdf3` | ✅ job-worker/obsidian-worker 走 kernel profile；controlDbPlugin 移入 @private-fund/db 共享 |

验证：`verify:all` 全绿（3531 tests）；api 99 tests（含 30+ 集成套件与回放等价 Gate）；全域 E2E 冒烟（项目/上传/资料/会话/事件流/tracking/valuation/workflow/收件箱）+ SIGTERM 干净退出；三个受管服务经 `manage-ts-services` 正常启停，健康信号不变；omnigent/web 与 apps/web 双前端契约无感。

| 5 Pi 退役 | `71b5a9f` | ✅ 自持 agent loop（in-process，harness 语义）：上下文由事件流 `deriveMessages()` 重建、模型走 OpenAI 兼容流式客户端（cloud=网关 pfm 令牌 / dev=PRIVATE_FUND_AGENT_*）、工具经统一流水线、steering/interrupt/compact 原语齐全；`apps/agent-worker`、`packages/agent-runtime`、Pi 依赖校验全部删除 |

| 6 ModelGateway 接管 | 本次提交 | ✅ commit-before-send 生效于生产路径：agent loop 全部模型调用（含 compaction）经 `ctx.modelGateway`，最终请求体（system prompt/上下文/工具 schema/参数，凭据除外）先落 `model.request.snapshot` 再发送，写失败即拒发；每个 provider 事件带 causation 落审计日志；毒化日志测试证明 fail closed（无任何模型输出）。kill switch：`PRIVATE_FUND_MODEL_COMMIT_BEFORE_SEND=0` |

尚未切换（浸泡期后动作）：journal 权威切换（仍 Shadow，legacy `session_events` 为权威——现在它同时是 agent loop 的上下文来源，切换后 deriveMessages 改读 journal 即可）。
