// @ts-nocheck
import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc, renderWc3Colors } from '../objModWebviewUtils';
import { details, detailCache, pendingDetails, failedDetails, ui, vscodeApi, iconLoader, initial, objects } from './state';
import { categoryLabel, categoryKey, objectIconHtml, matches, render } from './objectTree';
import { sourcePill, valueCell, postEdit, setModValue, editorHtml, collapsedView, normalizeNumberValue, needsColorEditor, tooltipToolbarHtml } from './fieldDisplay';
import { observeModelThumbs } from './modelThumbnails';
import { wireColorBar, setCaretEnd, richToWc3, forcePlainTextPaste, forceWc3ColorCopy, wrapColor, applyRichColor, updateColorSwatch, containsNode } from './richTextEditor';
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
    // Include the category ("Abilities", "Stats", ...) so a query like "abilities" finds a field whose
    // own label is just "Normal" — the category is what ties it to that word, not the field name.
    const fsearch = esc((category + ' ' + (mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.currentValue || '') + ' ' + (mod.editValue || '') + ' ' + (mod.displayValue || '') + ' ' + (mod.displayDetail || '')).toLowerCase());
    // "-" is WC3's own placeholder for "no value" (asset paths, rawcode lists, ...) — treat it as blank
    // too, same as decoratedValueHtml/collapsedView already do when deciding whether to show "(empty)".
    const currentDisplay = (mod.editValue == null ? (mod.currentValue == null ? '' : String(mod.currentValue)) : String(mod.editValue)).trim();
    const isEmpty = currentDisplay === '' || currentDisplay === '-';
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '" data-cat="' + esc(catKey) + '" data-empty="' + (isEmpty ? '1' : '0') + '" data-fsearch="' + fsearch + '">' +
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
      // Grouped so only the group as a whole gets pushed to the right edge (margin-left: auto on
      // *each* chip individually would split the leftover space between all of them, scattering them
      // across the bar instead of clustering them together).
      '<div class="toggle-chip-group">' +
        '<label class="toggle-chip"><input id="hide-empty-toggle" type="checkbox" ' + (ui.hideEmpty ? 'checked' : '') + '> hide empty</label>' +
        '<label class="toggle-chip"><input id="hide-unmodified-toggle" type="checkbox" ' + (ui.hideUnmodified ? 'checked' : '') + '> modified only</label>' +
        '<label class="toggle-chip"><input id="technical-toggle" type="checkbox" ' + (ui.showTechnical ? 'checked' : '') + '> technical</label>' +
      '</div>' +
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
  const hideEmptyToggle = document.getElementById('hide-empty-toggle');
  if (hideEmptyToggle) {
    hideEmptyToggle.addEventListener('change', () => {
      ui.hideEmpty = hideEmptyToggle.checked;
      vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { hideEmpty: ui.hideEmpty }));
      filterFields(ui.fieldQuery);
    });
  }
  const hideUnmodifiedToggle = document.getElementById('hide-unmodified-toggle');
  if (hideUnmodifiedToggle) {
    hideUnmodifiedToggle.addEventListener('change', () => {
      ui.hideUnmodified = hideUnmodifiedToggle.checked;
      vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { hideUnmodified: ui.hideUnmodified }));
      filterFields(ui.fieldQuery);
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
function stepNumberInput(numStep) {
  const mi = numStep.getAttribute('data-mi');
  const input = details.querySelector('.num-input[data-mi="' + mi + '"]');
  if (!input) return;
  const varType = input.getAttribute('data-num-type');
  const stepAmount = Number(input.getAttribute('data-num-step')) || 1;
  const dir = Number(numStep.getAttribute('data-dir')) || 1;
  const cur = Number(input.value);
  input.value = normalizeNumberValue(varType, String((Number.isFinite(cur) ? cur : 0) + dir * stepAmount));
  input.focus();
  input.dispatchEvent(new Event('input'));
}

export function setupDetails() {
  // Steppers must not steal focus from the input they adjust (mirrors the color-swatch buttons), and
  // holding one down repeats the step (first tick immediately, then every 60ms after a 400ms delay —
  // the click handler below no-ops for .num-step since this already applied the single-click case).
  let numStepHoldTimer = null;
  let numStepHoldInterval = null;
  const stopNumStepHold = () => {
    clearTimeout(numStepHoldTimer); numStepHoldTimer = null;
    clearInterval(numStepHoldInterval); numStepHoldInterval = null;
  };
  details.addEventListener('mousedown', e => {
    const numStep = e.target.closest('.num-step[data-dir]');
    if (numStep) {
      e.preventDefault();
      stepNumberInput(numStep);
      numStepHoldTimer = setTimeout(() => {
        numStepHoldInterval = setInterval(() => stepNumberInput(numStep), 60);
      }, 400);
      return;
    }
    if (e.target.closest('.num-step')) e.preventDefault();
  });
  window.addEventListener('mouseup', stopNumStepHold);
  window.addEventListener('blur', stopNumStepHold);
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
    // Stepping itself already happened on mousedown (see setupDetails) — this just stops the click
    // from falling through to the row-expand/jump handling below.
    if (e.target.closest('.num-step[data-dir]')) return;
    const jump = e.target.closest('.resolved-chip[data-jump]');
    if (jump) {
      const key = jump.getAttribute('data-jump') || '';
      if (key) { ui.selectedKey = key; render(); }
      return;
    }
    const xref = e.target.closest('.resolved-chip[data-xref]');
    if (xref) {
      const rawcode = xref.getAttribute('data-xref') || '';
      if (rawcode) vscodeApi.postMessage({ type: 'openObjectReference', rawcode, label: xref.getAttribute('data-xref-label') || '' });
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
    } else if (ae && ae.classList && ae.classList.contains('resolved-chip')) {
      e.preventDefault();
      const jumpKey = ae.getAttribute('data-jump');
      const rawcode = ae.getAttribute('data-xref');
      if (jumpKey) { ui.selectedKey = jumpKey; render(); }
      else if (rawcode) vscodeApi.postMessage({ type: 'openObjectReference', rawcode, label: ae.getAttribute('data-xref-label') || '' });
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

function autosizeRaw(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

export function enterTooltipEdit(collapsed, mi, clickEvent) {
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!mod || !collapsed) return;
  if (activeTooltipEdit && activeTooltipEdit.mi === mi && activeTooltipEdit.collapsed === collapsed) return; // already editing
  exitTooltipEdit(true);

  const body = collapsed.querySelector('.tt-collapsed-body');
  if (!body) return;
  // The floating toolbar anchors to the actual tooltip box, not `collapsed` (the outer row) — that row
  // also contains the source-pill/edit-hint beside the box (see fieldDisplay.ts), so its rect extends
  // well past the box itself and threw the toolbar's position off to the right.
  const box = collapsed.querySelector('.tt-collapsed-box') || collapsed;

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
  forceWc3ColorCopy(body);

  // Raw view swaps in this textarea right beside the rich body, inside the same .tt-collapsed-box (see
  // objModPreview.ts) — toggling never touches the floating toolbar's own size/position, so there's
  // nothing to reposition and nothing that can misfire the outside-click/scroll-close listeners below.
  const rawArea = document.createElement('textarea');
  rawArea.className = 'tt-collapsed-raw';
  rawArea.spellcheck = false;
  rawArea.rows = 1;
  rawArea.hidden = true;
  body.insertAdjacentElement('afterend', rawArea);

  const toolbar = document.createElement('div');
  toolbar.className = 'tt-float-toolbar';
  toolbar.innerHTML = tooltipToolbarHtml(mi, original);
  document.body.appendChild(toolbar);
  positionFloatToolbar(toolbar, box.getBoundingClientRect());

  activeTooltipEdit = { collapsed, body, rawArea, toolbar, mi, original, rawMode: false };

  const currentValue = () => (activeTooltipEdit && activeTooltipEdit.rawMode) ? rawArea.value : richToWc3(body);

  let timer;
  let postedValue = original;
  const commit = () => {
    clearTimeout(timer);
    const value = currentValue();
    if (value === postedValue) return;
    setModValue(mod, value);
    markModified(collapsed, mod);
    postEdit(mod);
    postedValue = value;
  };
  const schedule = () => {
    clearTimeout(timer);
    const value = currentValue();
    if (value !== postedValue) timer = setTimeout(commit, 250);
  };
  body._commitNow = commit;
  rawArea._commitNow = commit;

  const onEscapeOrSubmit = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (currentValue() !== original) {
        body.innerHTML = renderWc3Colors(original);
        rawArea.value = original;
        setModValue(mod, original);
      }
      exitTooltipEdit(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      exitTooltipEdit(true);
    }
  };
  const onBodyInput = () => { setModValue(mod, richToWc3(body)); schedule(); };
  const onRawInput = () => { setModValue(mod, rawArea.value); autosizeRaw(rawArea); schedule(); };
  body.addEventListener('input', onBodyInput);
  body.addEventListener('keydown', onEscapeOrSubmit);
  rawArea.addEventListener('input', onRawInput);
  rawArea.addEventListener('keydown', onEscapeOrSubmit);

  body.focus({ preventScroll: true });
  if (range) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  else setCaretEnd(body);

  const bar = toolbar.querySelector('.tt-bar');
  if (bar) wireColorBar(bar, body, () => (activeTooltipEdit && activeTooltipEdit.rawMode) ? rawArea : null);

  // Quick-reference swatches for colors already used in this tooltip (see tooltipToolbarHtml) — same
  // apply logic as a preset swatch, just outside the popover for one-click access.
  for (const sw of toolbar.querySelectorAll('.tt-used-sw')) {
    sw.addEventListener('mousedown', e => e.preventDefault());
    sw.addEventListener('click', () => {
      const hex = sw.getAttribute('data-color');
      if (activeTooltipEdit.rawMode) wrapColor(rawArea, hex);
      else applyRichColor(body, hex);
      if (bar) updateColorSwatch(bar, hex);
    });
  }

  const rawToggle = toolbar.querySelector('.tt-raw-toggle');
  if (rawToggle) {
    rawToggle.addEventListener('click', () => {
      activeTooltipEdit.rawMode = !activeTooltipEdit.rawMode;
      rawToggle.setAttribute('aria-pressed', String(activeTooltipEdit.rawMode));
      rawToggle.classList.toggle('active', activeTooltipEdit.rawMode);
      rawToggle.textContent = activeTooltipEdit.rawMode ? 'Rich' : 'Raw';
      if (activeTooltipEdit.rawMode) {
        rawArea.value = richToWc3(body);
        body.hidden = true;
        rawArea.hidden = false;
        autosizeRaw(rawArea);
        rawArea.focus();
        rawArea.setSelectionRange(rawArea.value.length, rawArea.value.length);
      } else {
        const value = rawArea.value;
        body.innerHTML = value ? renderWc3Colors(value) : '';
        setModValue(mod, value);
        rawArea.hidden = true;
        body.hidden = false;
        body.focus({ preventScroll: true });
        setCaretEnd(body);
      }
    });
  }
  const copyBtn = toolbar.querySelector('.tt-copy-raw');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      let text;
      if (activeTooltipEdit.rawMode) {
        const s = rawArea.selectionStart, e = rawArea.selectionEnd;
        text = s !== e ? rawArea.value.slice(s, e) : rawArea.value;
      } else {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed && containsNode(body, sel.anchorNode) && containsNode(body, sel.focusNode)) {
          const wrap = document.createElement('div');
          wrap.appendChild(sel.getRangeAt(0).cloneContents());
          text = richToWc3(wrap);
        } else {
          text = richToWc3(body);
        }
      }
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
      if (!body.contains(document.activeElement) && document.activeElement !== rawArea && !toolbar.contains(document.activeElement)) exitTooltipEdit(true);
    }, 120);
  };
  body.addEventListener('focusout', onFocusOut);
  rawArea.addEventListener('focusout', onFocusOut);
  toolbar.addEventListener('focusout', onFocusOut);
  activeTooltipEdit.cleanup = () => {
    document.removeEventListener('mousedown', onOutsideDown, true);
    window.removeEventListener('resize', onScrollOrResize);
    if (scrollHost) scrollHost.removeEventListener('scroll', onScrollOrResize);
    // `body` is the persistent .tt-collapsed-body node — reused for every future edit of this same
    // field — so its listeners MUST be removed here. Leaving them meant a second edit session left
    // this session's stale onFocusOut (closed over this now-detached toolbar/rawArea) still firing
    // alongside the new one; since the stale one always saw `document.activeElement` as "outside" its
    // own detached toolbar, it force-closed the *new* session on its very next focus change (raw
    // toggle, copy button, anything). That's what made Raw/Copy "instantly close" after first use.
    body.removeEventListener('input', onBodyInput);
    body.removeEventListener('keydown', onEscapeOrSubmit);
    body.removeEventListener('focusout', onFocusOut);
  };
}

export function exitTooltipEdit(commit) {
  if (!activeTooltipEdit) return;
  const { collapsed, body, rawArea, toolbar, mi, cleanup } = activeTooltipEdit;
  // Commit while activeTooltipEdit (and its rawMode flag) is still live — currentValue() inside
  // commit() needs it to know whether to read rawArea.value or richToWc3(body).
  if (commit && body._commitNow) body._commitNow();
  activeTooltipEdit = null;
  if (cleanup) cleanup();
  toolbar.remove();
  if (rawArea) rawArea.remove();
  if (!collapsed.isConnected) return;
  body.hidden = false;
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
  // Split on whitespace and require every token to match somewhere in the row's haystack (category +
  // field id/label/value) — order-independent, so "abilities normal" finds the Abilities > Normal row
  // even though "abilities" only appears via the category and "normal" only via the field label.
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];
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
    if (ui.hideEmpty && tr.getAttribute('data-empty') === '1') { tr.classList.add('hidden'); return; }
    if (ui.hideUnmodified && !tr.classList.contains('overridden')) { tr.classList.add('hidden'); return; }
    const hay = tr.getAttribute('data-fsearch') || '';
    const vis = !tokens.length || tokens.every(tok => fuzzyMatch(tok, hay));
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
