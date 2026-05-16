const editor = document.getElementById('editor');

const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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

function highlight() {
  const pos = saveCaret();
  const text = editor.innerText;
  editor.innerHTML = esc(text).replace(/red/g, '<span class="red">red</span>');
  restoreCaret(pos);
}

editor.addEventListener('input', highlight);
highlight();
