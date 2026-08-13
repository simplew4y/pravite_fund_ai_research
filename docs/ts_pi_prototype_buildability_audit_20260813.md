# TypeScript + Pi 原型可构建性审计

- 审计日期：2026-08-13
- 实施分支：`codex/ts-pi-web-refactor-20260813`
- 审计环境：独立 detached Git worktree
- 审计目录：`/private/tmp/private-fund-pi-audit.GmnAvV`
- 原型 stash：`b8c1b97ca238a4eeb4c65532cb6759894ac0279d`
- 原型基点：`905ac64186667a8e6ef140e6a5d30a95438b3b9d`
- stash index parent：`9548372399476f29f6588080394c724dab8591eb`
- 未跟踪源码树：`b23cd6aa1422120fbcd58c0ab89ee620127c044e`

## 1. 审计结论

结论：**通过，可作为本次架构改造的实现来源和测试资产。**

原型可以从 Git 对象独立恢复，根 workspace 和 React 前端均可按各自的
`package-lock.json` 干净安装。Python compute sidecar 环境准备完成后，TypeScript
编译、根工作区测试、Python 单元测试、React 类型检查、React 全量测试和 canonical
bundle 扫描全部通过。

本轮未发现阻止后续模块迁移的代码错误。首轮出现的 3 个 Node 集成测试失败和
Python 测试无法启动，均由隔离 worktree 中尚未创建
`python/compute-worker/.venv` 引起；按仓库 setup 约定安装 `pdf` extra 后全部通过。

该结论不表示原型可以不经评审整体合入或直接发布。仍应以当前 `main` 的 UI、账号、
Skills、i18n、Tracking 和 Valuation 为产品真值，按模块迁移并重新验收。

## 2. 恢复方式与源码边界

恢复过程没有对当前脏工作区执行 `git stash pop`，而是在 detached worktree 中组合：

1. `refs/stash^1`：原型基点；
2. `refs/stash` 相对基点的 tracked/index 变更；
3. `refs/stash^3`：原型未跟踪源码快照。

核心恢复命令：

```bash
git worktree add --detach /private/tmp/private-fund-pi-audit.GmnAvV refs/stash^1
git diff --binary refs/stash^1 refs/stash \
  | git -C /private/tmp/private-fund-pi-audit.GmnAvV apply --index
git archive refs/stash^3 \
  | tar -x -C /private/tmp/private-fund-pi-audit.GmnAvV
```

恢复范围：

| 范围 | 数量/结果 |
|---|---:|
| tracked 变更 | 195 个修改、32 个删除 |
| `refs/stash^3` 文件 | 440 |
| `apps/` 未跟踪快照 | 108 |
| `packages/` 未跟踪快照 | 183 |
| `python/` 未跟踪快照 | 25 |
| `omnigent/web/` 未跟踪快照 | 30 |
| 其余未跟踪快照 | 94 |
| 恢复后的 apps/packages/python 源码与测试文件 | 255 |

已确认恢复的关键入口包括：

- 根 `package.json`、`package-lock.json`、`tsconfig.json`、`tsconfig.base.json`；
- `apps/api`、`apps/agent-worker`、`apps/job-worker`、`apps/obsidian-worker`；
- `packages/contracts`、`core`、`db`、`agent-runtime`、`compute-client`、
  `compute-projector`、`job-queue` 等 workspace；
- `python/compute-worker` 源码、fixture 和测试；
- `omnigent/web` 中的 canonical TypeScript API adapter、页面和测试。

## 3. 锁定环境

| 项目 | 审计值 |
|---|---|
| Node.js | `v24.16.0`，项目要求 `>=22.19.0` |
| npm | `11.13.0` |
| 根 lockfile | npm lockfile v3 |
| React 前端 lockfile | npm lockfile v3 |
| TypeScript | `6.0.2` |
| Vitest（根 workspace） | `4.1.10` |
| Python | `3.9.6`，项目要求 `>=3.9` |
| Pi Coding Agent | `@earendil-works/pi-coding-agent@0.83.0` |
| Pi Agent Core | `@earendil-works/pi-agent-core@0.83.0` |
| Pi AI | `@earendil-works/pi-ai@0.83.0` |
| PyMuPDF | `1.26.5` |
| openpyxl | `3.1.5` |
| reportlab | `4.5.1` |

根依赖执行 `npm ci --no-audit --no-fund`，成功安装 611 个包，postinstall 的 Pi
依赖校验通过。React 前端执行独立 `npm ci --no-audit --no-fund`，成功安装 1221 个包。

## 4. 验证结果

| 范围 | 命令 | 结果 |
|---|---|---|
| 根 TypeScript 类型检查 | `npm run typecheck` | 通过 |
| 根 TypeScript 构建 | `npm run build` | 通过 |
| Pi 依赖约束 | `npm run verify:pi-dependencies` | 通过 |
| 服务拓扑测试 | `npm run test:service-topology` | 5/5 通过 |
| 根 workspace 测试 | `npm test` | 369/369 通过 |
| Python compute 健康检查 | `worker.py --health` | 通过，7 项 operation 可用 |
| Python compute 单测 | `npm run test:compute` | 37/37 通过 |
| React 类型检查 | `npm --prefix omnigent/web run type-check` | 通过 |
| React 全量测试 | `npm --prefix omnigent/web test` | 3385 通过、3 expected fail、1 skipped |
| React production build | `npm --prefix omnigent/web run build` | 通过 |
| Canonical bundle 扫描 | `npm --prefix omnigent/web run verify:canonical-bundle` | 389 文件，0 个 forbidden token |

Node 测试 369 项由 5 项服务拓扑测试和 364 项 workspace 测试组成，覆盖 API、Agent
Worker、Job Worker、Obsidian Worker、Agent Runtime、数据库、任务队列、迁移器、
Compute client/projector、研究与工作流 store 等模块。

React 测试中的 3 个 expected-fail 用例是显式 `it.fails`：

- `src/shell/FileViewer.test.tsx`：删除锚点后的 draft comment detached 提示；
- `src/components/PermissionsModal.safety.test.tsx`：非 sandbox 环境分享提示；
- `src/shell/AddAgentDialog.test.tsx`：子会话初始 review prompt 注入。

另有 1 个 load benchmark 通过 `BENCH_ON` 条件默认跳过：
`src/loadtest/streamRenderBench.run.test.ts`。

## 5. 可构建性问题清单

### B-01：根测试依赖预先存在的 Python venv

- 严重度：中（开发环境问题，不是代码正确性阻塞）
- 现象：只执行根 `npm ci` 后直接运行 `npm test`，API 有 1 项、Job Worker 有 2 项
  集成测试失败；`npm run test:compute` 无法启动。
- 原因：脚本固定调用 `python/compute-worker/.venv/bin/python`，而 `npm ci` 不创建 venv。
- 已验证处理：创建 venv，并安装 `./python/compute-worker[pdf]` 后所有测试通过。
- 后续建议：CI 和开发文档统一先执行 `npm run setup`，或增加明确的
  `setup:compute` 命令并让测试前置检查给出可操作错误。

### B-02：Electron 打包依赖包含弃用的传递依赖

- 严重度：低至中（供应链维护项）
- 现象：根 `npm ci` 提示 `tar@6.2.1`、`rimraf@2/3`、`glob@7/8/10`、
  `inflight`、`@npmcli/move-file` 等弃用警告。
- 来源：主要来自 `electron-builder@26.0.12` -> `app-builder-lib` ->
  `@electron/rebuild` / `@electron/node-gyp` 的传递依赖。
- 后续建议：不要在本轮恢复提交中强制升级；在桌面打包 smoke 之前单独评估可升级版本，
  同时运行 `npm audit` 和 macOS/Windows packaged smoke。

### B-03：React production bundle 存在大 chunk

- 严重度：低（性能优化项）
- 现象：Vite 构建通过，但提示部分 chunk 超过 500 kB；主入口压缩前约
  1.656 MB，另有多个语言/渲染依赖大 chunk。
- 后续建议：Phase 6 前按路由和重型渲染器做动态加载，并用真实首屏基准决定是否优化；
  不在架构恢复阶段改动现有 UI 行为。

### B-04：前端存在 3 个显式 expected-fail 和 1 个条件跳过测试

- 严重度：低（既有测试债务）
- 现象：完整前端测试退出码为 0，但并非所有用例都处于普通 pass 状态。
- 后续建议：为 3 个 `it.fails` 建 backlog；在性能验收时显式启用 `BENCH_ON`。

## 6. 阶段判定

本次“恢复原型源码并执行可构建性审计”判定为 **完成**：

- 原型已在隔离 worktree 可重复恢复；
- 根和前端依赖均可由 lockfile 重建；
- TypeScript、Pi、Python 和 React 验证全部通过；
- 首轮失败已定位为环境前置条件，并经复跑排除代码故障；
- 当前实施分支的既有未跟踪目录没有被覆盖或纳入提交；
- 非阻断问题已记录并给出后续处置建议。

下一步进入模块化迁移：先迁入 `packages/contracts`、`packages/core`、`packages/db` 和
`packages/agent-runtime`，同时启动当前 `main` 的 route/table/UI capability 基线冻结。
