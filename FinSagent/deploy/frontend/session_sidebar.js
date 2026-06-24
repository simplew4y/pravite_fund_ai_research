/**
 * 会话侧栏：列表、新建、切换、重命名、删除；日期分组在前端完成。
 * 依赖后端 GET/POST/PATCH/DELETE /sessions（未配置 session_history_db 时隐藏侧栏）。
 */
(function () {
    const LS_KEY = 'finsagent_session_id';
    let currentSessionId = '';
    /** 当前已是「新会话页」且尚未完成任意一轮对话写入侧栏时，再点「开启新对话」无操作 */
    let isFreshNewChat = false;
    /** 保存正在流式输出的消息 DOM（key: sessionId, value: {userRow, assistantRow}），切换 session 时保存，回来时恢复 */
    const streamingSessions = {};

    // ========== URL 管理 ==========

    function getSessionIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('sid') || '';
    }

    function updateUrlWithSession(sessionId) {
        const url = new URL(window.location.href);
        if (sessionId) {
            url.searchParams.set('sid', sessionId);
        } else {
            url.searchParams.delete('sid');
        }
        history.pushState({ sessionId }, '', url.toString());
    }

    function clearUrlSession() {
        updateUrlWithSession('');
    }

    // ========== Session ID 解析 ==========
// URL 有 sid → 用 URL 的（即使 localStorage 有不同的值）
// URL 无 sid → 返回空字符串（不在这里生成新 ID，让 init 决定行为）

function resolveSessionId() {
    const urlSid = getSessionIdFromUrl();
    if (urlSid) {
        currentSessionId = urlSid;
        localStorage.setItem(LS_KEY, currentSessionId);
        return currentSessionId;
    }
    // URL 无 sid，标记为无 session（由 init 决定是否创建新 session）
    return '';
}

    window.markSessionHasMessages = function () {
        isFreshNewChat = false;
    };

    /** 标记当前 session 正在流式输出（添加运行动画）；生成中时禁用「开启新对话」 */
    window.markSessionStreaming = function (streaming) {
        const sessionItem = document.querySelector(`.session-item[data-id="${currentSessionId}"]`);
        if (sessionItem) {
            sessionItem.classList.toggle('is-streaming', streaming);
        }
        const newBtn = document.getElementById('sidebar-new-chat');
        if (newBtn) {
            newBtn.disabled = !!streaming;
            newBtn.setAttribute('aria-disabled', streaming ? 'true' : 'false');
        }
    };

    /** 本轮 SSE 结束后清除「仅两行 DOM」缓存，避免切回会话时跳过拉全量历史 */
    window.clearStreamingSessionBackup = function (sessionId) {
        if (sessionId && streamingSessions[sessionId]) {
            delete streamingSessions[sessionId];
        }
    };

    /** 当前会话 id；空表示尚未向后端申请 id（发首条消息前由 ensureServerSessionBeforeSend POST 获取） */
    window.getCurrentSessionId = function () {
        return currentSessionId || '';
    };

    function looksLikeSessionUuid(s) {
        return (
            typeof s === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())
        );
    }

    /**
     * 发消息前调用：无有效 id 时 POST /sessions 获取 id，后端会插入默认 sessions 行；随后刷新侧栏以便长流程中可切换。
     */
    window.ensureServerSessionBeforeSend = async function () {
        let sid = (currentSessionId && String(currentSessionId).trim()) || '';
        if (looksLikeSessionUuid(sid) && !sid.startsWith('web_')) {
            return true;
        }
        try {
            const res = await fetch('/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!res.ok) return false;
            const data = await res.json();
            sid = (data && data.id && String(data.id).trim()) || '';
            if (!looksLikeSessionUuid(sid)) return false;
            currentSessionId = sid;
            localStorage.setItem(LS_KEY, currentSessionId);
            updateUrlWithSession(currentSessionId);
            setMainHeaderTitle('新对话');
            if (typeof window.refreshSessionSidebar === 'function') {
                await window.refreshSessionSidebar();
            }
            highlightActive();
            return true;
        } catch (e) {
            console.warn('ensureServerSessionBeforeSend', e);
            return false;
        }
    };

    function parseUpdatedAt(s) {
        if (!s) return new Date(0);
        const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
        const t = Date.parse(iso);
        return new Date(isNaN(t) ? Date.now() : t);
    }

    /** 前端分组键：today | d7 | d30 | older */
    function timeBucket(updated_at) {
        const u = parseUpdatedAt(updated_at);
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const uDay = new Date(u.getFullYear(), u.getMonth(), u.getDate());
        if (uDay.getTime() === startToday.getTime()) return 'today';
        const diffDays = Math.round((startToday - uDay) / 86400000);
        if (diffDays <= 7) return 'd7';
        if (diffDays <= 30) return 'd30';
        return 'older';
    }

    const GROUP_LABEL = {
        today: '今天',
        d7: '7 天内',
        d30: '30 天内',
        older: '更早',
    };

    const GROUP_ORDER = ['today', 'd7', 'd30', 'older'];

    /** 最近 GET /sessions 列表，用于主标题与当前 id 对齐 */
    let lastSessionsSnapshot = [];

    function setMainHeaderTitle(text) {
        const el = document.getElementById('main-header-title-text');
        const wrap = document.getElementById('main-header-title');
        const t = text != null && String(text).trim() ? String(text).trim() : '新对话';
        if (el) el.textContent = t;
        if (wrap) wrap.setAttribute('title', t);
    }

    function syncMainHeaderTitle() {
        const s = lastSessionsSnapshot.find((x) => x.id === currentSessionId);
        setMainHeaderTitle(s && s.title ? s.title : '新对话');
    }

    function highlightActive() {
        document.querySelectorAll('.session-item').forEach((el) => {
            el.classList.toggle('is-active', el.dataset.id === currentSessionId);
        });
    }

    function renderList(sessions) {
        const scroll = document.getElementById('session-list-scroll');
        if (!scroll) return;

        lastSessionsSnapshot = Array.isArray(sessions) ? sessions.slice() : [];

        const buckets = { today: [], d7: [], d30: [], older: [] };
        (sessions || []).forEach((s) => {
            buckets[timeBucket(s.updated_at)].push(s);
        });

        scroll.textContent = '';
        GROUP_ORDER.forEach((key) => {
            const arr = buckets[key];
            if (!arr.length) return;

            const groupEl = document.createElement('div');
            groupEl.className = 'session-group';
            const label = document.createElement('div');
            label.className = 'session-group-label';
            label.textContent = GROUP_LABEL[key];
            groupEl.appendChild(label);

            arr.forEach((s) => {
                const item = document.createElement('div');
                item.className = 'session-item' + (s.id === currentSessionId ? ' is-active' : '');
                item.dataset.id = s.id;
                item.setAttribute('role', 'button');
                item.tabIndex = 0;

                const title = document.createElement('span');
                title.className = 'session-item-title';
                title.textContent = s.title || '新对话';

                const menuBtn = document.createElement('button');
                menuBtn.type = 'button';
                menuBtn.className = 'session-item-menu';
                menuBtn.setAttribute('aria-label', '更多');
                menuBtn.innerHTML =
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="18" r="1.8"/></svg>';

                menuBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openSessionMenu(menuBtn, s.id, s.title);
                });

                item.appendChild(title);
                item.appendChild(menuBtn);

                item.addEventListener('click', () => switchSession(s.id, s.title));
                item.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        switchSession(s.id, s.title);
                    }
                });

                groupEl.appendChild(item);
            });

            scroll.appendChild(groupEl);
        });

        if (!scroll.children.length) {
            const empty = document.createElement('div');
            empty.className = 'session-empty-hint';
            empty.textContent = '暂无历史会话';
            scroll.appendChild(empty);
        }

        syncMainHeaderTitle();
    }

    let menuOverlay = null;

    function closeMenu() {
        if (menuOverlay) {
            menuOverlay.remove();
            menuOverlay = null;
        }
    }

    function openSessionMenu(anchorEl, sessionId, title) {
        closeMenu();
        const rect = anchorEl.getBoundingClientRect();
        menuOverlay = document.createElement('div');
        menuOverlay.className = 'session-menu-overlay';
        const panel = document.createElement('div');
        panel.className = 'session-menu-panel';
        const left = Math.min(Math.max(8, rect.left), window.innerWidth - 168);
        const top = Math.min(rect.bottom + 4, window.innerHeight - 120);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';

        const renameBtn = document.createElement('button');
        renameBtn.type = 'button';
        renameBtn.textContent = '重命名';
        renameBtn.addEventListener('click', async () => {
            closeMenu();
            const nt = window.prompt('会话标题', title || '');
            if (nt === null) return;
            const t = nt.trim() || '新对话';
            try {
                const r = await fetch('/sessions/' + encodeURIComponent(sessionId), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: t }),
                });
                if (!r.ok) throw new Error();
                await refreshSessionSidebar();
            } catch (e) {
                console.error(e);
                alert('重命名失败');
            }
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', async () => {
            closeMenu();
            if (!confirm('确定删除此会话？')) return;
            try {
                const r = await fetch('/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
                if (!r.ok && r.status !== 204) throw new Error();
                if (sessionId === currentSessionId) {
                    // 不自动 POST 新建会话：与「开启新对话」前空白态一致，下次发消息或点新对话再建
                    if (streamingSessions[sessionId]) {
                        delete streamingSessions[sessionId];
                    }
                    currentSessionId = '';
                    localStorage.removeItem(LS_KEY);
                    clearUrlSession();
                    setMainHeaderTitle('新对话');
                    clearChatToWelcome();
                    isFreshNewChat = true;
                }
                await refreshSessionSidebar();
            } catch (e) {
                console.error(e);
                alert('删除失败');
            }
        });

        panel.appendChild(renameBtn);
        panel.appendChild(delBtn);
        menuOverlay.appendChild(panel);
        document.body.appendChild(menuOverlay);
        menuOverlay.addEventListener('click', (e) => {
            if (e.target === menuOverlay) closeMenu();
        });
    }

    function clearChatToWelcome() {
        const root =
            document.getElementById('chat-messages-root') || document.getElementById('chat-container');
        if (!root) return;
        root.innerHTML = `
            <div class="welcome-message" id="initial-message">
                <h2>Hello, I'm FinSagent</h2>
                <p>我是您的专业金融 Agent。</p>
                <p>我可以帮您进行市场分析、财报解读和复杂问题规划。</p>
                <p style="font-size: 13px; margin-top: 12px; color: var(--color-primary);">
                    💡 提示：使用右上角「⚡ 预览模式」开关可切换快速草稿+深度分析（Preview）或标准单阶段响应模式
                </p>
            </div>`;
    }

    function escHtml(t) {
        return String(t || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * @param {string} id
     * @param {string|undefined} sessionTitle
     * @param {{ force?: boolean }} [opts] force=true：即使当前已是该 id 仍重新拉消息（页面带 ?sid= 刷新、popstate 等）
     */
    async function switchSession(id, sessionTitle, opts = {}) {
        const force = opts && opts.force === true;
        const prevSessionId = currentSessionId;
        if (!force && id === currentSessionId) return;
        currentSessionId = id;
        localStorage.setItem(LS_KEY, currentSessionId);
        updateUrlWithSession(id);  // 更新 URL
        isFreshNewChat = false;
        highlightActive();
        if (sessionTitle !== undefined && sessionTitle !== null) {
            setMainHeaderTitle(sessionTitle || '新对话');
        } else {
            syncMainHeaderTitle();
        }

        const scrollEl = document.getElementById('chat-container');
        const mountRoot =
            document.getElementById('chat-messages-root') || document.getElementById('chat-container');
        if (!mountRoot) return;

        // 保存当前 session 的流式输出状态（不移除，仅保存引用）
        // 注意：这里保存的是 DOM 引用，SSE 事件会继续更新它们
        if (prevSessionId && typeof window.isMessageSending === 'function' && window.isMessageSending()) {
            const rows = mountRoot.querySelectorAll('.message-row');
            const rowCountAtLeave = rows.length;
            if (rows.length >= 2) {
                streamingSessions[prevSessionId] = {
                    userRow: rows[rows.length - 2],
                    assistantRow: rows[rows.length - 1],
                    rowCountAtLeave,
                };
            } else if (rows.length === 1) {
                streamingSessions[prevSessionId] = {
                    userRow: null,
                    assistantRow: rows[0],
                    rowCountAtLeave,
                };
            }
        }

        mountRoot.innerHTML = '';

        try {
            const savedStreaming = streamingSessions[id];
            if (savedStreaming) {
                delete streamingSessions[id];
            }

            const r = await fetch('/sessions/' + encodeURIComponent(id) + '/messages');
            if (!r.ok) throw new Error('load messages');
            const data = await r.json();
            const msgs = data.messages || [];

            if (msgs.length === 0 && !savedStreaming) {
                clearChatToWelcome();
                return;
            }

            const skip = { skipScroll: true };
            msgs.forEach((m) => {
                renderMessage('user', escHtml(m.question), null, skip);
                renderHistoryAssistantMessage(m, skip);
            });

            // 离开会话时若正在流式，只缓存了最后两行；必须先拉全量再决定是否挂上未落库的那一轮
            if (savedStreaming) {
                const R = savedStreaming.rowCountAtLeave || 0;
                const renderedPersistedRows = msgs.length * 2;
                const needAppendInFlight = renderedPersistedRows < R;
                if (needAppendInFlight) {
                    if (savedStreaming.userRow) {
                        mountRoot.appendChild(savedStreaming.userRow);
                    }
                    mountRoot.appendChild(savedStreaming.assistantRow);
                }
            }

            if (typeof scrollChatToBottomInstant === 'function') {
                scrollChatToBottomInstant();
            } else if (scrollEl) {
                scrollEl.style.scrollBehavior = 'auto';
                scrollEl.scrollTop = scrollEl.scrollHeight;
                scrollEl.style.removeProperty('scroll-behavior');
            }
        } catch (e) {
            console.error(e);
            clearChatToWelcome();
        }

        if (window.innerWidth <= 900) closeMobileSidebar();
    }

    async function startNewChat() {
        if (isFreshNewChat) return;
        if (typeof window.isMessageSending === 'function' && window.isMessageSending()) return;
        currentSessionId = '';
        localStorage.removeItem(LS_KEY);
        clearUrlSession();
        setMainHeaderTitle('新对话');
        clearChatToWelcome();
        isFreshNewChat = true;
        await refreshSessionSidebar();
        highlightActive();
        document.getElementById('prompt-input')?.focus();
        if (window.innerWidth <= 900) closeMobileSidebar();
    }

    window.refreshSessionSidebar = async function () {
        try {
            const res = await fetch('/sessions');
            if (!res.ok) return;
            const data = await res.json();
            renderList(data.sessions || []);
            highlightActive();
        } catch (e) {
            /* ignore */
        }
    };

    function openMobileSidebar() {
        document.body.classList.add('sidebar-open');
    }

    function closeMobileSidebar() {
        document.body.classList.remove('sidebar-open');
    }

    async function init() {
        const sidebar = document.getElementById('session-sidebar');
        const newBtn = document.getElementById('sidebar-new-chat');
        const toggle = document.getElementById('sidebar-toggle-btn');
        const backdrop = document.getElementById('sidebar-backdrop');

        if (newBtn) newBtn.addEventListener('click', () => startNewChat());
        if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
        if (backdrop) backdrop.addEventListener('click', closeMobileSidebar);

        // 关键：优先从 URL 解析 session ID
        resolveSessionId();

        try {
            let res = await fetch('/sessions');
            if (res.status === 503) {
                sidebar?.classList.add('sidebar-hidden');
                document.getElementById('app-shell')?.classList.add('no-session-sidebar');
                setMainHeaderTitle('新对话');
                return;
            }
            if (!res.ok) throw new Error('list');

            let { sessions } = await res.json();

            if (!currentSessionId) {
                // URL 无 sid → 完全空白的新状态，不创建 session，不选中高亮
                currentSessionId = '';
                localStorage.removeItem(LS_KEY);
                clearUrlSession();
                setMainHeaderTitle('新对话');
                // 只有在 URL 无 sid 时才是真正的"新会话"状态
                isFreshNewChat = true;
                renderList(sessions);
                return;
            }

            // URL 有 sid：侧栏只列「有过消息」的会话，故需探测 DB 是否仍有该 id（含 0 条消息的空行）
            let exists = sessions.some((s) => s.id === currentSessionId);
            if (!exists) {
                const probe = await fetch('/sessions/' + encodeURIComponent(currentSessionId) + '/messages');
                if (probe.ok) {
                    exists = true;
                }
            }

            if (!exists) {
                // 无效 sid：不 POST 建空会话，与「开启新对话」一致
                currentSessionId = '';
                localStorage.removeItem(LS_KEY);
                clearUrlSession();
                setMainHeaderTitle('新对话');
                isFreshNewChat = true;
                clearChatToWelcome();
            } else {
                isFreshNewChat = false;
                await switchSession(currentSessionId, undefined, { force: true });
            }

            renderList(sessions);
            highlightActive();
        } catch (e) {
            console.warn('Session sidebar init:', e);
            sidebar?.classList.add('sidebar-hidden');
            document.getElementById('app-shell')?.classList.add('no-session-sidebar');
            setMainHeaderTitle('新对话');
        }
    }

    // 处理浏览器前进/后退按钮
    window.addEventListener('popstate', async (e) => {
        const prevId = currentSessionId;
        resolveSessionId();

        if (currentSessionId === prevId) return;

        // 如果 URL 变更为无 sid，显示空白状态
        if (!currentSessionId) {
            currentSessionId = '';
            localStorage.removeItem(LS_KEY);
            clearChatToWelcome();
            isFreshNewChat = true;
            setMainHeaderTitle('新对话');
            try {
                const res = await fetch('/sessions');
                if (!res.ok) return;
                const { sessions } = await res.json();
                renderList(sessions);
            } catch (e) {
                console.warn('popstate failed:', e);
            }
            return;
        }

        try {
            const res = await fetch('/sessions');
            if (!res.ok) return;
            const { sessions } = await res.json();
            let exists = sessions.some((s) => s.id === currentSessionId);
            if (!exists) {
                const probe = await fetch('/sessions/' + encodeURIComponent(currentSessionId) + '/messages');
                if (probe.ok) exists = true;
            }
            if (exists) {
                await switchSession(currentSessionId, undefined, { force: true });
                renderList(sessions);
                highlightActive();
            } else {
                currentSessionId = '';
                localStorage.removeItem(LS_KEY);
                clearUrlSession();
                setMainHeaderTitle('新对话');
                isFreshNewChat = true;
                clearChatToWelcome();
                renderList(sessions);
                highlightActive();
            }
        } catch (e) {
            console.warn('popstate failed:', e);
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
