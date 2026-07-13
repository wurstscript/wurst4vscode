// @ts-nocheck
import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc, renderWc3Colors } from '../objModWebviewUtils';
import { details, detailCache, pendingDetails, failedDetails, ui, vscodeApi, iconLoader, initial, objects } from './state';
import { categoryLabel, categoryKey, objectIconHtml, matches, render } from './objectTree';
import { sourcePill, valueCell, postEdit, setModValue, editorHtml, collapsedView, normalizeNumberValue, needsColorEditor, tooltipToolbarHtml } from './fieldDisplay';
import { observeModelThumbs } from './modelThumbnails';
import { wireColorBar, setCaretEnd, richToWc3, forcePlainTextPaste, wrapColor, applyRichColor, updateColorSwatch } from './richTextEditor';
import { openAssetBrowser } from './assetBrowser';
import { showModelPreview } from './modelPreviewPanel';

export function requestDetails(obj) {
  if (!obj || detailCache.has(obj.key) || pendingDetails.has(obj.key)) return;
  failedDetails.delete(obj.key);
  pendingDetails.add(obj.key);
  vscodeApi.postMessage({ type: 'loadObjectDetails', key: obj.key });
}

export function retryDetails(key) {
  const obj = objects.find(candidate => candidate.key === key);
  failedDetails.delete(key);
  if (key === ui.selectedKey) renderDetails();
  else requestDetails(obj);
}

function persistHiddenCategories() {
  vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { hiddenCategories: Array.from(ui.hiddenCategories) }));
}

// The real WC3 category vocabulary (sound/pathing/editor-only/... on top of the common abil/art/
// combat/...) isn't something worth hand-maintaining, so the filter checklist is the union of every
// category seen across objects loaded so far this session — accurate for whatever file is actually
// open, and it only grows (never reshuffles/disappears) as detailCache accumulates more objects.
const CATEGORY_SORT_ORDER = ['text', 'art', 'stats', 'combat', 'move', 'abil', 'tech', 'data', 'sound'];
function categoriesSeenSoFar() {
  const seen = new Set();
  for (const mods of detailCache.values()) for (const mod of mods) seen.add(categoryKey(mod.category));
  return Array.from(seen).sort((a, b) => {
    const ra = CATEGORY_SORT_ORDER.indexOf(a), rb = CATEGORY_SORT_ORDER.indexOf(b);
    if (ra !== rb) return (ra < 0 ? CATEGORY_SORT_ORDER.length : ra) - (rb < 0 ? CATEGORY_SORT_ORDER.length : rb);
    return a.localeCompare(b);
  });
}

// "Custom view" category filter — a checklist popover next to the technical toggle that hides whole
// field-category groups (e.g. everything but Text, to focus on tooltips). Persisted like showTechnical
// so it stays applied while browsing between objects.
function categoryFilterHtml() {
  const keys = categoriesSeenSoFar();
  const activeCount = keys.length - keys.filter(k => ui.hiddenCategories.has(k)).length;
  const badge = ui.hiddenCategories.size ? '<span class="cat-filter-badge">' + activeCount + '/' + keys.length + '</span>' : '';
  return '<div class="cat-filter">' +
    '<button type="button" id="cat-filter-btn" class="toggle-chip cat-filter-btn" aria-haspopup="true" aria-expanded="false">Categories' + badge + '</button>' +
    '<div id="cat-filter-pop" class="cat-filter-pop" hidden>' +
      keys.map(key =>
        '<label class="cat-filter-opt"><input type="checkbox" data-cat-key="' + esc(key) + '" ' + (ui.hiddenCategories.has(key) ? '' : 'checked') + '> ' + esc(categoryLabel(key)) + '</label>'
      ).join('') +
      '<div class="cat-filter-actions"><button type="button" id="cat-filter-all">All</button><button type="button" id="cat-filter-none">None</button></div>' +
    '</div>' +
  '</div>';
}

export function renderDetails() {
  exitTooltipEdit(true); // about to rebuild #details — the in-place editor's anchor is going stale
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
  // A failed load stays failed until the user asks to retry — auto-retrying every render would just
  // hammer whatever broke (missing game data, a thrown parser error) in a silent loop.
  const failedReason = failedDetails.get(obj.key);
  const hasFailed = !mods && failedDetails.has(obj.key);
  if (!mods && !hasFailed) requestDetails(obj);
  let lastCategory = '';
  const rows = (mods || []).map((mod, mi) => {
    const category = categoryLabel(mod.category);
    const catKey = categoryKey(mod.category);
    const groupRow = category !== lastCategory
      ? '<tr class="category-row" data-cat="' + esc(catKey) + '"><td colspan="' + headers.length + '">' + esc(category) + '</td></tr>'
      : '';
    lastCategory = category;
    const fieldCell = ui.showTechnical
      ? '<td class="id">' + esc(mod.fieldId) + '</td><td class="label">' + esc(mod.label || '-') + '</td><td class="type">' + esc(category) + '</td><td class="type">' + esc(mod.type) + '</td>' +
        (initial.extended ? '<td class="num">' + esc(mod.level ?? '') + '</td>' + '<td class="num">' + esc(mod.dataPt ?? '') + '</td>' : '')
      : '<td class="field">' + esc(mod.label || mod.fieldId) + '</td>';
    const fsearch = esc(((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.currentValue || '') + ' ' + (mod.editValue || '') + ' ' + (mod.displayValue || '') + ' ' + (mod.displayDetail || '')).toLowerCase());
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '" data-cat="' + esc(catKey) + '" data-fsearch="' + fsearch + '">' +
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
      categoryFilterHtml() +
      '<label class="toggle-chip"><input id="technical-toggle" type="checkbox" ' + (ui.showTechnical ? 'checked' : '') + '> technical</label>' +
    '</div>' : '') +
  '</div>' +
  (mods
    ? '<div class="table-wrap"><table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + headers.length + '" class="empty">no modifications</td></tr>') + '</tbody></table></div>'
    : hasFailed
      ? '<div class="details-loading details-error"><div>' +
          '<div class="details-error-title">Couldn\'t load fields for this object.</div>' +
          (failedReason ? '<div class="details-error-reason">' + esc(failedReason) + '</div>' : '') +
          '<button type="button" id="details-retry" class="browse-btn">Retry</button>' +
        '</div></div>'
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
  details.addEventListener('change', e => {
    const cb = e.target.closest('#cat-filter-pop input[data-cat-key]');
    if (!cb) return;
    const key = cb.getAttribute('data-cat-key');
    if (cb.checked) ui.hiddenCategories.delete(key); else ui.hiddenCategories.add(key);
    persistHiddenCategories();
    updateCatFilterBadge();
    filterFields(ui.fieldQuery);
  });
  details.addEventListener('click', e => {
    const retry = e.target.closest('#details-retry');
    if (retry) {
      retryDetails(ui.selectedKey);
      return;
    }
    const catFilterBtn = e.target.closest('#cat-filter-btn');
    if (catFilterBtn) {
      const pop = details.querySelector('#cat-filter-pop');
      if (pop) {
        const open = pop.hidden;
        pop.hidden = !open;
        catFilterBtn.setAttribute('aria-expanded', String(open));
      }
      return;
    }
    const catFilterAll = e.target.closest('#cat-filter-all');
    const catFilterNone = e.target.closest('#cat-filter-none');
    if (catFilterAll || catFilterNone) {
      if (catFilterAll) ui.hiddenCategories.clear();
      else categoriesSeenSoFar().forEach(key => ui.hiddenCategories.add(key));
      persistHiddenCategories();
      for (const cb of details.querySelectorAll('#cat-filter-pop input[data-cat-key]')) cb.checked = !ui.hiddenCategories.has(cb.getAttribute('data-cat-key'));
      updateCatFilterBadge();
      filterFields(ui.fieldQuery);
      return;
    }
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
    // Raw-toggle/copy for tooltip fields live in the floating toolbar (outside #details, wired
    // per-instance in enterTooltipEdit) — nothing to delegate here for those anymore.
    const collapsed = e.target.closest('.tt-collapsed, .cell-edit');
    if (collapsed) {
      const mi = Number(collapsed.getAttribute('data-mi'));
      const mod = (detailCache.get(ui.selectedKey) || [])[mi];
      if (mod && needsColorEditor(mod)) enterTooltipEdit(collapsed, mi, e);
      else expandEditor(collapsed);
      return;
    }
  });
  // A focused collapsed cell expands on Enter/Space (matching its click affordance).
  details.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ae = document.activeElement;
    if (ae && ae.classList && (ae.classList.contains('tt-collapsed') || ae.classList.contains('cell-edit'))) {
      e.preventDefault();
      const mi = Number(ae.getAttribute('data-mi'));
      const mod = (detailCache.get(ui.selectedKey) || [])[mi];
      if (mod && needsColorEditor(mod)) enterTooltipEdit(ae, mi, null);
      else expandEditor(ae);
    }
  });
}

// Tooltip/color fields edit in place: the exact box the user is looking at (.tt-collapsed-body)
// becomes contenteditable, at its existing position and size — nothing is swapped for a copy
// elsewhere, so there's no layout shift and no scroll jump. Only the small color-picker/raw-text
// toolbar floats (position: fixed, doesn't participate in table layout) beside the row.
let activeTooltipEdit = null;

function positionFloatToolbar(toolbar, rect) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const margin = 6;
  const width = toolbar.offsetWidth || 160;
  let left = rect.right - width;
  left = Math.max(margin, Math.min(left, vw - width - margin));
  const height = toolbar.offsetHeight || 30;
  let top = rect.top - height - 4;
  if (top < margin) top = Math.min(rect.bottom + 4, vh - height - margin);
  toolbar.style.left = Math.round(left) + 'px';
  toolbar.style.top = Math.round(top) + 'px';
}

export function enterTooltipEdit(collapsed, mi, clickEvent) {
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!mod || !collapsed) return;
  if (activeTooltipEdit && activeTooltipEdit.mi === mi && activeTooltipEdit.collapsed === collapsed) return; // already editing
  exitTooltipEdit(true);

  const body = collapsed.querySelector('.tt-collapsed-body');
  if (!body) return;

  // Same node before and after — the click's caret position is already valid for the body once it's
  // made editable, no coordinate remapping needed.
  let range = null;
  if (clickEvent && typeof document.caretRangeFromPoint === 'function') {
    const r = document.caretRangeFromPoint(clickEvent.clientX, clickEvent.clientY);
    if (r && body.contains(r.startContainer)) range = r;
  }

  const original = mod.editValue == null ? '' : String(mod.editValue);
  // An empty field's collapsed body holds a "(empty)" placeholder (see collapsedView) — clear it before
  // editing so typing doesn't start by appending to that literal text. No real content existed to click
  // into, so the captured range (if any) is meaningless here too.
  if (!original) { body.innerHTML = ''; range = null; }
  body.contentEditable = 'true';
  body.spellcheck = false;
  body.classList.add('edit-rich'); // reused by Ctrl+S / undo-vs-native-undo detection elsewhere
  collapsed.classList.add('tt-editing');
  forcePlainTextPaste(body);

  const toolbar = document.createElement('div');
  toolbar.className = 'tt-float-toolbar';
  toolbar.innerHTML = tooltipToolbarHtml(mi, original);
  document.body.appendChild(toolbar);
  positionFloatToolbar(toolbar, collapsed.getBoundingClientRect());

  activeTooltipEdit = { collapsed, body, toolbar, mi, original };

  let timer;
  let postedValue = original;
  const commit = () => {
    clearTimeout(timer);
    const value = richToWc3(body);
    if (value === postedValue) return;
    setModValue(mod, value);
    markModified(collapsed, mod);
    postEdit(mod);
    postedValue = value;
  };
  const schedule = () => {
    clearTimeout(timer);
    const value = richToWc3(body);
    if (value !== postedValue) timer = setTimeout(commit, 250);
  };
  body._commitNow = commit;
  body.addEventListener('input', () => { setModValue(mod, richToWc3(body)); schedule(); });
  body.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (richToWc3(body) !== original) { body.innerHTML = renderWc3Colors(original); setModValue(mod, original); }
      exitTooltipEdit(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      exitTooltipEdit(true);
    }
  });

  body.focus({ preventScroll: true });
  if (range) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  else setCaretEnd(body);

  const bar = toolbar.querySelector('.tt-bar');
  if (bar) wireColorBar(bar, body, () => toolbar.querySelector('.tt-raw-input'));

  // Quick-reference swatches for colors already used in this tooltip (see tooltipToolbarHtml) — same
  // apply logic as a preset swatch, just outside the popover for one-click access.
  for (const sw of toolbar.querySelectorAll('.tt-used-sw')) {
    sw.addEventListener('mousedown', e => e.preventDefault());
    sw.addEventListener('click', () => {
      const hex = sw.getAttribute('data-color');
      const ta = toolbar.querySelector('.tt-raw-input');
      if (ta && document.activeElement === ta) wrapColor(ta, hex);
      else applyRichColor(body, hex);
      if (bar) updateColorSwatch(bar, hex);
    });
  }

  const rawToggle = toolbar.querySelector('.tt-raw-toggle');
  const rawPanel = toolbar.querySelector('.tt-float-raw');
  if (rawToggle && rawPanel) {
    rawToggle.addEventListener('click', () => {
      const open = rawPanel.hidden;
      rawPanel.hidden = !open;
      rawToggle.setAttribute('aria-expanded', String(open));
      rawToggle.classList.toggle('active', open);
      if (open) {
        const ta = rawPanel.querySelector('.tt-raw-input');
        ta.classList.add('edit-raw');
        ta.value = richToWc3(body);
        ta._commitNow = commit;
        ta.addEventListener('input', () => {
          const value = String(ta.value);
          body.innerHTML = renderWc3Colors(value);
          setModValue(mod, value);
          schedule();
        });
        ta.addEventListener('blur', commit);
      }
      positionFloatToolbar(toolbar, collapsed.getBoundingClientRect());
    });
  }
  const copyBtn = toolbar.querySelector('.tt-copy-raw');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = richToWc3(body);
      const flash = ok => {
        clearTimeout(copyBtn._flashTimer);
        const label = copyBtn._origLabel ?? (copyBtn._origLabel = copyBtn.textContent);
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        copyBtn._flashTimer = setTimeout(() => { copyBtn.textContent = label; }, 1200);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => flash(true), () => flash(false));
      else flash(false);
    });
  }

  const onOutsideDown = e => { if (!toolbar.contains(e.target) && !collapsed.contains(e.target)) exitTooltipEdit(true); };
  const onScrollOrResize = () => exitTooltipEdit(true);
  document.addEventListener('mousedown', onOutsideDown, true);
  window.addEventListener('resize', onScrollOrResize);
  const scrollHost = collapsed.closest('.table-wrap');
  if (scrollHost) scrollHost.addEventListener('scroll', onScrollOrResize);
  const onFocusOut = () => {
    setTimeout(() => {
      if (!activeTooltipEdit || activeTooltipEdit.mi !== mi || activeTooltipEdit.collapsed !== collapsed) return;
      if (!body.contains(document.activeElement) && !toolbar.contains(document.activeElement)) exitTooltipEdit(true);
    }, 120);
  };
  body.addEventListener('focusout', onFocusOut);
  toolbar.addEventListener('focusout', onFocusOut);
  activeTooltipEdit.cleanup = () => {
    document.removeEventListener('mousedown', onOutsideDown, true);
    window.removeEventListener('resize', onScrollOrResize);
    if (scrollHost) scrollHost.removeEventListener('scroll', onScrollOrResize);
  };
}

export function exitTooltipEdit(commit) {
  if (!activeTooltipEdit) return;
  const { collapsed, body, toolbar, mi, cleanup } = activeTooltipEdit;
  activeTooltipEdit = null;
  if (commit && body._commitNow) body._commitNow();
  if (cleanup) cleanup();
  toolbar.remove();
  if (!collapsed.isConnected) return;
  body.contentEditable = 'false';
  body.removeAttribute('spellcheck');
  body.classList.remove('edit-rich');
  collapsed.classList.remove('tt-editing');
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  const value = mod && mod.editValue != null ? String(mod.editValue) : '';
  body.innerHTML = value ? renderWc3Colors(value) : '<span class="tt-empty">(empty)</span>';
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
// (Tooltip/color fields never reach this — they edit in place via enterTooltipEdit instead.)
export function expandEditor(c) {
  const mi = Number(c.getAttribute('data-mi'));
  const cell = c.parentElement;
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  cell.innerHTML = editorHtml(mod, mi);
  const ta = cell.querySelector('.edit-raw');
  if (ta) {
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
      // The +/- stepper buttons are tabindex="-1" (they must not steal focus from the input), so
      // Up/Down here is the only keyboard path to stepping — mirrors native <input type="number">.
      ta.addEventListener('keydown', e => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const stepAmount = Number(ta.getAttribute('data-num-step')) || 1;
        const cur = Number(ta.value);
        ta.value = normalizeNumberValue(ta.getAttribute('data-num-type'), String((Number.isFinite(cur) ? cur : 0) + dir * stepAmount));
        ta.dispatchEvent(new Event('input'));
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
  // Undo/redo landed on the field currently being edited in place — drop the in-progress edit rather
  // than let it stomp the externally-applied value when it next commits.
  if (activeTooltipEdit && activeTooltipEdit.mi === mi) exitTooltipEdit(false);
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

// Reflects the current hidden-category count on the filter button without a full re-render, so
// toggling checkboxes doesn't blow away the open popover.
function updateCatFilterBadge() {
  const btn = document.getElementById('cat-filter-btn');
  if (!btn) return;
  const total = details.querySelectorAll('#cat-filter-pop input[data-cat-key]').length;
  const activeCount = total - ui.hiddenCategories.size;
  btn.innerHTML = 'Categories' + (ui.hiddenCategories.size ? '<span class="cat-filter-badge">' + activeCount + '/' + total + '</span>' : '');
}

// Filter the details table rows by field id / label / value AND by the category checklist, without
// rebuilding (keeps focus while typing, and keeps the category popover open while its checkboxes change).
let lastFieldFilterFirst = null;
export function filterFields(q) {
  const query = String(q || '').trim().toLowerCase();
  const table = details.querySelector('table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  // Single pass: toggle field-row visibility and roll up each category's visible-child count at the
  // same time (was two full passes over a 700-row table on every keystroke).
  let shown = 0;
  let cat = null, catHasVisible = false, catHidden = false;
  const flush = () => { if (cat) cat.classList.toggle('hidden', catHidden || !catHasVisible); };
  rows.forEach(tr => {
    if (tr.classList.contains('category-row')) {
      flush();
      cat = tr;
      catHasVisible = false;
      catHidden = ui.hiddenCategories.has(tr.getAttribute('data-cat') || '-');
      return;
    }
    if (catHidden) { tr.classList.add('hidden'); return; }
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
