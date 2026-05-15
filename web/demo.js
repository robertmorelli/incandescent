const src = document.getElementById('source');
const exprBg = document.getElementById('expr-bg');
const foundBg = document.getElementById('found-bg');
const mouseBg = document.getElementById('mouse-bg');
const pre = document.getElementById('hilite');
const info = document.getElementById('info');
const mouseInfo = document.getElementById('mouse-info');
let highlights = [], dirty = true, seq = 0, latestSeq = 0, lastTiming = null, lastMouseXY = null;
const ws = new WebSocket(`ws://${location.host}/ws`);
const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const blocks = s => s.replace(/[^\n]/g, '█');

ws.onopen = analyze;
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.kind === 'analyze') {
    if (msg.seq && msg.seq < latestSeq) return;
    msg.timing.transport_roundtrip_ms = +(performance.now() - msg.client_sent_at).toFixed(2);
    msg.timing.transport_minus_server_ms = +(msg.timing.transport_roundtrip_ms - msg.timing.server_total_ms).toFixed(2);
    highlights = msg.highlights; dirty = false; lastTiming = msg.timing; paint();
    show_info(); if (lastMouseXY) show_mouse_at(lastMouseXY.x, lastMouseXY.y);
  }
  if (msg.kind === 'info') {
    const data = { ...msg.data, timing: lastTiming };
    (msg.target === 'mouse' ? mouseInfo : info).innerText = JSON.stringify(data, null, 2);
    if (msg.target === 'mouse') mouseBg.innerHTML = range_html(msg.data.expression_range, 'mouse-hit');
    else { exprBg.innerHTML = range_html(msg.data.expression_range, 'expr-hit'); foundBg.innerHTML = range_html(msg.data.found_range, 'found-hit'); }
  }
};

function send(x) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(x)); }
function analyze() { latestSeq = ++seq; send({ kind: 'analyze', seq: latestSeq, client_sent_at: performance.now(), source: src.value }); }
function changed() { dirty = true; analyze(); }
function paint() {
  const s = src.value;
  let html = '', at = 0, kind = '';
  for (let i = 0; i < s.length; i++) {
    const hit = best(highlights, [[i, i + 1]])?.payload.kind ?? '';
    const k = /[+\-*/%@<>=!&|^~]/.test(s[i] ?? '') && /Operation/.test(hit) ? 'Operator' : hit.replace(/.*Operation/, '');
    if (k !== kind) { html += span(kind, s.slice(at, i)); at = i; kind = k; }
  }
  pre.innerHTML = html + span(kind, s.slice(at));
}
function span(kind, text) { return kind ? `<span class="${kind}">${esc(blocks(text))}</span>` : esc(blocks(text)); }
function range_html(r, cls) {
  const s = src.value;
  if (!r) return esc(blocks(s));
  return esc(blocks(s.slice(0, r.start))) + `<span class="${cls}">${esc(blocks(s.slice(r.start, r.end)))}</span>` + esc(blocks(s.slice(r.end)));
}
function best(ranges, spans) { return spans.flatMap(([s,e]) => ranges.filter(r => r.start <= s && r.end >= e)).sort((a,b) => b.height - a.height)[0]; }
function show_info() { send({ kind: 'info', target: 'cursor', start: src.selectionStart, end: src.selectionEnd }); }
let lastMouse = 0;
function show_mouse(e) { lastMouseXY = { x: e.clientX, y: e.clientY }; if (dirty || Date.now() - lastMouse < 80) return; lastMouse = Date.now(); show_mouse_at(e.clientX, e.clientY); }
function show_mouse_at(x, y) { const pos = offset_from_point(x, y); send({ kind: 'info', target: 'mouse', start: pos, end: pos }); }
function offset_from_point(clientX, clientY) {
  const p = text_position_from_point(clientX, clientY);
  if (p != null) return p;
  const cs = getComputedStyle(src), r = src.getBoundingClientRect();
  const x = clientX - r.left - parseFloat(cs.paddingLeft) + src.scrollLeft;
  const y = clientY - r.top - parseFloat(cs.paddingTop) + src.scrollTop;
  const lines = src.value.split('\n');
  const row = Math.max(0, Math.min(lines.length - 1, Math.floor(y / parseFloat(cs.lineHeight))));
  let off = 0; for (let i = 0; i < row; i++) off += lines[i].length + 1;
  return off + Math.min(Math.max(0, Math.round(x / char_width())), lines[row].length);
}
function text_position_from_point(x, y) {
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (p?.offsetNode === src || p?.offsetNode?.parentNode === src) return p.offset; }
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r?.startContainer === src || r?.startContainer?.parentNode === src) return r.startOffset; }
  return null;
}
let cw = 0;
function char_width() { if (cw) return cw; const m = document.createElement('span'); m.style.cssText = `position:fixed;left:-9999px;white-space:pre;font:${getComputedStyle(src).font}`; m.textContent = 'M'; document.body.append(m); cw = m.getBoundingClientRect().width; m.remove(); return cw; }

src.addEventListener('input', changed);
src.addEventListener('scroll', () => { for (const el of [exprBg, foundBg, mouseBg, pre]) { el.scrollTop = src.scrollTop; el.scrollLeft = src.scrollLeft; } });
src.addEventListener('mousemove', show_mouse);
src.addEventListener('mouseup', show_info); src.addEventListener('keyup', show_info); src.addEventListener('select', show_info); src.addEventListener('click', show_info);
