// One reusable view = the bg + 7 rainbow + main pre stack inside a grid container.
// Parameters:
//   container        — DOM element to render into
//   source           — full source text the view's coordinates are anchored to
//   editable         — boolean; main pre is contenteditable when true
//   lineStart/End    — 1-indexed inclusive line range to show (default: full source)
//   lineToCharRange  — Map<line, {start,end}> used to slice when line range is given
//   borderColor      — optional CSS color applied as a left border to the view container

import { BG, FG, markup, RAINBOW, syntaxMarks } from './render.js';
import { restoreCaret, saveCaret } from './caret.js';

let nextSeq = 0;

function el(tag, attrs = {}) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style') e.setAttribute('style', v);
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
    }
    return e;
}

export function createView(opts) {
    const id = ++nextSeq;
    const {
        container,
        source,
        editable = false,
        lineStart,
        lineEnd,
        lineToCharRange,
        borderColor,
        layers: layerNames = RAINBOW,   // which rainbow layers to actually build (default: all 7)
        withBg = true,                  // whether to build the bg overlay pre
    } = opts;

    // Slice the source to the line range if one was given.
    let displaySource = source;
    let offset = 0;
    if (lineStart !== undefined && lineEnd !== undefined && lineToCharRange) {
        const s = lineToCharRange.get(lineStart);
        const e = lineToCharRange.get(lineEnd);
        if (s && e) {
            offset = s.start;
            displaySource = source.slice(s.start, e.end);
        }
    }

    const view = el('div', { class: 'view' + (borderColor ? ' bordered' : '') });
    if (borderColor) view.style.setProperty('--border-color', borderColor);

    const bg = withBg ? el('pre', { class: 'bg' }) : null;
    const layers = {};
    for (const name of layerNames) {
        layers[name] = el('pre', { class: `layer ${name}` });
    }
    const main = el('pre', { class: 'main', id: `view-${id}-main` });
    if (editable) {
        main.setAttribute('contenteditable', 'true');
        main.setAttribute('spellcheck', 'false');
    }
    main.textContent = displaySource;

    if (bg) view.appendChild(bg);
    for (const n of layerNames) view.appendChild(layers[n]);
    view.appendChild(main);
    container.appendChild(view);

    let highlights = [];
    const layerMarks = Object.fromEntries(layerNames.map(n => [n, []]));
    let bgMarks = [];

    function translate(rangesWithStyle) {
        const lo = 0, hi = displaySource.length;
        const out = [];
        for (const r of rangesWithStyle ?? []) {
            if (!r) continue;
            const start = r.start - offset;
            const end = r.end - offset;
            if (end <= lo || start >= hi) continue;
            out.push({ ...r, start: Math.max(lo, start), end: Math.min(hi, end) });
        }
        return out;
    }

    function syncDisplaySourceFromMain() {
        if (!editable) return;
        if (lineStart !== undefined && lineEnd !== undefined) return;
        displaySource = main.innerText;
    }

    function repaintMain() {
        syncDisplaySourceFromMain();
        const filteredHighlights = translate(highlights.map(h => ({ ...h, start: h.start, end: h.end })));
        const marks = syntaxMarks(filteredHighlights);
        if (editable) {
            const pos = saveCaret(main);
            main.innerHTML = markup(displaySource, marks);
            restoreCaret(main, pos);
        } else {
            main.innerHTML = markup(displaySource, marks);
        }
    }

    function repaintLayer(name) {
        if (!layers[name]) return;
        syncDisplaySourceFromMain();
        const ms = translate(layerMarks[name].map(m => ({ start: m.start, end: m.end, style: 'background:transparent' })));
        // Layer content is just position-padding: space everywhere, block char at highlighted
        // positions, newlines preserved. Same column count as the source, so it aligns under the
        // editor. We don't duplicate the source text in every layer.
        const buf = new Array(displaySource.length);
        for (let i = 0; i < displaySource.length; i++) buf[i] = displaySource[i] === '\n' ? '\n' : ' ';
        for (const m of ms) {
            for (let i = m.start; i < Math.min(displaySource.length, m.end); i++) {
                if (buf[i] !== '\n') buf[i] = '█';
            }
        }
        layers[name].innerHTML = markup(buf.join(''), ms);
    }

    function repaintBg() {
        if (!bg) return;
        syncDisplaySourceFromMain();
        const ms = translate(bgMarks);
        // Same position-padding trick as layers — bg never duplicates the source text.
        const buf = new Array(displaySource.length);
        for (let i = 0; i < displaySource.length; i++) buf[i] = displaySource[i] === '\n' ? '\n' : ' ';
        for (const m of ms) {
            for (let i = m.start; i < Math.min(displaySource.length, m.end); i++) {
                if (buf[i] !== '\n') buf[i] = '█';
            }
        }
        bg.innerHTML = markup(buf.join(''), ms);
    }

    return {
        view, main, bg, layers,
        source: () => displaySource,
        offset: () => offset,

        setHighlights(hs) { highlights = hs ?? []; repaintMain(); },

        paintLayer(name, marks) {
            if (!layers[name]) return;
            layerMarks[name] = marks ?? [];
            repaintLayer(name);
        },
        clearLayer(name) {
            if (!layers[name]) return;
            layerMarks[name] = [];
            repaintLayer(name);
        },
        clearAllLayers() { for (const n of Object.keys(layers)) this.clearLayer(n); },

        paintBg(marks) { bgMarks = marks ?? []; repaintBg(); },
    };
}

// Find which 1-indexed line number contains a given character offset.
export function lineOf(pos, lineToCharRange) {
    for (const [num, r] of lineToCharRange) {
        if (pos >= r.start && pos <= r.end) return num;
    }
    return undefined;
}

// Build a Map<line, {start, end}> from a source string (mirrors server-side line_items).
export function buildLineToCharRange(source) {
    const m = new Map();
    let start = 0, line = 1;
    for (let i = 0; i <= source.length; i++) {
        if (i === source.length || source[i] === '\n') {
            m.set(line, { start, end: i });
            start = i + 1;
            line++;
        }
    }
    return m;
}
