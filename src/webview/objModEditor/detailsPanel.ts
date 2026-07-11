// @ts-nocheck
import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc, renderWc3Colors } from '../objModWebviewUtils';
import { details, detailCache, pendingDetails, ui, vscodeApi, iconLoader, initial, objects } from './state';
import { categoryLabel, objectIconHtml, matches, render } from './objectTree';
import { sourcePill, valueCell, postEdit, setModValue, editorHtml, collapsedView, normalizeNumberValue } from './fieldDisplay';
import { observeModelThumbs } from './modelThumbnails';
import { wireRichEditor, wireColorBar, setCaretEnd } from './richTextEditor';
import { openAssetBrowser } from './assetBrowser';
import { showModelPreview } from './modelPreviewPanel';

export function requestDetails(obj) {
  if (!obj || detailCache.has(obj.key) || pendingDetails.has(obj.key)) return;
  pendingDetails.add(obj.key);
  vscodeApi.postMessage({ type: 'loadObjectDetails', key: obj.key });
}

export function renderDetails() {
  const obj = objects.find(candidate => candidate.key === ui.selectedKey) || objects.find(matches) || objects[0];
  if (!obj) {
    details.innerHTML = '<div class="empty-state">No object modifications</div>';
    return;
  }
  ui.selectedKey = obj.key;
  const headers = ui.showTechnical
    ? (initial.extended ? ['Field', 'Label', 'Group', 'Type', 'Level', 'Data', 'Value'] : ['Field', 'Label', 'Group', 'Type', 'Value'])
    : ['Field', 'Value'];
  const mods = detailCache.get(obj.key);
  if (!mods) requestDetails(obj);
  let lastCategory = '';
  const rows = (mods || []).map((mod, mi) => {
    const category = categoryLabel(mod.category);
    const groupRow = category !== lastCategory
      ? '<tr class="category-row"><td colspan="' + headers.length + '">' + esc(category) + '</td></tr>'
      : '';
    lastCategory = category;
    const fieldCell = ui.showTechnical
      ? '<td class="id">' + esc(mod.fieldId) + '</td><td class="label">' + esc(mod.label || '-') + '</td><td class="type">' + esc(category) + '</td><td class="type">' + esc(mod.type) + '</td>' +
        (initial.extended ? '<td class="num">' + esc(mod.level ?? '') + '</td>' + '<td class="num">' + esc(mod.dataPt ?? '') + '</td>' : '')
      : '<td class="field">' + esc(mod.label || mod.fieldId) + '</td>';
    const fsearch = esc(((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.currentValue || '') + ' ' + (mod.editValue || '') + ' ' + (mod.displayValue || '') + ' ' + (mod.displayDetail || '')).toLowerCase());
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '" data-fsearch="' + fsearch + '">' +
      fieldCell +
      '<td class="value current">' + valueCell(mod, mi) + '</td>' +
    '</tr>';
  }).join('');

  const rawcode = obj.newId ? esc(obj.baseId) + ' → ' + esc(obj.newId) : esc(obj.baseId);
  details.innerHTML = '<div class="details-head">' +
    '<div class="details-title-row">' + objectIconHtml(obj, 'details-icon') +
      '<div class="details-title">' + esc(obj.displayName) +
        '<span class="details-rawcode">' + rawcode + '</span>' +
        (obj.displaySource ? sourcePill({ source: obj.displaySource }) : '') + '</div>' +
    '</div>' +
    (mods ? '<div class="field-search-wrap">' +
      '<input id="field-search" class="field-search" type="text" placeholder="Search fields…" aria-label="Search fields" spellcheck="false" value="' + esc(ui.fieldQuery) + '">' +
      '<span id="field-match" class="field-match" role="status" aria-live="polite"></span>' +
      '<label class="toggle-chip"><input id="technical-toggle" type="checkbox" ' + (ui.showTechnical ? 'checked' : '') + '> technical</label>' +
    '</div>' : '') +
  '</div>' +
  (mods
    ? '<div class="table-wrap"><table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + headers.length + '" class="empty">no modifications</td></tr>') + '</tbody></table></div>'
    : '<div class="details-loading"><div><div class="wv-spinner"></div><div class="wv-loading-text">Loading fields...</div></div></div>');

  const technicalToggle = document.getElementById('technical-toggle');
  if (technicalToggle) {
    technicalToggle.addEventListener('change', () => {
      ui.showTechnical = technicalToggle.checked;
      vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { showTechnical: ui.showTechnical }));
      renderDetails();
    });
  }

  const fieldSearch = document.getElementById('field-search');
  if (fieldSearch) {
    let fieldFilterRaf = 0;
    fieldSearch.addEventListener('input', () => {
      ui.fieldQuery = fieldSearch.value;
      if (fieldFilterRaf) cancelAnimationFrame(fieldFilterRaf);
      fieldFilterRaf = requestAnimationFrame(() => {
        fieldFilterRaf = 0;
        filterFields(ui.fieldQuery);
      });
    });
  }
  filterFields(ui.fieldQuery);

  iconLoader.observe(details);
  observeModelThumbs(details);
}

// Delegated details handlers, wired once. The #details element persists across renders (only its
// innerHTML changes), so a single listener covers every collapsed cell and object-jump chip — no
// more re-wiring 1000+ listeners on each object switch / search / technical toggle.
export function setupDetails() {
  // Steppers must not steal focus from the input they adjust (mirrors the color-swatch buttons).
  details.addEventListener('mousedown', e => {
    if (e.target.closest('.num-step')) e.preventDefault();
  });
  details.addEventListener('click', e => {
    const numStep = e.target.closest('.num-step[data-dir]');
    if (numStep) {
      e.preventDefault();
      e.stopPropagation();
      const mi = numStep.getAttribute('data-mi');
      const input = details.querySelector('.num-input[data-mi="' + mi + '"]');
      if (input) {
        const varType = input.getAttribute('data-num-type');
        const stepAmount = Number(input.getAttribute('data-num-step')) || 1;
        const dir = Number(numStep.getAttribute('data-dir')) || 1;
        const cur = Number(input.value);
        input.value = normalizeNumberValue(varType, String((Number.isFinite(cur) ? cur : 0) + dir * stepAmount));
        input.focus();
        input.dispatchEvent(new Event('input'));
      }
      return;
    }
    const jump = e.target.closest('.resolved-chip[data-jump]');
    if (jump) {
      const key = jump.getAttribute('data-jump') || '';
      if (key) { ui.selectedKey = key; render(); }
      return;
    }
    const browse = e.target.closest('[data-browse]');
    if (browse) {
      e.stopPropagation();
      openAssetBrowser(Number(browse.getAttribute('data-browse')));
      return;
    }
    const modelPreview = e.target.closest('[data-model-preview]');
    if (modelPreview) {
      e.stopPropagation();
      showModelPreview(modelPreview.getAttribute('data-model-preview') || '');
      return;
    }
    const openAsset = e.target.closest('[data-open-asset]');
    if (openAsset) {
      e.stopPropagation();
      vscodeApi.postMessage({ type: 'openAsset', path: openAsset.getAttribute('data-open-asset') || '' });
      return;
    }
    const rawToggle = e.target.closest('.tt-raw-toggle[data-mi]');
    if (rawToggle) {
      e.preventDefault();
      e.stopPropagation();
      const mi = rawToggle.getAttribute('data-mi');
      const panel = details.querySelector('.tt-raw-panel[data-mi="' + mi + '"]');
      if (panel) {
        const open = panel.hidden;
        panel.hidden = !open;
        rawToggle.setAttribute('aria-expanded', String(open));
        rawToggle.classList.toggle('active', open);
      }
      return;
    }
    const copyRaw = e.target.closest('.tt-copy-raw[data-mi]');
    if (copyRaw) {
      e.preventDefault();
      e.stopPropagation();
      const raw = details.querySelector('.tt-raw-input[data-mi="' + copyRaw.getAttribute('data-mi') + '"]');
      if (raw) {
        raw.select();
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(raw.value).catch(() => {});
        else document.execCommand('copy');
      }
      return;
    }
    const collapsed = e.target.closest('.tt-collapsed, .cell-edit');
    if (collapsed) expandEditor(collapsed);
  });
  // A focused collapsed cell expands on Enter/Space (matching its click affordance).
  details.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ae = document.activeElement;
    if (ae && ae.classList && (ae.classList.contains('tt-collapsed') || ae.classList.contains('cell-edit'))) {
      e.preventDefault();
      expandEditor(ae);
    }
  });
}

export function markModified(el, mod) {
  if (!mod.overridden) {
    mod.overridden = true;
    const tr = el.closest('tr');
    if (tr) tr.classList.add('overridden');
  }
}

export function wireEditRaw(el) {
  const mi = Number(el.getAttribute('data-mi'));
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!mod) return;
  const startVal = mod.editValue == null ? '' : String(mod.editValue);
  let timer;
  let postedValue = startVal;
  const commit = () => {
    clearTimeout(timer);
    const value = String(el.value);
    if (value === postedValue) return;
    setModValue(mod, value);
    markModified(el, mod);
    postEdit(mod);
    postedValue = value;
  };
  el._commitNow = commit;
  const onEdit = () => {
    setModValue(mod, el.value);
    const preview = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (preview) preview.innerHTML = renderWc3Colors(el.value);
    clearTimeout(timer);
    // Only create/update a mod once the value actually changes (clicking a field to view it shouldn't modify it).
    if (String(el.value) !== postedValue) timer = setTimeout(commit, 250);
  };
  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('blur', () => { commit(); el._commitNow = null; });
  // Track selection so the toolbar / color picker act on it even after the textarea blurs.
  const saveSel = () => {
    if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return;
    el._ss = el.selectionStart; el._se = el.selectionEnd;
  };
  ['keyup', 'mouseup', 'select', 'blur', 'click'].forEach(ev => el.addEventListener(ev, saveSel));
}

// Swap a collapsed cell for its editor on demand. The editor collapses back when focus leaves it.
export function expandEditor(c) {
  const mi = Number(c.getAttribute('data-mi'));
  const cell = c.parentElement;
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  const before = c.getBoundingClientRect();
  cell.innerHTML = editorHtml(mod, mi);
  const editor = cell.querySelector('.value-editor');
  if (editor && c.classList.contains('tt-collapsed')) {
    editor.style.setProperty('--edit-w', Math.max(1, Math.round(before.width)) + 'px');
    editor.style.setProperty('--edit-h', Math.max(1, Math.round(before.height)) + 'px');
  }
  const rich = cell.querySelector('.edit-rich');
  const ta = cell.querySelector('.edit-raw');
  if (rich) {
    wireRichEditor(rich);
    rich.focus();
    setCaretEnd(rich);
    const original = mod.editValue == null ? '' : String(mod.editValue);
    rich.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const raw = cell.querySelector('.tt-raw-input[data-mi="' + mi + '"]');
        if (raw && raw.value !== original) {
          raw.value = original;
          raw.dispatchEvent(new Event('input', { bubbles: true }));
        }
        cell._refocusOnCollapse = true;
        rich.blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        cell._refocusOnCollapse = true;
        rich.blur();
      }
    });
  } else if (ta) {
    if (ta.classList.contains('num-input')) {
      // Registered before wireEditRaw's own blur listener so the value is clamped/rounded to a valid
      // int/unreal *before* that listener commits it.
      ta.addEventListener('blur', () => {
        const normalized = normalizeNumberValue(ta.getAttribute('data-num-type'), ta.value);
        if (normalized !== ta.value) {
          ta.value = normalized;
          ta.dispatchEvent(new Event('input'));
        }
      });
    }
    wireEditRaw(ta);
    ta.focus();
    if (ta.tagName === 'INPUT' && ta.type !== 'number' && ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);
    // Keyboard: Esc reverts and closes; Enter commits+closes (Ctrl/Cmd+Enter in the textarea).
    const original = mod.editValue == null ? '' : String(mod.editValue);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (ta.value !== original) { ta.value = original; ta.dispatchEvent(new Event('input')); }
        cell._refocusOnCollapse = true; // closed via keyboard → return focus to the cell
        ta.blur();
      } else if (e.key === 'Enter' && (ta.tagName === 'INPUT' || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        cell._refocusOnCollapse = true;
        ta.blur();
      }
    });
  }
  const bar = cell.querySelector('.tt-bar');
  if (bar) wireColorBar(bar);
  // Collapse back to the compact view once focus truly leaves this editor (not when clicking its own
  // color bar / popup / picker, which keep focus inside the cell). The handler is stored so collapseCell
  // can remove it — otherwise it would linger on the collapsed cell and stack on every re-expand.
  if (cell._collapseHandler) cell.removeEventListener('focusout', cell._collapseHandler);
  cell._collapseHandler = () => {
    setTimeout(() => {
      if (cell.isConnected && !cell.contains(document.activeElement)) collapseCell(cell, mi);
    }, 120);
  };
  cell.addEventListener('focusout', cell._collapseHandler);
}

export function collapseCell(cell, mi) {
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  if (cell._collapseHandler) { cell.removeEventListener('focusout', cell._collapseHandler); cell._collapseHandler = null; }
  cell.innerHTML = collapsedView(mod, mi);
  iconLoader.observe(cell);
  observeModelThumbs(cell);
  // When the editor was closed via keyboard (Esc/Enter), return focus to the collapsed cell so
  // keyboard users keep their place; on click-away the user already moved focus, so don't yank it back.
  if (cell._refocusOnCollapse) {
    cell._refocusOnCollapse = false;
    const el = cell.querySelector('.tt-collapsed, .cell-edit');
    if (el) el.focus();
  }
}

// Update a single field's cell in place (used by undo/redo — avoids rebuilding the whole table).
export function updateFieldCell(mods, mod) {
  const mi = mods.indexOf(mod);
  if (mi < 0) return;
  const el = details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (el) {
    el.value = mod.editValue == null ? '' : String(mod.editValue);
    const rich = details.querySelector('.edit-rich[data-mi="' + mi + '"]');
    if (rich) rich.innerHTML = renderWc3Colors(el.value);
    const pv = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (pv) pv.innerHTML = renderWc3Colors(el.value);
    return;
  }
  const rich = details.querySelector('.edit-rich[data-mi="' + mi + '"]');
  if (rich) {
    const value = mod.editValue == null ? '' : String(mod.editValue);
    rich.innerHTML = renderWc3Colors(value);
    return;
  }
  const col = details.querySelector('.tt-collapsed[data-mi="' + mi + '"], .cell-edit[data-mi="' + mi + '"]');
  if (col && col.parentElement) {
    col.parentElement._refocusOnCollapse = false; // programmatic (undo/redo) collapse must not steal focus
    collapseCell(col.parentElement, mi);
  }
}

// Filter the details table rows by field id / label / value without rebuilding (keeps focus while typing).
let lastFieldFilterFirst = null;
export function filterFields(q) {
  const query = String(q || '').trim().toLowerCase();
  const table = details.querySelector('table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  // Single pass: toggle field-row visibility and roll up each category's visible-child count at the
  // same time (was two full passes over a 700-row table on every keystroke).
  let shown = 0;
  let cat = null, catHasVisible = false;
  const flush = () => { if (cat) cat.classList.toggle('hidden', !catHasVisible); };
  rows.forEach(tr => {
    if (tr.classList.contains('category-row')) { flush(); cat = tr; catHasVisible = false; return; }
    const hay = tr.getAttribute('data-fsearch') || '';
    const vis = !query || fuzzyMatch(query, hay);
    tr.classList.toggle('hidden', !vis);
    if (vis) { shown++; catHasVisible = true; }
  });
  flush();
  const fm = document.getElementById('field-match');
  if (fm) fm.textContent = query ? (shown + ' match' + (shown === 1 ? '' : 'es')) : '';
  // Bring the first match into view while actively filtering (not on clear / initial render).
  if (query && shown > 0) {
    const first = table.querySelector('tbody tr:not(.hidden):not(.category-row)');
    if (first && first !== lastFieldFilterFirst) first.scrollIntoView({ block: 'nearest' });
    lastFieldFilterFirst = first;
  } else {
    lastFieldFilterFirst = null;
  }
}
