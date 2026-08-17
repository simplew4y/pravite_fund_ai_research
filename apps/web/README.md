# @private-fund/web

私募投研 AI 工作台的新前端（Industry 设计系统 + v3 高保真三栏布局），只对接 `apps/api`。

- 设计基准：`docs/design/表单范围和视觉方向/`（Industry DS tokens vendor 到 `src/styles/industry.css`；布局按 `私募投研 AI 工作台 v3 高保真.dc.html`）。
- 栈：Vite + React 19 + TS，纯 CSS（无 Tailwind），TanStack Query + zustand，自研 zh/en 词典。
- 类型与校验：`@private-fund/contracts` 的 zod schema；insights 域（tracking/valuation 概览）暂未入 contracts，客户端做宽松解析（`src/api/insights.ts`）。

## 运行

```bash
npm run dev:web            # Vite dev server :6780，代理 /v1 /auth /health 到 127.0.0.1:6768
npm run build --workspace @private-fund/web
PRIVATE_FUND_WEB_ROOT=apps/web/dist npm run start:api   # 生产静态托管
```

## 布局

- 左栏 `features/rail/`：项目列表（创建/删除）、全局上传收件箱（needs_review 改派路由）、语言切换。
- 中栏 `features/workbench/` + `features/chat/`：资料上传区、会话卡片、展开会话（SSE 流式：推理/工具调用/正文，中断、分叉、排队发送）。
- 右栏 `features/board/`：项目资料（搜索/多选/删除/加入会话上下文）、Memo（版本/比较/下载，`insights_store` 门控）、估值跟踪、风险与催化剂（alerts 确认）。

## 与 v3 设计稿的降级项（apps/api 暂无对应端点）

- 观察池 watchlist、分享按钮：隐藏。
- 现价行情：只显示模型口径，缺失显示 "数据缺失"。
- 索引进度 %：以状态代替。

## 测试

`npm run test --workspace @private-fund/web`（vitest + Testing Library，组件同目录 `.test.tsx`；`test-utils.tsx` 提供 fetch 路由表 stub）。
