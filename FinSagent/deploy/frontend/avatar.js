// avatar.js - Pixel sprite character animations

const CHARACTER_IMAGES = [
    'pixel-assets/assets/characters/char_0.png',
    'pixel-assets/assets/characters/char_1.png',
    'pixel-assets/assets/characters/char_2.png',
    'pixel-assets/assets/characters/char_3.png',
    'pixel-assets/assets/characters/char_4.png',
    'pixel-assets/assets/characters/char_5.png'
];

const SHEET_W = 112;
const SHEET_H = 96;
const FRAME_W = 16;
const FRAME_H = 32;
const COLS = 7;
const ROWS = 3;

const ASSIGNED_CHARS = {};

function pickUniqueCharForKey(key) {
    if (ASSIGNED_CHARS[key] !== undefined) return ASSIGNED_CHARS[key];
    const used = new Set(Object.values(ASSIGNED_CHARS));
    const available = CHARACTER_IMAGES.map((_, i) => i).filter(i => !used.has(i));
    const pick = available.length ? available[Math.floor(Math.random() * available.length)] : Math.floor(Math.random() * CHARACTER_IMAGES.length);
    ASSIGNED_CHARS[key] = pick;
    return pick;
}

function setAvatarFrame(el, charIdx, col, row, maxSize) {
    const paddingFactor = 0.85;
    const scale = Math.min(maxSize / FRAME_W, maxSize / FRAME_H) * paddingFactor;
    const frameW = FRAME_W * scale;
    const frameH = FRAME_H * scale;
    const img = CHARACTER_IMAGES[charIdx % CHARACTER_IMAGES.length];
    el.style.backgroundImage = `url('${img}')`;
    el.style.backgroundSize = `${SHEET_W * scale}px ${SHEET_H * scale}px`;
    el.style.backgroundPosition = `-${col * FRAME_W * scale}px -${row * FRAME_H * scale}px`;
    el.dataset.char = charIdx;
    el.dataset.col = col;
    el.dataset.row = row;
    el.style.width = Math.round(frameW) + 'px';
    el.style.height = Math.round(frameH) + 'px';
    el.style.borderRadius = '50%';
    el.style.border = 'none';
}

function startSpriteAnim(el, maxSize, interval = 180, row = 2) {
    stopSpriteAnim(el);
    const charIdx = Number(el.dataset.char) || 0;
    let col = Number(el.dataset.col) || 0;
    const animId = setInterval(() => {
        col = (col + 1) % COLS;
        setAvatarFrame(el, charIdx, col, row, maxSize);
    }, interval);
    el.dataset.spriteAnim = animId;
}

function stopSpriteAnim(el) {
    const id = el.dataset.spriteAnim;
    if (id) {
        clearInterval(Number(id));
        delete el.dataset.spriteAnim;
    }
}

function createAvatarSpriteElement(charIdx = 0, size = 36, state = 'idle', animRow = null) {
    const el = document.createElement('div');
    el.className = 'avatar-sprite';
    const startCol = Math.floor(Math.random() * COLS);
    const runningRow = animRow !== null ? animRow : 2;
    const doneRow = animRow !== null ? animRow : 0;
    if (state === 'running') {
        setAvatarFrame(el, charIdx, startCol, runningRow, size);
        startSpriteAnim(el, size, 180, runningRow);
    } else if (state === 'done') {
        setAvatarFrame(el, charIdx, startCol, doneRow, size);
        startSpriteAnim(el, size, 220, doneRow);
    } else {
        setAvatarFrame(el, charIdx, startCol, doneRow, size);
    }
    return el;
}

function setAvatarState(el, state, size = 36, animRow = null) {
    try {
        const charIdx = Number(el.dataset.char) || 0;
        if (state === 'running') {
            startSpriteAnim(el, size, 180, animRow !== null ? animRow : 2);
        } else if (state === 'done') {
            startSpriteAnim(el, size, 220, animRow !== null ? animRow : 0);
        } else {
            stopSpriteAnim(el);
            const row = animRow !== null ? animRow : 0;
            setAvatarFrame(el, charIdx, 0, row, size);
        }
    } catch (e) { console.error(e); }
}

function applyAvatarToStep(stepEl, stepType) {
    try {
        const iconEl = stepEl.querySelector('.step-icon');
        if (!iconEl) return;
        try {
            [...iconEl.classList].forEach(c => { if (c.startsWith('step-type-')) iconEl.classList.remove(c); });
        } catch(e) {}

        const key = 'step-' + stepType;
        const idx = pickUniqueCharForKey(key);
        iconEl.innerHTML = '';

        let size = 30;
        let animRow = null;
        switch (stepType) {
            case 'orchestrator': size = 40; animRow = 1; break;
            case 'agents': size = 34; animRow = 2; break;
            case 'synthesis': size = 36; animRow = 0; break;
            default: size = 30; animRow = null;
        }

        iconEl.classList.add(`step-type-${stepType}`);
        iconEl.setAttribute('title', (STEP_CONFIG[stepType] && STEP_CONFIG[stepType].title) || stepType);

        const state = (stepEl.dataset.status === 'running') ? 'running' : 'done';
        const avatar = createAvatarSpriteElement(idx, size, state, animRow);
        iconEl.appendChild(avatar);
    } catch (e) { console.error(e); }
}

function attachAvatarsToAgentBlocks(container) {
    if (!container) return;
    const blocks = container.querySelectorAll('.agent-block');
    blocks.forEach((b) => {
        const agentName = b.dataset.agent || '';
        const key = 'agent-' + agentName;
        const idx = pickUniqueCharForKey(key);
        const avatarWrap = b.querySelector('.agent-avatar');
        if (avatarWrap && !avatarWrap.querySelector('.avatar-sprite')) {
            const stepEl = b.closest('.execution-step');
            const status = stepEl ? stepEl.dataset.status : 'done';
            const state = status === 'running' ? 'running' : 'done';
            avatarWrap.appendChild(createAvatarSpriteElement(idx, 28, state));
        }
    });
}
