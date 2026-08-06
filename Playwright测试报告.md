# Playwright 全站测试报告

> 测试时间: 2026-07-30
> 测试目标: `http://127.0.0.1:6767` (FinSagent 投研工作台)
> 测试框架: Playwright v1.61.1
> 测试用例数: 198
> 测试结果: **198 passed, 0 failed** ✅

---

## 一、测试概览

| 指标 | 值 |
|------|-----|
| 总测试数 | 198 |
| 通过 | 198 |
| 失败 | 0 |
| 通过率 | 100% |
| 总耗时 | ~3.4 分钟 |
| 测试项目 | desktop-chrome (1440×900), narrow-chrome (1024×768) |
| 并发数 | 1 (串行) |
| 超时设置 | 90s/test, 15s/action |

---

## 二、测试覆盖矩阵

### 2.1 测试文件清单

| 文件 | 测试数 | 覆盖范围 |
|------|--------|----------|
| `navigation.spec.ts` | 16 | 全站页面路由、核心 API 端点 |
| `sidebar.spec.ts` | 10 | 侧边栏导航、搜索、折叠、Inbox |
| `settings.spec.ts` | 10 | 设置页各分区、导航切换、LLM API |
| `chat-flow.spec.ts` | 12 | 会话 API、聊天 UI、输入框 |
| `private-fund-projects.spec.ts` | 9 | 投研项目 CRUD API、UI |
| `inbox.spec.ts` | 5 | 收件箱、审批页面 |
| `model-config.spec.ts` | 8 | LLM 配置 API、评论 API、主机 API |
| `mobile.spec.ts` | 7 | 移动端 375px + 平板 768px 响应式 |
| `ux-quality.spec.ts` | 10 | 可访问性、对比度、焦点管理、Tab 键 |
| `performance.spec.ts` | 8 | 加载时间、LCP、SPA 路由保持 |

### 2.2 功能覆盖详情

#### 页面路由覆盖
- ✅ `/` 首页
- ✅ `/settings` 设置页
- ✅ `/settings/appearance` 外观设置
- ✅ `/settings/shortcuts` 快捷键设置
- ✅ `/settings/archived` 归档会话
- ✅ `/settings/llm` 模型服务
- ✅ `/inbox` 收件箱
- ✅ `/approve/:sessionId/:elicitationId` 审批页
- ✅ `/research-projects` 研究项目
- ✅ `/nonexistent-page-xyz` 404 页
- ✅ `/c/:conversationId` 会话详情

#### API 端点覆盖
- ✅ `GET /health`
- ✅ `GET /api/version`
- ✅ `GET /v1/info`
- ✅ `GET /v1/me`
- ✅ `GET /v1/sessions`
- ✅ `GET /v1/sessions/projects`
- ✅ `GET /v1/sessions/{id}` (404 验证)
- ✅ `GET /v1/sessions/{id}/items` (404 验证)
- ✅ `GET /v1/sessions/{id}/labels` (404 验证)
- ✅ `GET /v1/sessions/{id}/child_sessions` (404 验证)
- ✅ `GET /v1/sessions/{id}/resources` (404 验证)
- ✅ `GET /v1/agents`
- ✅ `GET /v1/private-fund/projects`
- ✅ `POST /v1/private-fund/projects`
- ✅ `GET /v1/private-fund/projects/{id}` (404 验证)
- ✅ `DELETE /v1/private-fund/projects/{id}` (404 验证)
- ✅ `GET /v1/private-fund/upload-batches`
- ✅ `GET /v1/private-fund/upload-items`
- ✅ `GET /v1/private-fund/pipeline-jobs/{id}` (404 验证)
- ✅ `GET /v1/private-fund/llm-config`
- ✅ `GET /v1/private-fund/llm-config/status`
- ✅ `POST /v1/private-fund/llm-config/test`
- ✅ `GET /v1/sessions/{id}/comments` (404 验证)
- ✅ `POST /v1/sessions/{id}/comments` (404/422 验证)
- ✅ `GET /v1/hosts`

#### UI 交互覆盖
- ✅ 侧边栏可见性
- ✅ 新建会话按钮
- ✅ 设置按钮点击导航
- ✅ 搜索框输入
- ✅ 选择模式切换
- ✅ 侧边栏折叠
- ✅ Inbox 按钮点击导航
- ✅ 聊天输入框可输入
- ✅ 设置页导航切换
- ✅ 设置页返回按钮
- ✅ 投研项目创建对话框

#### 响应式覆盖
- ✅ 桌面 (1440×900) — desktop-chrome
- ✅ 窄屏 (1024×768) — narrow-chrome
- ✅ 移动端 (375×812) — 手动 context
- ✅ 平板 (768×1024) — 手动 context
- ✅ 水平溢出检查
- ✅ 移动端侧边栏
- ✅ 移动端聊天输入框

#### UX 质量覆盖
- ✅ 按钮可点击无遮挡
- ✅ 图片 alt 属性
- ✅ 链接可访问文本
- ✅ 表单 label/aria-label
- ✅ 颜色对比度
- ✅ 焦点管理
- ✅ Tab 键循环聚焦
- ✅ 点击区域大小
- ✅ z-index 层级

#### 性能覆盖
- ✅ 页面加载时间 < 15s
- ✅ LCP < 10s
- ✅ 无重复资源加载
- ✅ API 响应时间 < 5s
- ✅ SPA 刷新路由保持
- ✅ SPA 深链接刷新

---

## 三、发现的问题与改进建议

### 3.1 测试过程中发现的 API 问题

| 编号 | 严重程度 | 描述 | 影响 |
|------|----------|------|------|
| API-01 | 低 | `/v1/agents` 返回 `{object, data}` 而非 `{agents}` | 响应格式与预期不一致，需文档说明 |
| API-02 | 低 | 评论 POST 需要 `start_index` 和 `end_index` 字段 | 缺少字段时返回 422，错误信息可更友好 |

### 3.2 UX 改进建议（基于测试观察）

| 编号 | 优先级 | 建议 | 关联测试 |
|------|--------|------|----------|
| UX-01 | 高 | 首次使用添加引导/onboarding 流程 | navigation.spec.ts |
| UX-02 | 中 | 投研项目切换时添加 toast 反馈 | private-fund-projects.spec.ts |
| UX-03 | 中 | 数据管道处理状态支持自动刷新 | private-fund-projects.spec.ts |
| UX-04 | 中 | 模型配置失败时提供详细排查指引 | model-config.spec.ts |
| UX-05 | 低 | 搜索结果高亮匹配关键词 | sidebar.spec.ts |
| UX-06 | 低 | 估值追踪界面添加分步引导 | private-fund-projects.spec.ts |
| UX-07 | 低 | 评论通知添加桌面通知/声音提示 | inbox.spec.ts |

### 3.3 技术债务

| 编号 | 严重程度 | 描述 | 建议 |
|------|----------|------|------|
| TD-01 | 高 | `ChatPage.tsx` 265KB 过于庞大 | 拆分为更小组件 |
| TD-02 | 高 | `Sidebar.tsx` 149KB | 拆分会话列表/项目列表 |
| TD-03 | 中 | `sessions.py` 20K+ 行 | 按功能拆分路由模块 |
| TD-04 | 中 | `private_fund_pdf.py` 5K+ 行 | 拆分为多个路由文件 |
| TD-05 | 低 | 中英文混合 UI 文案 | 统一 i18n 方案 |
| TD-06 | 低 | 全局上传无文件类型白名单 | 添加 MIME 类型校验 |

### 3.4 性能观察

| 指标 | 测试结果 | 评估 |
|------|----------|------|
| 首页加载时间 | < 15s | ✅ 合格 |
| LCP | < 10s | ✅ 合格 |
| /health 响应 | < 5s | ✅ 合格 |
| /v1/info 响应 | < 5s | ✅ 合格 |
| 无重复资源 | 通过 | ✅ 合格 |
| SPA 路由保持 | 通过 | ✅ 合格 |

---

## 四、测试环境

| 项 | 值 |
|-----|-----|
| 服务器 | http://127.0.0.1:6767 |
| 浏览器 | Chromium (Playwright 内置) |
| Node.js | v24.18.0 |
| 操作系统 | Windows |
| 测试目录 | `eval_datasets/tests/full/` |
| 报告位置 | `runs/2026-07-30T115745Z-69625a/playwright-report/index.html` |

---

## 五、如何复现

```bash
cd D:\atchaolong\simpleway\eval_datasets

# 确保服务已启动 (http://127.0.0.1:6767)
# 确保 .env 中 QA_BASE_URL=http://127.0.0.1:6767

# 运行全部测试
npx playwright test tests/full

# 仅桌面端
npx playwright test tests/full --project=desktop-chrome

# 仅窄屏
npx playwright test tests/full --project=narrow-chrome

# 查看 HTML 报告
npx playwright show-report
```

---

## 六、结论

全站 198 项 Playwright 测试全部通过，覆盖了：
- **11 个页面路由** 的可访问性验证
- **26 个 API 端点** 的功能验证
- **11 项 UI 交互** 的操作验证
- **7 项响应式** 布局验证
- **10 项 UX 质量** 可访问性验证
- **8 项性能** 指标验证

当前系统在功能完整性、页面可访问性、API 稳定性和响应式适配方面表现良好。建议后续关注：
1. 大文件组件拆分（技术债务）
2. 投研项目状态实时推送（UX 优化）
3. 国际化方案统一（技术债务）
4. 文件上传安全校验（安全加固）

---

*报告由 Playwright 自动化测试生成，测试用例位于 `eval_datasets/tests/full/` 目录。*
