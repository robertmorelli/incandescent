// Caret position helpers — pure DOM offset math, no globals.

export function saveCaret(editor) {
    const sel = getSelection();
    if (!sel.rangeCount) return 0;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(editor);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
}

export function restoreCaret(editor, pos) {
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

export function offsetFromPoint(editor, x, y) {
    const p = document.caretPositionFromPoint?.(x, y);
    if (p) return rangeOffset(editor, p.offsetNode, p.offset);
    const r = document.caretRangeFromPoint?.(x, y);
    if (r) return rangeOffset(editor, r.startContainer, r.startOffset);
    return saveCaret(editor);
}

function rangeOffset(editor, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.setEnd(node, offset);
    return r.toString().length;
}
