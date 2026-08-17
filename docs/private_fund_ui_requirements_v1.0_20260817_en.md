# Private Fund AI Research Workbench — UI Functional Specification

This document describes the features, components, and main business workflows required for the UI refactor. It does not define layout or visual styling.

## 1. Functional Modules

### 1. Project Management

- Create, search, select, and switch research projects.
- View the project name, company, ticker, source count, and indexing status.
- Edit project information.
- Delete a project with a clear explanation of the impact on sources, indexes, research assets, and outputs.
- Use the active project as the shared scope for sources, conversations, assets, memos, valuation, and tracking.

### 2. Source Upload and Management

- Support PDF, Excel, Word, PowerPoint, CSV, Markdown, and text files.
- Support global upload with automatic company detection and project matching or creation.
- Support project-level upload, assigning files directly to the active project.
- Show upload, queued, parsing, indexing, completed, warning, and failed states.
- Allow manual review and reassignment when the company cannot be identified or a conflict exists.
- Create, rename, and delete source folders.
- Move files, restore automatic classification, search, preview, and inspect metadata.
- Add individual files, folders, or all sources to the current question context.
- Select and delete sources in batches.

### 3. Start New Research

- Select a research project.
- Enter a research question.
- Choose standard or deep research mode.
- Add attachments, use voice input, or invoke skills.
- Show source counts, indexing status, and suggested questions for the project.
- Select an agent, model, and reasoning configuration when required.
- Create a research conversation once the project, index, and agent are ready.

### 4. Research Conversation

- Display user messages, agent responses, reasoning, tool calls, commands, and execution status.
- Support Markdown, tables, code, mathematical expressions, Mermaid, and images.
- Send questions, interrupt generation, queue follow-up questions, and load message history.
- Preserve conversation drafts and question history.
- Copy a response or fork a conversation from a selected response.
- Handle approval requests, structured questions, and plan reviews.
- Show connecting, generating, completed, interrupted, failed, and read-only states.
- Support reconnecting, cloning, or restarting with another model when a conversation disconnects.

### 5. Citations and Source Verification

- Display clickable citations in responses.
- Open PDF citations at the relevant file and page.
- Open Excel citations at the relevant workbook, sheet, range, or cell.
- Show original values, formulas, and nearby context.
- Preview Office documents, text files, and research assets.
- Distinguish unavailable sources, missing indexes, empty ranges, and cross-project citations.
- Allow users to mark a source as trusted.

### 6. Question Context

- Select sources and research assets for the current question.
- View the currently selected sources, assets, and context count.
- Add or remove individual sources, folders, or assets.
- Pass the selected context to subsequent agent requests.
- Keep question-context selection separate from batch-delete selection.

### 7. Research Assets

- Manage source documents, answer notes, research notes, memos, and reports in one place.
- Search or filter by title, summary, tag, and type.
- Sort by update time, title, type, and evidence count.
- Open, preview, download, and delete assets.
- View the current version and version history.
- Add assets to future question context.
- Save a full response or selected content as an answer note or research asset.
- Generate text, tables, charts, or memos from sources, assets, and conversation context.

### 8. Memos and Historical Changes

- Generate or revise a memo.
- View the current memo and historical versions.
- Open, download, or add a memo to question context.
- Compare any two versions.
- Show added, changed, not mentioned, unchanged, and needs-review content.
- Show added or removed evidence and link back to its source.
- View version timelines for theses, assumptions, and metrics.
- Keep “not mentioned in this version” separate from “invalidated.”

### 9. Valuation Tracking

- Select a valuation model and related source documents.
- Refresh model data and market data.
- View the current model version, processing progress, and diagnostics.
- View historical periods, quarterly metrics, and the current market snapshot.
- Compare modeled values with actual values.
- Show genuine discrepancy alerts while keeping missing data separate.
- Ask the agent to analyze valuation impact and inspect supporting evidence.
- Generate a derived model and add it to project sources after explicit user confirmation.

### 10. Risk, Catalyst, and Alert Tracking

- View risks, catalysts, needs-review items, and unread alerts.
- Search tracking items and filter them by type or quality.
- View the current judgment, sources, excerpts, and version changes.
- Acknowledge or dismiss alerts.
- Create, edit, enable, or disable watch rules.
- Configure impact level, update frequency, keywords, and event conditions.
- Trigger a tracking update manually and view task status.
- Archive, restore, permanently remove, or rebuild low-quality historical records.

### 11. Conversations and Collaboration

- Search, open, rename, pin, archive, stop, and delete conversations.
- Archive or delete conversations in batches.
- Copy a share link and grant access by user or email.
- Set, update, or revoke view, comment, edit, and manage permissions.
- Show message authors in shared conversations.
- Add and resolve file comments.

### 12. Inbox and Approvals

- Combine pending approvals and unread file comments.
- Approve or reject agent action requests.
- Answer multi-step structured questions.
- Open the relevant conversation, file, and comment from a notification.
- Support standalone approval links.
- Show empty, loading-failed, resolved, and unread-count states.

### 13. General Agent Workspace

- View all files or only changed files.
- Search, filter, and sort files, and switch the working directory.
- View, edit, save, and download files.
- Review file diffs and manage file comments.
- View the main agent, child agents, execution status, and recent output.
- Create, connect, switch, and close shells.
- View tasks and execution logs.
- Configure the agent, model, permissions, host, sandbox, directory, branch, and worktree.

### 14. Settings and Administration

- Configure language, generated-content language, theme, and keyboard shortcuts.
- Search, install, uninstall, and inspect skill sources.
- View, restore, or permanently delete archived conversations.
- Manage account information, nickname, password, and sign-out.
- Configure model source, platform usage, feedback, and LLM providers.
- View desktop Local CLI status and configure its path.
- Allow administrators to invite members, reset passwords, and remove members.
- Allow administrators to add, configure, enable, disable, and remove global policies.

### 15. Errors and Recovery

- Handle missing projects, conversations, sources, or evidence.
- Handle projects that are not indexed and environments without an available agent.
- Handle upload, parsing, indexing, and generation failures.
- Handle disconnected conversations, runners, and terminals.
- Handle insufficient permissions, revoked access, and read-only states.
- Handle background task timeouts, retries, and recovery.
- Preserve unsent questions, drafts, attachment selections, and task information.
- Provide retry, reconnect, clone, change-model, select-directory, or safe-exit actions.

## 2. Main Components

| Component              | Includes                                                           | Primary Responsibility                                                           |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Application entry      | Capability loading, identity checks, first-run setup, routing      | Decide whether the user enters authentication, approval, or the main application |
| Global navigation      | Project entry, conversation list, search, inbox, settings          | Switch between projects, conversations, and system functions                     |
| Project selector       | Project search, create, edit, delete, and status                   | Manage the active research project                                               |
| Global uploader        | File selection, company detection, project matching, task progress | Route mixed source files into the correct projects                               |
| Project source library | Upload, folders, file list, preview, batch management              | Manage original source materials for the active project                          |
| New research composer  | Question, project, research mode, attachments, skills, agent       | Create a new research conversation                                               |
| Message stream         | Messages, reasoning, tools, commands, approvals, citations         | Present the research process and results                                         |
| Conversation composer  | Input, attachments, voice, skills, context, generation controls    | Ask follow-up questions and control generation                                   |
| Source viewer          | PDF, Excel, Office, text, and citation navigation                  | Verify response evidence                                                         |
| Context selector       | Sources, folders, research assets, current selection               | Control the information used for the current question                            |
| Research asset library | Search, filters, sorting, preview, versions, deletion              | Manage long-term research content                                                |
| Content viewer         | Documents, Markdown, tables, charts, HTML, evidence                | Read different types of research content                                         |
| Memo manager           | Generation, current version, history, download                     | Manage memo series and versions                                                  |
| History comparison     | Version selection, change summary, evidence changes, timeline      | Compare changes in research judgments                                            |
| Valuation panel        | Models, metrics, market data, discrepancies, agent analysis        | Track valuation changes                                                          |
| Tracking panel         | Risks, catalysts, alerts, watch rules, governance records          | Track ongoing research items                                                     |
| Inbox                  | Approvals, structured questions, file comments                     | Handle collaborative action items                                                |
| Permission manager     | Share links, members, permission levels, revocation                | Manage conversation access                                                       |
| File workspace         | File tree, editor, diffs, comments                                 | Work with agent-generated and workspace files                                    |
| Agent panel            | Main agent, child agents, status, configuration                    | Inspect and manage agents                                                        |
| Terminal panel         | Shell list, terminal connection, reconnection                      | Operate the execution environment                                                |
| Tasks and logs         | To-do items, execution status, raw logs                            | Inspect agent execution progress                                                 |
| Settings center        | Language, skills, theme, account, model, administration            | Configure user and system capabilities                                           |
| Common feedback        | Loading, empty, error, confirmation, progress, notification        | Communicate operation results and system states                                  |

## 3. Core Business Workflows

### 1. Create a Project and Start Research

1. Create or select a project.
2. Upload project sources.
3. Wait for parsing and indexing to finish.
4. Enter a research question and select a research mode.
5. The system checks the project, index, and agent status.
6. Create a conversation and automatically send the first question.
7. The agent returns a response with citations.
8. Open citations to verify the original sources.

### 2. Global Upload and Automatic Filing

1. Upload sources from one or more companies.
2. The system identifies the company for each source.
3. Match an existing project or create a new one.
4. Send unidentified sources to manual review.
5. Manually update the source assignment.
6. Complete ingestion and indexing.
7. Open the relevant project and continue research.

### 3. Continue Research with Selected Context

1. Select content from project sources or research assets.
2. Add the selected content to the current question context.
3. Enter a question and choose text, table, chart, or memo output.
4. The agent generates a result using conversation history and selected context.
5. Follow citations back to the original sources.
6. Adjust the context and continue with the next research question.

### 4. Save a Response as a Research Asset

1. Select a complete response or part of its content.
2. Save it as an answer note or research asset.
3. Preserve its relationship to the original conversation, response, and evidence.
4. Add the new asset to the research asset library.
5. Use the asset in future questions or memo generation.

### 5. Generate and Update a Memo

1. Select sources, notes, and research assets.
2. Enter the memo topic and generation instructions.
3. Generate a new memo version.
4. View, download, or revise the memo.
5. Generate another version after new sources are added to the project.
6. Select two versions for comparison.
7. Review changes in judgments, evidence, and needs-review items.

### 6. Valuation Tracking

1. Upload or select a valuation model.
2. Extract model versions, metrics, and periods.
3. Refresh actual and market data.
4. Review modeled values, actual values, missing data, and discrepancies.
5. Ask the agent to analyze valuation impact.
6. Open the supporting evidence for verification.
7. Generate a derived model when needed.
8. Add the derived model to project sources after user confirmation.

### 7. Risk and Catalyst Tracking

1. Create or enable a watch rule.
2. Update tracking items based on events or schedules.
3. Generate risk, catalyst, or needs-review alerts from new changes.
4. Open an item to review its judgment, sources, and version history.
5. Acknowledge or dismiss the alert.
6. Send low-quality records through the governance workflow.

### 8. Conversation Collaboration and Approval

1. The conversation owner shares the conversation and sets permissions.
2. Collaborators view, comment, or edit according to their permissions.
3. The agent creates an approval request for a controlled action.
4. The request appears in both the conversation and inbox.
5. The user approves, rejects, or answers a structured question.
6. The agent continues or stops based on the decision.

### 9. Error Recovery

1. The system detects an upload failure, indexing failure, disconnected conversation, or unreachable runner.
2. The UI preserves the current input, task, and conversation information.
3. Show the cause and impact of the error.
4. Let the user retry, reconnect, clone, switch models, or exit safely.
5. Continue the original workflow after recovery succeeds.
