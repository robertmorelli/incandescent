const src = document.getElementById('source');
const exprBg = document.getElementById('expr-bg');
const foundBg = document.getElementById('found-bg');
const mouseBg = document.getElementById('mouse-bg');
const pre = document.getElementById('hilite');
const info = document.getElementById('info');
const mouseInfo = document.getElementById('mouse-info');
let highlights = [], dirty = true, timer = 0;
const ws = new WebSocket(`ws://${location.host}/ws`);
const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

ws.onopen = analyze;
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.kind === 'analyze') { highlights = msg.highlights; dirty = false; paint(); info.innerText = JSON.stringify({ timing: msg.timing }, null, 2); show_info(); }
  if (msg.kind === 'timing') info.innerText = JSON.stringify({ timing: msg.timing }, null, 2);
  if (msg.kind === 'info') {
    (msg.target === 'mouse' ? mouseInfo : info).innerText = JSON.stringify(msg.data, null, 2);
    if (msg.target === 'mouse') mouseBg.innerHTML = range_html(msg.data.expression_range, 'mouse-hit');
    else paint_ranges(msg.data.expression_range, msg.data.found_range);
  }
};

function send(x) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x)); }
function analyze() { send({ kind: 'analyze', source: src.value }); }
function changed() { dirty = true; clearTimeout(timer); timer = setTimeout(analyze, 300); }
function paint() {
  const s = src.value;
  let html = '', at = 0, kind = '';
  for (let i = 0; i < s.length; i++) {
    const hit = best(highlights, [[i, i + 1]])?.payload.kind ?? '';
    const k = /[+\-*/%@<>=!&|^~]/.test(s[i] ?? '') && /Operation/.test(hit) ? 'Operator' : hit.replace(/.*Operation/, '');
    if (k !== kind) { html += kind ? `<span class="${kind}">${esc(s.slice(at, i))}</span>` : esc(s.slice(at, i)); at = i; kind = k; }
  }
  pre.innerHTML = html + (kind ? `<span class="${kind}">${esc(s.slice(at))}</span>` : esc(s.slice(at)));
}
function paint_ranges(expr, found) {
  exprBg.innerHTML = range_html(expr, 'expr-hit');
  foundBg.innerHTML = range_html(found, 'found-hit');
}
function range_html(r, cls) {
  const s = src.value;
  if (!r) return esc(s);
  return esc(s.slice(0, r.start)) + `<span class="${cls}">${esc(s.slice(r.start, r.end))}</span>` + esc(s.slice(r.end));
}
function best(ranges, spans) {
  return spans.flatMap(([s,e]) => ranges.filter(r => r.start <= s && r.end >= e)).sort((a,b) => b.height - a.height)[0];
}
function show_info() {
  const start = src.selectionStart, end = src.selectionEnd;
  send({ kind: 'info', target: 'cursor', start, end });
}
let lastMouse = 0;
function show_mouse(e) {
  if (dirty || Date.now() - lastMouse < 80) return;
  lastMouse = Date.now();
  const pos = offset_from_mouse(e);
  send({ kind: 'info', target: 'mouse', start: pos, end: pos });
}
function offset_from_mouse(e) {
  const p = text_position_from_point(e.clientX, e.clientY);
  if (p != null) return p;

  const cs = getComputedStyle(src), r = src.getBoundingClientRect();
  const x = e.clientX - r.left - parseFloat(cs.paddingLeft) + src.scrollLeft;
  const y = e.clientY - r.top - parseFloat(cs.paddingTop) + src.scrollTop;
  const lines = src.value.split('\n');
  const row = Math.max(0, Math.min(lines.length - 1, Math.floor(y / line_height())));
  let off = 0; for (let i = 0; i < row; i++) off += lines[i].length + 1;
  return off + Math.min(Math.max(0, Math.round(x / char_width())), lines[row].length);
}
function text_position_from_point(x, y) {
  const old = src.selectionStart;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p?.offsetNode === src || p?.offsetNode?.parentNode === src) return p.offset;
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r?.startContainer === src || r?.startContainer?.parentNode === src) return r.startOffset;
  }
  if (src.setSelectionRange && src.matches(':hover')) {
    document.caretPositionFromPoint?.(x, y);
    src.setSelectionRange(old, old);
  }
  return null;
}
let cw = 0;
function line_height() { return parseFloat(getComputedStyle(src).lineHeight); }
function char_width() {
  if (cw) return cw;
  const m = document.createElement('span');
  m.style.cssText = `position:fixed;left:-9999px;white-space:pre;font:${getComputedStyle(src).font}`;
  m.textContent = 'M'; document.body.append(m); cw = m.getBoundingClientRect().width; m.remove(); return cw;
}

src.addEventListener('input', changed);
src.addEventListener('scroll', () => {
  for (const el of [exprBg, foundBg, mouseBg, pre]) { el.scrollTop = src.scrollTop; el.scrollLeft = src.scrollLeft; }
});
src.addEventListener('mousemove', show_mouse);
src.addEventListener('mouseup', show_info); src.addEventListener('keyup', show_info); src.addEventListener('select', show_info); src.addEventListener('click', show_info);
