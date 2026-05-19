import { offsetFromPoint, restoreCaret, saveCaret } from './caret.js';
import { BG, clearLayer, paintLayer, RAINBOW, renderBg, renderEditor } from './render.js';
import { connect } from './ws.js';

const editor    = document.getElementById('editor');
const bg        = document.getElementById('bg');
const info      = document.getElementById('info');
const mouseInfo = document.getElementById('mouse-info');
const layers    = Object.fromEntries(RAINBOW.map(n => [n, document.getElementById(`layer-${n}`)]));

let highlights = [];
let seq = 0, latestSeq = 0;
let timing = null;
let cursorExpr = null, cursorFound = null, mouseExpr = null;
let lastMouse = null;

const source = () => editor.innerText;

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const tx = connect(wsUrl, {
    onopen: () => analyze(),
    onmessage: handleMessage,
});

function handleMessage(msg) {
    if (msg.kind === 'analyze') {
        if (msg.seq < latestSeq) return;
        msg.timing.transport_roundtrip_ms     = +(performance.now() - msg.client_sent_at).toFixed(2);
        msg.timing.transport_minus_server_ms  = +(msg.timing.transport_roundtrip_ms - msg.timing.server_total_ms).toFixed(2);
        highlights = msg.highlights;
        timing = msg.timing;
        const pos = saveCaret(editor);
        renderEditor(editor, source(), highlights);
        restoreCaret(editor, pos);
        paintOverlays();
        showCursor();
        if (lastMouse) showMouseAt(lastMouse.x, lastMouse.y);
        return;
    }
    if (msg.kind === 'info') {
        const data = { ...msg.data, timing };
        if (msg.target === 'mouse') {
            mouseInfo.innerText = JSON.stringify(data, null, 2);
            mouseExpr = msg.data.expression_range;
        } else {
            info.innerText = JSON.stringify(data, null, 2);
            cursorExpr = msg.data.expression_range;
            cursorFound = msg.data.found_range;
        }
        paintOverlays();
    }
}

function paintOverlays() {
    renderBg(bg, source(), [
        cursorExpr  && { ...cursorExpr,  style: BG.expr  },
        cursorFound && { ...cursorFound, style: BG.found },
        mouseExpr   && { ...mouseExpr,   style: BG.mouse },
    ]);
}

function analyze() {
    latestSeq = ++seq;
    tx.send({ kind: 'analyze', seq: latestSeq, client_sent_at: performance.now(), source: source() });
}

function showCursor() {
    const p = saveCaret(editor);
    tx.send({ kind: 'info', target: 'cursor', start: p, end: p });
}

function showMouse(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
    showMouseAt(e.clientX, e.clientY);
}

function showMouseAt(x, y) {
    const p = offsetFromPoint(editor, x, y);
    tx.send({ kind: 'info', target: 'mouse', start: p, end: p });
}

// Rainbow layer API — exposed for ad-hoc experiments from devtools.
globalThis.paintLayer     = (name, marks) => layers[name] && paintLayer(layers[name], source(), marks);
globalThis.clearLayer     = name          => layers[name] && clearLayer(layers[name]);
globalThis.clearAllLayers = ()            => { for (const n of RAINBOW) clearLayer(layers[n]); };
globalThis.RAINBOW        = RAINBOW;

editor.addEventListener('input',     analyze);
editor.addEventListener('keyup',     showCursor);
editor.addEventListener('mouseup',   showCursor);
editor.addEventListener('click',     showCursor);
editor.addEventListener('mousemove', showMouse);
editor.addEventListener('scroll', () => {
    bg.scrollTop  = editor.scrollTop;
    bg.scrollLeft = editor.scrollLeft;
    for (const n of RAINBOW) {
        const l = layers[n];
        l.scrollTop  = editor.scrollTop;
        l.scrollLeft = editor.scrollLeft;
    }
});

// Initial paint while we wait for the first analyze response.
renderEditor(editor, source(), highlights);
