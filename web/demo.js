import { offsetFromPoint, saveCaret } from './caret.js';
import { BG, FG, markup, RAINBOW } from './render.js';
import { buildLineToCharRange, createView, lineOf } from './view.js';
import { connect } from './ws.js';

// Each reflow table → which rainbow color identifies it.
const CATEGORIES = [
    { key: 'linked',  color: 'violet', label: 'linked'  },
    { key: 'reads',   color: 'orange', label: 'reads'   },
    { key: 'writes',  color: 'yellow', label: 'writes'  },
    { key: 'args',    color: 'green',  label: 'args'    },
    { key: 'calls',   color: 'blue',   label: 'calls'   },
    { key: 'returns', color: 'indigo', label: 'returns' },
];

// CSS rgba values matched to the layer colors (used for data-view borders + section labels).
const CSS = {
    red:    'rgba(255, 60, 60, 1)',
    orange: 'rgba(255,150, 60, 1)',
    yellow: 'rgba(255,230, 90, 1)',
    green:  'rgba(110,230,120, 1)',
    blue:   'rgba( 90,170,255, 1)',
    indigo: 'rgba(140,110,230, 1)',
    violet: 'rgba(220,130,230, 1)',
};

const left      = document.getElementById('left');
const right     = document.getElementById('right');
const mouseCol  = document.getElementById('mouse-right');
const defaultSource = document.getElementById('default-source').textContent;

// Main editable view spans the entire left column.
const mainView = createView({
    container: left,
    source: defaultSource,
    editable: true,
});

let highlights = [];
let seq = 0, latestSeq = 0;
let timing = null;
let cursorExpr = null, cursorFound = null, mouseExpr = null;
let lastMouse = null;
let lineToCharRange = buildLineToCharRange(defaultSource);
let maxLine = 1;
let lastCursorReflowId = null, lastMouseReflowId = null;

const source = () => mainView.main.innerText;

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const tx = connect(wsUrl, {
    onopen: () => analyze(),
    onmessage: handleMessage,
});

function handleMessage(msg) {
    if (msg.kind === 'analyze') {
        if (msg.seq < latestSeq) return;
        msg.timing.transport_roundtrip_ms    = +(performance.now() - msg.client_sent_at).toFixed(2);
        msg.timing.transport_minus_server_ms = +(msg.timing.transport_roundtrip_ms - msg.timing.server_total_ms).toFixed(2);
        highlights = msg.highlights;
        timing = msg.timing;
        lineToCharRange = buildLineToCharRange(source());
        maxLine = Math.max(1, ...lineToCharRange.keys());
        mainView.setHighlights(highlights);
        lastCursorReflowId = null;
        lastMouseReflowId = null;
        paintOverlays();
        showCursor();
        if (lastMouse) showMouseAt(lastMouse.x, lastMouse.y);
        return;
    }
    if (msg.kind === 'info') {
        const rid = msg.data.reflow?.id ?? null;
        if (msg.target === 'mouse') {
            mouseExpr = msg.data.expression_range;
            if (rid !== lastMouseReflowId) {
                lastMouseReflowId = rid;
                renderColumn(mouseCol, msg.data);
            }
        } else {
            cursorExpr = msg.data.expression_range;
            cursorFound = msg.data.found_range;
            if (rid !== lastCursorReflowId) {
                lastCursorReflowId = rid;
                renderColumn(right, msg.data);
                applyReflowToMain(msg.data.reflow);
            }
        }
        paintOverlays();
    }
}

function paintOverlays() {
    mainView.paintBg([
        cursorExpr  && { ...cursorExpr,  style: BG.expr  },
        cursorFound && { ...cursorFound, style: BG.found },
        mouseExpr   && { ...mouseExpr,   style: BG.mouse },
    ]);
}

function applyReflowToMain(reflow) {
    if (!reflow) { mainView.clearAllLayers(); return; }
    for (const { key, color } of CATEGORIES) {
        mainView.paintLayer(color, reflow[key] ?? []);
    }
}

// Highlight backgrounds matching the rainbow layer alphas (used inline in mini snippets).
const HL_BG = {
    red:    'rgba(255, 60, 60,.60)',
    orange: 'rgba(255,150, 60,.60)',
    yellow: 'rgba(255,230, 90,.55)',
    green:  'rgba(110,230,120,.55)',
    blue:   'rgba( 90,170,255,.60)',
    indigo: 'rgba(140,110,230,.65)',
    violet: 'rgba(220,130,230,.60)',
};

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Single styled <pre> per snippet. Per-character style combines syntax FG color with the
// category's highlight background over the target range. No nested grids, no layers.
function snippetHTML(range, color) {
    const hitStart = lineOf(range.start, lineToCharRange) ?? 1;
    const hitEnd   = lineOf(Math.max(range.start, range.end - 1), lineToCharRange) ?? hitStart;
    const startLine = Math.max(1, hitStart - 1);
    const endLine   = Math.min(maxLine, hitEnd + 1);
    const s = lineToCharRange.get(startLine);
    const e = lineToCharRange.get(endLine);
    if (!s || !e) return '';
    const sliceStart = s.start, sliceEnd = e.end;
    const slice = source().slice(sliceStart, sliceEnd);

    const styles = new Array(slice.length).fill('');
    for (const h of highlights) {
        if (h.end <= sliceStart || h.start >= sliceEnd) continue;
        const fg = FG[h.payload.kind];
        if (!fg) continue;
        const lo = Math.max(0, h.start - sliceStart);
        const hi = Math.min(slice.length, h.end - sliceStart);
        for (let i = lo; i < hi; i++) styles[i] = fg;
    }
    const localStart = Math.max(0, range.start - sliceStart);
    const localEnd   = Math.min(slice.length, range.end - sliceStart);
    const bg = `background:${HL_BG[color]}`;
    for (let i = localStart; i < localEnd; i++) {
        styles[i] = styles[i] ? `${styles[i]};${bg}` : bg;
    }

    let inner = '', start = 0, cur = styles[0] || '';
    for (let i = 1; i <= slice.length; i++) {
        if ((styles[i] || '') !== cur || i === slice.length) {
            const chunk = esc(slice.slice(start, i));
            inner += cur ? `<span style="${cur}">${chunk}</span>` : chunk;
            start = i;
            cur = styles[i] || '';
        }
    }

    return `<pre class="data-view" tabindex="0" data-start="${range.start}" data-end="${range.end}" style="border-left-color:${CSS[color]}">${inner}</pre>`;
}

function renderColumn(container, data) {
    const reflow = data?.reflow;
    if (!reflow) { container.innerHTML = ''; return; }
    let html = `<div style="font:12px/1.4 monospace;color:#aab;padding:0 0 6px 0;">id ${esc(String(reflow.id))} · ${esc(reflow.role ?? '—')}</div>`;
    for (const { key, color, label } of CATEGORIES) {
        const entries = reflow[key] ?? [];
        if (!entries.length) continue;
        html += `<div class="data-section"><h4 style="color:${CSS[color]}">${label} (${entries.length})</h4>`;
        for (const range of entries) html += snippetHTML(range, color);
        html += `</div>`;
    }
    container.innerHTML = html;
}

// One delegated click/keyboard listener per column instead of one per snippet.
function attachColumnDelegate(container) {
    const handle = el => {
        if (!el) return;
        const start = Number(el.dataset.start), end = Number(el.dataset.end);
        if (Number.isFinite(start) && Number.isFinite(end)) jumpTo(start, end);
    };
    container.addEventListener('click',   e => handle(e.target.closest('.data-view')));
    container.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target.closest('.data-view');
        if (!el) return;
        e.preventDefault();
        handle(el);
    });
}
attachColumnDelegate(right);
attachColumnDelegate(mouseCol);

// Locate the (textNode, offsetWithinNode) pair for a file-coordinate offset inside main.
function findTextPos(main, offset) {
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    let node, seen = 0;
    while ((node = walker.nextNode())) {
        const next = seen + node.nodeValue.length;
        if (offset <= next) return { node, offset: offset - seen };
        seen = next;
    }
    return null;
}

// Scroll the main view so `range` is centered-ish, place the selection on it, focus the editor.
function jumpTo(start, end) {
    const main = mainView.main;
    const view = main.parentElement;
    const startPos = findTextPos(main, start);
    const endPos   = findTextPos(main, end);
    if (!startPos) return;
    const r = document.createRange();
    r.setStart(startPos.node, startPos.offset);
    if (endPos) r.setEnd(endPos.node, endPos.offset);
    else r.collapse(true);
    const rect = r.getBoundingClientRect();
    const viewRect = view.getBoundingClientRect();
    const target = view.scrollTop + (rect.top - viewRect.top) - view.clientHeight / 3;
    view.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    main.focus();
    showCursor();
}

function analyze() {
    latestSeq = ++seq;
    tx.send({ kind: 'analyze', seq: latestSeq, client_sent_at: performance.now(), source: source() });
}

function showCursor() {
    const p = saveCaret(mainView.main);
    tx.send({ kind: 'info', target: 'cursor', start: p, end: p });
}

let mouseScheduled = false;
function showMouse(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (mouseScheduled) return;
    mouseScheduled = true;
    requestAnimationFrame(() => {
        mouseScheduled = false;
        if (lastMouse) showMouseAt(lastMouse.x, lastMouse.y);
    });
}

function showMouseAt(x, y) {
    const p = offsetFromPoint(mainView.main, x, y);
    tx.send({ kind: 'info', target: 'mouse', start: p, end: p });
}

// Devtools ad-hoc API (paint rainbow layers on the main view).
globalThis.paintLayer     = (name, marks) => mainView.paintLayer(name, marks);
globalThis.clearLayer     = name           => mainView.clearLayer(name);
globalThis.clearAllLayers = ()             => mainView.clearAllLayers();
globalThis.RAINBOW        = RAINBOW;

mainView.main.addEventListener('input',     analyze);
mainView.main.addEventListener('keyup',     showCursor);
mainView.main.addEventListener('mouseup',   showCursor);
mainView.main.addEventListener('click',     showCursor);
mainView.main.addEventListener('mousemove', showMouse);

// Initial paint with empty highlights — replaced once the analyze response arrives.
mainView.setHighlights([]);
