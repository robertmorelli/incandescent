import { offsetFromPoint, saveCaret } from './caret.js';
import { BG, FG, markup, RAINBOW } from './render.js';
import { buildLineToCharRange, createView, lineOf } from './view.js';
import { create_analysis_session } from '../incandescent.ts';

// Each reflow table → which rainbow color identifies it.
const CATEGORIES = [
    { key: 'linked',  color: 'violet', label: 'linked'  },
    { key: 'reads',   color: 'orange', label: 'reads'   },
    { key: 'writes',  color: 'yellow', label: 'writes'  },
    { key: 'args',    color: 'green',  label: 'args'    },
    { key: 'calls',   color: 'blue',   label: 'calls'   },
    { key: 'returns', color: 'indigo', label: 'returns' },
    { key: 'indexed', color: 'red',    label: 'indexed' },
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

// Initialize in-memory serverless analysis session
const session = create_analysis_session();
let activeTrees = null;

// type_kind → underline color + style. Hue = semantic family, line-style = variant.
const TYPE_KIND_UNDERLINE = {
    dynamic_unknown:          { color: '#7a8090', style: 'dashed' },
    none_only:                { color: '#ffd166', style: 'solid'  },
    cinder_scalar:            { color: '#5aaaff', style: 'solid'  },
    cinder_checked_container: { color: '#5aaaff', style: 'double' },
    python_scalar:            { color: '#6ee678', style: 'solid'  },
    python_container:         { color: '#6ee678', style: 'dashed' },
    python_tuple:             { color: '#6ee678', style: 'double' },
    callable:                 { color: '#ff963c', style: 'solid'  },
    iterator:                 { color: '#ff963c', style: 'dashed' },
    optional:                 { color: '#8c6ee6', style: 'solid'  },
    union:                    { color: '#8c6ee6', style: 'dashed' },
    python_user_object:       { color: '#ff5a8a', style: 'solid'  },
};

function typeKindUnderlines(trees) {
    if (!trees) return [];
    const out = [];
    const tk = trees.backmaps.type_kind_by_annotation_id;
    for (const seg of trees.annotation_owners.ranges_by_id.values()) {
        const kind = tk.get(seg.id);
        if (!kind) continue;
        const m = TYPE_KIND_UNDERLINE[kind];
        if (!m) continue;
        const style = `text-decoration:underline;text-decoration-color:${m.color};text-decoration-style:${m.style};text-decoration-thickness:2px;text-underline-offset:3px`;
        out.push({ start: seg.start, end: seg.end, style, kind });
    }
    return out;
}

function ranges(tree) {
    return [...tree.ranges_by_id.values()].map((r) => ({
        start: r.start,
        end: r.end,
        height: r.height,
        payload: {
            kind: r.payload.kind,
            type: r.payload.type,
            name: r.payload.name,
            definition: r.payload.definition,
        },
    }));
}

function best(tree, spans) {
    return spans
        .map(([s, e]) => tree.query_max(s, e))
        .filter(Boolean)
        .sort((a, b) => b.height - a.height)[0];
}

function reflow(trees, id) {
    const b = trees.backmaps;
    const def_by_id = new Map();
    for (const r of trees.identifier_definitions.ranges_by_id.values()) {
        const d = r.payload.definition;
        if (d) def_by_id.set(d.id, { start: r.start, end: r.end });
    }
    const range_of = (i) => def_by_id.get(i);
    const tied_ids = b.tied_to_id.get(id) ?? [];
    const seen = new Set();
    const linked = [];
    for (const i of [id, ...tied_ids]) {
        const r = range_of(i);
        if (!r) continue;
        const k = `${r.start}:${r.end}`;
        if (seen.has(k)) continue;
        seen.add(k);
        linked.push(r);
    }
    return {
        id,
        role:    b.role_by_id.get(id),
        linked,
        reads:   (b.reads_by_id.get(id)  ?? []).map(r => ({ start: r.start, end: r.end })),
        writes:  (b.writes_by_id.get(id) ?? []).map(r => ({ start: r.start, end: r.end })),
        args:     b.args_by_parameter_id.get(id)   ?? [],
        calls:    b.calls_by_function_id.get(id)   ?? [],
        returns:  b.returns_by_function_id.get(id) ?? [],
        indexed:  b.indexed_by_id.get(id)          ?? [],
    };
}

function info(trees, start, end) {
    const point = start === end;
    const s = Math.min(start, end), e = Math.max(start, end);
    const spans = point ? [[start, start + 1], [Math.max(0, start - 1), start]] : [[s, e]];
    const expr = best(trees.expression_types, spans);
    const annOwner = best(trees.annotation_owners, spans);
    const use = annOwner ?? best(trees.identifier_uses, spans);
    const defId = use?.payload.definition?.id;
    const annId = annOwner?.id;
    const b = trees.backmaps;
    return {
        range: point ? { cursor: start } : { start: s, end: e },
        line: trees.lines.query_max(start, point ? start + 1 : end)?.payload.name,
        type: expr?.payload.type,
        definition: use?.payload.definition,
        expression_range: expr ? { start: expr.start, end: expr.end } : undefined,
        found_range: use?.payload.definition ? { start: use.payload.definition.start, end: use.payload.definition.end } : undefined,
        reflow: defId !== undefined ? reflow(trees, defId) : undefined,
        annotation: annId !== undefined ? {
            id: annId,
            range: { start: annOwner.start, end: annOwner.end },
            context: b.context_label_by_annotation_id.get(annId),
            type_kind: b.type_kind_by_annotation_id.get(annId),
            printed_type: b.printed_type_by_annotation_id.get(annId),
        } : undefined,
    };
}

const tx = {
    send(msg) {
        if (msg.kind === 'analyze') {
            const t0 = performance.now();
            const result = session.collect_trees_timed(msg.source);
            activeTrees = result.trees;
            const t1 = performance.now();
            const hs = ranges(activeTrees.highlights);
            const t2 = performance.now();

            const response = {
                kind: 'analyze',
                seq: msg.seq,
                client_sent_at: msg.client_sent_at,
                highlights: hs,
                timing: {
                    bytes: msg.source.length,
                    server_receive_ms: 0,
                    service_ms: result.timing.service_ms,
                    tree_build_ms: result.timing.tree_build_ms,
                    total_collect_ms: result.timing.total_collect_ms,
                    server_outer_collect_ms: +(t1 - t0).toFixed(2),
                    serialize_highlights_ms: +(t2 - t1).toFixed(2),
                    server_total_ms: +(t2 - t0).toFixed(2),
                }
            };
            setTimeout(() => handleMessage(response), 0);
        } else if (msg.kind === 'info') {
            if (!activeTrees) {
                activeTrees = session.collect_trees(source());
            }
            const infoData = info(activeTrees, msg.start, msg.end);
            const response = {
                kind: 'info',
                target: msg.target,
                data: infoData
            };
            setTimeout(() => handleMessage(response), 0);
        }
    }
};

setTimeout(() => analyze(), 0);

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
        mainView.setUnderlines(typeKindUnderlines(activeTrees));
        lastCursorReflowId = null;
        lastMouseReflowId = null;
        paintOverlays();
        showCursor();
        if (lastMouse) showMouseAt(lastMouse.x, lastMouse.y);
        return;
    }
    if (msg.kind === 'info') {
        const rid = `${msg.data.reflow?.id ?? ''}|${msg.data.annotation?.id ?? ''}`;
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
    const ann = data?.annotation;
    if (!reflow && !ann) { container.innerHTML = ''; return; }
    const parts = [];
    if (reflow) {
        parts.push(esc(String(reflow.id)));
        parts.push(esc(reflow.role ?? '—'));
    }
    if (ann) {
        const tk = ann.type_kind ?? '—';
        const u = TYPE_KIND_UNDERLINE[tk];
        const tkStyle = u
            ? `text-decoration:underline;text-decoration-color:${u.color};text-decoration-style:${u.style};text-decoration-thickness:2px;text-underline-offset:3px`
            : '';
        parts.push(`<span style="${tkStyle}">${esc(tk)}</span>`);
    }
    let html = `<div style="font:12px/1.4 monospace;color:#aab;padding:0 0 6px 0;">${parts.join(' | ')}</div>`;
    if (!reflow) { container.innerHTML = html; return; }
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

// Devtools ad-hoc dump: window.__dump(pos) shows the classifier result at a source offset.
globalThis.__trees = () => activeTrees;
globalThis.__dump = (pos) => {
    const t = activeTrees; if (!t) return 'no trees';
    const ann = t.annotation_owners.query_max(pos, pos + 1);
    if (!ann) return { pos, hit: null };
    return {
        pos,
        ann_id: ann.id,
        text: source().slice(ann.start, ann.end),
        context: t.backmaps.context_label_by_annotation_id.get(ann.id),
        type_kind: t.backmaps.type_kind_by_annotation_id.get(ann.id),
        printed: t.backmaps.printed_type_by_annotation_id.get(ann.id),
    };
};
globalThis.__dumpAll = () => {
    const t = activeTrees; if (!t) return 'no trees';
    const out = [];
    for (const s of t.annotation_owners.ranges_by_id.values()) {
        out.push({
            id: s.id,
            text: source().slice(s.start, s.end),
            type_kind: t.backmaps.type_kind_by_annotation_id.get(s.id),
            printed: t.backmaps.printed_type_by_annotation_id.get(s.id),
        });
    }
    return out;
};

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
