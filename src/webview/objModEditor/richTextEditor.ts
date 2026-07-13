// @ts-nocheck

// Current selection range for a textarea (kept fresh even after blur, so toolbar/color-picker work).
export function taRange(ta) {
  const ss = ta._ss != null ? ta._ss : (ta.selectionStart || 0);
  const se = ta._se != null ? ta._se : (ta.selectionEnd || 0);
  return ss <= se ? [ss, se] : [se, ss];
}

export function applyToTextarea(ta, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  ta._ss = selStart; ta._se = selEnd;
  ta.dispatchEvent(new Event('input'));
}

// Wrap the current selection in |cffRRGGBB ... |r (hex = 6 chars, no '#').
export function wrapColor(ta, hex) {
  const r = taRange(ta);
  const val = ta.value;
  const open = '|cff' + String(hex).replace('#', '').toLowerCase();
  const selected = val.slice(r[0], r[1]) || 'text';
  ta.value = val.slice(0, r[0]) + open + selected + '|r' + val.slice(r[1]);
  const a = r[0] + open.length;
  applyToTextarea(ta, a, a + selected.length);
}

export function insertText(ta, text) {
  const r = taRange(ta);
  const val = ta.value;
  ta.value = val.slice(0, r[0]) + text + val.slice(r[1]);
  const c = r[0] + text.length;
  applyToTextarea(ta, c, c);
}

export function cssColorToHex(color) {
  const s = String(color || '').trim();
  const hex = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hex) return hex[1].toLowerCase();
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(s);
  if (!rgb) return '';
  return [rgb[1], rgb[2], rgb[3]].map(v => {
    const n = Math.max(0, Math.min(255, Number(v) || 0));
    return n.toString(16).padStart(2, '0');
  }).join('');
}

export function wc3EscapeText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\|/g, '||');
}

export function richNodeToWc3(node) {
  if (node.nodeType === Node.TEXT_NODE) return wc3EscapeText(node.nodeValue || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'br') return '|n';
  let out = '';
  const children = Array.from(el.childNodes || []);
  children.forEach((child, index) => {
    out += richNodeToWc3(child);
    const childTag = child.tagName ? child.tagName.toLowerCase() : '';
    if ((childTag === 'div' || childTag === 'p') && index < children.length - 1 && !out.endsWith('|n')) out += '|n';
  });
  const color = cssColorToHex(el.style?.color || el.getAttribute?.('color'));
  return color && out ? '|cff' + color + out + '|r' : out;
}

export function richToWc3(el) {
  return Array.from(el.childNodes || []).map(richNodeToWc3).join('').replace(/(\|n)+$/g, '');
}

export function setCaretEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

export function containsNode(parent, node) {
  while (node) {
    if (node === parent) return true;
    node = node.parentNode;
  }
  return false;
}

export function richSelectionColor(rich) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !containsNode(rich, sel.anchorNode)) return '';
  let node = sel.anchorNode;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== rich) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const explicit = cssColorToHex(node.style?.color || node.getAttribute?.('color'));
      if (explicit) return explicit;
      const computed = cssColorToHex(window.getComputedStyle(node).color);
      if (computed && computed !== 'ffffff') return computed;
    }
    node = node.parentNode;
  }
  return 'ffffff';
}

export function updateColorSwatch(bar, color) {
  const hex = (color || 'ffffff').replace('#', '').toLowerCase();
  const sq = bar?.querySelector('.tt-color-sq');
  const input = bar?.querySelector('.tt-color');
  if (sq) {
    sq.style.background = '#' + hex;
    sq.setAttribute('data-color', hex);
    sq.title = 'Text color #' + hex;
  }
  if (input) input.value = '#' + hex;
}

export function applyRichColor(rich, color) {
  const hex = String(color || '').replace('#', '').toLowerCase();
  if (!hex) return;
  if (richSelectionColor(rich) === hex) return;
  rich.focus();
  document.execCommand('foreColor', false, '#' + hex);
  rich.dispatchEvent(new Event('input', { bubbles: true }));
}

// Force plain-text paste into a contenteditable. richToWc3() only understands <br> and inline color —
// anything else a browser paste brings in (bold, fonts, images, Word markup) would render in the
// preview but then silently vanish from the saved value on the next input event, with no indication
// anything changed.
export function forcePlainTextPaste(el) {
  el.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
}

// Only one tooltip/color editor is ever open at a time in practice, so a single shared listener
// tracking whichever one was wired most recently is enough — registering a fresh `selectionchange`
// listener per `wireColorBar` call (once per click-to-edit, with no matching removal) accumulated one
// leaked, permanently-firing listener per edit for the whole session.
let activeRichSync = null;
document.addEventListener('selectionchange', () => {
  if (!activeRichSync) return;
  const { rich, bar } = activeRichSync;
  if (!rich.isConnected) { activeRichSync = null; return; }
  if (containsNode(rich, window.getSelection()?.anchorNode)) updateColorSwatch(bar, richSelectionColor(rich));
});

// `rich` is the contenteditable text the bar controls (always present). `getTa`, if given, is called
// at interaction time to get the current raw-text textarea (it may not exist yet — the raw panel is
// created lazily — so this can't be captured once up front like `rich` can).
export function wireColorBar(bar, rich, getTa) {
  const ta = () => (typeof getTa === 'function' ? getTa() : null);
  const useRaw = () => document.activeElement === ta();
  const syncColor = () => { if (rich) updateColorSwatch(bar, richSelectionColor(rich)); };
  if (rich) {
    activeRichSync = { rich, bar };
    syncColor();
    rich.addEventListener('keyup', syncColor);
    rich.addEventListener('mouseup', syncColor);
    rich.addEventListener('focus', syncColor);
    rich.addEventListener('input', syncColor);
  }
  const pop = bar.querySelector('.tt-pop');
  const sq = bar.querySelector('.tt-color-sq');
  if (sq) {
    sq.addEventListener('mousedown', e => e.preventDefault()); // keep textarea selection
    sq.addEventListener('click', () => { if (pop) pop.hidden = !pop.hidden; });
    sq.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (pop) pop.hidden = !pop.hidden; }
    });
  }
  if (pop) {
    for (const sw of pop.querySelectorAll('.tt-sw')) {
      sw.addEventListener('mousedown', e => e.preventDefault());
      sw.addEventListener('click', () => {
        const hex = sw.getAttribute('data-color');
        const t = ta();
        if (t && useRaw()) wrapColor(t, hex);
        else if (rich) applyRichColor(rich, hex);
        updateColorSwatch(bar, hex);
        pop.hidden = true;
      });
    }
    const colorInput = pop.querySelector('.tt-color');
    if (colorInput) colorInput.addEventListener('change', () => {
      const t = ta();
      if (t && useRaw()) wrapColor(t, colorInput.value);
      else if (rich) applyRichColor(rich, colorInput.value);
      updateColorSwatch(bar, colorInput.value);
      pop.hidden = true;
    });
  }
}
