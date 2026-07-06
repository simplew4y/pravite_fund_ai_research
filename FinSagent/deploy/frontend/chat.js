// chat.js - Core communication logic: sendMessage, SSE stream handling

const API_URL = '/chat/stream';
const PREVIEW_URL = '/chat/preview';
const RESEARCH_CHAT_URL = '/pdf-research/ask';

function sessionIdForRequest() {
    if (typeof window.getCurrentSessionId === 'function') {
        return window.getCurrentSessionId();
    }
    return 'web_user_' + Math.random().toString(36).substring(2, 10);
}
let isSending = false;
let isPreviewMode = true;

/** 暴露给外部检测是否有消息正在发送（流式输出中） */
window.isMessageSending = function () {
    return isSending;
};

function setExecutionPanelVisible(stepsContainer, visible) {
    const panel = stepsContainer?.closest('.execution-flow');
    if (panel) panel.style.display = visible ? 'block' : 'none';
}

function startPendingLoading(rowDiv) {
    const loadingEl = rowDiv?.querySelector('#pending-loading');
    if (!loadingEl) return;
    let tick = 0;
    loadingEl.style.display = 'block';
    loadingEl.textContent = '.';
    rowDiv._pendingLoadingTimer = setInterval(() => {
        tick = (tick + 1) % 3;
        loadingEl.textContent = '.'.repeat(tick + 1);
    }, 450);
}

function stopPendingLoading(rowDiv) {
    if (rowDiv?._pendingLoadingTimer) {
        clearInterval(rowDiv._pendingLoadingTimer);
        rowDiv._pendingLoadingTimer = null;
    }
    const loadingEl = rowDiv?.querySelector('#pending-loading');
    if (loadingEl) loadingEl.style.display = 'none';
}

function getRowDivFromSteps(stepsContainer) {
    return stepsContainer?.closest('.message-row') || null;
}

async function renderOffTopicDirectAnswer(stepsContainer, finalAnswerEl, finalAnswer, statusDisplayEl) {
    const rowDiv = getRowDivFromSteps(stepsContainer);
    stopPendingLoading(rowDiv);
    setExecutionPanelVisible(stepsContainer, false);
    if (finalAnswerEl) {
        finalAnswerEl.style.display = 'block';
        await typeText(finalAnswerEl, finalAnswer ? finalAnswer : '已回答', 18);
    }
    if (statusDisplayEl) statusDisplayEl.textContent = '';
}

function onOrchestratorContinue(stepsContainer, statusDisplayEl) {
    const rowDiv = getRowDivFromSteps(stepsContainer);
    stopPendingLoading(rowDiv);
    setExecutionPanelVisible(stepsContainer, true);
    if (statusDisplayEl) statusDisplayEl.textContent = '专家团队深度分析中...';
}

function renderPreviewDraftStep(stepsContainer, rowDiv, data, statusDisplayEl) {
    stopPendingLoading(rowDiv);
    setExecutionPanelVisible(stepsContainer, true);
    const stage = data.stage || 'running';
    const isDone = stage === 'finalize' || stage === 'error';
    const summary = data.message || 'General draft working...';
    updateStep(
        stepsContainer,
        'preview_draft',
        isDone ? 'done' : 'running',
        `${escapeHtml(summary)}${data.evidence_count ? `<div style="margin-top:6px; font-size:13px;">证据数: ${data.evidence_count}</div>` : ''}`,
        formatPreviewDraftDetails(data),
        true
    );
    if (stage === 'draft' && statusDisplayEl) {
        statusDisplayEl.textContent = '快速草稿已生成，专家团队深度分析中...';
    }
}

function handleKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

async function sendMessage() {
    const PROMPT_INPUT = document.getElementById('prompt-input');
    const SEND_BUTTON = document.getElementById('send-button');
    const STATUS_DISPLAY = document.getElementById('status-display');
    const CHAT_ROOT = typeof getChatMessagesRoot === 'function' ? getChatMessagesRoot() : document.getElementById('chat-container');
    const INITIAL_MESSAGE = document.getElementById('initial-message');

    if (isSending) return;
    const question = PROMPT_INPUT.value.trim();
    if (!question) return;

    isSending = true;
    PROMPT_INPUT.value = '';
    autoExpand(PROMPT_INPUT);
    SEND_BUTTON.disabled = true;
    STATUS_DISPLAY.textContent = 'Agent 启动中...';

    if (typeof window.ensureServerSessionBeforeSend === 'function') {
        const ok = await window.ensureServerSessionBeforeSend();
        if (!ok) {
            isSending = false;
            SEND_BUTTON.disabled = false;
            STATUS_DISPLAY.textContent = '';
            return;
        }
    }
    const sendingSessionId = sessionIdForRequest();

    // 标记侧边栏当前 session 正在流式输出
    if (typeof window.markSessionStreaming === 'function') {
        window.markSessionStreaming(true);
    }

    renderMessage('user', question);
    if (typeof window.forceChatScrollToBottomAfterSend === 'function') {
        window.forceChatScrollToBottomAfterSend();
    }

    if (INITIAL_MESSAGE) INITIAL_MESSAGE.style.display = 'none';
    const rowDiv = document.createElement('div');
    rowDiv.classList.add('message-row', 'assistant-row');
    rowDiv.innerHTML = `
        <div class="message-content">
            <div class="message-icon">✦</div>
            <div class="message-bubble">
                <div class="message-bubble-text" id="pending-loading" style="display:none; color:#6b7280;"></div>
                <div class="message-bubble-text" id="final-answer-div" style="display:none;"></div>
                <div class="research-citation-strip" id="research-citation-strip"></div>
                <div class="research-trace-box" id="research-trace-box" style="display:none;"></div>
            </div>
        </div>
    `;

    CHAT_ROOT.appendChild(rowDiv);
    if (typeof window.forceChatScrollToBottomAfterSend === 'function') {
        window.forceChatScrollToBottomAfterSend();
    }

    try {
        const iconEl = rowDiv.querySelector('.message-icon');
        if (iconEl) {
            const idx = pickUniqueCharForKey('assistant');
            iconEl.innerHTML = '';
            iconEl.appendChild(createAvatarSpriteElement(idx, 36, 'running'));
        }
    } catch(e) { console.error(e); }

    const messageBubble = rowDiv.querySelector('.message-bubble');
    const executionPanel = createExecutionFlowPanel();
    executionPanel.style.display = 'none';
    messageBubble.appendChild(executionPanel);
    rowDiv.querySelector('.message-content')?.classList.add('has-execution-flow');
    startPendingLoading(rowDiv);
    const stepsContainer = executionPanel.querySelector('.execution-steps');
    if (typeof window.forceChatScrollToBottomAfterSend === 'function') {
        window.forceChatScrollToBottomAfterSend();
    }

    await sendMessageResearchMode(question, rowDiv, stepsContainer, sendingSessionId);
}

async function sendMessageResearchMode(question, rowDiv, stepsContainer, sendingSessionId) {
    const STATUS_DISPLAY = document.getElementById('status-display');
    const SEND_BUTTON = document.getElementById('send-button');
    const finalAnswerDiv = rowDiv.querySelector('#final-answer-div');
    const traceBox = rowDiv.querySelector('#research-trace-box');
    const citationStrip = rowDiv.querySelector('#research-citation-strip');

    STATUS_DISPLAY.textContent = 'Research 检索中...';
    setExecutionPanelVisible(stepsContainer, true);
    updateStep(stepsContainer, 'pdf_research', 'running', '正在检索本地 PDF evidence...');

    try {
        const response = await fetch(RESEARCH_CHAT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, session_id: sendingSessionId })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Research request failed');

        updateStep(
            stepsContainer,
            'pdf_research',
            'done',
            `命中 ${result.citations ? result.citations.length : 0} 条可追溯 citation`
        );
        updateStep(
            stepsContainer,
            'synthesis',
            'done',
            result.llm_used ? 'LLM 已基于本地 evidence 完成综合' : '已使用抽取式 fallback'
        );

        stopPendingLoading(rowDiv);
        if (finalAnswerDiv) {
            finalAnswerDiv.style.display = 'block';
            await typeText(finalAnswerDiv, result.answer || '（无回复）', 12);
            if (result.needs_review || result.llm_error) {
                const warn = document.createElement('div');
                warn.className = 'research-warning';
                warn.textContent = result.llm_error || 'Needs review';
                finalAnswerDiv.appendChild(warn);
            }
        }

        renderResearchCitations(rowDiv, result.citations || [], result.traces || []);
        if (result.traces && result.traces[0]) {
            renderResearchTrace(traceBox, result.traces[0]);
        }

        try {
            const stepAvatars = stepsContainer.querySelectorAll('.avatar-sprite');
            stepAvatars.forEach(av => setAvatarState(av, 'done'));
            const assistantIcon = rowDiv.querySelector('.message-icon .avatar-sprite');
            if (assistantIcon) setAvatarState(assistantIcon, 'done', 36);
        } catch (e) { console.error(e); }
        if (typeof window.markSessionHasMessages === 'function') window.markSessionHasMessages();
    } catch (error) {
        stopPendingLoading(rowDiv);
        if (finalAnswerDiv) {
            finalAnswerDiv.style.display = 'block';
            finalAnswerDiv.innerHTML = '<span style="color:red;">Error: ' + escapeHtml(error.message) + '</span>';
        }
        updateStep(stepsContainer, 'pdf_research', 'done', '<span style="color:#b91c1c;">Research 请求失败</span>');
    } finally {
        isSending = false;
        SEND_BUTTON.disabled = false;
        STATUS_DISPLAY.textContent = '';
        if (typeof window.clearStreamingSessionBackup === 'function') {
            window.clearStreamingSessionBackup(sendingSessionId);
        }
        if (typeof window.markSessionStreaming === 'function') window.markSessionStreaming(false);
        if (typeof window.refreshSessionSidebar === 'function') window.refreshSessionSidebar();
        if (typeof window.requestChatScrollToBottom === 'function') {
            window.requestChatScrollToBottom({ repeat: 2 });
        }
    }
}

function renderResearchCitations(rowDiv, citations, traces) {
    const citationStrip = rowDiv.querySelector('#research-citation-strip');
    const traceBox = rowDiv.querySelector('#research-trace-box');
    if (!citationStrip) return;
    const traceMap = new Map();
    (traces || []).forEach((trace) => {
        if (trace && trace.citation && trace.citation.citation_id) {
            traceMap.set(trace.citation.citation_id, trace);
        }
    });
    citationStrip.innerHTML = (citations || []).map((citation) => {
        return `<button type="button" class="research-citation-btn" data-citation-id="${escapeHtml(citation.citation_id)}">${escapeHtml(citation.citation_id)}</button>`;
    }).join('');
    citationStrip.querySelectorAll('[data-citation-id]').forEach((button) => {
        button.addEventListener('click', async () => {
            const cid = button.dataset.citationId;
            let trace = traceMap.get(cid);
            if (!trace) {
                const res = await fetch('/pdf-research/trace/' + encodeURIComponent(cid));
                trace = await res.json();
                if (!res.ok) {
                    if (traceBox) {
                        traceBox.style.display = 'block';
                        traceBox.innerHTML = '<span style="color:red;">Trace failed</span>';
                    }
                    return;
                }
                traceMap.set(cid, trace);
            }
            renderResearchTrace(traceBox, trace);
        });
    });
}

function renderResearchTrace(traceBox, trace) {
    if (!traceBox || !trace) return;
    const citation = trace.citation || {};
    const evidence = trace.evidence || {};
    const documentInfo = trace.document || {};
    const version = trace.version || {};
    const location = trace.location || {};
    traceBox.style.display = 'block';
    traceBox.innerHTML = `
        <div><strong>Citation</strong><br>${escapeHtml(citation.citation_id || '')}</div>
        <div><strong>Location</strong><br>${escapeHtml(location.file_name || documentInfo.file_name || '')}, p.${escapeHtml(location.page_no || '')}, paragraph ${escapeHtml(location.paragraph_no || '')}</div>
        <div><strong>Original File</strong><br>${escapeHtml(trace.original_file || documentInfo.file_path || '')}</div>
        <div><strong>Version</strong><br>${escapeHtml(version.version_id || '')}<br>${escapeHtml(version.checksum || '')}</div>
        <div><strong>Evidence</strong><br>${escapeHtml(evidence.content_text || citation.quote || '')}</div>
    `;
}

// Preview mode: calls /chat/preview → generate_response_with_preview (SSE stream)
async function sendMessagePreviewMode(question, rowDiv, stepsContainer, sendingSessionId) {
    const CHAT_CONTAINER = typeof getChatScrollEl === 'function' ? getChatScrollEl() : document.getElementById('chat-container');
    const STATUS_DISPLAY = document.getElementById('status-display');
    const SEND_BUTTON = document.getElementById('send-button');

    const phase1Section = rowDiv.querySelector('#phase1-section');
    const phase1Body = rowDiv.querySelector('#phase1-body');
    const phase2Loading = rowDiv.querySelector('#phase2-loading');
    const phase2Section = rowDiv.querySelector('#phase2-section');
    const phase2Body = rowDiv.querySelector('#phase2-body');
    const phase2Agents = rowDiv.querySelector('#phase2-agents');
    const previewFinalAnswerDiv = rowDiv.querySelector('#preview-final-answer-div');

    phase2Loading.style.display = 'none';
    STATUS_DISPLAY.textContent = '';

    try {
        const response = await fetch(PREVIEW_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, session_id: sessionIdForRequest() })
        });
        if (!response.ok) throw new Error('Network response was not ok');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));
                        await handlePreviewStreamEvent(event, stepsContainer, rowDiv);
                        handlePreviewEvent(event, {
                            rowDiv,
                            phase1Section, phase1Body,
                            phase2Loading, phase2Section, phase2Body, phase2Agents,
                            previewFinalAnswerDiv
                        });
                        if (typeof window.requestChatScrollToBottom === 'function') {
                            window.requestChatScrollToBottom({ repeat: 2 });
                        }
                    } catch (e) { console.error(e); }
                }
            }
        }
    } catch (error) {
        phase2Loading.style.display = 'none';
        phase1Section.style.display = 'block';
        phase1Body.innerHTML = '<span style="color:red;">Error: ' + error.message + '</span>';
    } finally {
        stopPendingLoading(rowDiv);
        isSending = false;
        SEND_BUTTON.disabled = false;
        STATUS_DISPLAY.textContent = '';
        if (typeof window.clearStreamingSessionBackup === 'function') {
            window.clearStreamingSessionBackup(sendingSessionId);
        }
        if (typeof window.markSessionStreaming === 'function') window.markSessionStreaming(false);
        if (typeof window.refreshSessionSidebar === 'function') window.refreshSessionSidebar();
    }
}

// Standard mode: calls /chat/stream → generate_response_stream (SSE stream)
async function sendMessageStandardMode(question, rowDiv, stepsContainer, sendingSessionId) {
    const CHAT_CONTAINER = typeof getChatScrollEl === 'function' ? getChatScrollEl() : document.getElementById('chat-container');
    const STATUS_DISPLAY = document.getElementById('status-display');
    const SEND_BUTTON = document.getElementById('send-button');

    const finalAnswerDiv = rowDiv.querySelector('#final-answer-div');
    STATUS_DISPLAY.textContent = '正在思考...';

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, session_id: sessionIdForRequest() })
        });
        if (!response.ok) throw new Error('Network response was not ok');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const event = JSON.parse(line.slice(6));
                        await handleStreamEvent(event, stepsContainer, finalAnswerDiv);
                        if (typeof window.requestChatScrollToBottom === 'function') {
                            window.requestChatScrollToBottom({ repeat: 2 });
                        }
                    } catch (e) { console.error(e); }
                }
            }
        }
    } catch (error) {
        finalAnswerDiv.style.display = 'block';
        finalAnswerDiv.innerHTML = '<span style="color:red;">Error: ' + error.message + '</span>';
    } finally {
        isSending = false;
        SEND_BUTTON.disabled = false;
        STATUS_DISPLAY.textContent = '';
        if (typeof window.clearStreamingSessionBackup === 'function') {
            window.clearStreamingSessionBackup(sendingSessionId);
        }
        if (typeof window.markSessionStreaming === 'function') window.markSessionStreaming(false);
        if (typeof window.refreshSessionSidebar === 'function') window.refreshSessionSidebar();
    }
}

async function handlePreviewStreamEvent(event, stepsContainer, rowDiv) {
    const STATUS_DISPLAY = document.getElementById('status-display');
    const { event: type, data } = event;

    switch (type) {
        case 'start':
            STATUS_DISPLAY.textContent = '';
            break;

        case 'orchestrator':
            if (data.off_topic) {
                rowDiv.dataset.previewOfftopic = '1';
                rowDiv.dataset.previewRoutingState = 'offtopic';
                rowDiv._previewDraftBuffer = [];
                const phase1Section = rowDiv.querySelector('#phase1-section');
                const phase2Loading = rowDiv.querySelector('#phase2-loading');
                const phase2Section = rowDiv.querySelector('#phase2-section');
                const previewFinalAnswerDiv = rowDiv.querySelector('#preview-final-answer-div');
                if (phase1Section) phase1Section.style.display = 'none';
                if (phase2Loading) phase2Loading.style.display = 'none';
                if (phase2Section) phase2Section.style.display = 'none';
                await renderOffTopicDirectAnswer(stepsContainer, previewFinalAnswerDiv, data.final_answer, STATUS_DISPLAY);
                break;
            }

            rowDiv.dataset.previewRoutingState = 'allow';
            onOrchestratorContinue(stepsContainer, STATUS_DISPLAY);
            const phase2LoadingForRouting = rowDiv.querySelector('#phase2-loading');
            if (phase2LoadingForRouting) phase2LoadingForRouting.style.display = 'flex';
            if (Array.isArray(rowDiv._previewDraftBuffer) && rowDiv._previewDraftBuffer.length > 0) {
                for (const buffered of rowDiv._previewDraftBuffer) {
                    renderPreviewDraftStep(stepsContainer, rowDiv, buffered, STATUS_DISPLAY);
                }
                rowDiv._previewDraftBuffer = [];
            }
            updateStep(
                stepsContainer,
                'orchestrator',
                'done',
                `激活代理: ${data.selected_agents ? data.selected_agents.join(', ') : 'None'}<div style="margin-top:6px; font-size:13px;"><strong>激活理由:</strong> ${data.routing_reason || ''}</div>`,
                data.rewritten_query
                    ? `<div class="sub-answer-card"><div class="sub-answer-q">路由后查询</div><div style="font-size:13px;">${escapeHtml(data.rewritten_query)}</div></div>`
                    : null,
                !!data.rewritten_query
            );

            if ((data.selected_agents || []).length > 0) {
                updateStep(stepsContainer, 'agents', 'running', null, formatAgentsPlaceholder(data.selected_agents || []), true);
            }
            break;

        case 'agentic_search':
            stopPendingLoading(rowDiv);
            setExecutionPanelVisible(stepsContainer, true);
            renderAgenticSearchEvent(stepsContainer, data || {});
            break;

        case 'preview_draft': {
            // In preview mode, Phase 1 may emit draft events before orchestrator decision.
            // Buffer early draft events and replay after orchestrator confirms non-off-topic.
            if (rowDiv.dataset.previewRoutingState !== 'allow') {
                if (rowDiv.dataset.previewRoutingState === 'unknown') {
                    if (!Array.isArray(rowDiv._previewDraftBuffer)) rowDiv._previewDraftBuffer = [];
                    rowDiv._previewDraftBuffer.push(data);
                }
                break;
            }
            renderPreviewDraftStep(stepsContainer, rowDiv, data, STATUS_DISPLAY);
            break;
        }

        case 'agent_completed':
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const output = {
                    agent: data.agent,
                    sub_queries: data.sub_queries || [],
                    draft_answer: data.draft_answer || '',
                    evidence_count: data.evidence_count || 0,
                    evidence: data.evidence || [],
                    tool_results: data.tool_results || {},
                };
                // 不 await：让每个代理的打字机独立并发运行，互不阻塞事件处理
                if (data.agent !== 'general') {
                    updateAgentBlock(details || stepsContainer, output).catch(e => console.error(e));
                }
                if (!rowDiv.dataset.completedAgents) {
                    rowDiv.dataset.completedAgents = data.agent;
                } else {
                    rowDiv.dataset.completedAgents += ',' + data.agent;
                }
            } catch (e) { console.error(e); }
            break;

        case 'agent_failed':
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const container = details || stepsContainer;
                const failEl = document.createElement('div');
                failEl.style.cssText = 'color:#b91c1c;font-size:13px;margin:4px 0;';
                failEl.textContent = `[${data.agent}] 分析失败: ${data.error || 'unknown error'}`;
                container.appendChild(failEl);
            } catch (e) { console.error(e); }
            break;

        case 'agents': {
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const agentOutputs = data.agent_outputs || [];
                // Get completed agents from rowDiv dataset (set by agent_completed events)
                const completedAgents = new Set(
                    rowDiv.dataset.completedAgents ? rowDiv.dataset.completedAgents.split(',') : []
                );
                for (const aout of agentOutputs) {
                    // Only render if not already rendered via agent_completed
                    if (!completedAgents.has(aout.agent) && aout.agent !== 'general') {
                        await updateAgentBlock(details || stepsContainer, aout);
                    }
                }
            } catch (e) { console.error(e); }

            const specialistCount = (data.agent_outputs || []).filter(a => a.agent !== 'general').length;
            updateStep(stepsContainer, 'agents', 'done', `完成 ${specialistCount} 个专家草稿`, null, false);
            updateStep(stepsContainer, 'synthesis', 'running', '正在融合 general 草稿与专家分析...');
            break;
        }

        case 'synthesis':
            // Only mark done if we have final_answer (ignore status=running)
            if (data.final_answer) {
                updateStep(stepsContainer, 'synthesis', 'done', '合成完成', null, false);
            }
            break;

        case 'complete':
            stopPendingLoading(rowDiv);
            try {
                const stepAvatars = stepsContainer.querySelectorAll('.avatar-sprite');
                stepAvatars.forEach(av => setAvatarState(av, 'done'));
                const assistantIcon = rowDiv.querySelector('.message-icon .avatar-sprite');
                if (assistantIcon) setAvatarState(assistantIcon, 'done', 36);
            } catch(e) { console.error(e); }
            STATUS_DISPLAY.textContent = '';
            if (typeof window.markSessionHasMessages === 'function') window.markSessionHasMessages();
            break;

        case 'error':
            stopPendingLoading(rowDiv);
            STATUS_DISPLAY.textContent = '';
            break;
    }
}

function handlePreviewEvent(event, els) {
    const CHAT_CONTAINER = typeof getChatScrollEl === 'function' ? getChatScrollEl() : document.getElementById('chat-container');
    const STATUS_DISPLAY = document.getElementById('status-display');
    const { event: type, data } = event;
    if (els.rowDiv?.dataset.previewOfftopic === '1' && type !== 'error') {
        return;
    }
    switch (type) {
        case 'preliminary':
            els.phase1Section.style.display = 'block';
            els.phase1Body.innerHTML = data.answer ? data.answer.replace(/\n/g, '<br>') : '<em>（无草稿内容）</em>';
            STATUS_DISPLAY.textContent = '专家团队深度分析中...';
            if (typeof window.requestChatScrollToBottom === 'function') {
                window.requestChatScrollToBottom({ repeat: 2 });
            } else {
                CHAT_CONTAINER.scrollTop = CHAT_CONTAINER.scrollHeight;
            }
            break;
        case 'comprehensive':
            els.phase2Loading.style.display = 'none';
            els.phase2Section.style.display = 'block';
            els.phase2Body.innerHTML = data.answer ? data.answer.replace(/\n/g, '<br>') : '<em>（无深度分析内容）</em>';
            if (data.selected_agents && data.selected_agents.length > 0) {
                els.phase2Agents.innerHTML = data.selected_agents.map(a => `<span class="phase-agents-badge">${a}</span>`).join('');
            }
            STATUS_DISPLAY.textContent = '';
            if (typeof window.requestChatScrollToBottom === 'function') {
                window.requestChatScrollToBottom({ repeat: 2 });
            } else {
                CHAT_CONTAINER.scrollTop = CHAT_CONTAINER.scrollHeight;
            }
            break;
        case 'error':
            els.phase2Loading.style.display = 'none';
            if (!els.phase1Section.style.display || els.phase1Section.style.display === 'none') {
                els.phase1Section.style.display = 'block';
            }
            els.phase1Body.innerHTML += '<br><span style="color:red;">Error: ' + (data.message || 'Unknown error') + '</span>';
            STATUS_DISPLAY.textContent = '';
            break;
    }
}

async function handleStreamEvent(event, stepsContainer, finalAnswerDiv) {
    const CHAT_CONTAINER = typeof getChatScrollEl === 'function' ? getChatScrollEl() : document.getElementById('chat-container');
    const STATUS_DISPLAY = document.getElementById('status-display');
    const { event: type, data } = event;

    switch (type) {
        case 'start':
            STATUS_DISPLAY.textContent = '正在思考...';
            break;

        case 'orchestrator':
            if (data.off_topic) {
                await renderOffTopicDirectAnswer(stepsContainer, finalAnswerDiv, data.final_answer, STATUS_DISPLAY);
                break;
            }
            onOrchestratorContinue(stepsContainer, STATUS_DISPLAY);
            updateStep(
                stepsContainer,
                'orchestrator',
                'done',
                `激活代理: ${data.selected_agents ? data.selected_agents.join(', ') : 'None'}<div style="margin-top:6px; font-size:13px;"><strong>激活理由:</strong> ${data.routing_reason || ''}</div>`,
                data.rewritten_query
                    ? `<div class="sub-answer-card"><div class="sub-answer-q">路由后查询</div><div style="font-size:13px;">${data.rewritten_query}</div></div>`
                    : null,
                !!data.rewritten_query
            );
            const selected = data.selected_agents || [];
            updateStep(stepsContainer, 'agents', 'running', null, formatAgentsPlaceholder(selected), true);
            break;

        case 'agent_completed':
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const output = {
                    agent: data.agent,
                    sub_queries: data.sub_queries || [],
                    draft_answer: data.draft_answer || '',
                    evidence_count: data.evidence_count || 0,
                    evidence: data.evidence || [],
                    tool_results: data.tool_results || {},
                };
                // 不 await：让每个代理的打字机独立并发运行，互不阻塞事件处理
                updateAgentBlock(details || stepsContainer, output).catch(e => console.error(e));
                if (!stepsContainer.dataset.completedAgents) {
                    stepsContainer.dataset.completedAgents = data.agent;
                } else {
                    stepsContainer.dataset.completedAgents += ',' + data.agent;
                }
            } catch (e) { console.error(e); }
            break;

        case 'agent_failed':
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const container = details || stepsContainer;
                const failEl = document.createElement('div');
                failEl.style.cssText = 'color:#b91c1c;font-size:13px;margin:4px 0;';
                failEl.textContent = `[${data.agent}] 分析失败: ${data.error || 'unknown error'}`;
                container.appendChild(failEl);
            } catch (e) { console.error(e); }
            break;

        case 'agents':
            try {
                const agentsStepEl = stepsContainer.querySelector('.execution-step[data-type="agents"]');
                const details = agentsStepEl ? agentsStepEl.querySelector('.step-details-content') : null;
                const agentOutputs = data.agent_outputs || [];
                // Get completed agents from stepsContainer dataset (set by agent_completed events)
                const completedAgents = new Set(
                    stepsContainer.dataset.completedAgents ? stepsContainer.dataset.completedAgents.split(',') : []
                );
                for (const aout of agentOutputs) {
                    // Only render if not already rendered via agent_completed
                    if (!completedAgents.has(aout.agent)) {
                        updateAgentBlock(details || stepsContainer, aout).catch(e => console.error(e));
                    }
                }
            } catch (e) { console.error(e); }
            updateStep(stepsContainer, 'agents', 'done', `完成 ${data.agent_outputs?.length || 0} 个专家草稿`, null, false);
            updateStep(stepsContainer, 'synthesis', 'running', '正在合成最终答案...');
            break;

        case 'synthesis':
            // Only update if we have final_answer (ignore status=running)
            if (data.final_answer) {
                updateStep(stepsContainer, 'synthesis', 'done', '合成完成', null, false);
            }
            break;

        case 'complete':
            stopPendingLoading(stepsContainer.closest('.message-row'));
            if (finalAnswerDiv) {
                finalAnswerDiv.style.display = 'block';
                await typeText(finalAnswerDiv, data.final_answer ? data.final_answer : 'Completed.', 16);
                if (typeof window.requestChatScrollToBottom === 'function') {
                    window.requestChatScrollToBottom({ repeat: 2 });
                } else {
                    CHAT_CONTAINER.scrollTop = CHAT_CONTAINER.scrollHeight;
                }
            }
            try {
                const stepAvatars = stepsContainer.querySelectorAll('.avatar-sprite');
                stepAvatars.forEach(av => setAvatarState(av, 'done'));
                const assistantIcon = stepsContainer.closest('.message-row')?.querySelector('.message-icon .avatar-sprite');
                if (assistantIcon) setAvatarState(assistantIcon, 'done', 36);
            } catch(e) { console.error(e); }
            if (typeof window.markSessionHasMessages === 'function') window.markSessionHasMessages();
            break;
    }
}
