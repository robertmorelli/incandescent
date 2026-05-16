const editor = document.getElementById('editor');
const bg = document.getElementById('bg');
const info = document.getElementById('info');
const mouseInfo = document.getElementById('mouse-info');
const ws = new WebSocket(`ws://${location.host}/ws`);

let highlights = [], seq = 0, latestSeq = 0, timing = null;
let cursorExpr = null, cursorFound = null, mouseExpr = null, lastMouse = null;

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const source = () => editor.innerText;
const fg = {
  Name: 'color:#ffffff', Number: 'color:#fdffab', String: 'color:#c8ffa7;background:#374048', StringList: 'color:#c8ffa7;background:#374048',
  Call: 'color:#9ce7ff', Function: 'color:#9ce7ff', MemberAccess: 'color:#ffffff', Operator: 'color:#ffaff3',
  Class: 'color:#ffddfa', TypeAnnotation: 'color:#ffddfa', Parameter: 'color:#ffddfa',
  Import: 'color:#fe7ab2;font-style:italic', ImportFrom: 'color:#fe7ab2;font-style:italic', ImportAs: 'color:#fe7ab2;font-style:italic', ImportFromAs: 'color:#fe7ab2;font-style:italic',
  keyword: 'color:#fe7ab2;font-style:italic', control: 'color:#ffd596;font-style:italic', builtin: 'color:#fe7ab2;font-style:italic', comment: 'color:#c4c4c4;background:#373B4A',
};
const bgStyle = {
  expr: 'background:rgba(255,255,210,.18)', found: 'background:rgba(210,240,255,.16)', mouse: 'background:rgba(255,235,215,.16)'
};

ws.onopen = analyze;
ws.onmessage = e => {
  const msg = JSON.parse(e.data);
  if (msg.kind === 'analyze') {
    if (msg.seq < latestSeq) return;
    msg.timing.transport_roundtrip_ms = +(performance.now() - msg.client_sent_at).toFixed(2);
    msg.timing.transport_minus_server_ms = +(msg.timing.transport_roundtrip_ms - msg.timing.server_total_ms).toFixed(2);
    highlights = msg.highlights; timing = msg.timing; render(); showCursor(); if (lastMouse) showMouseAt(lastMouse.x, lastMouse.y);
  }
  if (msg.kind === 'info') {
    const data = { ...msg.data, timing };
    if (msg.target === 'mouse') { mouseInfo.innerText = JSON.stringify(data, null, 2); mouseExpr = msg.data.expression_range; }
    else { info.innerText = JSON.stringify(data, null, 2); cursorExpr = msg.data.expression_range; cursorFound = msg.data.found_range; }
    renderBg();
  }
};

function analyze() { latestSeq = ++seq; send({ kind: 'analyze', seq: latestSeq, client_sent_at: performance.now(), source: source() }); }
function send(x) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x)); }

function saveCaret() {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(editor);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function restoreCaret(pos) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node, seen = 0;
  while ((node = walker.nextNode())) {
    const next = seen + node.nodeValue.length;
    if (pos <= next) {
      const r = document.createRange();
      r.setStart(node, pos - seen);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
    seen = next;
  }
}

function render() {
  const pos = saveCaret();
  const s = source();
  editor.innerHTML = markup(s, syntaxMarks(s));
  restoreCaret(pos);
  renderBg();
}
function renderBg() {
  const s = source();
  bg.innerHTML = markup(s, [
    cursorExpr && { ...cursorExpr, style: bgStyle.expr },
    cursorFound && { ...cursorFound, style: bgStyle.found },
    mouseExpr && { ...mouseExpr, style: bgStyle.mouse },
  ].filter(Boolean));
}
function markup(s, marks) {
  const style = Array(s.length).fill('');
  for (const m of marks) for (let i = Math.max(0, m.start); i < Math.min(s.length, m.end); i++) style[i] = m.style;
  let html = '', start = 0, cur = style[0] || '';
  for (let i = 1; i <= s.length; i++) if ((style[i] || '') !== cur || i === s.length) {
    const chunk = esc(s.slice(start, i));
    html += cur ? `<span style="${cur}">${chunk}</span>` : chunk;
    start = i; cur = style[i] || '';
  }
  return html;
}
function syntaxMarks(_s) {
  return highlights
    .map(h => ({ start: h.start, end: h.end, style: fg[h.payload.kind] }))
    .filter(m => m.style);
}

function caret() { return saveCaret(); }
function showCursor() { const p = caret(); send({ kind: 'info', target: 'cursor', start: p, end: p }); }
function showMouse(e) { lastMouse = { x: e.clientX, y: e.clientY }; showMouseAt(e.clientX, e.clientY); }
function showMouseAt(x, y) { const p = offsetFromPoint(x, y); send({ kind: 'info', target: 'mouse', start: p, end: p }); }
function offsetFromPoint(x, y) {
  const p = document.caretPositionFromPoint?.(x, y); if (p) return rangeOffset(p.offsetNode, p.offset);
  const r = document.caretRangeFromPoint?.(x, y); if (r) return rangeOffset(r.startContainer, r.startOffset);
  return caret();
}
function rangeOffset(node, offset) { const r = document.createRange(); r.selectNodeContents(editor); r.setEnd(node, offset); return r.toString().length; }

editor.addEventListener('input', () => { analyze(); });
editor.addEventListener('keyup', showCursor);
editor.addEventListener('mouseup', showCursor);
editor.addEventListener('click', showCursor);
editor.addEventListener('mousemove', showMouse);
editor.addEventListener('scroll', () => { bg.scrollTop = editor.scrollTop; bg.scrollLeft = editor.scrollLeft; });
render();
