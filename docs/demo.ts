(globalThis as any).Buffer ??= { from: (x: string) => ({ toString: () => x }) };

const { collect_trees } = await import('../incandescent.ts');

const src = document.getElementById('source') as HTMLTextAreaElement;
const pre = document.getElementById('hilite') as HTMLPreElement;
const info = document.getElementById('info') as HTMLPreElement;
let trees = collect_trees(src.value), dirty = false;
const esc = (s: string) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));

function paint() {
  const s = src.value;
  let html = '', at = 0, kind = '';
  for (let i = 0; i < s.length; i++) {
    const hit = trees.highlights.query_max(i, i + 1)?.payload.kind ?? '';
    const k = /[+\-*/%@<>=!&|^~]/.test(s[i] ?? '') && /Operation/.test(hit) ? 'Operator' : hit.replace(/.*Operation/, '');
    if (k !== kind) {
      html += kind ? `<span class="${kind}">${esc(s.slice(at, i))}</span>` : esc(s.slice(at, i));
      at = i; kind = k;
    }
  }
  pre.innerHTML = html + (kind ? `<span class="${kind}">${esc(s.slice(at))}</span>` : esc(s.slice(at)));
}

function rebuild() { trees = collect_trees(src.value); dirty = false; paint(); show_info(); }
function changed() { dirty = true; queueMicrotask(rebuild); }
function show_info() {
  if (dirty) rebuild();
  const a = src.selectionStart, b = src.selectionEnd, s = Math.min(a,b), e = Math.max(a,b), point = s === e;
  const spans = point ? [[s, s + 1], [Math.max(0, s - 1), s]] : [[s, e]];
  const best = (tree: any) => spans.map(([x,y]) => tree.query_max(x,y)).filter(Boolean).sort((a,b) => b.height - a.height)[0];
  const type = best(trees.expression_types)?.payload.type;
  const definition = best(trees.identifier_uses)?.payload.definition;
  const line = trees.lines.query_max(s, point ? s + 1 : e)?.payload.name;
  info.innerText = JSON.stringify({ range: point ? { cursor: s } : { start: s, end: e }, line, type, definition }, null, 2);
}

src.addEventListener('input', changed);
src.addEventListener('scroll', () => { pre.scrollTop = src.scrollTop; pre.scrollLeft = src.scrollLeft; });
src.addEventListener('mouseup', show_info); src.addEventListener('keyup', show_info); src.addEventListener('select', show_info); src.addEventListener('click', show_info);
rebuild();
