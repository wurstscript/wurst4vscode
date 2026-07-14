// @ts-nocheck
import { renderWc3Colors } from '../objModWebviewUtils';

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

// Same "does this look like it has WC3 markup" check as fieldDisplay.ts's hasColorMarkup — duplicated
// rather than imported (it's three lines, and richTextEditor.ts otherwise has no dependency on
// fieldDisplay.ts) so pasted/copied text can be told apart from ordinary plain text.
function looksLikeWc3Markup(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return s.indexOf('|c') !== -1 || s.indexOf('|n') !== -1 || s.indexOf('|r') !== -1 || s.indexOf(String.fromCharCode(10)) !== -1;
}

// Force plain-text paste into a contenteditable, EXCEPT when the pasted text itself is WC3 markup
// (|cffRRGGBB.../|n/|r — e.g. something copied from this same tooltip editor, or straight out of game
// data), in which case it's rendered as colors instead of showing the literal codes as text. Browser
// paste brings in far more than richToWc3() understands (bold, fonts, images, Word markup) — that
// would render in the preview but then silently vanish from the saved value on the next input event,
// with no indication anything changed, hence forcing everything else down to plain text.
// `el` (the tooltip's .tt-collapsed-body) is a fixed DOM node that gets re-entered into edit mode
// repeatedly across separate click-to-edit sessions — this only needs wiring once, ever, so a second
// call is a no-op rather than stacking another paste listener (which would insert pasted text twice).
export function forcePlainTextPaste(el) {
  if (el._pastePlainWired) return;
  el._pastePlainWired = true;
  el.addEventListener('paste', e => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const text = cd.getData('text/plain');
    if (!text) return;
    // execCommand('insertText') silently no-ops here often enough to matter: a box that was just
    // cleared and re-focused programmatically (e.g. right before a paste) doesn't always have the
    // browser-established caret/Range execCommand relies on, so the paste event fires with the right
    // clipboard text but nothing gets inserted. Inserting through the Selection/Range API directly
    // works regardless of how the caret got there, and still lands inside the existing undo
    // transaction the same way execCommand would.
    const sel = window.getSelection();
    const hasRange = sel && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer);
    const markup = looksLikeWc3Markup(text);
    if (hasRange) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      let lastNode;
      if (markup) {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderWc3Colors(text);
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) { lastNode = tmp.firstChild; frag.appendChild(lastNode); }
        range.insertNode(frag);
      } else {
        lastNode = document.createTextNode(text);
        range.insertNode(lastNode);
      }
      if (lastNode) { range.setStartAfter(lastNode); range.collapse(true); }
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (markup) {
      el.insertAdjacentHTML('beforeend', renderWc3Colors(text));
    } else {
      el.textContent += text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Makes native copy/cut on a tooltip's rich contenteditable put the raw WC3 string (|cffRRGGBB.../|n/
// |r) on the clipboard instead of the browser's default plain-text serialization (which just reads off
// rendered characters/colors, discarding the codes that produced them) — so a copy-paste round trip,
// even into a different tooltip field or a plain text editor, preserves formatting instead of silently
// flattening it. Copies just the selection if there is one (matching the toolbar's own Copy button),
// otherwise the whole tooltip. Cut additionally removes the selected content, same as native cut would.
export function forceWc3ColorCopy(el) {
  if (el._copyWc3Wired) return;
  el._copyWc3Wired = true;
  const handler = e => {
    const sel = window.getSelection();
    const hasSelection = sel && sel.rangeCount && !sel.isCollapsed && containsNode(el, sel.anchorNode) && containsNode(el, sel.focusNode);
    let text;
    if (hasSelection) {
      const wrap = document.createElement('div');
      wrap.appendChild(sel.getRangeAt(0).cloneContents());
      text = richToWc3(wrap);
    } else {
      text = richToWc3(el);
    }
    const cd = e.clipboardData || window.clipboardData;
    cd.setData('text/plain', text);
    e.preventDefault();
    if (e.type === 'cut' && hasSelection) {
      sel.getRangeAt(0).deleteContents();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  el.addEventListener('copy', handler);
  el.addEventListener('cut', handler);
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
//
// `rich` (the tooltip's .tt-collapsed-body) is a fixed DOM node reused across separate edit sessions —
// `bar` is a fresh toolbar each time, though, so each call's `syncColor` closure is only valid for the
// toolbar that was live when it was created. Without removing the previous session's listeners first,
// they'd pile up on `rich` and keep firing (harmlessly here, but the same reuse pattern is exactly
// what caused focusout listeners elsewhere to fire against a stale, already-detached toolbar).
export function wireColorBar(bar, rich, getTa) {
  const ta = () => (typeof getTa === 'function' ? getTa() : null);
  const useRaw = () => document.activeElement === ta();
  const syncColor = () => { if (rich) updateColorSwatch(bar, richSelectionColor(rich)); };
  if (rich) {
    if (rich._colorSyncHandlers) {
      for (const [ev, fn] of rich._colorSyncHandlers) rich.removeEventListener(ev, fn);
    }
    const handlers = [['keyup', syncColor], ['mouseup', syncColor], ['focus', syncColor], ['input', syncColor]];
    rich._colorSyncHandlers = handlers;
    activeRichSync = { rich, bar };
    syncColor();
    for (const [ev, fn] of handlers) rich.addEventListener(ev, fn);
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
