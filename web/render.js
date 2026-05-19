// All DOM painting lives here. Nothing else writes innerHTML.

export const RAINBOW = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'];

// Text colors only — backgrounds belong to the rainbow layers so they can show through.
export const FG = {
    Name: 'color:#ffffff',
    Number: 'color:#fdffab',
    String: 'color:#c8ffa7',
    StringList: 'color:#c8ffa7',
    Call: 'color:#9ce7ff',
    Function: 'color:#9ce7ff',
    MemberAccess: 'color:#ffffff',
    Operator: 'color:#ffaff3',
    Class: 'color:#ffddfa',
    TypeAnnotation: 'color:#ffddfa',
    Parameter: 'color:#ffddfa',
    Import: 'color:#fe7ab2;font-style:italic',
    ImportFrom: 'color:#fe7ab2;font-style:italic',
    ImportAs: 'color:#fe7ab2;font-style:italic',
    ImportFromAs: 'color:#fe7ab2;font-style:italic',
    keyword: 'color:#fe7ab2;font-style:italic',
    control: 'color:#ffd596;font-style:italic',
    builtin: 'color:#fe7ab2;font-style:italic',
    comment: 'color:#c4c4c4',
};

export const BG = {
    expr:  'background:rgba(255,255,210,.18)',
    found: 'background:rgba(210,240,255,.16)',
    mouse: 'background:rgba(255,235,215,.16)',
};

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function markup(source, marks) {
    const style = Array(source.length).fill('');
    for (const m of marks) {
        for (let i = Math.max(0, m.start); i < Math.min(source.length, m.end); i++) style[i] = m.style;
    }
    let html = '', start = 0, cur = style[0] || '';
    for (let i = 1; i <= source.length; i++) {
        if ((style[i] || '') !== cur || i === source.length) {
            const chunk = esc(source.slice(start, i));
            html += cur ? `<span style="${cur}">${chunk}</span>` : chunk;
            start = i;
            cur = style[i] || '';
        }
    }
    return html;
}

export function syntaxMarks(highlights) {
    return highlights
        .map(h => ({ start: h.start, end: h.end, style: FG[h.payload.kind] }))
        .filter(m => m.style);
}

export function renderEditor(editor, source, highlights) {
    editor.innerHTML = markup(source, syntaxMarks(highlights));
}

export function renderBg(bg, source, marks) {
    bg.innerHTML = markup(source, marks.filter(Boolean));
}

// Rainbow layers: per-layer span background is set by CSS via `.layer.<name> span { ... !important }`,
// so the inline style we pass through `markup` only needs to be non-empty (to emit a <span>).
export function paintLayer(layer, source, marks) {
    layer.innerHTML = markup(source, (marks ?? []).map(m => ({ start: m.start, end: m.end, style: 'background:transparent' })));
}

export function clearLayer(layer) {
    layer.innerHTML = '';
}
