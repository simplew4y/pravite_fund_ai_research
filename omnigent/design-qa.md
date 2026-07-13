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
