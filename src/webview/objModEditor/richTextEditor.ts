// @ts-nocheck
import { renderWc3Colors } from '../objModWebviewUtils';
import { setModValue, postEdit } from './fieldDisplay';
import { markModified } from './detailsPanel';
import { details, detailCache, ui } from './state';

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

export function wireRichEditor(rich) {
  const mi = Number(rich.getAttribute('data-mi'));
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  const raw = rich.closest('.tt-rich-shell')?.querySelector('.tt-raw-input[data-mi="' + mi + '"]');
  if (!mod || !raw) return;
  const startVal = mod.editValue == null ? '' : String(mod.editValue);
  let timer;
  let postedValue = startVal;
  const commit = () => {
    clearTimeout(timer);
    const value = String(raw.value);
    if (value === postedValue) return;
    setModValue(mod, value);
    markModified(rich, mod);
    postEdit(mod);
    postedValue = value;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (String(raw.value) !== postedValue) timer = setTimeout(commit, 250);
  };
  rich._commitNow = commit;
  raw._commitNow = commit;
  rich.addEventListener('input', () => {
    const value = richToWc3(rich);
    raw.value = value;
    setModValue(mod, value);
    schedule();
  });
  raw.addEventListener('input', () => {
    const value = String(raw.value);
    rich.innerHTML = renderWc3Colors(value);
    setModValue(mod, value);
    schedule();
  });
  rich.addEventListener('blur', commit);
  raw.addEventListener('blur', commit);
}

export function wireColorBar(bar) {
  const mi = bar.getAttribute('data-mi');
  const shell = bar.closest('.tt-rich-shell');
  const rich = shell?.querySelector('.edit-rich[data-mi="' + mi + '"]');
  const ta = shell?.querySelector('.edit-raw[data-mi="' + mi + '"]') ?? details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (!ta && !rich) return;
  const useRaw = () => document.activeElement === ta;
  const syncColor = () => { if (rich) updateColorSwatch(bar, richSelectionColor(rich)); };
  if (rich) {
    syncColor();
    rich.addEventListener('keyup', syncColor);
    rich.addEventListener('mouseup', syncColor);
    rich.addEventListener('focus', syncColor);
    rich.addEventListener('input', syncColor);
    document.addEventListener('selectionchange', () => {
      if (rich.isConnected && containsNode(rich, window.getSelection()?.anchorNode)) syncColor();
    });
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
        if (ta && useRaw()) wrapColor(ta, hex);
        else if (rich) applyRichColor(rich, hex);
        updateColorSwatch(bar, hex);
        pop.hidden = true;
      });
    }
    const colorInput = pop.querySelector('.tt-color');
    if (colorInput) colorInput.addEventListener('change', () => {
      if (ta && useRaw()) wrapColor(ta, colorInput.value);
      else if (rich) applyRichColor(rich, colorInput.value);
      updateColorSwatch(bar, colorInput.value);
      pop.hidden = true;
    });
  }
}
