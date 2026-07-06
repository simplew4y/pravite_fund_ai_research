// ui.js - UI rendering, updates, and toggle helpers

const STEP_CONFIG = {
    'orchestrator': { title: 'Agent 路由', icon: '🧭' },
    'pdf_research': { title: 'Evidence 检索', icon: 'PDF' },
    'preview_draft': { title: '草稿工作流', icon: '⚡' },
    'agentic_search': { title: 'Agentic 检索', icon: 'AS' },
    'agents': { title: '专家执行', icon: '🧠' },
    'synthesis': { title: '合成答案', icon: '✍️' }
};

function autoExpand(field) {
    field.style.height = 'inherit';
    const height = field.scrollHeight;
    field.style.height = `${Math.min(height, 200)}px`;
}

function togglePreviewMode() {
    isPreviewMode = !isPreviewMode;
    const toggleEl = document.getElementById('preview-toggle');
    if (toggleEl) toggleEl.classList.toggle('active', isPreviewMode);
    console.log('Preview mode:', isPreviewMode ? 'ON' : 'OFF');
}

function escapeHtml(unsafe) {
    if (!unsafe && unsafe !== '') return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** 消息气泡挂载在此节点；纵向滚动由外层 #chat-container（全宽）承担，滚动条贴齐主区域右缘 */
function getChatMessagesRoot() {
    return document.getElementById('chat-messages-root') || document.getElementById('chat-container');
}

function getChatScrollEl() {
    return document.getElementById('chat-container');
}

const CHAT_BOTTOM_THRESHOLD_PX = 24;
const CHAT_USER_SCROLL_WINDOW_MS = 1200;
let chatAutoFollowInitialized = false;
let chatAutoFollowMode = true;
let chatSuppressScroll = false;
let chatUserScrollIntentAt = 0;
let chatScrollRaf = null;
let chatScrollTimer = null;
let chatResizeObserver = null;
let chatMutationObserver = null;

function isChatAtBottom(scrollEl = getChatScrollEl()) {
    if (!scrollEl) return true;
    if (scrollEl.scrollHeight <= scrollEl.clientHeight + CHAT_BOTTOM_THRESHOLD_PX) return true;
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return distance <= CHAT_BOTTOM_THRESHOLD_PX;
}

function initChatAutoFollow() {
    if (chatAutoFollowInitialized) return;
    const scrollEl = getChatScrollEl();
    const rootEl = getChatMessagesRoot();
    if (!scrollEl) return;
    chatAutoFollowInitialized = true;

    const markUserScrollIntent = () => {
        if (!chatSuppressScroll) chatUserScrollIntentAt = Date.now();
    };

    scrollEl.addEventListener('wheel', markUserScrollIntent, { passive: true });
    scrollEl.addEventListener('touchstart', markUserScrollIntent, { passive: true });
    scrollEl.addEventListener('pointerdown', markUserScrollIntent);
    scrollEl.addEventListener('keydown', markUserScrollIntent);
    scrollEl.addEventListener('scroll', () => {
        if (chatSuppressScroll) return;
        if (isChatAtBottom(scrollEl)) {
            chatAutoFollowMode = true;
        } else if (Date.now() - chatUserScrollIntentAt < CHAT_USER_SCROLL_WINDOW_MS) {
            chatAutoFollowMode = false;
        }
    });

    if (rootEl && typeof ResizeObserver !== 'undefined') {
        chatResizeObserver = new ResizeObserver(() => requestChatScrollToBottom({ repeat: 1 }));
        chatResizeObserver.observe(rootEl);
    }
    if (rootEl && typeof MutationObserver !== 'undefined') {
        chatMutationObserver = new MutationObserver(() => requestChatScrollToBottom({ repeat: 1 }));
        chatMutationObserver.observe(rootEl, { childList: true, subtree: true });
    }
}

function requestChatScrollToBottom(options = {}) {
    const scrollEl = getChatScrollEl();
    if (!scrollEl) return;
    initChatAutoFollow();

    const force = !!options.force;
    const repeat = Number.isFinite(options.repeat) ? Math.max(1, options.repeat) : 2;
    if (force) chatAutoFollowMode = true;
    if (!force && !chatAutoFollowMode) return;

    if (chatScrollRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(chatScrollRaf);
        chatScrollRaf = null;
    }
    if (chatScrollTimer) {
        clearTimeout(chatScrollTimer);
        chatScrollTimer = null;
    }

    chatSuppressScroll = true;
    const prevBehavior = scrollEl.style.scrollBehavior;
    scrollEl.style.scrollBehavior = 'auto';

    let remaining = repeat;
    const apply = () => {
        if (force || chatAutoFollowMode) scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    const finish = () => {
        chatSuppressScroll = false;
        if (isChatAtBottom(scrollEl)) chatAutoFollowMode = true;
        if (prevBehavior) scrollEl.style.scrollBehavior = prevBehavior;
        else scrollEl.style.removeProperty('scroll-behavior');
    };
    const step = () => {
        apply();
        remaining -= 1;
        if (remaining <= 0) {
            finish();
            return;
        }
        chatScrollTimer = setTimeout(() => {
            chatScrollTimer = null;
            if (typeof requestAnimationFrame === 'function') {
                chatScrollRaf = requestAnimationFrame(() => {
                    chatScrollRaf = null;
                    step();
                });
            } else {
                step();
            }
        }, 45);
    };

    if (typeof requestAnimationFrame === 'function') {
        chatScrollRaf = requestAnimationFrame(() => {
            chatScrollRaf = null;
            step();
        });
    } else {
        step();
    }
}

window.requestChatScrollToBottom = requestChatScrollToBottom;
window.forceChatScrollToBottomAfterSend = function() {
    requestChatScrollToBottom({ force: true, repeat: 4 });
};

/** 无视 CSS scroll-behavior: smooth，立即滚到底（用于切换历史会话等场景） */
function scrollChatToBottomInstant() {
    requestChatScrollToBottom({ force: true, repeat: 3 });
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function typeText(el, text, speed = 18) {
    if (!el) return;
    const key = 'typingId';
    const id = Date.now() + Math.random();
    el.dataset[key] = id;
    el.classList.add('typing');
    el.textContent = '';
    const cursor = document.createElement('span');
    cursor.className = 'typing-cursor';
    el.appendChild(cursor);
    for (let i = 0; i < text.length; i++) {
        if (el.dataset[key] !== String(id)) return;
        cursor.insertAdjacentText('beforebegin', text[i]);
        if (i % 8 === 0) requestChatScrollToBottom({ repeat: 1 });
        await sleep(speed);
    }
    if (el.dataset[key] === String(id)) delete el.dataset[key];
    cursor.remove();
    el.classList.remove('typing');
    requestChatScrollToBottom({ repeat: 2 });
}

function createExecutionFlowPanel() {
    const panel = document.createElement('div');
    panel.className = 'execution-flow';
    panel.innerHTML = `
        <div class="execution-flow-header">
            <div class="execution-flow-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                思考过程 (Process)
            </div>
            <button class="details-toggle" onclick="toggleAllDetails(this)">展开全部</button>
        </div>
        <div class="execution-steps"></div>
    `;
    return panel;
}

function updateStep(stepsContainer, stepType, status, contentHTML = null, detailHTML = null, autoExpandDetails = false) {
    const config = STEP_CONFIG[stepType] || { title: stepType, icon: '⚡' };
    const hideStepSummary = stepType === 'agentic_search';
    const existingSteps = stepsContainer.querySelectorAll(`.execution-step[data-type="${stepType}"]`);
    const lastStep = existingSteps.length > 0 ? existingSteps[existingSteps.length - 1] : null;
    let stepEl;

    if (!lastStep || lastStep.dataset.status === 'done') {
        stepEl = document.createElement('div');
        stepEl.className = `execution-step step-${status}`;
        stepEl.setAttribute('data-type', stepType);
        stepEl.setAttribute('data-status', status);
        stepEl.innerHTML = `
            <div class="step-sidebar">
                <div class="step-icon ${status === 'running' ? 'rotate-animation' : ''}">
                    <span class="avatar-placeholder" data-step="${stepType}"></span>
                </div>
            </div>
            <div class="step-main">
                <div class="step-header">
                    <span class="step-title">${config.title}</span>
                    <span class="step-status-text">${status === 'running' ? '进行中...' : '完成'}</span>
                </div>
                <div class="step-body">
                    <div class="step-summary" ${hideStepSummary ? 'hidden' : ''}>${hideStepSummary ? '' : (contentHTML || '处理中...')}</div>
                    ${detailHTML ? `
                        <button class="details-toggle" onclick="toggleStepDetail(this)">${autoExpandDetails ? '收起详情' : '查看详情'}</button>
                        <div class="step-details-content ${autoExpandDetails ? 'show' : ''}">${detailHTML}</div>
                    ` : '<div class="step-details-content"></div>'}
                </div>
            </div>
        `;
        stepsContainer.appendChild(stepEl);
        try { applyAvatarToStep(stepEl, stepType); } catch(e) { console.error(e); }
        try {
            const detailsEl = stepEl.querySelector('.step-details-content');
            if (detailsEl) attachAvatarsToAgentBlocks(detailsEl);
        } catch(e) { console.error(e); }
    } else {
        stepEl = lastStep;
        stepEl.className = `execution-step step-${status}`;
        stepEl.setAttribute('data-status', status);
        const iconEl = stepEl.querySelector('.step-icon');
        const statusTextEl = stepEl.querySelector('.step-status-text');
        const summaryEl = stepEl.querySelector('.step-summary');
        let detailsContentEl = stepEl.querySelector('.step-details-content');
        let toggleBtn = stepEl.querySelector('.details-toggle');

        if (status === 'running') {
            iconEl.classList.add('rotate-animation');
            statusTextEl.textContent = '进行中...';
        } else {
            iconEl.classList.remove('rotate-animation');
            statusTextEl.textContent = '已完成';
        }
        try { applyAvatarToStep(stepEl, stepType); } catch(e) {}
        if (hideStepSummary && summaryEl) {
            summaryEl.textContent = '';
            summaryEl.hidden = true;
        } else if (contentHTML) {
            summaryEl.innerHTML = contentHTML;
        }
        if (detailHTML) {
            if (!detailsContentEl) {
                detailsContentEl = document.createElement('div');
                detailsContentEl.className = 'step-details-content';
                stepEl.querySelector('.step-body').appendChild(detailsContentEl);
            }
            detailsContentEl.innerHTML = detailHTML;
            try { attachAvatarsToAgentBlocks(detailsContentEl); } catch(e) { console.error(e); }
            if (!toggleBtn) {
                toggleBtn = document.createElement('button');
                toggleBtn.className = 'details-toggle';
                toggleBtn.textContent = autoExpandDetails ? '收起详情' : '查看详情';
                toggleBtn.onclick = function() { toggleStepDetail(this); };
                summaryEl.insertAdjacentElement('afterend', toggleBtn);
            }
            if (autoExpandDetails) {
                detailsContentEl.classList.add('show');
                toggleBtn.textContent = '收起详情';
            }
        }
    }
}

window.toggleStepDetail = function(btn) {
    const content = btn.nextElementSibling;
    const isHidden = !content.classList.contains('show');
    if (isHidden) { content.classList.add('show'); btn.textContent = '收起详情'; }
    else { content.classList.remove('show'); btn.textContent = '查看详情'; }
};

window.toggleAllDetails = function(mainBtn) {
    const panel = mainBtn.closest('.execution-flow');
    const allContent = panel.querySelectorAll('.step-details-content');
    const allBtns = panel.querySelectorAll('.step-main .details-toggle');
    const isExpanding = mainBtn.textContent === '展开全部';
    allContent.forEach(el => { if(isExpanding) el.classList.add('show'); else el.classList.remove('show'); });
    allBtns.forEach(btn => { btn.textContent = isExpanding ? '收起详情' : '查看详情'; });
    mainBtn.textContent = isExpanding ? '收起全部' : '展开全部';
};

function formatSubQueries(queries) {
    if (!queries || queries.length === 0) return '';
    return `<ul class="sub-query-list">${queries.map(q => `<li class="sub-query-item">${q}</li>`).join('')}</ul>`;
}

function hasToolResults(toolResults) {
    return !!(toolResults && typeof toolResults === 'object' && Object.keys(toolResults).length > 0);
}

function getToolSource(toolName) {
    const finnhubTools = new Set(['get_stock_price', 'get_ipo_info', 'company_profile', 'company_news', 'basic_financials']);
    const yahooTools = new Set(['stock_snapshot', 'price_history']);
    if (finnhubTools.has(toolName)) return 'FinnHub';
    if (yahooTools.has(toolName)) return 'Yahoo Finance';
    return 'Tool';
}

function formatPrimitiveValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

function flattenToolResult(value, prefix = '') {
    const label = prefix || 'value';
    if (Array.isArray(value)) {
        if (value.length === 0) return [`${label}: []`];
        return value.flatMap((item, idx) => flattenToolResult(item, prefix ? `${prefix}.${idx}` : String(idx)));
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return [`${label}: {}`];
        return entries.flatMap(([key, nestedValue]) => {
            const nextPrefix = prefix ? `${prefix}.${key}` : key;
            return flattenToolResult(nestedValue, nextPrefix);
        });
    }
    return [`${label}: ${formatPrimitiveValue(value)}`];
}

function formatToolResults(toolResults) {
    if (!hasToolResults(toolResults)) return '';
    return `<div class="tool-results-section" style="margin-top:10px;">
        ${Object.entries(toolResults).map(([toolName, result]) => {
            const source = getToolSource(toolName);
            const lines = flattenToolResult(result).map(escapeHtml).join('\n');
            return `
                <div class="tool-result-card">
                    <div class="tool-result-header">
                        <span>来源: ${escapeHtml(source)}</span>
                        <button class="details-toggle" onclick="toggleToolResult(this)">点击展开</button>
                    </div>
                    <div style="padding:0 10px 8px; color:#666; font-size:12px;">${escapeHtml(toolName)}</div>
                    <div class="tool-result-body">${lines || '无工具结果'}</div>
                </div>
            `;
        }).join('')}
    </div>`;
}

function createToolLoadingElement() {
    const loading = document.createElement('div');
    loading.className = 'tool-search-loading';
    loading.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:10px; color:var(--color-secondary-text); font-size:13px;';
    loading.innerHTML = '<div class="agent-spinner"></div><span>正在联网搜索...</span>';
    return loading;
}

function formatAgents(agentOutputs) {
    if (!agentOutputs || agentOutputs.length === 0) return '<div style="color:#888; font-style:italic">无激活代理</div>';
    return `<div style="display:flex; flex-direction:column; gap:12px;">
        ${agentOutputs.map((a) => `
            <div class="agent-block" data-agent="${escapeHtml(a.agent || '')}" style="background:#fff; padding:10px; border:1px solid #eee; border-radius:6px;">
                <div style="display:flex; gap:10px; align-items:flex-start;">
                    <div class="agent-avatar" style="width:36px; min-width:36px;"></div>
                    <div style="flex:1;">
                        <div style="font-weight:600; color:var(--color-primary); margin-bottom:6px;">${escapeHtml(a.agent || '')}</div>
                        ${a.draft_answer ? `<div style="margin-top:6px; font-size:13px; color:#444;"><strong>草稿:</strong> ${a.draft_answer}</div>` : ''}
                        ${formatToolResults(a.tool_results || {})}
                        ${(a.sub_queries && a.sub_queries.length) ? `<div style="margin-top:10px;"><div style="font-weight:600; margin-bottom:6px; color:var(--color-primary);">Sub-queries</div>${formatSubQueries(a.sub_queries || [])}</div>` : ''}
                        ${createChunksHTML(a.evidence || [])}
                    </div>
                </div>
            </div>
        `).join('')}
    </div>`;
}

function formatPreviewDraftDetails(data) {
    if (!data) return '';

    const parts = [];
    if (data.message) {
        parts.push(`<div class="sub-answer-card"><div class="sub-answer-q">阶段说明</div><div style="font-size:13px;">${escapeHtml(data.message)}</div></div>`);
    }
    if (data.draft_answer) {
        parts.push(`<div style="margin-top:6px; font-size:13px; color:#444;"><strong>草稿:</strong> ${escapeHtml(data.draft_answer)}</div>`);
    }
    if (hasToolResults(data.tool_results)) {
        parts.push(formatToolResults(data.tool_results));
    }
    if (data.sub_queries && data.sub_queries.length) {
        parts.push(`<div style="margin-top:6px;"><div style="font-weight:600; margin-bottom:6px; color:var(--color-primary);">Sub-queries</div>${formatSubQueries(data.sub_queries)}</div>`);
    }
    if (data.evidence && data.evidence.length) {
        parts.push(createChunksHTML(data.evidence));
    }
    return parts.join('');
}

function formatAgenticJson(value) {
    try {
        return JSON.stringify(value === undefined ? null : value, null, 2);
    } catch (e) {
        return String(value);
    }
}

function getAgenticTurnKey(turn) {
    if (turn === undefined || turn === null || turn === '') return 'final';
    return String(turn);
}
const AGENTIC_VISIBLE_RECENT_LIMIT = 3;
const AGENTIC_MIN_HINT_DISPLAY_MS = 700;
const AGENTIC_TYPE_SLOW_INTERVAL_MS = 82;
const AGENTIC_TYPE_FAST_INTERVAL_MS = 38;
const AGENTIC_TYPE_ACCELERATE_MS = 650;
const AGENTIC_FEED_BOTTOM_THRESHOLD_PX = 12;
const AGENTIC_USER_SCROLL_WINDOW_MS = 1200;
const AGENTIC_COLLAPSIBLE_TOOLS = new Set(['Glob', 'Grep', 'Inspect', 'Read']);

function createAgenticLoopState(data = {}) {
    return {
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        roots: Array.isArray(data.roots) ? data.roots : [],
        toolNames: Array.isArray(data.tool_names) ? data.tool_names : [],
        turns: new Set(),
        items: [],
        nextId: 1,
        toolById: {},
        pendingByKey: {},
        followMode: true,
        activeItemId: '',
        visibleHint: '',
        hintVisibleUntil: 0,
        transcriptOpen: false,
        showTranscript: false,
        domByItemId: { feed: {}, transcript: {} },
        latestHint: '',
        initialized: false,
        renderTimer: null,
        liveTextTimer: null,
        liveTargetKey: '',
        liveTargetText: '',
        liveRenderedText: '',
        liveAcceleratedUntil: 0,
        suppressFeedScroll: false,
        feedUserScrollIntentAt: 0,
        feedScrollRaf: null,
        feedScrollTimer: null
    };
}

function clearAgenticTimers(state) {
    if (!state) return;
    if (state.renderTimer) {
        clearTimeout(state.renderTimer);
        state.renderTimer = null;
    }
    if (state.liveTextTimer) {
        clearTimeout(state.liveTextTimer);
        state.liveTextTimer = null;
    }
    if (state.feedScrollRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.feedScrollRaf);
        state.feedScrollRaf = null;
    }
    if (state.feedScrollTimer) {
        clearTimeout(state.feedScrollTimer);
        state.feedScrollTimer = null;
    }
}

function agenticCodeBlock(value, opts = {}) {
    const text = opts.raw ? String(value || '') : formatAgenticJson(value);
    const mode = opts.dark ? ' agentic-code-dark' : '';
    const longClass = opts.long ? ' agentic-code-long' : '';
    return `<pre class="agentic-code${mode}${longClass}">${escapeHtml(text)}</pre>`;
}

function getAgenticLoopStep(stepsContainer) {
    let stepEl = stepsContainer.querySelector('.execution-step[data-type="agentic_search"]');
    if (!stepEl) {
        updateStep(
            stepsContainer,
            'agentic_search',
            'running',
            'Agent Loop initializing...',
            '<div class="agentic-loop-panel"></div>',
            true
        );
        stepEl = stepsContainer.querySelector('.execution-step[data-type="agentic_search"]');
    }

    const stepBody = stepEl.querySelector('.step-body');
    let detailsEl = stepEl.querySelector('.step-details-content');
    if (!detailsEl) {
        detailsEl = document.createElement('div');
        detailsEl.className = 'step-details-content show';
        stepBody.appendChild(detailsEl);
    }
    detailsEl.classList.add('show');

    let toggleBtn = stepEl.querySelector('.step-main .details-toggle');
    if (!toggleBtn) {
        toggleBtn = document.createElement('button');
        toggleBtn.className = 'details-toggle';
        toggleBtn.textContent = '收起详情';
        toggleBtn.onclick = function() { toggleStepDetail(this); };
        const summaryEl = stepEl.querySelector('.step-summary');
        if (summaryEl) summaryEl.insertAdjacentElement('afterend', toggleBtn);
    }

    let panelEl = detailsEl.querySelector('.agentic-loop-panel');
    if (!panelEl) {
        panelEl = document.createElement('div');
        panelEl.className = 'agentic-loop-panel';
        detailsEl.innerHTML = '';
        detailsEl.appendChild(panelEl);
    }

    if (!stepEl._agenticLoopState) {
        stepEl._agenticLoopState = createAgenticLoopState();
    }

    return { stepEl, panelEl, state: stepEl._agenticLoopState };
}

function resetAgenticLoopState(stepEl, data) {
    clearAgenticTimers(stepEl._agenticLoopState);
    const state = createAgenticLoopState(data);
    state.initialized = true;
    stepEl._agenticLoopState = state;
    return state;
}

function rememberAgenticTurn(state, turn) {
    if (turn !== undefined && turn !== null && turn !== '') {
        state.turns.add(String(turn));
    }
}

function addAgenticItem(state, item) {
    item.id = item.id || `agentic-${state.nextId++}`;
    item.createdAt = item.createdAt || Date.now();
    item.updatedAt = item.updatedAt || item.createdAt;
    item.wasNew = true;
    state.items.push(item);
    return item;
}

function getAgenticPendingKey(data = {}) {
    if (data.tool_call_id) return String(data.tool_call_id);
    if (data.index !== undefined && data.index !== null) return `${getAgenticTurnKey(data.turn)}:${data.index}`;
    if (data.name) return `${getAgenticTurnKey(data.turn)}:${data.name}:latest`;
    return `${getAgenticTurnKey(data.turn)}:tool:latest`;
}

function registerAgenticTool(state, item, data = {}) {
    if (data.tool_call_id) {
        item.toolCallId = String(data.tool_call_id);
        state.toolById[item.toolCallId] = item.id;
    }
    const key = getAgenticPendingKey(data);
    if (key) {
        item.pendingKey = key;
        state.pendingByKey[key] = item.id;
    }
}

function findAgenticToolItem(state, data = {}) {
    const toolCallId = data.tool_call_id ? String(data.tool_call_id) : '';
    if (toolCallId && state.toolById[toolCallId]) {
        return state.items.find((item) => item.id === state.toolById[toolCallId]) || null;
    }

    const key = getAgenticPendingKey(data);
    if (key && state.pendingByKey[key]) {
        return state.items.find((item) => item.id === state.pendingByKey[key]) || null;
    }

    const turnKey = getAgenticTurnKey(data.turn);
    const name = data.name ? String(data.name) : '';
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i];
        if (item.type !== 'tool') continue;
        if (item.status !== 'preparing') continue;
        if (getAgenticTurnKey(item.turn) !== turnKey) continue;
        if (!name || item.name === name) return item;
    }
    return null;
}

function parseAgenticMaybeJson(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch (e) {
        return null;
    }
}

function getAgenticArg(args, keys) {
    const source = args || {};
    for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
    return '';
}

function agenticShortText(value, max = 110) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function agenticBaseName(path) {
    if (!path) return '';
    const normalized = String(path).replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() || normalized;
}

function isAgenticCollapsibleTool(item) {
    return item && item.type === 'tool' && AGENTIC_COLLAPSIBLE_TOOLS.has(item.name);
}

function getAgenticStatusClass(status) {
    if (status === 'done') return 'is-done';
    if (status === 'error') return 'is-error';
    if (status === 'preparing') return 'is-preparing';
    return 'is-running';
}

function getAgenticStatusLabel(status) {
    if (status === 'done') return '已完成';
    if (status === 'error') return '失败';
    return '运行中';
}

function getAgenticToolPreparingText(name) {
    if (name === 'Grep') return '正在准备搜索';
    if (name === 'Read') return '正在准备读取';
    if (name === 'Glob') return '正在匹配文件';
    if (name === 'Inspect') return '正在检查语料覆盖';
    if (name === 'FinishSearch') return '正在整理答案与证据';
    return name ? `正在准备 ${name}` : '正在准备工具调用';
}

function getAgenticToolUseSummary(name, args = {}) {
    if (name === 'Grep') {
        const pattern = getAgenticArg(args, ['pattern', 'query', 'regex']) || 'pattern';
        const scope = getAgenticArg(args, ['path', 'root', 'glob', 'include']) || 'corpus';
        return `搜索 "${agenticShortText(pattern, 72)}"${scope ? ` · ${agenticShortText(scope, 64)}` : ''}`;
    }
    if (name === 'Read') {
        const path = getAgenticArg(args, ['path', 'file_path']) || 'file';
        const page = getAgenticArg(args, ['page', 'pages']);
        const offset = getAgenticArg(args, ['offset', 'start_line', 'line']);
        const limit = getAgenticArg(args, ['limit', 'num_lines']);
        const range = page ? `第 ${page} 页` : (offset ? `第 ${offset} 行${limit ? ` +${limit}` : ''}` : '选定上下文');
        return `${agenticBaseName(path)} · ${range}`;
    }
    if (name === 'Glob') {
        const pattern = getAgenticArg(args, ['pattern', 'glob']) || '*';
        return `匹配 ${agenticShortText(pattern, 86)}`;
    }
    if (name === 'Inspect') {
        const root = getAgenticArg(args, ['path', 'root']) || 'corpus';
        return `检查 ${agenticShortText(root, 90)}`;
    }
    if (name === 'FinishSearch') return '答案 · 证据 · 覆盖';
    return agenticShortText(formatAgenticJson(args).replace(/\s+/g, ' '), 120);
}

function getAgenticToolResultSummary(item) {
    const result = item.result || {};
    if (item.ok === false || item.status === 'error') return item.error || '工具执行失败';

    if (item.name === 'Grep') {
        const files = result.matched_files ?? result.file_count ?? result.num_files ?? 0;
        const matches = result.total_matches ?? result.matches ?? result.match_count ?? 0;
        const searched = result.searched_files ?? result.scanned_files ?? 0;
        return `命中 ${matches} 处 / ${files} 个文件${searched ? ` · 扫描 ${searched}` : ''}`;
    }
    if (item.name === 'Read') {
        const lines = result.num_lines ?? result.line_count ?? 0;
        const pages = Array.isArray(result.pages) && result.pages.length ? ` · 第 ${result.pages.join(', ')} 页` : '';
        const path = result.rel_path || result.path || getAgenticArg(item.arguments, ['path', 'file_path']);
        return `读取 ${lines || '?'} 行${pages}${path ? ` · ${agenticBaseName(path)}` : ''}`;
    }
    if (item.name === 'Glob') {
        const files = result.num_files ?? (Array.isArray(result.files) ? result.files.length : 0);
        return `找到 ${files} 个候选文件`;
    }
    if (item.name === 'Inspect') {
        const total = result.total_files ?? result.file_count ?? 0;
        const extMap = result.extensions || result.extension_counts || result.by_extension || {};
        const extText = Object.entries(extMap).slice(0, 4).map(([ext, count]) => `${ext}:${count}`).join(', ');
        return `语料包含 ${total} 个文件${extText ? ` · ${extText}` : ''}`;
    }
    if (item.name === 'FinishSearch') return '已整理答案与证据包';
    return '工具执行完成';
}

function getAgenticToolHint(item) {
    const args = (item.arguments && Object.keys(item.arguments).length) ? item.arguments : (item.argsPreview || {});
    if (item.name === 'Grep') {
        const pattern = getAgenticArg(args, ['pattern', 'query', 'regex']);
        return pattern ? `"${agenticShortText(pattern, 110)}"` : '';
    }
    if (item.name === 'Read') {
        const path = getAgenticArg(args, ['path', 'file_path']) || (item.result && (item.result.rel_path || item.result.path));
        return path ? agenticBaseName(path) : '';
    }
    if (item.name === 'Glob') {
        const pattern = getAgenticArg(args, ['pattern', 'glob']);
        return pattern ? agenticShortText(pattern, 110) : '';
    }
    return '';
}

function setAgenticVisibleHint(state, text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    state.visibleHint = clean;
    state.hintVisibleUntil = Date.now() + AGENTIC_MIN_HINT_DISPLAY_MS;
}

function updateAgenticLatestHint(state, item) {
    const hint = getAgenticToolHint(item);
    if (hint) state.latestHint = hint;
    if (item.status === 'done' || item.status === 'error') {
        setAgenticVisibleHint(state, getAgenticToolResultSummary(item));
    } else {
        setAgenticVisibleHint(state, hint || getAgenticToolPreparingText(item.name));
    }
}

function getAgenticItemById(state, id) {
    if (!id) return null;
    return state.items.find((item) => item.id === id) || null;
}

function applyAgenticSearchEvent(state, data = {}) {
    const stage = data.stage;
    if (state.status === 'done') return;
    rememberAgenticTurn(state, data.turn);

    if (stage === 'turn_start') {
        state.status = 'running';
        state.latestHint = `Turn ${getAgenticTurnKey(data.turn)}`;
        const activeItem = getAgenticItemById(state, state.activeItemId);
        if (activeItem && getAgenticTurnKey(activeItem.turn) !== getAgenticTurnKey(data.turn)) {
            state.activeItemId = '';
            state.visibleHint = '';
            state.hintVisibleUntil = 0;
        }
        return;
    }

    if (stage === 'assistant_delta') {
        if (!data.content) return;
        const turnKey = getAgenticTurnKey(data.turn);
        let item = null;
        for (let i = state.items.length - 1; i >= 0; i--) {
            const candidate = state.items[i];
            if (candidate.type === 'assistant' && candidate.streaming && getAgenticTurnKey(candidate.turn) === turnKey) {
                item = candidate;
                break;
            }
        }
        if (!item) {
            item = addAgenticItem(state, {
                type: 'assistant',
                turn: data.turn,
                finalization: !!data.finalization,
                text: '',
                streaming: true,
                status: 'running'
            });
        }
        item.text += data.content || '';
        item.updatedAt = Date.now();
        state.activeItemId = item.id;
        setAgenticVisibleHint(state, agenticShortText(item.text, 140));
        return;
    }

    if (stage === 'assistant_message') {
        const content = data.content || '';
        if (!content) return;
        const turnKey = getAgenticTurnKey(data.turn);
        for (let i = state.items.length - 1; i >= 0; i--) {
            const candidate = state.items[i];
            if (candidate.type !== 'assistant') continue;
            if (getAgenticTurnKey(candidate.turn) !== turnKey) continue;
            const current = candidate.text || '';
            if (candidate.streaming || current.includes(content) || content.includes(current)) {
                candidate.text = content;
                candidate.streaming = false;
                candidate.status = 'done';
                candidate.updatedAt = Date.now();
                state.activeItemId = candidate.id;
                setAgenticVisibleHint(state, agenticShortText(content, 140));
                return;
            }
            break;
        }
        const item = addAgenticItem(state, {
            type: 'assistant',
            turn: data.turn,
            finalization: !!data.finalization,
            text: content,
            streaming: false,
            status: 'done'
        });
        state.activeItemId = item.id;
        setAgenticVisibleHint(state, agenticShortText(item.text, 140));
        return;
    }

    if (stage === 'tool_call_delta') {
        let item = findAgenticToolItem(state, data);
        if (!item) {
            item = addAgenticItem(state, {
                type: 'tool',
                turn: data.turn,
                finalization: !!data.finalization,
                name: data.name || 'Tool',
                status: 'preparing',
                arguments: {},
                argsPreview: {},
                startedAt: Date.now()
            });
        }
        if (data.name) item.name = data.name;
        item.status = item.status === 'done' ? 'done' : 'preparing';
        item.argumentText = data.arguments_so_far || item.argumentText || '';
        const parsed = parseAgenticMaybeJson(data.arguments_so_far);
        if (parsed) item.argsPreview = parsed;
        item.updatedAt = Date.now();
        state.activeItemId = item.id;
        registerAgenticTool(state, item, data);
        updateAgenticLatestHint(state, item);
        return;
    }

    if (stage === 'tool_call') {
        let item = findAgenticToolItem(state, data);
        if (!item) {
            item = addAgenticItem(state, {
                type: 'tool',
                turn: data.turn,
                finalization: !!data.finalization,
                startedAt: Date.now()
            });
        }
        item.type = 'tool';
        item.name = data.name || item.name || 'Tool';
        item.status = 'running';
        item.arguments = data.arguments || {};
        item.note = data.note || (item.arguments && item.arguments.public_note) || '';
        item.startedAt = item.startedAt || Date.now();
        item.updatedAt = Date.now();
        state.activeItemId = item.id;
        registerAgenticTool(state, item, data);
        updateAgenticLatestHint(state, item);
        return;
    }

    if (stage === 'tool_result') {
        let item = findAgenticToolItem(state, data);
        if (!item) {
            item = addAgenticItem(state, {
                type: 'tool',
                turn: data.turn,
                finalization: !!data.finalization,
                name: data.name || 'Tool',
                status: 'running',
                arguments: {},
                startedAt: Date.now()
            });
        }
        item.name = data.name || item.name || 'Tool';
        item.status = data.ok === false ? 'error' : 'done';
        item.ok = data.ok !== false;
        item.content = data.content || '';
        item.error = data.error || '';
        item.result = data.result || parseAgenticMaybeJson(data.content) || {};
        item.endedAt = Date.now();
        item.updatedAt = item.endedAt;
        if (state.activeItemId === item.id) state.activeItemId = '';
        registerAgenticTool(state, item, data);
        updateAgenticLatestHint(state, item);
        return;
    }

    if (stage === 'finish_rejected') {
        addAgenticItem(state, {
            type: 'rejection',
            turn: data.turn,
            status: 'done',
            reason: data.reason || 'coverage incomplete'
        });
        return;
    }

    if (stage === 'final') {
        state.status = 'done';
        state.endedAt = Date.now();
        state.activeItemId = '';
        for (const item of state.items) {
            if (item.type === 'tool' && (item.status === 'preparing' || item.status === 'running')) {
                item.status = 'done';
                item.ok = item.ok !== false;
                item.endedAt = item.endedAt || Date.now();
                item.updatedAt = item.endedAt;
            }
        }
        addAgenticItem(state, {
            type: 'final',
            turn: data.turn,
            status: 'done',
            answer: data.answer || '',
            evidence: data.evidence || [],
            coverage: data.coverage || {},
            gaps: data.gaps || [],
            reliabilityNotes: data.reliability_notes || [],
            confidence: data.confidence || '',
            stoppedReason: data.stopped_reason || ''
        });
        setAgenticVisibleHint(state, renderAgenticStepSummary(state));
        return;
    }

    if (stage === 'error') {
        state.status = 'error';
        state.endedAt = Date.now();
        state.activeItemId = '';
        const item = addAgenticItem(state, {
            type: 'error',
            turn: data.turn,
            status: 'error',
            message: data.message || 'Agent Loop error'
        });
        setAgenticVisibleHint(state, item.message);
    }
}

function computeAgenticStats(state) {
    const tools = state.items.filter((item) => item.type === 'tool');
    const grepTools = tools.filter((item) => item.name === 'Grep');
    const readTools = tools.filter((item) => item.name === 'Read' && item.status === 'done');
    const finalItem = [...state.items].reverse().find((item) => item.type === 'final');
    const elapsedMs = (state.endedAt || Date.now()) - state.startedAt;
    return {
        turns: state.turns.size,
        tools: tools.length,
        grepFiles: grepTools.reduce((sum, item) => sum + Number((item.result || {}).matched_files ?? (item.result || {}).file_count ?? (item.result || {}).num_files ?? 0), 0),
        grepMatches: grepTools.reduce((sum, item) => sum + Number((item.result || {}).total_matches ?? (item.result || {}).matches ?? (item.result || {}).match_count ?? 0), 0),
        reads: readTools.length,
        evidence: finalItem && Array.isArray(finalItem.evidence) ? finalItem.evidence.length : 0,
        elapsedMs
    };
}

function formatAgenticDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderAgenticStepSummary(state) {
    const stats = computeAgenticStats(state);
    const status = state.status === 'done' ? '完成' : state.status === 'error' ? '失败' : '运行中';
    return `${status} · ${stats.turns || 0} 轮 · ${stats.tools} 个工具 · ${formatAgenticDuration(stats.elapsedMs)}`;
}

function updateAgenticStepChrome(stepEl, state) {
    const status = state.status === 'error' ? 'error' : state.status === 'done' ? 'done' : 'running';
    stepEl.className = `execution-step step-${status}`;
    stepEl.setAttribute('data-status', status);

    const iconEl = stepEl.querySelector('.step-icon');
    const statusTextEl = stepEl.querySelector('.step-status-text');
    const summaryEl = stepEl.querySelector('.step-summary');
    if (iconEl) iconEl.classList.toggle('rotate-animation', status === 'running');
    if (statusTextEl) statusTextEl.textContent = getAgenticStatusLabel(status);
    if (summaryEl) {
        summaryEl.textContent = '';
        summaryEl.hidden = true;
    }
}

function buildAgenticGroupedEntries(items) {
    const entries = [];
    let group = [];
    const flush = () => {
        if (group.length) {
            entries.push({
                type: 'tool_group',
                id: `group-${group[0].id}`,
                items: group,
                status: group.some((item) => item.status === 'error') ? 'error' : group.some((item) => item.status === 'preparing' || item.status === 'running') ? 'running' : 'done',
                turn: group[0].turn
            });
            group = [];
        }
    };

    for (const item of items) {
        if (isAgenticCollapsibleTool(item)) {
            group.push(item);
        } else {
            flush();
            entries.push(item);
        }
    }
    flush();
    return entries;
}

function getAgenticTurnLabel(turn, finalization = false) {
    const key = getAgenticTurnKey(turn);
    return key === 'final' || finalization ? 'Final' : `Turn ${key}`;
}

function buildAgenticTranscriptEntries(state) {
    const entries = [];
    let currentTurn = '';
    for (const item of state.items) {
        const turnLabel = item.type === 'final' ? 'Final' : getAgenticTurnLabel(item.turn, item.finalization);
        if (turnLabel !== currentTurn) {
            entries.push({
                type: 'turn_divider',
                id: `turn-divider-${turnLabel}-${item.id}`,
                label: turnLabel
            });
            currentTurn = turnLabel;
        }
        entries.push(item);
    }
    return entries;
}

function pruneEmptyAgenticTurnDividers(entries) {
    const result = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type !== 'turn_divider') {
            result.push(entry);
            continue;
        }
        const next = entries[i + 1];
        if (next && next.type !== 'turn_divider') {
            result.push(entry);
        }
    }
    return result;
}

function getAgenticGroupSummary(group) {
    const counts = group.items.reduce((acc, item) => {
        acc[item.name] = (acc[item.name] || 0) + 1;
        return acc;
    }, {});
    const active = group.status === 'running' || group.status === 'preparing';
    const parts = [];
    if (counts.Glob) parts.push(`${active ? '正在匹配' : '已匹配'} ${counts.Glob} 个文件模式`);
    if (counts.Grep) parts.push(`${active ? '正在搜索' : '已搜索'} ${counts.Grep} 个关键词`);
    if (counts.Inspect) parts.push(`${active ? '正在检查' : '已检查'} ${counts.Inspect} 次语料覆盖`);
    if (counts.Read) parts.push(`${active ? '正在读取' : '已读取'} ${counts.Read} 个文件`);
    const text = parts.join('，') || (active ? '正在处理语料' : '已处理语料');
    return active ? `${text}...` : text;
}

function getAgenticGroupHint(group) {
    for (let i = group.items.length - 1; i >= 0; i--) {
        const hint = getAgenticToolHint(group.items[i]);
        if (hint) return hint;
    }
    return '';
}

function buildAgenticVisibleEntries(state) {
    if (state.status === 'running') {
        const entries = buildAgenticTranscriptEntries(state).filter((entry) => {
            return !(entry.type === 'assistant' && entry.id === state.activeItemId);
        });
        return { entries: pruneEmptyAgenticTurnDividers(entries), hiddenCount: 0 };
    }

    const entries = buildAgenticGroupedEntries(state.items).filter((entry) => {
        return !(state.status === 'running' && entry.type === 'assistant' && entry.id === state.activeItemId);
    });
    if (state.status === 'done') {
        const finalEntry = [...entries].reverse().find((entry) => entry.type === 'final');
        if (finalEntry) {
            return { entries: [finalEntry], hiddenCount: Math.max(0, entries.length - 1) };
        }
        const finishEntry = [...entries].reverse().find((entry) => entry.type === 'tool' && entry.name === 'FinishSearch');
        if (finishEntry) {
            return { entries: [finishEntry], hiddenCount: Math.max(0, entries.length - 1) };
        }
    }

    if (entries.length <= AGENTIC_VISIBLE_RECENT_LIMIT) {
        return { entries, hiddenCount: 0 };
    }

    const finalEntries = entries.filter((entry) => entry.type === 'final' || entry.type === 'error');
    const finalIds = new Set(finalEntries.map((entry) => entry.id));
    const nonFinal = entries.filter((entry) => !finalIds.has(entry.id));
    const recent = nonFinal.slice(-AGENTIC_VISIBLE_RECENT_LIMIT);
    const visibleIds = new Set([...recent, ...finalEntries].map((entry) => entry.id));
    return {
        entries: entries.filter((entry) => visibleIds.has(entry.id)),
        hiddenCount: entries.length - visibleIds.size
    };
}

function buildAgenticActivityText(state) {
    if (state.status === 'done') return '';
    const activeItem = getAgenticItemById(state, state.activeItemId);
    if (activeItem) {
        if (activeItem.type === 'assistant') {
            return activeItem.text ? agenticShortText(activeItem.text, 180) : 'Agent 正在组织说明...';
        }
        if (activeItem.type === 'tool') {
            const args = activeItem.arguments && Object.keys(activeItem.arguments).length ? activeItem.arguments : (activeItem.argsPreview || {});
            const summary = activeItem.status === 'preparing' ? getAgenticToolPreparingText(activeItem.name) : getAgenticToolUseSummary(activeItem.name, args);
            const hint = getAgenticToolHint(activeItem) || state.latestHint;
            return `${activeItem.name || 'Tool'} · ${summary}${hint ? ` · ${hint}` : ''}`;
        }
    }
    const activeTools = state.items.filter((item) => item.type === 'tool' && (item.status === 'preparing' || item.status === 'running'));
    if (activeTools.length) {
        const group = { items: activeTools, status: 'running' };
        const hint = getAgenticGroupHint(group) || state.latestHint;
        return `${getAgenticGroupSummary(group)}${hint ? ` · ${hint}` : ''}`;
    }
    if (!state.items.length) return 'Initializing...';
    if (Date.now() < state.hintVisibleUntil && state.visibleHint) return `刚完成：${state.visibleHint}`;
    if (state.latestHint && /^Turn\s+\S+$/i.test(state.latestHint)) return state.latestHint;
    return state.latestHint ? `最近：${state.latestHint}` : '等待下一步 agent 动作...';
}

function startAgenticLiveTextTimer(refs, state) {
    if (!refs || !refs.liveText || state.liveTextTimer) return;

    const tick = () => {
        const target = state.liveTargetText || '';
        if (!target) {
            state.liveRenderedText = '';
            refs.liveText.textContent = '';
            state.liveTextTimer = null;
            return;
        }

        if (state.liveRenderedText === target) {
            refs.liveText.textContent = target;
            state.liveTextTimer = null;
            return;
        }

        const remaining = Math.max(0, target.length - state.liveRenderedText.length);
        const fast = Date.now() < state.liveAcceleratedUntil || remaining > 120;
        const chunk = fast ? Math.min(remaining, 4) : 1;
        const nextLength = Math.min(target.length, state.liveRenderedText.length + Math.max(1, chunk));
        state.liveRenderedText = target.slice(0, nextLength);
        refs.liveText.textContent = state.liveRenderedText;
        state.liveTextTimer = setTimeout(tick, fast ? AGENTIC_TYPE_FAST_INTERVAL_MS : AGENTIC_TYPE_SLOW_INTERVAL_MS);
    };

    state.liveTextTimer = setTimeout(tick, 0);
}

function updateAgenticLiveText(refs, state, text, key = '') {
    const target = String(text || '');
    if (!target) {
        state.liveTargetKey = '';
        state.liveTargetText = '';
        state.liveRenderedText = '';
        state.liveAcceleratedUntil = 0;
        if (state.liveTextTimer) {
            clearTimeout(state.liveTextTimer);
            state.liveTextTimer = null;
        }
        if (refs && refs.liveText) refs.liveText.textContent = '';
        return;
    }

    const targetKey = String(key || target);
    const keyChanged = targetKey !== state.liveTargetKey;
    if (target !== state.liveTargetText || keyChanged) {
        const wasBehind = state.liveTargetText && state.liveRenderedText !== state.liveTargetText;
        const extendsPreviousTarget = state.liveTargetText && target.startsWith(state.liveTargetText);
        if (keyChanged || !extendsPreviousTarget || !target.startsWith(state.liveRenderedText)) {
            state.liveRenderedText = '';
        }
        state.liveTargetKey = targetKey;
        state.liveTargetText = target;
        if (wasBehind && !keyChanged) {
            state.liveAcceleratedUntil = Date.now() + AGENTIC_TYPE_ACCELERATE_MS;
        }
    }

    if (refs && refs.liveText) refs.liveText.textContent = state.liveRenderedText || '';
    startAgenticLiveTextTimer(refs, state);
}

function buildAgenticLiveKey(state, text) {
    if (!text) return '';
    const activeItem = getAgenticItemById(state, state.activeItemId);
    if (activeItem) return `item:${activeItem.id}:${activeItem.status || ''}`;
    if (state.latestHint && /^Turn\s+\S+$/i.test(state.latestHint)) return `turn:${state.latestHint}`;
    if (state.visibleHint && Date.now() < state.hintVisibleUntil) return `hint:${state.visibleHint}`;
    return `text:${text}`;
}

function renderAgenticTurnBadge(turn, finalization = false) {
    return `<span class="agentic-turn-badge">${escapeHtml(getAgenticTurnLabel(turn, finalization))}</span>`;
}

function renderAgenticTurnDivider(entry) {
    return `<div class="agentic-turn-divider">${escapeHtml(entry.label || 'Turn')}</div>`;
}

function renderAgenticDetails(title, contentHTML, open = false) {
    if (!contentHTML) return '';
    return `
        <details class="agentic-details" ${open ? 'open' : ''}>
            <summary>${escapeHtml(title)}</summary>
            ${contentHTML}
        </details>
    `;
}

function renderAgenticAssistantRow(item) {
    const statusClass = item.streaming ? 'is-running' : 'is-done';
    return `
        <div class="agentic-row is-assistant ${statusClass}">
            <span class="agentic-row-dot"></span>
            <div class="agentic-row-main">
                <div class="agentic-row-head is-assistant-head">
                    ${renderAgenticTurnBadge(item.turn, item.finalization)}
                    <span class="agentic-row-text">${escapeHtml(item.text || '')}${item.streaming ? '<span class="agentic-caret"></span>' : ''}</span>
                </div>
            </div>
        </div>
    `;
}

function renderAgenticToolDetails(item) {
    const args = item.arguments && Object.keys(item.arguments).length ? item.arguments : (item.argsPreview || {});
    const parts = [];
    if (args && Object.keys(args).length) parts.push(`<div class="agentic-detail-label">Arguments</div>${agenticCodeBlock(args, { dark: true })}`);
    if (item.content || item.error) parts.push(`<div class="agentic-detail-label">Tool output</div>${agenticCodeBlock(item.error || item.content, { raw: true, dark: true, long: true })}`);
    if (item.result && Object.keys(item.result).length) parts.push(`<div class="agentic-detail-label">Structured result</div>${agenticCodeBlock(item.result, { dark: true })}`);
    return parts.join('');
}

function renderAgenticToolMiniRow(item) {
    const args = item.arguments && Object.keys(item.arguments).length ? item.arguments : (item.argsPreview || {});
    const summary = item.status === 'preparing' ? getAgenticToolPreparingText(item.name) : getAgenticToolUseSummary(item.name, args);
    const resultSummary = (item.status === 'done' || item.status === 'error') ? getAgenticToolResultSummary(item) : '';
    return `
        <div class="agentic-mini-tool ${getAgenticStatusClass(item.status)}">
            <span class="agentic-row-dot"></span>
            <div>
                <div><strong>${escapeHtml(item.name || 'Tool')}</strong> <span>${escapeHtml(summary)}</span></div>
                ${resultSummary ? `<div class="agentic-row-subtle">${escapeHtml(resultSummary)}</div>` : ''}
                ${renderAgenticDetails('Details', renderAgenticToolDetails(item))}
            </div>
        </div>
    `;
}

function renderAgenticToolRow(item) {
    const args = item.arguments && Object.keys(item.arguments).length ? item.arguments : (item.argsPreview || {});
    const summary = item.status === 'preparing' ? getAgenticToolPreparingText(item.name) : getAgenticToolUseSummary(item.name, args);
    const resultSummary = (item.status === 'done' || item.status === 'error') ? getAgenticToolResultSummary(item) : '';
    const note = item.note || (args && args.public_note) || '';
    return `
        <div class="agentic-row is-tool ${getAgenticStatusClass(item.status)}">
            <span class="agentic-row-dot"></span>
            <div class="agentic-row-main">
                <div class="agentic-row-head">
                    ${renderAgenticTurnBadge(item.turn, item.finalization)}
                    <span class="agentic-row-title">${escapeHtml(item.name || 'Tool')}</span>
                    <span class="agentic-row-text">${escapeHtml(summary)}</span>
                </div>
                ${resultSummary ? `<div class="agentic-row-subtle">${escapeHtml(resultSummary)}</div>` : ''}
                ${note ? `<div class="agentic-public-note"><span class="agentic-public-note-label">工具目的</span><span>${escapeHtml(note)}</span></div>` : ''}
                ${renderAgenticDetails('Arguments and output', renderAgenticToolDetails(item))}
            </div>
        </div>
    `;
}

function renderAgenticToolGroup(group) {
    const hint = getAgenticGroupHint(group);
    const details = group.items.map(renderAgenticToolMiniRow).join('');
    return `
        <div class="agentic-row is-tool-group ${getAgenticStatusClass(group.status)}">
            <span class="agentic-row-dot"></span>
            <div class="agentic-row-main">
                <div class="agentic-row-head">
                    ${renderAgenticTurnBadge(group.turn)}
                    <span class="agentic-row-title">Search / Read</span>
                    <span class="agentic-row-text">${escapeHtml(getAgenticGroupSummary(group))}</span>
                </div>
                ${hint ? `<div class="agentic-row-subtle">${escapeHtml(hint)}</div>` : ''}
                ${renderAgenticDetails('View grouped tool calls', details)}
            </div>
        </div>
    `;
}

function formatAgenticEvidencePath(path) {
    if (!path) return '';
    const raw = String(path).replace(/\\/g, '/');
    if (/^https?:\/\//i.test(raw)) {
        try {
            const url = new URL(raw);
            const segments = url.pathname.split('/').filter(Boolean);
            const tail = segments.slice(-2).join('/');
            return tail ? `${url.hostname}/${tail}` : url.hostname;
        } catch (_) {
            return raw;
        }
    }
    const segments = raw.split('/').filter(Boolean);
    if (segments.length <= 2) return raw;
    return segments.slice(-2).join('/');
}

function renderAgenticEvidenceSummary(evidence) {
    if (!Array.isArray(evidence) || evidence.length === 0) return '<div class="agentic-row-subtle">未捕获直接证据。</div>';
    return `
        <div class="agentic-evidence-strip">
            ${evidence.slice(0, 3).map((item, idx) => {
                const sourcePath = (item && (item.path || item.source || item.file)) || '';
                const displayPath = formatAgenticEvidencePath(sourcePath) || `Evidence ${idx + 1}`;
                return `
                <div class="agentic-evidence-item">
                    <div class="agentic-evidence-path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</div>
                    ${item && item.quote ? `<div class="agentic-evidence-quote">${escapeHtml(agenticShortText(item.quote, 180))}</div>` : ''}
                </div>
            `;
            }).join('')}
            ${evidence.length > 3 ? `<div class="agentic-row-subtle">+ ${evidence.length - 3} 条证据在完整 transcript 中</div>` : ''}
        </div>
    `;
}

function renderAgenticFinalRow(item, state) {
    const stats = computeAgenticStats(state);
    const done = `Done (${stats.tools} tools · ${stats.evidence} evidence · ${formatAgenticDuration(stats.elapsedMs)})`;
    const packet = {
        answer: item.answer || '',
        evidence: item.evidence || [],
        coverage: item.coverage || {},
        gaps: item.gaps || [],
        reliability_notes: item.reliabilityNotes || [],
        confidence: item.confidence || '',
        stopped_reason: item.stoppedReason || ''
    };
    return `
        <div class="agentic-row is-final is-done">
            <span class="agentic-row-dot"></span>
            <div class="agentic-row-main">
                <div class="agentic-row-head">
                    ${renderAgenticTurnBadge(item.turn, true)}
                    <span class="agentic-row-title">FinishSearch</span>
                    <span class="agentic-row-text">${escapeHtml(done)}</span>
                </div>
                ${item.answer ? `<div class="agentic-answer">${escapeHtml(item.answer)}</div>` : ''}
                ${renderAgenticEvidenceSummary(item.evidence || [])}
                ${renderAgenticDetails('Full evidence packet', agenticCodeBlock(packet, { dark: true, long: true }))}
            </div>
        </div>
    `;
}

function renderAgenticNoteRow(item) {
    const isError = item.type === 'error';
    const label = isError ? 'Error' : 'FinishSearch 被拒绝';
    const text = isError ? item.message : item.reason;
    return `
        <div class="agentic-row ${isError ? 'is-error' : 'is-rejection'} ${isError ? 'is-error' : 'is-done'}">
            <span class="agentic-row-dot"></span>
            <div class="agentic-row-main">
                <div class="agentic-row-head">
                    ${renderAgenticTurnBadge(item.turn, item.finalization)}
                    <span class="agentic-row-title">${escapeHtml(label)}</span>
                    <span class="agentic-row-text">${escapeHtml(text || '')}</span>
                </div>
            </div>
        </div>
    `;
}

function renderAgenticEntry(entry, state) {
    if (entry.type === 'turn_divider') return renderAgenticTurnDivider(entry);
    if (entry.type === 'tool_group') return renderAgenticToolGroup(entry);
    if (entry.type === 'assistant') return renderAgenticAssistantRow(entry);
    if (entry.type === 'tool') return renderAgenticToolRow(entry);
    if (entry.type === 'final') return renderAgenticFinalRow(entry, state);
    if (entry.type === 'error' || entry.type === 'rejection') return renderAgenticNoteRow(entry);
    return '';
}

function ensureAgenticLoopShell(stepEl) {
    const panelEl = stepEl.querySelector('.agentic-loop-panel');
    if (!panelEl) return null;
    if (panelEl._agenticRefs) return panelEl._agenticRefs;

    panelEl.innerHTML = `
        <div class="agentic-loop-topbar">
            <div class="agentic-loop-title is-running" data-agentic-title>
                <span class="agentic-status-icon" aria-hidden="true">
                    <img class="agentic-status-search" src="icon/search.svg" alt="">
                    <span class="agentic-status-dot"></span>
                </span>
                <span>Agent Loop</span>
                <span class="agentic-state-label" data-agentic-status>运行中</span>
            </div>
            <div class="agentic-loop-metrics">
                <span class="agentic-chip" data-agentic-elapsed>0s</span>
            </div>
            <button type="button" class="agentic-transcript-toggle" data-agentic-transcript-toggle>展开 transcript</button>
        </div>
        <div class="agentic-live-line" data-agentic-live-line>
            <span class="agentic-live-dot"></span>
            <span class="agentic-active-text" data-agentic-live-text>Initializing...</span>
            <button type="button" class="agentic-follow-button" data-agentic-follow hidden>回到最新</button>
        </div>
        <div class="agentic-feed" data-agentic-feed role="log" aria-live="polite"></div>
        <div class="agentic-transcript-drawer" data-agentic-transcript-drawer hidden>
            <div class="agentic-transcript-drawer-head">完整 transcript</div>
            <div class="agentic-transcript-full" data-agentic-transcript-full></div>
        </div>
    `;

    const refs = {
        panel: panelEl,
        title: panelEl.querySelector('[data-agentic-title]'),
        status: panelEl.querySelector('[data-agentic-status]'),
        elapsed: panelEl.querySelector('[data-agentic-elapsed]'),
        transcriptToggle: panelEl.querySelector('[data-agentic-transcript-toggle]'),
        liveLine: panelEl.querySelector('[data-agentic-live-line]'),
        liveText: panelEl.querySelector('[data-agentic-live-text]'),
        follow: panelEl.querySelector('[data-agentic-follow]'),
        feed: panelEl.querySelector('[data-agentic-feed]'),
        transcriptDrawer: panelEl.querySelector('[data-agentic-transcript-drawer]'),
        transcriptFull: panelEl.querySelector('[data-agentic-transcript-full]')
    };

    const markFeedUserScrollIntent = () => {
        const state = stepEl._agenticLoopState;
        if (state && !state.suppressFeedScroll) {
            state.feedUserScrollIntentAt = Date.now();
        }
    };
    refs.feed.addEventListener('wheel', markFeedUserScrollIntent, { passive: true });
    refs.feed.addEventListener('touchstart', markFeedUserScrollIntent, { passive: true });
    refs.feed.addEventListener('pointerdown', markFeedUserScrollIntent);
    refs.feed.addEventListener('keydown', markFeedUserScrollIntent);
    refs.feed.addEventListener('scroll', () => {
        const state = stepEl._agenticLoopState;
        if (!state || state.suppressFeedScroll) return;
        const atBottom = isAgenticFeedAtBottom(refs.feed);
        if (atBottom) {
            state.followMode = true;
        } else if (Date.now() - state.feedUserScrollIntentAt < AGENTIC_USER_SCROLL_WINDOW_MS) {
            state.followMode = false;
        }
        updateAgenticFollowButton(refs, state);
    });
    refs.follow.addEventListener('click', () => {
        const state = stepEl._agenticLoopState;
        if (!state) return;
        state.followMode = true;
        scrollAgenticFeedToBottom(refs, state);
        updateAgenticFollowButton(refs, state);
    });
    refs.transcriptToggle.addEventListener('click', () => {
        const state = stepEl._agenticLoopState;
        if (!state) return;
        state.transcriptOpen = !state.transcriptOpen;
        state.showTranscript = state.transcriptOpen;
        renderAgenticLoopPanel(stepEl);
    });

    panelEl._agenticRefs = refs;
    return refs;
}

function updateAgenticFollowButton(refs, state) {
    if (!refs || !refs.follow) return;
    refs.follow.hidden = state.followMode || state.status === 'done';
}

function isAgenticFeedAtBottom(feed) {
    if (!feed) return true;
    if (feed.scrollHeight <= feed.clientHeight + AGENTIC_FEED_BOTTOM_THRESHOLD_PX) return true;
    const distance = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    return distance <= AGENTIC_FEED_BOTTOM_THRESHOLD_PX;
}

function scrollAgenticFeedToBottom(refs, state) {
    if (!refs || !refs.feed) return;
    if (state.feedScrollRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.feedScrollRaf);
        state.feedScrollRaf = null;
    }
    if (state.feedScrollTimer) {
        clearTimeout(state.feedScrollTimer);
        state.feedScrollTimer = null;
    }

    state.suppressFeedScroll = true;
    const applyScroll = () => {
        if (state.followMode) refs.feed.scrollTop = refs.feed.scrollHeight;
    };
    const finishScroll = () => {
        state.suppressFeedScroll = false;
        if (isAgenticFeedAtBottom(refs.feed)) state.followMode = true;
        updateAgenticFollowButton(refs, state);
    };

    if (typeof requestAnimationFrame === 'function') {
        state.feedScrollRaf = requestAnimationFrame(() => {
            state.feedScrollRaf = null;
            applyScroll();
            state.feedScrollTimer = setTimeout(() => {
                applyScroll();
                state.feedScrollTimer = null;
                finishScroll();
            }, 40);
        });
    } else {
        applyScroll();
        state.feedScrollTimer = setTimeout(() => {
            applyScroll();
            state.feedScrollTimer = null;
            finishScroll();
        }, 40);
    }
}

function syncAgenticEntryContainer(container, entries, state, bucket) {
    if (!container) return;
    const map = state.domByItemId[bucket] || (state.domByItemId[bucket] = {});
    const wanted = new Set(entries.map((entry) => entry.id));

    for (const entry of entries) {
        let wrapper = map[entry.id];
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'agentic-entry-shell is-new';
            wrapper.dataset.agenticEntryId = entry.id;
            map[entry.id] = wrapper;
            setTimeout(() => wrapper.classList.remove('is-new'), 260);
        }
        const html = renderAgenticEntry(entry, state);
        if (wrapper._agenticHtml !== html) {
            wrapper.innerHTML = html;
            wrapper._agenticHtml = html;
        }
        container.appendChild(wrapper);
    }

    for (const id of Object.keys(map)) {
        if (!wanted.has(id)) {
            map[id].remove();
            delete map[id];
        }
    }
}

function renderAgenticTopbarInto(refs, state, hiddenCount) {
    const stats = computeAgenticStats(state);
    const stateClass = state.status === 'done' ? 'is-done' : state.status === 'error' ? 'is-error' : 'is-running';
    refs.title.className = `agentic-loop-title ${stateClass}`;
    refs.status.textContent = getAgenticStatusLabel(state.status);
    if (refs.elapsed) refs.elapsed.textContent = formatAgenticDuration(stats.elapsedMs);
    refs.transcriptToggle.textContent = state.transcriptOpen
        ? '收起 transcript'
        : hiddenCount > 0 ? `展开 transcript (${hiddenCount})` : '展开 transcript';
}

function scheduleAgenticHintRefresh(stepEl, state) {
    if (state.renderTimer) {
        clearTimeout(state.renderTimer);
        state.renderTimer = null;
    }
    const delay = state.hintVisibleUntil - Date.now();
    if (delay > 0) {
        state.renderTimer = setTimeout(() => {
            state.renderTimer = null;
            renderAgenticLoopPanel(stepEl);
        }, delay + 20);
    }
}

function renderAgenticLoopPanel(stepEl) {
    const state = stepEl._agenticLoopState || createAgenticLoopState();
    stepEl._agenticLoopState = state;
    updateAgenticStepChrome(stepEl, state);

    const refs = ensureAgenticLoopShell(stepEl);
    if (!refs) return;

    const visible = buildAgenticVisibleEntries(state);
    const fullEntries = buildAgenticTranscriptEntries(state);
    const hiddenCount = visible.hiddenCount || 0;
    const finalOnly = state.status === 'done' && visible.entries.length === 1 && visible.entries[0].type === 'final';
    renderAgenticTopbarInto(refs, state, hiddenCount);

    const liveText = buildAgenticActivityText(state);
    refs.liveLine.hidden = !liveText;
    updateAgenticLiveText(refs, state, liveText, buildAgenticLiveKey(state, liveText));
    refs.feed.classList.toggle('is-final-only', finalOnly);

    if (visible.entries.length) {
        const empty = refs.feed.querySelector('.agentic-empty');
        if (empty) empty.remove();
        syncAgenticEntryContainer(refs.feed, visible.entries, state, 'feed');
    } else if (liveText) {
        refs.feed.innerHTML = '';
        state.domByItemId.feed = {};
    } else {
        refs.feed.innerHTML = '<div class="agentic-empty">Initializing...</div>';
        state.domByItemId.feed = {};
    }

    refs.transcriptDrawer.hidden = !state.transcriptOpen;
    if (state.transcriptOpen) {
        syncAgenticEntryContainer(refs.transcriptFull, fullEntries, state, 'transcript');
    }

    if (state.followMode) scrollAgenticFeedToBottom(refs, state);
    updateAgenticFollowButton(refs, state);
    scheduleAgenticHintRefresh(stepEl, state);
}

window.toggleAgenticTranscript = function(btn) {
    const stepEl = btn.closest('.execution-step[data-type="agentic_search"]');
    if (!stepEl || !stepEl._agenticLoopState) return;
    stepEl._agenticLoopState.transcriptOpen = !stepEl._agenticLoopState.transcriptOpen;
    stepEl._agenticLoopState.showTranscript = stepEl._agenticLoopState.transcriptOpen;
    renderAgenticLoopPanel(stepEl);
};

function renderAgenticSearchEvent(stepsContainer, data) {
    const stage = data && data.stage;
    const { stepEl, state: existingState } = getAgenticLoopStep(stepsContainer);
    let state = existingState;
    if (stage === 'start') {
        state = resetAgenticLoopState(stepEl, data || {});
    } else {
        applyAgenticSearchEvent(state, data || {});
    }
    renderAgenticLoopPanel(stepEl);
}

function formatAgentsPlaceholder(agentNames) {
    if (!agentNames || agentNames.length === 0) return '<div style="color:#888; font-style:italic">无激活代理</div>';
    return `<div style="display:flex; flex-direction:column; gap:12px;">
        ${agentNames.map((name) => `
            <div class="agent-block" data-agent="${escapeHtml(name || '')}" style="background:#fff; padding:10px; border:1px solid #eee; border-radius:6px;">
                <div style="display:flex; gap:10px; align-items:center;">
                    <div class="agent-avatar" style="width:36px; min-width:36px;"></div>
                    <div style="flex:1; display:flex; align-items:center; gap:8px;">
                        <div style="font-weight:600; color:var(--color-primary);">${escapeHtml(name || '')}</div>
                        <div class="agent-spinner" data-spinner-for="${escapeHtml(name || '')}"></div>
                    </div>
                </div>
                <div class="agent-output" style="margin-top:8px; color:#555; font-size:13px; display:none;"></div>
            </div>
        `).join('')}
    </div>`;
}

async function updateAgentBlock(detailsContainer, output) {
    const agentName = output.agent || '';
    const blocks = detailsContainer.querySelectorAll('.agent-block');
    let target = null;
    blocks.forEach(b => { if ((b.dataset.agent || '') === agentName) target = b; });

    const contentHtmlParts = [];
    if (output.draft_answer) contentHtmlParts.push(`<div style="margin-top:6px; font-size:13px; color:#444;"><strong>草稿:</strong> ${escapeHtml(output.draft_answer)}</div>`);
    if (hasToolResults(output.tool_results)) contentHtmlParts.push(formatToolResults(output.tool_results));
    if (output.sub_queries && output.sub_queries.length) contentHtmlParts.push(`<div style="margin-top:10px;"><div style="font-weight:600; margin-bottom:6px; color:var(--color-primary);">Sub-queries</div>${formatSubQueries(output.sub_queries)}</div>`);
    const evidenceHtml = (output.evidence && output.evidence.length) ? createChunksHTML(output.evidence) : '';
    const contentHtml = contentHtmlParts.join('') || '';

    if (!target) {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-block';
        wrapper.setAttribute('data-agent', escapeHtml(agentName));
        wrapper.innerHTML = `
            <div style="display:flex; gap:10px; align-items:flex-start;">
                <div class="agent-avatar" style="width:36px; min-width:36px;"></div>
                <div style="flex:1;">
                    <div style="font-weight:600; color:var(--color-primary); margin-bottom:6px;">${escapeHtml(agentName)}</div>
                    ${contentHtml}
                </div>
            </div>`;
        detailsContainer.appendChild(wrapper);
        attachAvatarsToAgentBlocks(detailsContainer);
        return;
    }

    const spinner = target.querySelector('.agent-spinner');
    if (spinner) spinner.remove();

    let outEl = target.querySelector('.agent-output');
    if (!outEl) {
        outEl = document.createElement('div');
        outEl.className = 'agent-output';
        outEl.style.cssText = 'margin-top:8px; color:#555; font-size:13px;';
        target.appendChild(outEl);
    }
    outEl.style.display = 'block';

    const draftText = output.draft_answer || '（已返回内容）';
    await typeText(outEl, draftText, 14);

    if (hasToolResults(output.tool_results)) {
        const loading = createToolLoadingElement();
        outEl.appendChild(loading);
        await sleep(250);
        const toolWrap = document.createElement('div');
        toolWrap.innerHTML = formatToolResults(output.tool_results);
        loading.replaceWith(toolWrap);
    }

    if (output.sub_queries && output.sub_queries.length) {
        const subWrap = document.createElement('div');
        subWrap.innerHTML = `<div style="margin-top:10px;"><div style="font-weight:600; margin-bottom:6px; color:var(--color-primary);">Sub-queries</div>${formatSubQueries(output.sub_queries)}</div>`;
        outEl.appendChild(subWrap);
    }

    if (evidenceHtml) { const evWrap = document.createElement('div'); evWrap.innerHTML = evidenceHtml; outEl.appendChild(evWrap); }
    attachAvatarsToAgentBlocks(target);
}

function createChunksHTML(evidences) {
    if (!evidences || evidences.length === 0) return '';
    const allChunks = [];
    evidences.forEach((ev) => { if (ev && ev.chunks && ev.chunks.length) ev.chunks.forEach(c => allChunks.push(c)); });
    if (allChunks.length === 0) return '';

    const chunkHtmls = allChunks.map((c, ci) => {
        const docid = (c.metadata && (c.metadata.doc_id || c.metadata.docId || c.metadata.id)) || '';
        const filename = (c.metadata && c.metadata.filename) || '';
        const full = escapeHtml((c.page_content || ''));
        const short = full.length > 120 ? full.slice(0, 120) + '...' : full;
        const pageNum = (c.metadata && (c.metadata.page || c.metadata.page_number || c.metadata.pageIndex)) || '';
        return `<div class="evidence-chunk-item" style="margin-top:6px; padding:6px; border:1px dashed #eee; border-radius:4px; background:#fafafa;">
            <div style="font-size:12px; color:#333; margin-bottom:4px;"><strong>Chunk ${ci+1}</strong> ${filename ? ' • ' + filename : ''}</div>
            <div class="chunk-snippet" data-full="${encodeURIComponent(full)}" style="font-size:12px; color:#555; white-space:pre-wrap;">${short}</div>
            <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
                <button class="details-toggle" onclick="openPdfDrawer('${encodeURIComponent(docid)}', '${encodeURIComponent(filename)}', '${encodeURIComponent(pageNum)}')">查看原文 PDF</button>
                <button class="details-toggle" onclick="toggleChunkExpand(this)">展开</button>
            </div>
        </div>`;
    }).join('');

    return `<div style="margin-top:6px;">
        <button class="details-toggle" onclick="toggleChunkList(this)">显示 Chunks (${allChunks.length})</button>
        <div class="evidence-chunk-list" style="margin-top:8px; display:none;">${chunkHtmls}</div>
    </div>`;
}

window.toggleChunkList = function(btn) {
    const list = btn.nextElementSibling;
    if (!list) return;
    const items = list.querySelectorAll('.evidence-chunk-item') || [];
    const isHidden = list.style.display === 'none' || list.style.display === '';
    if (isHidden) { list.style.display = 'block'; btn.textContent = '收起 Chunks'; }
    else { list.style.display = 'none'; btn.textContent = `显示 Chunks (${items.length})`; }
};

window.toggleToolResult = function(btn) {
    const card = btn.closest('.tool-result-card');
    const body = card ? card.querySelector('.tool-result-body') : null;
    if (!body) return;
    const isHidden = !body.classList.contains('show');
    body.classList.toggle('show', isHidden);
    btn.textContent = isHidden ? '收起' : '点击展开';
};

window.toggleChunkExpand = function(btn) {
    const item = btn.closest('.evidence-chunk-item');
    if (!item) return;
    const snippet = item.querySelector('.chunk-snippet');
    if (!snippet) return;
    const full = decodeURIComponent(snippet.dataset.full || '');
    const isExpanded = btn.dataset.expanded === '1';
    if (!isExpanded) { snippet.innerHTML = full; btn.textContent = '收起'; btn.dataset.expanded = '1'; }
    else { snippet.innerHTML = full.length > 120 ? full.slice(0, 120) + '...' : full; btn.textContent = '展开'; btn.dataset.expanded = '0'; }
};

function ensureDrawerExists() {
    if (document.getElementById('evidence-drawer')) return;
    const drawer = document.createElement('div');
    drawer.id = 'evidence-drawer';
    drawer.innerHTML = `
        <div id="evidence-drawer-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.3); display:none; z-index:2000;" onclick="closeEvidenceDrawer()"></div>
        <div id="evidence-drawer-panel" style="position:fixed; top:0; right:0; height:100%; width:42%; max-width:720px; background:#fff; box-shadow:-8px 0 24px rgba(0,0,0,0.12); transform:translateX(100%); transition:transform 0.28s ease; z-index:2001; display:flex; flex-direction:column;">
            <div style="padding:12px 16px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
                <div style="font-weight:600;">原始证据 JSON</div>
                <button onclick="closeEvidenceDrawer()" style="background:none;border:none;font-size:16px;cursor:pointer;">✕</button>
            </div>
            <div id="evidence-drawer-body" style="padding:12px; overflow:auto; flex:1; font-family:monospace; font-size:13px; white-space:pre-wrap;"></div>
        </div>
    `;
    document.body.appendChild(drawer);
}

window.openPdfDrawer = function(docidEnc, filenameEnc, pageEnc) {
    ensureDrawerExists();
    const docid = decodeURIComponent(docidEnc || '');
    const filename = decodeURIComponent(filenameEnc || '');
    const page = decodeURIComponent(pageEnc || '') || '';
    const overlay = document.getElementById('evidence-drawer-overlay');
    const panel = document.getElementById('evidence-drawer-panel');
    const body = document.getElementById('evidence-drawer-body');
    overlay.style.display = 'block';
    panel.style.transform = 'translateX(0)';
    body.textContent = '加载中 PDF...';

    const collection = 'zeekr';
    let base = '';
    if (filename) {
        const nameOnly = filename.split('/').pop();
        const stripped = nameOnly.replace(/_base_final\.json$/i, '').replace(/\.json$/i, '').replace(/\.pdf$/i, '');
        base = stripped;
    }
    if (!base) base = docid || 'document';
    const pdfName = base.endsWith('.pdf') ? base : base + '.pdf';
    let pdfUrl = `/pdf/${encodeURIComponent(collection)}/${encodeURIComponent(pdfName)}`;
    if (page) { const p = (Number(page) || 0) + 1; pdfUrl += `#page=${p}`; }

    body.innerHTML = '';
    const infoDiv = document.createElement('div');
    infoDiv.style.cssText = 'padding:8px 0 12px; font-size:13px; color:#333;';
    infoDiv.textContent = `PDF: ${pdfName}`;
    body.appendChild(infoDiv);
    const iframe = document.createElement('iframe');
    iframe.src = pdfUrl;
    iframe.style.cssText = 'width:100%; height:100%; border:none; flex:1;';
    body.appendChild(iframe);
};

window.closeEvidenceDrawer = function() {
    const overlay = document.getElementById('evidence-drawer-overlay');
    const panel = document.getElementById('evidence-drawer-panel');
    if (overlay) overlay.style.display = 'none';
    if (panel) panel.style.transform = 'translateX(100%)';
};

function renderMessage(role, content, extraElement = null, options = {}) {
    const INITIAL_MESSAGE = document.getElementById('initial-message');
    const scrollEl = getChatScrollEl();
    const mountRoot = getChatMessagesRoot();
    if (INITIAL_MESSAGE) INITIAL_MESSAGE.style.display = 'none';
    const rowDiv = document.createElement('div');
    rowDiv.classList.add('message-row', role + '-row');
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    const iconDiv = document.createElement('div');
    iconDiv.classList.add('message-icon');
    if (role === 'user') {
        iconDiv.textContent = 'U';
    } else {
        try {
            const idx = pickUniqueCharForKey('assistant');
            iconDiv.appendChild(createAvatarSpriteElement(idx, 36, 'idle'));
        } catch(e) { iconDiv.textContent = '✦'; }
    }
    const bubbleDiv = document.createElement('div');
    bubbleDiv.classList.add('message-bubble');
    if (role === 'assistant' && extraElement) bubbleDiv.appendChild(extraElement);
    const textDiv = document.createElement('div');
    textDiv.className = 'message-bubble-text';
    textDiv.innerHTML = content.replace(/\n/g, '<br>');
    if (content) bubbleDiv.appendChild(textDiv);
    if (role === 'user') { contentDiv.appendChild(bubbleDiv); contentDiv.appendChild(iconDiv); }
    else { contentDiv.appendChild(iconDiv); contentDiv.appendChild(bubbleDiv); }
    rowDiv.appendChild(contentDiv);
    mountRoot.appendChild(rowDiv);
    if (!options.skipScroll && scrollEl) requestChatScrollToBottom({ force: role === 'user', repeat: role === 'user' ? 4 : 2 });
    return textDiv;
}

function formatMessageBodyToHtml(text) {
    return escapeHtml(String(text || '')).replace(/\n/g, '<br>');
}

/**
 * 从历史 API 恢复助手气泡：与实时 Preview 一致（快速草稿 + 深度分析与 agent 徽标），不含思考过程面板。
 * @param {object} m - { draft_answer, final_answer, activated_agents, is_off_topic }
 */
function renderHistoryAssistantMessage(m, options = {}) {
    const INITIAL_MESSAGE = document.getElementById('initial-message');
    const scrollEl = getChatScrollEl();
    const mountRoot = getChatMessagesRoot();
    if (INITIAL_MESSAGE) INITIAL_MESSAGE.style.display = 'none';

    const rowDiv = document.createElement('div');
    rowDiv.classList.add('message-row', 'assistant-row');

    if (m.is_off_topic) {
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        const iconDiv = document.createElement('div');
        iconDiv.classList.add('message-icon');
        try {
            const idx = pickUniqueCharForKey('assistant');
            iconDiv.appendChild(createAvatarSpriteElement(idx, 36, 'done'));
        } catch (e) {
            iconDiv.textContent = '✦';
        }
        const bubbleDiv = document.createElement('div');
        bubbleDiv.classList.add('message-bubble');
        const textDiv = document.createElement('div');
        textDiv.className = 'message-bubble-text';
        textDiv.innerHTML = formatMessageBodyToHtml((m.final_answer || '').trim() || '（无回复）');
        bubbleDiv.appendChild(textDiv);
        contentDiv.appendChild(iconDiv);
        contentDiv.appendChild(bubbleDiv);
        rowDiv.appendChild(contentDiv);
        mountRoot.appendChild(rowDiv);
        if (!options.skipScroll && scrollEl) requestChatScrollToBottom({ repeat: 2 });
        return;
    }

    const draft = (m.draft_answer || '').trim();
    const finalAns = (m.final_answer || '').trim();
    const hasDraft = !!draft;

    const agentsHtml =
        Array.isArray(m.activated_agents) && m.activated_agents.length
            ? m.activated_agents
                  .map((a) => `<span class="phase-agents-badge">${escapeHtml(String(a))}</span>`)
                  .join('')
            : '';

    rowDiv.innerHTML = `
        <div class="message-content">
            <div class="message-icon"></div>
            <div class="message-bubble">
                ${
                    hasDraft
                        ? `
                <div class="phase-section phase-preliminary" style="display:block;">
                    <div class="phase-header">⚡ 快速草稿 (Quick Draft)</div>
                    <div class="phase-body">${formatMessageBodyToHtml(draft)}</div>
                </div>`
                        : ''
                }
                <div class="phase-section phase-comprehensive" style="display:block;">
                    <div class="phase-header">🔬 深度分析 (Deep Dive) <span class="history-phase2-agents">${agentsHtml}</span></div>
                    <div class="phase-body">${formatMessageBodyToHtml(finalAns || '（无回复）')}</div>
                </div>
            </div>
        </div>
    `;

    const iconEl = rowDiv.querySelector('.message-icon');
    try {
        const idx = pickUniqueCharForKey('assistant');
        iconEl.appendChild(createAvatarSpriteElement(idx, 36, 'done'));
    } catch (e) {
        iconEl.textContent = '✦';
    }

    mountRoot.appendChild(rowDiv);
    if (!options.skipScroll && scrollEl) requestChatScrollToBottom({ repeat: 2 });
}
