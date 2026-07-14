# 📝 Design QA — Honen 风格前端视觉重构（2026-07-14）

> 📝 本轮在不改变现有信息架构和业务布局的前提下，重构配色、组件表面、交互动效与不合理排版。

## 📝 最终结论

- 未发现未解决的 P0、P1 或 P2 视觉、交互、可读性问题。
- P3：Honen 参考图使用“项目导航 / 研究正文 / 研究上下文”三段式信息架构；当前产品保留用户要求的“项目侧栏 / 对话工作区 / 资产面板”布局，因此只对齐视觉语言，不做逐像素布局克隆。
- P3：当前真实会话的长提示文本和空资产状态使首屏内容密度与参考样例不同；这属于数据状态差异，组件层级、边界、焦点和节奏已完成对齐。

## 📝 视觉真值与证据

- 参考视觉：`/Users/feiyuzi/.codex/generated_images/019f5cd0-2222-74b0-8481-24cae62bef49/exec-8cf74300-f8e0-4c07-a437-a5ed61130e35.png`
- 标准化参考图：`/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/honen-style-target-1280x720.png`
- 浏览器实现截图：`/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/honen-restyle-final.png`
- 全视图并排对照：`/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/honen-restyle-comparison.png`
- 输入器与资产区重点对照：`/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/honen-restyle-comparison-focus.png`
- 暗色主题证据：`/tmp/omnigent-dark-after-final.png`
- 视口：1280 × 720，DPR 1；状态为“阳光电源”真实项目会话，研究标签激活，右侧资产面板为空状态。

## 📝 对照与修正历史

1. 初始实现仍使用冷灰 / 钴蓝应用外观，标签、按钮、输入器和资产卡片层级偏重。
   - 修正：统一为暖白画布、暖灰边框与森林绿主色；移除装饰性渐变，降低阴影和圆角强度，标签改为细下划线激活态。
2. 1024–1279 px 区间会过早进入三栏布局，聊天区被压缩；侧栏项目元信息和长路径也存在溢出风险。
   - 修正：主工作区分栏断点由 `lg` 调整为 `xl`，项目元信息改为纵向节奏，长路径使用自然断行，并扩大关键小按钮触控面积。
3. 输入器和资产筛选缺少足够的交互反馈，项目首屏与内嵌 HTML 资产仍沿用旧冷色语义。
   - 修正：补齐 `focus-visible`、hover、active、轻微位移与柔和阴影；同步项目首屏、资产库和 HTML iframe 的亮暗主题语义变量。
4. 最终并排对照确认：暖白背景、森林绿主操作、克制卡片、编辑器边界与留白节奏已形成一致视觉语言；未发现新的 P0、P1 或 P2 差异。

## 📝 关键交互与浏览器检查

- 研究 / 资料标签可正常切换，返回研究标签后会话与输入器状态保持。
- 输入器聚焦时使用绿色边界、柔和阴影和 1 px 上移动效，未引发布局跳动。
- 亮色与暗色主题均完成真实页面检查；暗色侧栏主按钮文字对比度已修正。
- 1280 px 视口无页面级横向溢出，无 Vite 错误覆盖层。
- 侧栏搜索、项目卡、资料筛选、空状态与提示建议保留原业务行为。

## 📝 验证

- TypeScript `type-check` 通过。
- 定向测试通过：6 个测试文件，162 / 162 个测试通过。
- 本轮 8 个相关文件通过 Prettier 检查。
- 相关 TSX 文件通过 oxlint，无 error；15 条 warning 均为既有代码告警。
- 生产构建通过，静态资源已写入 `omnigent/server/static/web-ui`。
- 全仓 lint 与 `NewChatDialog` 历史测试债务不属于本轮视觉改造，继续在项目待办中单独跟踪。

final result: passed

---

# Design QA — Private Fund Research Graph Workbench

> 📝 2026-07-13: Recorded the final private-fund workbench visual and interaction QA state.

## Findings

- No unresolved P0, P1, or P2 visual or interaction issues remain.
- P3: the 1280 × 720 implementation viewport opens the real transcript bottom-locked, so the beginning of the seeded answer is above the fold. The source mock is 1480 × 1058 and can show the same answer plus composer at once. Scrolling remains available and the node context, answer actions, and composer stay visible.
- P3: the source mock gives valuation outputs a bespoke range highlight and citation cards. The implementation keeps actual streamed Markdown rendering and real file links, then adds the three workflow actions beneath the completed response. A future artifact renderer could give valuation/model outputs a richer bespoke card without changing this workbench structure.

## Visual truth and evidence

- Source visual truth: `/Users/feiyuzi/.codex/generated_images/019f486e-2029-7230-9090-113550ac1b71/exec-de65b055-05e5-437f-acef-8c518f2cef95.png`
- Browser-rendered implementation: `/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/research-workbench-final.png`
- Full-view combined comparison: `/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/research-workbench-comparison-full.png`
- Focused graph comparison: `/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/research-workbench-comparison-graph.png`
- Focused AI rail comparison: `/Users/feiyuzi/project/pravite_fund_ai_research/omnigent/design-qa-artifacts/research-workbench-comparison-chat.png`
- Implementation viewport: 1280 × 720, light workbench presentation.
- Source viewport: 1480 × 1058. The combined full-view comparison normalizes both screenshots to the same visual height; the focused graph and chat comparisons normalize matching regions to equal frames. Native aspect-ratio and height differences are called out rather than treated as pixel-precise mismatches.
- State: project “阳光电源”, base scenario selected, real project source list, one real user message and one persisted assistant answer, AI conversation tab active.

## Comparison history

1. First browser pass found a P1 readability issue: the original wide left-to-right DAG was fit into the remaining center width, shrinking node text below a useful size. The private-fund sidebar was also wider than the visual target.
   - Fixes: capped the private-fund project rail at 240 px; rebuilt the DAG as a compact upper research chain with vertically arranged scenarios and outputs; reduced node width and vertical extent; hid the minimap below 800 px viewport height so it never covers output nodes.
   - Post-fix evidence: `research-workbench-comparison-graph.png`.
2. Second browser pass found a P2 density issue in the AI rail: generic chat typography made one research answer 548 px tall inside a short contextual rail.
   - Fixes: changed private-fund answers to 13 px / 20 px document typography, tightened heading/list rhythm and card padding, kept the three research actions visible, and retained the actual conversation/composer tree.
   - Post-fix evidence: `research-workbench-comparison-chat.png`.
3. Interaction pass found that conditionally rendering the detail tab could unmount the chat and lose a draft.
   - Fix: chat and detail surfaces now stay mounted and switch visibility. The same typed draft survived node selection, detail view, path selection, branch creation, and return to AI chat.
   - Post-fix evidence: browser interaction checks and `PrivateFundResearchWorkbench.test.tsx`.
4. Final comparison found no new actionable P0, P1, or P2 differences.

## Required fidelity surfaces

- Fonts and typography: the existing native system font stack is retained. Workbench chrome uses compact 10–14 px labels with clear weight hierarchy; graph cards remain readable at 1280 px; contextual AI output uses 13 px / 20 px research-document typography. No clipped or overlapping labels were observed.
- Spacing and layout rhythm: desktop composition is a 240 px project/source rail, flexible graph canvas, and 360–390 px AI rail. Dividers are flat and quiet, card radii stay in the 16–22 px family, and short-height viewports remove the overlapping minimap.
- Colors and tokens: the source palette is mapped to warm off-white, sage, mist blue, sand, coral, and lilac surfaces. Private-fund workspaces consistently use the light research palette even when the surrounding application theme is dark, avoiding light-canvas/dark-token contrast failures.
- Image quality and asset fidelity: both project cards use generated, correctly cropped renewable-energy raster thumbnails at the displayed aspect ratio. Interface icons come from the existing Lucide library; React Flow owns graph connectors. No inline SVG illustration, CSS art, emoji, or placeholder imagery replaces a target asset.
- Copy and content: technical identity controls are hidden from the private-fund composer. Visible copy is project-oriented Chinese: research graph, project sources, project chats, node details, current path, research history, research modes, and the three answer-to-research actions.

## Primary interactions tested

- Switched among source, analysis, weight, scenario, and output nodes.
- Opened node details and edited weight controls.
- Selected a different scenario as the current path.
- Created a new branch from a historical node without removing the prior path.
- Switched between path view and research history.
- Converted a completed AI answer into a research node.
- Referenced an AI answer into the selected node’s assumptions.
- Verified the real composer draft remains intact while switching nodes and tabs.
- Verified the old generic Memo/workspace third rail is not mounted for private-fund sessions.
- Browser console errors checked after the final production build: none.

## Verification

- Production build passed and was written to the static directory served by port 6767.
- TypeScript check passed.
- Targeted private-fund workbench, Sidebar, AppShell, composer, and research-mode suites passed: 203 / 203 tests.
- New workbench files pass focused lint checks. Existing unrelated lint findings in older AppShell/Sidebar/ChatPage code were not introduced by this pass.

## Implementation checklist

- [x] Project-specific conversation list remains scoped to the selected project.
- [x] Research DAG is the dominant workspace surface.
- [x] Real streaming conversation and composer remain available in the right rail.
- [x] Completed answers can become useful information, research nodes, or current assumptions.
- [x] Weight selection and three scenario paths are interactive.
- [x] Historical nodes can create append-only branches.
- [x] Research history and current-path states are persisted per conversation.
- [x] Claude Code, Workspace, model, agent picker, and terminal-oriented text are hidden from the private-fund workbench.

final result: passed
