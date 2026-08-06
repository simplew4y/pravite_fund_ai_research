# AI UX 评测报告 (基于项目 Rubric + Catalog)

> 评测时间: 2026-07-30T13:46:23.801Z
> 目标: http://127.0.0.1:6767
> 评测模型: private-fund-default (via LiteLLM)
> Rubric: rubrics/ux.md (6 维度, 1-5 分)
> Catalog: catalog/core.yaml (20 个任务)
> Run ID: 2026-07-30T133936Z-2766f8

## 结果汇总

| 指标 | 值 |
|------|-----|
| 总任务数 | 20 |
| Passed | 3 |
| Failed | 9 |
| Blocked | 3 |
| Observed | 5 |
| 平均 Rubric 得分 | 2.7/5 |

---

## Rubric 评分总览

| 任务 | 优先级 | Oracle | 可发现性 | 流程连续性 | 系统反馈 | 错误恢复 | 研究可信度 | 信息密度 | 总分 | 状态 | 严重度 |
|------|--------|--------|---------|-----------|---------|---------|-----------|---------|------|------|--------|
| PF-AUTH-001 | P0 | hybrid | 3 | 2 | 2 | 3 | 4 | 4 | **3** | failed | high |
| PF-AUTH-001 | P0 | hybrid | 3 | 2 | 2 | 3 | 4 | 4 | **3** | failed | high |
| PF-PROJECT-001 | P0 | hybrid | 3 | 2 | 3 | 4 | 3 | 4 | **3.2** | observed | medium |
| PF-PROJECT-001 | P0 | hybrid | 3 | 2 | 3 | 4 | 3 | 4 | **3.2** | failed | medium |
| PF-SOURCES-001 | P0 | hybrid | 3 | 2 | 2 | 1 | 3 | 4 | **2.5** | failed | high |
| PF-SOURCES-001 | P0 | hybrid | 3 | 2 | 2 | 1 | 3 | 4 | **2.5** | failed | high |
| PF-CONTEXT-001 | P1 | deterministic | - | - | - | - | - | - | **0** | passed | none |
| PF-CONTEXT-001 | P1 | deterministic | - | - | - | - | - | - | **0** | passed | none |
| PF-CHAT-001 | P0 | hybrid | 4 | 3 | 2 | 3 | 2 | 4 | **3** | failed | high |
| PF-CHAT-001 | P0 | hybrid | 4 | 3 | 2 | 3 | 2 | 4 | **3** | observed | medium |
| PF-CITATION-001 | P0 | hybrid | 3 | 2 | 3 | 3 | 2 | 4 | **2.8** | blocked | high |
| PF-CITATION-001 | P0 | hybrid | 3 | 2 | 4 | 5 | 1 | 4 | **3.2** | blocked | high |
| PF-ASSET-001 | P1 | hybrid | 2 | 3 | 2 | 3 | 1 | 4 | **2.5** | failed | high |
| PF-ASSET-001 | P1 | hybrid | 2 | 3 | 3 | 4 | 1 | 4 | **2.8** | failed | high |
| PF-MEMO-001 | P0 | hybrid | 3 | 2 | 1 | 3 | 2 | 4 | **2.5** | blocked | high |
| PF-MEMO-001 | P0 | hybrid | 3 | 2 | 2 | 3 | 2 | 4 | **2.7** | failed | high |
| PF-LAYOUT-001 | P2 | rubric | 4 | 3 | 3 | 3 | 2 | 4 | **3.2** | observed | medium |
| PF-LAYOUT-001 | P2 | rubric | 3 | 4 | 3 | 4 | 2 | 3 | **3.2** | observed | medium |
| PF-ISOLATION-001 | P0 | hybrid | 4 | 3 | 4 | 5 | 3 | 5 | **4** | observed | none |
| PF-ISOLATION-001 | P0 | hybrid | 4 | 3 | 4 | 5 | 4 | 4 | **4** | passed | none |

## 各任务详细评测

### PF-AUTH-001: Register, sign in, switch account, and sign out -- 3/5 (failed)

- **用户画像**: A first-time private-fund researcher
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like 'New session' and '统一上传资料' are visible, but account-related actions (sign in, sign out, switch) are not present in the DOM snapshot, making it unclear how a first-time researcher would access authentication flows from this screen. |
| Workflow continuity | 2/5 | The DOM shows an active project '测试项目_1785415689148' and workspace state, but there is no visible user identity or account indicator. After sign-out, it's unclear if project/chat state is cleared, violating task expectation that 'previous user's project...state does not remain visible.' |
| System feedback | 2/5 | No visible indicators of authentication state (signed in/out), current user identity, or confirmation of successful registration/sign-in/sign-out. The absence of any account UI makes system feedback for auth transitions non-existent. |
| Error recovery | 3/5 | Authentication error scenarios (e.g., invalid login) cannot be evaluated from current DOM, but the lack of visible auth controls suggests limited support for retrying failed auth without context loss. |
| Research trust | 4/5 | Project-scoped assets and sessions appear isolated under '测试项目_1785415689148', and destructive actions like project deletion aren't exposed here. However, account switching safeguards can't be verified due to missing auth UI. |
| Information density and readability | 4/5 | At 1440x900, text and controls are readable with no clipping or overlap. Project name, upload button, and composer area are well-spaced and legible. |

**优点:**
- Clear visual hierarchy for core research actions (upload, new session)
- Readable layout at target resolution

**问题:**
- Missing account/authentication UI violates Workflow continuity and System feedback dimensions — user cannot discover or confirm auth state changes as required by PF-AUTH-001
- Active project persists without user identity indicator, risking cross-user state leakage on shared devices

**改进建议:**
- Add persistent user identity badge and sign-out button in top bar
- Clear all project/chat state on sign-out and show empty/auth-only view
- Provide explicit success message after registration/login

**证据:**
- desktop-PF_AUTH_001_desktop.png

### PF-AUTH-001: Register, sign in, switch account, and sign out -- 3/5 (failed)

- **用户画像**: A first-time private-fund researcher
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like '统一上传资料' and 'New session' are visible, but account-related actions (register, sign in, sign out) are not present in the DOM snapshot, making it unclear how a first-time researcher initiates authentication. |
| Workflow continuity | 2/5 | The page shows an active project '测试项目_1785415689148' and workspace state, but there is no visible user identity or account switcher. After sign-out, such user-scoped state should be cleared, yet the UI gives no indication of current authentication status or mechanism to switch accounts, violating task expectation that 'previous user's project... does not remain visible'. |
| System feedback | 2/5 | No visible indicators of authentication state (signed in/out, which account). The absence of any auth-related UI elements (e.g., profile avatar, sign-out button) means system feedback for registration, login, or logout is missing entirely at this viewport. |
| Error recovery | 3/5 | No error states observed in the snapshot; however, since auth flows are not represented in the visible UI, it's unclear how errors (e.g., failed login) would be handled or recovered from. |
| Research trust | 4/5 | Project context is clearly labeled ('Workspace: 测试项目_1785415689148'), and research modes are distinct. No destructive actions are visible in this state, so trust is maintained within the visible scope. |
| Information density and readability | 4/5 | Text and controls are legible at 1024x768 with no clipping or overlap observed in the DOM snapshot. Layout appears stable. |

**优点:**
- Clear labeling of research project and modes
- Readable layout at target viewport

**问题:**
- Authentication flow (register/sign in/sign out) is not discoverable or visible, violating Workflow continuity and System feedback dimensions for task PF-AUTH-001
- User identity and account switching affordances are missing, risking state leakage between users

**改进建议:**
- Add visible user account indicator (e.g., avatar or email) in header or sidebar
- Include sign-out and account-switching actions in persistent navigation
- Clear project and chat state upon sign-out and confirm empty initial state for new users

**证据:**
- narrow-PF_AUTH_001_narrow.png

### PF-PROJECT-001: Create and switch a research project -- 3.2/5 (observed)

- **用户画像**: A researcher starting coverage of a new company
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: medium

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Project creation is possible via '统一上传资料' which auto-creates a project, but there's no explicit 'New Project' button. The project switcher (testid=private-fund-project-switcher) is visible, but its role as primary entry for project creation isn't obvious. |
| Workflow continuity | 2/5 | After creating a project named '测试项目_1785415689148', the active project is reflected in the sidebar and composer (via chip). However, task step 2 cannot be fully verified from static DOM: no evidence that switching away and back preserves source list, chats, and clears attachments. The presence of only one project in DOM prevents validation of cross-project state isolation. |
| System feedback | 3/5 | No upload or indexing activity is shown in the DOM snapshot; the '暂无项目资料' and '当前项目暂无会话' labels indicate empty state, but lack dynamic progress indicators for background operations like indexing. |
| Error recovery | 4/5 | No errors occurred during the observed session; error handling cannot be evaluated from current data, but absence of console/network errors suggests baseline stability. |
| Research trust | 3/5 | No research output or citations are present yet (new session), but the interface separates composer input ('What should we do?') from workspace context. Destructive actions like project deletion aren’t visible, so safeguards can’t be assessed. |
| Information density and readability | 4/5 | At 1440x900, all controls and text are visible without clipping or overlap. Lists are minimal (empty states), but layout appears stable and scannable. |

**优点:**
- Clear visual separation between composer and project context
- Readable layout at target resolution
- Project name consistently displayed in sidebar and composer chip

**问题:**
- Workflow continuity cannot be confirmed due to inability to verify project switching behavior and state isolation (violates Workflow continuity rubric)
- Project creation discoverability is indirect—relies on upload rather than explicit project creation affordance (violates Discoverability rubric)

**改进建议:**
- Add an explicit 'New Project' action in the project switcher dropdown or sidebar
- Ensure full state reset (sources, attachments, chat history) when switching projects, and validate this in multi-project scenarios

**证据:**
- desktop-PF_PROJECT_001_desktop.png

### PF-PROJECT-001: Create and switch a research project -- 3.2/5 (failed)

- **用户画像**: A researcher starting coverage of a new company
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: medium

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Project switching is possible via 'private-fund-project-switcher' button labeled with current project name, but no clear entry point for creating a new project from scratch is visible in the UI beyond the global upload button which implies auto-creation. The primary action for starting a new company coverage is ambiguous without instructions. |
| Workflow continuity | 2/5 | After project switch, the composer area (new-chat-landing) still displays '测试项目_1785415689148' in both the research project chip and workspace label, suggesting the active project context may not be fully synchronized across all UI regions. No evidence of chat or source list updating dynamically on switch was observed in DOM snapshot. |
| System feedback | 3/5 | Upload initiation is represented by buttons, but no visible indicators for indexing, processing, or completion states are present in the snapshot. System appears static after interaction, offering no progress cues. |
| Error recovery | 4/5 | No errors occurred during observed session; no error messages or recovery mechanisms were triggered or visible. Default assumption is basic retry is possible, but not verifiable from snapshot alone. |
| Research trust | 3/5 | Final answers not present in this pre-session state, but project-scoped sources are labeled ('资料来源', '暂无项目资料'). However, no citation mechanism or source tracing UI is visible yet. Destructive actions like project deletion are not evident, so guarding cannot be assessed. |
| Information density and readability | 4/5 | At 1024x768, text and controls appear unclipped and non-overlapping in DOM dimensions. Lists are minimal (empty states), so scan efficiency cannot be fully judged, but layout appears stable. |

**优点:**
- Stable layout at target resolution
- Clear labeling of current project in multiple locations

**问题:**
- Workflow continuity violated: Project context not consistently reflected across composer and sidebar after switch (PF-PROJECT-001 step 2)
- Discoverability issue: No obvious way to create a named research project without uploading files first

**改进建议:**
- Add explicit 'Create new project' button alongside project switcher
- Ensure all UI regions (composer, sidebar, right rail) update atomically on project switch

**证据:**
- narrow-PF_PROJECT_001_narrow.png

### PF-SOURCES-001: Upload, index, organize, and preview source documents -- 2.5/5 (failed)

- **用户画像**: A researcher preparing a project corpus
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary upload actions are present ('统一上传资料' and project-specific '上传资料' button), but their distinct purposes (global vs. project-scoped) are not clearly differentiated by label or placement. The '资料来源' section shows '暂无项目资料', yet no visual cue guides the user to the nearby upload button. |
| Workflow continuity | 2/5 | The task requires previewing a file and returning to the conversation, but no file preview functionality is accessible from the current DOM state. The UI shows '暂无项目资料', so preview cannot be initiated. Even if files existed, there's no visible back navigation from preview to conversation; the only navigation leads to '/inbox' or '/' (home). |
| System feedback | 2/5 | No upload or indexing state is visible in the current snapshot. The UI displays '暂无项目资料' with no indication of ongoing background activity, progress bar, or success/failure messaging. Since uploads are expected to run asynchronously, the absence of any feedback violates the expectation that 'upload progress and failures are visible.' |
| Error recovery | 1/5 | No error states are rendered, and no mechanisms for retry, source retention, or context preservation are observable. Given that uploads haven't occurred yet, the system provides no guidance on how errors would be handled, violating the requirement that users can retry without losing context. |
| Research trust | 3/5 | No sources or claims are present to evaluate citation tracing or separation of answers from tool activity. However, destructive actions (e.g., folder deletion) aren't visible, and duplicate prevention isn't testable. The lack of content limits risk but doesn't demonstrate positive trust mechanisms. |
| Information density and readability | 4/5 | At 1440x900, text and controls are legible with no overlap or clipping. The layout is stable, and key elements (project name, upload buttons, composer) are appropriately spaced. Empty states are cleanly presented. |

**优点:**
- Clean layout with good readability at target resolution
- Project context is consistently labeled across sidebar and composer

**问题:**
- System feedback: No visible upload progress, indexing status, or failure indicators (violates PF-SOURCES-001 step 1)
- Workflow continuity: No mechanism to return from file preview to originating conversation; preview itself is inaccessible due to missing sources (violates PF-SOURCES-001 step 3)
- Error recovery: No observable error handling or retry support for upload/indexing failures

**改进建议:**
- Add explicit upload progress indicators and persistent status banners for indexing
- Implement file preview with clear navigation back to the active conversation
- Design error states that preserve user context and offer actionable recovery

**证据:**
- desktop-PF_SOURCES_001_desktop.png

### PF-SOURCES-001: Upload, index, organize, and preview source documents -- 2.5/5 (failed)

- **用户画像**: A researcher preparing a project corpus
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary upload actions are labeled ('统一上传资料', '上传资料到测试项目...'), but the distinction between global vs. project-specific upload is unclear without instruction. Source list is empty with '暂无项目资料', offering no cues for next steps after upload. |
| Workflow continuity | 2/5 | No evidence that preview navigation preserves conversation context; the DOM shows only a new session landing state. Project name appears in multiple places (sidebar, composer), but there's no active conversation or preview state to verify continuity. |
| System feedback | 2/5 | No visible indicators of upload progress, indexing status, or success/failure states in the current DOM. The UI shows '暂无项目资料' but provides no feedback about whether files were uploaded or are processing. |
| Error recovery | 1/5 | No error messages or recovery options are present in the DOM. Since upload inputs are hidden and no failure states are rendered, users cannot identify what failed or retry without losing context. |
| Research trust | 3/5 | No sources are loaded, so citation tracing cannot be evaluated. However, the separation between workspace label ('Workspace: 测试项目...') and input area suggests potential for clear answer/source delineation once content exists. |
| Information density and readability | 4/5 | At 1024x768, text and controls are legible with no clipping or overlap observed in the DOM snapshot. Layout appears stable with clear sections for sidebar, composer, and project controls. |

**优点:**
- Readable layout at target viewport
- Project context consistently labeled across UI regions

**问题:**
- Lack of upload/indexing feedback violates System feedback dimension
- No observable workflow continuity after preview navigation (Workflow continuity)
- Zero error recovery affordances for upload failures (Error recovery)
- Ambiguous primary action for source management (Discoverability)

**改进建议:**
- Show explicit upload progress and indexing status near the upload button
- Render file list immediately after upload with processing states
- Ensure preview back-navigation returns to originating conversation
- Display actionable error messages with retry options for failed uploads

**证据:**
- narrow-PF_SOURCES_001_narrow.png

### PF-CONTEXT-001: Add and remove source documents from the next question -- 0/5 (passed)

- **用户画像**: A researcher focusing a question on selected evidence
- **优先级**: P1
- **Oracle**: deterministic
- **严重度**: none

**优点:**
- 确定性检查全部通过

**证据:**
- desktop-PF_CONTEXT_001_desktop.png

### PF-CONTEXT-001: Add and remove source documents from the next question -- 0/5 (passed)

- **用户画像**: A researcher focusing a question on selected evidence
- **优先级**: P1
- **Oracle**: deterministic
- **严重度**: none

**优点:**
- 确定性检查全部通过

**证据:**
- narrow-PF_CONTEXT_001_narrow.png

### PF-CHAT-001: Start a project-bound research conversation -- 3/5 (failed)

- **用户画像**: A researcher asking a source-grounded company question
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 4/5 | Primary actions like starting a new session, uploading files, and selecting a project are clearly labeled and visually prominent. The 'New session' button and project chip are easily identifiable. |
| Workflow continuity | 3/5 | The active project is displayed in multiple places (sidebar project switcher, composer chip), but it's unclear if switching projects or using browser back preserves conversation state since no conversation has been started yet. Continuity cannot be fully verified from static snapshot. |
| System feedback | 2/5 | No visible indication of system state during or after message submission. The UI shows 'What should we do?' with an input field but lacks any progress indicator, streaming response area, or status for upload/indexing/generation. This violates the expectation that the UI never remains silently stuck in 'Working'. |
| Error recovery | 3/5 | No errors occurred during observation, but the interface lacks visible error handling elements (e.g., retry buttons, error messages). Recovery capability cannot be assessed without triggering an error, though the absence of safeguards suggests potential data loss on failure. |
| Research trust | 2/5 | No citations, source tracing, or separation between tool activity and final answers are visible because no research output exists yet. The UI provides no mechanism to verify claims or distinguish intermediate reasoning from conclusions at this stage. |
| Information density and readability | 4/5 | Text and controls are well-spaced and readable at 1440x900. No clipping, overlap, or unstable resizing observed. Project name and action buttons are legible and appropriately sized. |

**优点:**
- Clear labeling of primary actions
- Readable layout at target resolution

**问题:**
- System feedback: UI provides no progress indication or state visibility during or after initiating a research task, violating PF-CHAT-001 expectation that 'UI never remains silently stuck in Working'
- Research trust: Absence of citation display or answer/source differentiation mechanisms even before interaction begins

**改进建议:**
- Add a visible streaming response area and real-time status indicators for generation, indexing, and upload states
- Implement clear visual separation between tool steps and final answers once responses are generated

**证据:**
- desktop-PF_CHAT_001_desktop.png

### PF-CHAT-001: Start a project-bound research conversation -- 3/5 (observed)

- **用户画像**: A researcher asking a source-grounded company question
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: medium

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 4/5 | Primary actions like starting a new session, selecting a project, and uploading are labeled clearly and located in expected areas (left rail for projects/uploads, center for composer). The 'New session' button and project chip are prominent. |
| Workflow continuity | 3/5 | The active project is shown in both the left rail ('测试项目_1785415689148') and the composer area ('Workspace: 测试项目...'), maintaining consistency. However, no actual conversation has been started yet, so continuity during navigation or back/forward cannot be verified from this static snapshot. |
| System feedback | 2/5 | The UI shows no indication of system state beyond static labels. There is no visible progress indicator, loading spinner, or status message related to indexing, upload, or model readiness. The task expects non-silent feedback during 'Working' states, but none is present in the captured state. |
| Error recovery | 3/5 | No errors occurred during this session, and no error messages are visible. Recovery cannot be assessed without an error state, but the absence of any error UI suggests potential gaps. |
| Research trust | 2/5 | The landing screen shows '暂无项目资料' and '已加入当前提问 0 份', indicating no sources are attached. Yet the user can still submit a question. There are no guards preventing source-less queries, violating the expectation that destructive or low-quality actions (like ungrounded answers) should be guarded. |
| Information density and readability | 4/5 | At 1024x768, text and controls are readable with no clipping or overlap observed in the DOM snapshot. Lists are minimal but structured; scanning is efficient due to clear sectioning and whitespace. |

**优点:**
- Clear visual hierarchy for project selection and session initiation
- Consistent project labeling across sidebar and composer
- Readable layout at target viewport

**问题:**
- System feedback dimension violated: No visible progress or state indication during 'Working' (Rubric 3)
- Research trust dimension violated: Allows submission with zero sources and no warning (Rubric 5)

**改进建议:**
- Add explicit progress indicators for indexing/upload/model states
- Disable or warn when submitting a research question with no selected sources

**证据:**
- narrow-PF_CHAT_001_narrow.png

### PF-CITATION-001: Open PDF or spreadsheet citations and return to the conversation -- 2.8/5 (blocked)

- **用户画像**: A researcher verifying an answer against primary evidence
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like upload and project switching are labeled but lack visual hierarchy to clearly indicate next steps for a researcher starting verification. |
| Workflow continuity | 2/5 | The DOM snapshot shows a new session landing state with no active conversation or citation preview. Task PF-CITATION-001 cannot be executed because there is no final answer with citations to open, breaking workflow continuity before it begins. |
| System feedback | 3/5 | No active operations (upload, indexing, etc.) are in progress in the captured state, so feedback cannot be evaluated; however, UI lacks visible indicators for such states in general layout. |
| Error recovery | 3/5 | No errors occurred during capture, but the interface provides no evident mechanisms for retry or context preservation since no task context exists yet. |
| Research trust | 2/5 | There is no final answer, citations, or source tracing available in the current state, making citation verification impossible and violating the core requirement of traceable claims. |
| Information density and readability | 4/5 | At 1440x900, text and controls are readable with no clipping or overlap; empty states are cleanly presented. |

**优点:**
- Clean layout at target resolution
- Clear labeling of project and upload functions

**问题:**
- Citation verification task cannot proceed due to absence of conversation and final answer (violates Workflow continuity and Research trust)
- No evidence of citation support in current UI state

**改进建议:**
- Ensure test tasks are performed in a session with an existing answer containing citations
- Add guardrails to prevent navigation to citation workflows without valid source material

**证据:**
- desktop-PF_CITATION_001_desktop.png

### PF-CITATION-001: Open PDF or spreadsheet citations and return to the conversation -- 3.2/5 (blocked)

- **用户画像**: A researcher verifying an answer against primary evidence
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like 'New session' and '统一上传资料' are visible, but no citations exist yet to evaluate citation discoverability. Project switching is labeled clearly. |
| Workflow continuity | 2/5 | The task requires verifying citation navigation, but no conversation or citations exist in the current state (DOM shows '当前项目暂无会话'). Thus, workflow continuity for citation preview ↔ conversation cannot be validated; the expected flow is blocked by missing content. |
| System feedback | 4/5 | No active operations (upload, generation, etc.) are in progress, so feedback mechanisms aren't triggered. UI appears responsive with clear labels and states for available actions. |
| Error recovery | 5/5 | No errors occurred during observation; no recovery scenario was triggered. |
| Research trust | 1/5 | No final answers, citations, or source references are present. The system does not display any claims or evidence, making citation tracing impossible—violates 'Can claims be traced to citations' under Research trust. |
| Information density and readability | 4/5 | At 1024x768, text and controls are legible with no clipping or overlap. Layout is stable, though sparse due to empty state. |

**优点:**
- Clear project labeling and upload affordances
- Responsive layout at target viewport

**问题:**
- Research trust violated: No citations or answer content available for verification (PF-CITATION-001)
- Workflow continuity untestable due to absence of conversation and citations

**改进建议:**
- Populate test session with a sample answer containing PDF/spreadsheet citations to enable validation of PF-CITATION-001

**证据:**
- narrow-PF_CITATION_001_narrow.png

### PF-ASSET-001: Separate trusted sources, context selection, and batch management -- 2.5/5 (failed)

- **用户画像**: A researcher curating reusable research evidence
- **优先级**: P1
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 2/5 | Trusted source action is not visible in the DOM snapshot; no UI element allows adding a final answer as a trusted source. Context selection and batch management controls are absent, making primary actions undiscoverable. |
| Workflow continuity | 3/5 | Project name appears consistently in sidebar and composer (e.g., '测试项目_1785415689148'), but no active research session or asset context exists to evaluate continuity during task execution. |
| System feedback | 2/5 | No indication of upload, indexing, or generation states is present. The '暂无项目资料' message offers static feedback but does not reflect dynamic system state during or after operations. |
| Error recovery | 3/5 | No errors occurred during observation, but absence of error handling UI (e.g., retry buttons, error messages) prevents validation of recovery capabilities. |
| Research trust | 1/5 | Final answers cannot be added as trusted sources per task step 1—no such control exists. No separation between tool activity and final answers is observable. Duplicate prevention for trusted sources cannot be verified. |
| Information density and readability | 4/5 | Text and controls are legible at 1440x900 with no clipping or overlap. Empty states are clearly labeled, though list scanning efficiency cannot be assessed due to lack of content. |

**优点:**
- Consistent project labeling across sidebar and composer
- Clean layout with readable text at target resolution

**问题:**
- Research trust violated: No mechanism to add final answer as trusted source (PF-ASSET-001 step 1)
- Discoverability violated: Primary actions for trusted source, context selection, and batch management are missing or hidden

**改进建议:**
- Implement a visible 'Add as trusted source' button that appears only after answer completion
- Differentiate context selection (toggle) from batch management (explicit mode) with clear visual affordances
- Add confirmation dialogs for destructive batch actions

**证据:**
- desktop-PF_ASSET_001_desktop.png

### PF-ASSET-001: Separate trusted sources, context selection, and batch management -- 2.8/5 (failed)

- **用户画像**: A researcher curating reusable research evidence
- **优先级**: P1
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 2/5 | The UI lacks any visible control or button to 'Add the final answer as a trusted source' (PF-ASSET-001 step 1). No element suggests this action is available after an answer completes. Similarly, there is no indication of how to add/remove assets from context or enter batch management—these core actions are not discoverable from the current DOM snapshot. |
| Workflow continuity | 3/5 | Project name '测试项目_1785415689148' appears consistently in sidebar, composer, and landing area, suggesting basic project continuity. However, no active session or asset context exists to evaluate preservation across navigation or preview states. |
| System feedback | 3/5 | No upload, indexing, or generation is in progress, so feedback cannot be evaluated. Static placeholders like '暂无项目资料' and '当前项目暂无会话' provide minimal state awareness but do not reflect dynamic system activity. |
| Error recovery | 4/5 | No errors occurred during observation; no error messages or recovery flows are present in the DOM. Absence of failure scenarios prevents negative scoring, but also offers no evidence of robust recovery design. |
| Research trust | 1/5 | The task requires saving only the final answer as a trusted source, excluding tool calls and intermediate content. However, no mechanism exists in the UI to perform this action. Additionally, there is no separation between final answers and tool activity because no answers exist yet—and no safeguards against duplicate trusted-source creation are visible. |
| Information density and readability | 4/5 | At 1024x768, text and controls are legible with no clipping or overlap observed. Layout is stable, and key sections (project switcher, upload, composer) are clearly spaced. Empty states are appropriately labeled. |

**优点:**
- Consistent project labeling across UI regions
- Readable layout at target viewport
- Clear empty-state messaging

**问题:**
- Trusted-source capture action is undiscoverable and absent from UI (violates Research trust and Discoverability)
- No visual distinction or access to context selection vs. batch management modes (violates Discoverability and Research trust)
- Core task PF-ASSET-001 cannot be completed due to missing UI affordances

**改进建议:**
- Add a visible 'Save as trusted source' button that appears only after a final answer is generated
- Implement distinct UI modes for context selection (toggle per asset) and batch management (with explicit destructive confirmation)
- Ensure saved trusted sources exclude tool calls and intermediate content by design

**证据:**
- narrow-PF_ASSET_001_narrow.png

### PF-MEMO-001: Generate and inspect a memo without duplicate products -- 2.5/5 (blocked)

- **用户画像**: A researcher turning selected evidence into a deliverable
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Memo workspace is not visible in the current DOM snapshot; user cannot identify how to generate a memo from this screen. Primary action for memo generation is absent. |
| Workflow continuity | 2/5 | The task requires generating and inspecting a memo, but no memo-related UI (history, viewer, or workspace) is present in the DOM, breaking continuity for the researcher persona at the 'generate memo' stage. |
| System feedback | 1/5 | No visible progress indicators, status messages, or outcomes related to memo generation exist in the interface. The system provides zero feedback for the core P0 task. |
| Error recovery | 3/5 | No errors occurred during page load, but the absence of memo functionality means error recovery paths for memo duplication or failure cannot be evaluated; assumed neutral. |
| Research trust | 2/5 | No mechanism visible to trace memo claims to sources or distinguish final deliverables from intermediate content. Memo history and citation features are absent from the UI. |
| Information density and readability | 4/5 | Existing controls and text are readable at 1440x900 with no clipping or overlap. Layout is stable, though sparse due to missing memo components. |

**优点:**
- Page loads quickly with no console or network errors
- Basic project switching and upload controls are present and labeled

**问题:**
- Memo generation workflow is entirely missing from the UI (violates System feedback and Workflow continuity)
- Researcher cannot discover how to create or access memos (violates Discoverability)
- No evidence of memo history or source tracing, undermining Research trust

**改进建议:**
- Implement memo workspace entry point in the left rail or main view
- Add visible progress and outcome states for memo generation
- Ensure generated memos appear in a history list with clear identification and preview capability

**证据:**
- desktop-PF_MEMO_001_desktop.png

### PF-MEMO-001: Generate and inspect a memo without duplicate products -- 2.7/5 (failed)

- **用户画像**: A researcher turning selected evidence into a deliverable
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: high

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like memo generation are not visible in the current DOM snapshot; user must infer next steps from 'What should we do?' prompt without clear affordances for memo-specific workflows. |
| Workflow continuity | 2/5 | No evidence of memo workspace or generated memo in DOM; project context ('测试项目_1785415689148') appears in multiple places but there is no visible mechanism to return to a generated memo or confirm its existence, violating task step 2 expectations. |
| System feedback | 2/5 | Memo generation progress and outcome are absent from the UI; no indicators for upload, indexing, or generation states related to memos, contradicting expected visible progress and single completion outcome. |
| Error recovery | 3/5 | No errors observed, but no visible retry mechanisms or persistence of context during memo creation either; insufficient evidence of recovery support for memo-related failures. |
| Research trust | 2/5 | No memo product is visible, so claims cannot be traced; no separation between tool activity and final deliverables; duplicate prevention cannot be verified as memo list/history is absent. |
| Information density and readability | 4/5 | Text and controls are readable at 1024x768 with no clipping or overlap observed; layout appears stable despite minimal content. |

**优点:**
- UI layout remains stable and readable at target viewport
- Project context is consistently labeled across sidebar and composer area

**问题:**
- Memo generation workflow lacks discoverable entry point (Discoverability)
- Generated memo cannot be opened or traced back to project, breaking workflow continuity (Workflow continuity)
- No system feedback for memo generation progress or result (System feedback)
- Absence of memo history or product listing undermines research trust (Research trust)

**改进建议:**
- Add a visible 'Generate Memo' action in the workspace with clear placement
- Display memo products in a dedicated history/list with timestamps and preview links
- Show real-time progress indicators during memo generation
- Ensure project context persists when navigating to/from memo previews

**证据:**
- narrow-PF_MEMO_001_narrow.png

### PF-LAYOUT-001: Review desktop and narrow workbench usability -- 3.2/5 (observed)

- **用户画像**: A researcher working on a laptop or resized desktop window
- **优先级**: P2
- **Oracle**: rubric
- **严重度**: medium

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 4/5 | Primary actions like '统一上传资料', project switching ('测试项目_1785415689148'), and 'Attach files' are prominently labeled and visually distinct. The left rail clearly separates global upload from project-specific actions. The main composer area invites input with clear placeholder text. |
| Workflow continuity | 3/5 | The active project '测试项目_1785415689148' appears consistently in the left rail (project switcher), composer chip, and workspace label. However, there is no evidence of state preservation across browser back or chat switching because the session is new and empty; this cannot be fully validated without interaction history. |
| System feedback | 3/5 | Empty states are explicitly shown ('暂无项目资料', '当前项目暂无会话'), which is good. However, no dynamic states (uploading, indexing, streaming) are present in this snapshot, so feedback quality during active operations cannot be assessed. Static empty states are clear but do not demonstrate real-time progress handling. |
| Error recovery | 3/5 | No errors are present in the current state, so error messaging and recovery cannot be evaluated. The interface shows no visible safeguards or retry mechanisms because no failure has occurred. |
| Research trust | 2/5 | The workbench lacks any citations, source tracing, or separation between tool activity and final answers because no research has been performed yet. More critically, destructive actions (e.g., project deletion, file removal) show no confirmation guards in the visible UI, and duplicate uploads appear unguarded—violating rubric point about guarding destructive/duplicate actions. |
| Information density and readability | 4/5 | At 1440x900, controls and text are well-spaced with no overlap or clipping. Lists (e.g., sessions, sources) are minimal but structured for scanning. Typography and spacing support readability. Rail resizing is possible via a visible handle, though narrow viewport behavior wasn't tested here per DOM snapshot constraints. |

**优点:**
- Clear visual hierarchy for primary actions
- Consistent project labeling across UI regions
- Readable layout at 1440x900 with stable components

**问题:**
- Research trust compromised by lack of safeguards on destructive actions (violates Research trust dimension)
- Insufficient evidence of workflow continuity and error recovery due to static empty state

**改进建议:**
- Add confirmation dialogs for project deletion or bulk source removal
- Implement visible progress indicators for upload/indexing states
- Ensure error messages include actionable next steps and preserve user context

**证据:**
- desktop-PF_LAYOUT_001_desktop.png

### PF-LAYOUT-001: Review desktop and narrow workbench usability -- 3.2/5 (observed)

- **用户画像**: A researcher working on a laptop or resized desktop window
- **优先级**: P2
- **Oracle**: rubric
- **严重度**: medium

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 3/5 | Primary actions like '统一上传资料' and 'New session' are visible, but project switching and source management controls are compact and rely on icons without labels (e.g., three 28x28 buttons near project name), reducing clarity at 1024x768. The '管理' button is present but its purpose is ambiguous without context. |
| Workflow continuity | 4/5 | Active project '测试项目_1785415689148' appears consistently in left rail (project switcher), composer (research project chip), and workspace header. No evidence of state loss during navigation within current view. |
| System feedback | 3/5 | Empty states are acknowledged ('暂无项目资料', '当前项目暂无会话'), but upload/indexing/generation states are not observable in this static snapshot. No progress indicators or status messages visible for background processes. |
| Error recovery | 4/5 | No errors present in current state; no evidence of poor error handling. Since no failure occurred, recovery mechanisms cannot be evaluated, but absence of errors and stable UI suggests baseline robustness. |
| Research trust | 2/5 | No citations, source tracing, or separation between tool activity and final answers visible. The interface shows '资料来源' but reports '暂无项目资料', offering no mechanism to verify claims or distinguish intermediate vs. final content—violates rubric requirement for traceable claims and clear output separation. |
| Information density and readability | 3/5 | At 1024x768, text remains readable with no clipping observed in DOM snapshot. However, dense interactive elements (e.g., five 28px buttons clustered near project name) reduce scannability. Sidebar resizability is present (resize handle detected), but minimum/maximum limits and impact on composer usability cannot be verified from static data—meets baseline but with efficiency cost. |

**优点:**
- Consistent project identification across UI regions
- Clear empty states for sessions and project assets
- Responsive layout without text overflow at 1024x768

**问题:**
- Research trust compromised: no citation support or answer/source differentiation (Research trust)
- Ambiguous icon-only controls reduce action discoverability at narrow viewport (Discoverability)
- Lack of visible system feedback for asynchronous operations like upload or indexing (System feedback)

**改进建议:**
- Add labeled tooltips or inline text for project management icons
- Implement citation rendering and visually distinct final answer blocks
- Introduce progress indicators for uploads and background processing

**证据:**
- narrow-PF_LAYOUT_001_narrow.png

### PF-ISOLATION-001: Verify basic project isolation between two accounts -- 4/5 (observed)

- **用户画像**: Two researchers using the same deployment
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: none

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 4/5 | Primary actions like 'New session', project switching ('测试项目_1785415689148'), and upload buttons are clearly labeled and visually prominent in expected locations (sidebar and composer). |
| Workflow continuity | 3/5 | Active project name appears consistently in sidebar ('private-fund-project-switcher') and composer ('new-chat-landing-research-project-chip'), but no evidence of state preservation across sign-in/sign-out cycles is visible in this snapshot; task requires multi-account verification which cannot be confirmed from single DOM state. |
| System feedback | 4/5 | Project context is explicitly shown (e.g., 'Workspace: 测试项目_1785415689148'), and empty states like '暂无项目资料' provide clarity. No active operations (upload/indexing) are in progress, so dynamic feedback isn't observable here. |
| Error recovery | 5/5 | No errors occurred during the observed session; console, network, and server logs show no failures. Error handling cannot be evaluated without an error state. |
| Research trust | 3/5 | Project-scoped workspace is labeled, but no citations, sources, or final answers are present in this landing state to evaluate separation of claims from tool activity. Destructive action guards not observable without interaction. |
| Information density and readability | 5/5 | Text is legible at 1440x900; no clipping, overlap, or unstable layout observed. Lists are minimal but structured with clear headings (e.g., '资料来源', 'What should we do?'). |

**优点:**
- Clear project context labeling across UI regions
- Legible layout at target resolution
- Intuitive primary action placement

**问题:**
- Workflow continuity cannot be verified for cross-account isolation from a single session DOM snapshot (violates Workflow continuity rubric requirement to preserve user place across project/account switches)

**改进建议:**
- Conduct end-to-end test with two authenticated sessions to validate project isolation as per PF-ISOLATION-001

**证据:**
- desktop-PF_ISOLATION_001_desktop.png

### PF-ISOLATION-001: Verify basic project isolation between two accounts -- 4/5 (passed)

- **用户画像**: Two researchers using the same deployment
- **优先级**: P0
- **Oracle**: hybrid
- **严重度**: none

**Rubric 评分:**

| 维度 | 得分 | 证据 |
|------|------|------|
| Discoverability | 4/5 | Primary actions like 'New session', project switching ('测试项目_1785415689148'), and upload buttons are clearly labeled and visually prominent in the sidebar and composer area. The user can identify next steps without instructions. |
| Workflow continuity | 3/5 | The active project '测试项目_1785415689148' is consistently shown in the sidebar (project switcher), composer chip, and workspace label. However, no evidence of browser back or chat switching behavior is observable in this static snapshot, limiting full assessment. |
| System feedback | 4/5 | Project state is explicitly displayed (e.g., '暂无项目资料', '当前项目暂无会话'). No active operations (upload, indexing, etc.) are in progress, so feedback for dynamic states cannot be evaluated, but static states are clear. |
| Error recovery | 5/5 | No errors occurred during the observed session; no error messages or recovery flows were triggered. Given the task passed without failure, this dimension does not generate issues. |
| Research trust | 4/5 | Project-scoped workspace is clearly labeled ('Workspace: 测试项目_1785415689148'), and no cross-user content is visible, supporting isolation. No final answers or citations are present yet, but structural separation of project context is maintained. |
| Information density and readability | 4/5 | At 1024x768, all controls and text are readable with no clipping, overlap, or unstable layout. Lists are minimal (only one project shown), but hierarchy and spacing support efficient scanning. |

**优点:**
- Clear project scoping and labeling across UI regions
- Consistent visual identification of active project
- Readable layout at target viewport

**改进建议:**
- Add visual indication of account identity to reinforce isolation awareness
- Consider showing empty-state illustrations to improve discoverability of initial actions

**证据:**
- narrow-PF_ISOLATION_001_narrow.png

---

## 全局问题汇总

- Missing account/authentication UI violates Workflow continuity and System feedback dimensions — user cannot discover or confirm auth state changes as required by PF-AUTH-001
- Active project persists without user identity indicator, risking cross-user state leakage on shared devices
- Authentication flow (register/sign in/sign out) is not discoverable or visible, violating Workflow continuity and System feedback dimensions for task PF-AUTH-001
- User identity and account switching affordances are missing, risking state leakage between users
- Workflow continuity cannot be confirmed due to inability to verify project switching behavior and state isolation (violates Workflow continuity rubric)
- Project creation discoverability is indirect—relies on upload rather than explicit project creation affordance (violates Discoverability rubric)
- Workflow continuity violated: Project context not consistently reflected across composer and sidebar after switch (PF-PROJECT-001 step 2)
- Discoverability issue: No obvious way to create a named research project without uploading files first
- System feedback: No visible upload progress, indexing status, or failure indicators (violates PF-SOURCES-001 step 1)
- Workflow continuity: No mechanism to return from file preview to originating conversation; preview itself is inaccessible due to missing sources (violates PF-SOURCES-001 step 3)
- Error recovery: No observable error handling or retry support for upload/indexing failures
- Lack of upload/indexing feedback violates System feedback dimension
- No observable workflow continuity after preview navigation (Workflow continuity)
- Zero error recovery affordances for upload failures (Error recovery)
- Ambiguous primary action for source management (Discoverability)
- System feedback: UI provides no progress indication or state visibility during or after initiating a research task, violating PF-CHAT-001 expectation that 'UI never remains silently stuck in Working'
- Research trust: Absence of citation display or answer/source differentiation mechanisms even before interaction begins
- System feedback dimension violated: No visible progress or state indication during 'Working' (Rubric 3)
- Research trust dimension violated: Allows submission with zero sources and no warning (Rubric 5)
- Citation verification task cannot proceed due to absence of conversation and final answer (violates Workflow continuity and Research trust)

## 全局改进建议

- Add persistent user identity badge and sign-out button in top bar
- Clear all project/chat state on sign-out and show empty/auth-only view
- Provide explicit success message after registration/login
- Add visible user account indicator (e.g., avatar or email) in header or sidebar
- Include sign-out and account-switching actions in persistent navigation
- Clear project and chat state upon sign-out and confirm empty initial state for new users
- Add an explicit 'New Project' action in the project switcher dropdown or sidebar
- Ensure full state reset (sources, attachments, chat history) when switching projects, and validate this in multi-project scenarios
- Add explicit 'Create new project' button alongside project switcher
- Ensure all UI regions (composer, sidebar, right rail) update atomically on project switch
- Add explicit upload progress indicators and persistent status banners for indexing
- Implement file preview with clear navigation back to the active conversation
- Design error states that preserve user context and offer actionable recovery
- Show explicit upload progress and indexing status near the upload button
- Render file list immediately after upload with processing states
- Ensure preview back-navigation returns to originating conversation
- Display actionable error messages with retry options for failed uploads
- Add a visible streaming response area and real-time status indicators for generation, indexing, and upload states
- Implement clear visual separation between tool steps and final answers once responses are generated
- Add explicit progress indicators for indexing/upload/model states

---

*本报告由 AI 自动评测生成，基于项目 rubrics/ux.md + catalog/core.yaml + Playwright 页面捕获 + LLM 评判。*
