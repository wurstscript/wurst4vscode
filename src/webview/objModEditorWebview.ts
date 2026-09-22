import { effect } from './signals';
import { initial, objects, ui, vscodeApi, details, search } from './objModEditor/state';
import { commitActiveEditor } from './objModEditor/fieldDisplay';
import { matches, revealRow, setActiveRow, setupTree } from './objModEditor/objectTree';
import { setupDetails } from './objModEditor/detailsPanel';
import { setupAssetBrowser } from './objModEditor/assetBrowser';
import { setupModelPreviewPanel } from './objModEditor/modelPreviewPanel';
import { setupMessageHandler } from './objModEditor/messageHandler';
import { modelThumbEnsureInit } from './objModEditor/modelThumbnails';
import { installDebugApi } from './objModEditor/debugApi';

let searchRaf = 0;
function applySearch() {
  searchRaf = 0;
  // Writing ui.query drives the tree's own reactive effect (see setupTree() in objectTree.ts), which
  // rebuilds it synchronously right here. ui.selectedKey deliberately isn't a tracked dependency of
  // that rebuild (selection normally moves via the cheap setActiveRow(), not a full tree rebuild) —
  // so if the query change knocked the selection out of the results, the freshly rebuilt tree still
  // needs its active row fixed up explicitly, same as a normal click would via selectObject().
  ui.query = search.value.trim().toLowerCase();
  const matched = ui.query ? objects.filter(matches).length : 0;
  const sm = document.getElementById('search-match');
  if (sm) sm.textContent = ui.query ? (matched + ' of ' + objects.length) : '';
  const sc = document.getElementById('search-clear');
  if (sc) sc.classList.toggle('show', !!search.value);
  const selected = objects.find(obj => obj.key === ui.selectedKey);
  if (selected && !matches(selected)) {
    ui.selectedKey = (objects.find(matches) || objects[0] || {}).key || '';
  }
  // Follow the selection: narrowing the tree clamps its scroll position, so without this, clearing the
  // query leaves the object still selected but scrolled off somewhere far below. revealRow() no-ops
  // whenever the row is already on screen, so this costs nothing on the common keystroke path.
  revealRow(setActiveRow(ui.selectedKey));
}
// Restore the last search query for this file (state.ts seeds ui.query from persisted vscodeApi
// state) so the search box and its match-count/clear-button indicators don't visually reset to empty
// on every reopen. Runs before setupTree()/setupDetails() further down are called, so their reactive
// effects' very first render already reflects the restored query — no separate re-render needed.
if (ui.query) {
  search.value = ui.query;
  applySearch();
}

// Coalesce rapid keystrokes into one render per frame — typing stays smooth on large lists.
search.addEventListener('input', () => {
  if (searchRaf) cancelAnimationFrame(searchRaf);
  searchRaf = requestAnimationFrame(applySearch);
});
const searchClear = document.getElementById('search-clear');
if (searchClear) {
  searchClear.addEventListener('click', () => {
    search.value = '';
    applySearch();
    search.focus();
  });
}

// Creating an object is deliberately a short, explicit two-step choice: the base is required so the
// resulting entry has meaningful inherited fields; the new rawcode is optional because the host can
// safely choose an unused one. Populate choices through DOM APIs, not HTML interpolation, because
// game-data names are external text.
const addObjectButton = document.getElementById('add-object') as HTMLButtonElement | null;
const addObjectOverlay = document.getElementById('add-object-overlay') as HTMLElement | null;
const addObjectDialog = document.getElementById('add-object-dialog') as HTMLFormElement | null;
const addObjectBase = document.getElementById('add-object-base') as HTMLSelectElement | null;
const addObjectBaseList = document.getElementById('add-object-base-list') as HTMLElement | null;
const addObjectBaseSearch = document.getElementById('add-object-base-search') as HTMLInputElement | null;
const addObjectId = document.getElementById('add-object-id') as HTMLInputElement | null;
const addObjectGenerated = document.getElementById('add-object-generated') as HTMLElement | null;
const addObjectBaseStatus = document.getElementById('add-object-base-status') as HTMLElement | null;
const addObjectError = document.getElementById('add-object-error') as HTMLElement;
const addObjectCancel = document.getElementById('add-object-cancel') as HTMLButtonElement | null;
const addObjectConfirm = addObjectDialog?.querySelector('.add-object-confirm') as HTMLButtonElement | null;
const copyObjectButton = document.getElementById('copy-object') as HTMLButtonElement | null;
const pasteObjectButton = document.getElementById('paste-object') as HTMLButtonElement | null;
const baseObjects = initial.baseObjects || [];
let copiedObjectKey = '';
let addObjectSubmissionPending = false;
function setAddObjectSubmissionPending(pending: boolean) {
  addObjectSubmissionPending = pending;
  if (addObjectConfirm) addObjectConfirm.disabled = pending;
  if (addObjectCancel) addObjectCancel.disabled = pending;
}
function renderBaseOptions(query = '') {
  if (!addObjectBase) return;
  const selected = addObjectBase.value;
  const needle = query.trim().toLowerCase();
  const matches = baseObjects.filter(base => !needle
    || String(base.label || '').toLowerCase().includes(needle)
    || String(base.detail || base.value).toLowerCase().includes(needle))
    .sort((left, right) => baseSearchRank(left, needle) - baseSearchRank(right, needle)
      || String(left.label || left.value).localeCompare(String(right.label || right.value)));
  addObjectBase.replaceChildren();
  addObjectBaseList?.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = matches.length ? 'Select a base object…' : 'No matching base objects';
  addObjectBase.appendChild(placeholder);
  for (const base of matches) {
    const option = document.createElement('option');
    option.value = base.value;
    option.textContent = base.label + (base.race ? ' - ' + base.race : '') + (base.detail ? ' (' + base.detail + ')' : '');
    addObjectBase.appendChild(option);

    const row = document.createElement('div');
    row.className = 'add-object-base-row';
    row.setAttribute('role', 'option');
    row.dataset.baseId = base.value;
    row.tabIndex = -1;
    const name = document.createElement('span');
    name.className = 'add-object-base-name';
    name.textContent = base.label || base.value;
    row.appendChild(name);
    if (base.race) {
      const race = document.createElement('span');
      race.className = 'add-object-base-race';
      race.textContent = base.race;
      row.appendChild(race);
    }
    const rawcode = document.createElement('code');
    rawcode.className = 'add-object-base-rawcode';
    rawcode.textContent = base.detail || base.value;
    row.appendChild(rawcode);
    addObjectBaseList?.appendChild(row);
  }
  if (matches.some(base => base.value === selected)) addObjectBase.value = selected;
  updateBaseObjectSelection();
  if (addObjectBaseStatus) addObjectBaseStatus.textContent = needle
    ? `${matches.length} matching base object${matches.length === 1 ? '' : 's'}`
    : `${matches.length} base objects`;
  // Filtering can remove the selected base. Clear the rawcode preview immediately rather than
  // leaving a candidate that belongs to a base object which is no longer selected.
  if (!matches.some(base => base.value === selected)) updateGeneratedRawcodeHint();
}
function updateBaseObjectSelection() {
  const selected = addObjectBase?.value || '';
  addObjectBaseList?.querySelectorAll<HTMLElement>('[data-base-id]').forEach(row => {
    const active = row.dataset.baseId === selected;
    row.classList.toggle('selected', active);
    row.setAttribute('aria-selected', String(active));
  });
}
function selectBaseObject(baseId: string, focus = false) {
  if (!addObjectBase || !Array.from(addObjectBase.options).some(option => option.value === baseId)) return;
  addObjectBase.value = baseId;
  updateBaseObjectSelection();
  updateGeneratedRawcodeHint();
  if (focus) addObjectBaseList?.focus();
}
function baseSearchRank(base: { value: string; label?: string; detail?: string }, needle: string) {
  if (!needle) return 0;
  const label = String(base.label || '').toLowerCase();
  const rawcode = String(base.detail || base.value).toLowerCase();
  if (label === needle || rawcode === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (rawcode.startsWith(needle)) return 2;
  if (label.includes(needle)) return 3;
  return 4;
}
function requestGeneratedRawcode() {
  const baseId = addObjectBase?.value;
  if (!baseId || addObjectId?.value.trim()) return;
  if (addObjectGenerated) addObjectGenerated.textContent = 'checking…';
  vscodeApi.postMessage({ type: 'requestGeneratedRawcode', baseId });
}
function updateGeneratedRawcodeHint() {
  if (!addObjectGenerated) return;
  if (addObjectId?.value.trim()) {
    addObjectGenerated.textContent = 'your chosen rawcode';
    return;
  }
  if (!addObjectBase?.value) {
    addObjectGenerated.textContent = 'an available rawcode';
    return;
  }
  requestGeneratedRawcode();
}
renderBaseOptions();
addObjectBaseSearch?.addEventListener('input', () => renderBaseOptions(addObjectBaseSearch.value));
addObjectBase?.addEventListener('change', () => { updateBaseObjectSelection(); updateGeneratedRawcodeHint(); });
addObjectBaseList?.addEventListener('click', event => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-base-id]');
  if (row?.dataset.baseId) selectBaseObject(row.dataset.baseId, true);
});
addObjectBaseList?.addEventListener('keydown', event => {
  if (!addObjectBase) return;
  const rows = Array.from(addObjectBaseList.querySelectorAll<HTMLElement>('[data-base-id]'));
  if (!rows.length) return;
  const current = Math.max(0, rows.findIndex(row => row.dataset.baseId === addObjectBase.value));
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
    selectBaseObject(rows[next].dataset.baseId || '', true);
    rows[next].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    selectBaseObject(rows[current].dataset.baseId || '', true);
  }
});
addObjectId?.addEventListener('input', updateGeneratedRawcodeHint);
window.addEventListener('objmod-generated-rawcode', (event: Event) => {
  const detail = (event as CustomEvent<{ baseId?: string; rawcode?: string }>).detail;
  if (!detail || detail.baseId !== addObjectBase?.value || addObjectId?.value.trim()) return;
  if (addObjectGenerated) addObjectGenerated.textContent = detail.rawcode || 'no unused rawcode is available';
});
function copySelectedObject() {
  if (!ui.selectedKey || !objects.some(object => object.key === ui.selectedKey)) return;
  copiedObjectKey = ui.selectedKey;
  if (pasteObjectButton) pasteObjectButton.disabled = false;
}
function pasteCopiedObject() {
  if (!copiedObjectKey) return;
  vscodeApi.postMessage({ type: 'duplicateObject', key: copiedObjectKey });
}
function closeAddObjectDialog() {
  if (addObjectSubmissionPending) return;
  if (!addObjectOverlay) return;
  addObjectOverlay.hidden = true;
  addObjectError.textContent = '';
  addObjectButton?.focus();
}
if (addObjectButton) addObjectButton.addEventListener('click', () => {
  if (!addObjectOverlay) return;
  addObjectOverlay.hidden = false;
  addObjectError.textContent = '';
  if (addObjectBaseSearch) addObjectBaseSearch.value = '';
  renderBaseOptions();
  if (addObjectId) addObjectId.value = '';
  updateGeneratedRawcodeHint();
  addObjectBaseSearch?.focus();
});
copyObjectButton?.addEventListener('click', copySelectedObject);
pasteObjectButton?.addEventListener('click', pasteCopiedObject);
if (addObjectCancel) addObjectCancel.addEventListener('click', closeAddObjectDialog);
if (addObjectOverlay) addObjectOverlay.addEventListener('mousedown', event => {
  if (event.target === addObjectOverlay) closeAddObjectDialog();
});
if (addObjectDialog) addObjectDialog.addEventListener('submit', event => {
  event.preventDefault();
  if (addObjectSubmissionPending) return;
  const baseId = addObjectBase.value;
  const rawcode = addObjectId.value.trim();
  if (!baseId) { addObjectError.textContent = 'Select a base object.'; addObjectBase.focus(); return; }
  if (rawcode && !/^[\x20-\x7e]{4}$/.test(rawcode)) {
    addObjectError.textContent = 'A rawcode must be exactly four printable characters.';
    addObjectId.focus();
    return;
  }
  addObjectError.textContent = '';
  setAddObjectSubmissionPending(true);
  vscodeApi.postMessage({ type: 'addObject', baseId, rawcode });
});
window.addEventListener('objmod-add-object-finished', () => setAddObjectSubmissionPending(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && addObjectOverlay && !addObjectOverlay.hidden) closeAddObjectDialog();
  const target = event.target as HTMLElement | null;
  const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
  if (editingText || !event.ctrlKey && !event.metaKey) return;
  if (event.key.toLowerCase() === 'c') {
    event.preventDefault();
    copySelectedObject();
  } else if (event.key.toLowerCase() === 'v' && copiedObjectKey) {
    event.preventDefault();
    pasteCopiedObject();
  }
});

// Side-by-side survives all the way down to a very narrow pane now (the browse list is capped at 46%
// of the editor by CSS and the field table's compact 2-column mode no longer demands 620px), so this
// is only the point below which even a ~130px list would leave nothing usable beside it. The stacked
// layout it falls back to is much worse to work in, so it stays a genuine last resort.
const NARROW_LAYOUT_PX = 440;
const LIST_MIN_PX = 130;
const LIST_W_DEFAULT = 220; // keep in sync with --list-w in objModPreview.ts
// Matches the 46% cap in the .object-editor grid — dragging past it would detach the splitter from
// the pointer, since CSS would keep clamping the column while --list-w kept growing.
const LIST_MAX_RATIO = 0.46;

function setupSplitter() {
  const editor = document.getElementById('object-editor');
  const splitter = document.getElementById('splitter');
  if (!editor || !splitter) return;
  const isStacked = () => editor.classList.contains('narrow');
  const updateSplitterAria = () => {
    const rect = editor.getBoundingClientRect();
    const max = Math.max(LIST_MIN_PX, rect.width * LIST_MAX_RATIO);
    const current = parseInt(editor.style.getPropertyValue('--list-w'), 10) || LIST_W_DEFAULT;
    splitter.setAttribute('aria-valuemin', String(LIST_MIN_PX));
    splitter.setAttribute('aria-valuemax', String(Math.round(max)));
    splitter.setAttribute('aria-valuenow', String(Math.round(Math.max(LIST_MIN_PX, Math.min(max, current)))));
  };
  const setListWidth = (width: number) => {
    const rect = editor.getBoundingClientRect();
    const max = Math.max(LIST_MIN_PX, rect.width * LIST_MAX_RATIO);
    const clamped = Math.max(LIST_MIN_PX, Math.min(max, width));
    editor.style.setProperty('--list-w', clamped + 'px');
    updateSplitterAria();
    return clamped;
  };
  const applySavedWidth = () => {
    const saved = vscodeApi.getState() || {};
    // Stacked: drop the override so the single-column grid isn't sized by a stale side-by-side width.
    if (isStacked() || !saved.listW) editor.style.removeProperty('--list-w');
    else editor.style.setProperty('--list-w', saved.listW + 'px');
    updateSplitterAria();
  };
  // The ResizeObserver below measures the editor element itself and fires on its first observation,
  // so it covers both the initial layout and every later resize — no separate window 'resize'
  // listener (which could only ever fire alongside it) and no bootstrap call needed.
  if (typeof ResizeObserver === 'function') {
    // Only re-read/apply the persisted width when the layout actually flips between side-by-side and
    // stacked — otherwise this ran once per frame for the whole of a window drag-resize.
    let stacked: boolean | null = null;
    const ro = new ResizeObserver(entries => {
      const rect = entries[0] && entries[0].contentRect;
      if (!rect) return;
      const next = ui.e2eForcedNarrowLayout || rect.width < NARROW_LAYOUT_PX;
      if (next === stacked) {
        updateSplitterAria();
        return;
      }
      stacked = next;
      editor.classList.toggle('narrow', next);
      applySavedWidth();
    });
    ro.observe(editor);
  } else {
    applySavedWidth();
  }
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    if (isStacked()) return;
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = editor.getBoundingClientRect();
    setListWidth(e.clientX - rect.left);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const cur = parseInt(editor.style.getPropertyValue('--list-w'), 10) || LIST_W_DEFAULT;
    vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { listW: cur }));
    updateSplitterAria();
  });
  splitter.addEventListener('keydown', e => {
    if (isStacked()) return;
    const rect = editor.getBoundingClientRect();
    const max = Math.max(LIST_MIN_PX, rect.width * LIST_MAX_RATIO);
    const saved = parseInt(editor.style.getPropertyValue('--list-w'), 10) || LIST_W_DEFAULT;
    const current = Math.max(LIST_MIN_PX, Math.min(max, saved));
    let next: number | undefined;
    if (e.key === 'ArrowLeft') next = current - 16;
    else if (e.key === 'ArrowRight') next = current + 16;
    else if (e.key === 'Home') next = LIST_MIN_PX;
    else if (e.key === 'End') next = max;
    if (next === undefined) return;
    e.preventDefault();
    const width = setListWidth(next);
    vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { listW: Math.round(width) }));
  });
}
setupSplitter();

// Close any open color popup / category-filter popover when clicking outside it.
document.addEventListener('mousedown', e => {
  for (const pop of details.querySelectorAll('.tt-pop')) {
    if (pop.hidden) continue;
    const bar = pop.closest('.tt-bar');
    if (!bar || !bar.contains(e.target as Node)) pop.hidden = true;
  }
  const catPop = details.querySelector('#cat-filter-pop');
  if (catPop && !catPop.hidden && !catPop.closest('.cat-filter').contains(e.target as Node)) {
    catPop.hidden = true;
    const btn = document.getElementById('cat-filter-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
});

function saveNow() {
  commitActiveEditor();
  vscodeApi.postMessage({ type: 'save' });
}

// Forward undo/redo to the host (so the custom-document edit stack drives them) — except while a
// text field is focused, where the browser's native text undo should win.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const ae = document.activeElement;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    saveNow();
    return;
  }
  if (ae && ae.classList && (ae.classList.contains('edit-raw') || ae.classList.contains('edit-rich'))) return;
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); vscodeApi.postMessage({ type: 'undo' }); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); vscodeApi.postMessage({ type: 'redo' }); }
});

// The dirty badge doubles as a Save button — Ctrl+S is invisible to a mouse-only user, and "editable"
// on its own gives no hint that clicking it does anything.
const editableBadge = document.getElementById('editable-badge');
if (editableBadge) editableBadge.addEventListener('click', saveNow);

const refreshEditor = document.getElementById('refresh-editor');
if (refreshEditor) refreshEditor.addEventListener('click', () => {
  commitActiveEditor();
  vscodeApi.postMessage({ type: 'refresh' });
});

// Density is a document-wide spacing scale (tree, header, field table all retune at once), so it's a
// single class on <body> driving the :root / body.density-cozy variable pair in objModPreview.ts —
// nothing has to re-render. The effect runs immediately on creation, which is what applies a restored
// 'cozy' preference on load.
const densityToggle = document.getElementById('density-toggle');
effect(() => {
  const cozy = ui.density === 'cozy';
  document.body.classList.toggle('density-cozy', cozy);
  if (densityToggle) {
    densityToggle.setAttribute('aria-checked', String(cozy));
    densityToggle.setAttribute('title', cozy ? 'Use compact density' : 'Use spacious density');
  }
}, 'objModEditor.density');
if (densityToggle) {
  densityToggle.addEventListener('click', () => { ui.density = ui.density === 'cozy' ? 'compact' : 'cozy'; });
}

// setupTree()/setupDetails() each wire a reactive effect that runs immediately on creation — that
// first run *is* the tree/details panel's initial paint, so no separate bootstrap render() call is
// needed here.
setupTree();
setupDetails();
setupAssetBrowser();
setupModelPreviewPanel();
setupMessageHandler();
setTimeout(() => { try { modelThumbEnsureInit(); } catch (e) {} }, 0);

// The in-game tooltip's own fill texture and gold border tiles, applied over the plain --wc3-tip-bg
// color / border once they load (see applyTooltipBackdrop/applyTooltipBorder in messageHandler.ts) —
// requested once per document open since neither changes, rather than per tooltip field like icons/
// model thumbs.
vscodeApi.postMessage({ type: 'requestTooltipBackdrop' });
vscodeApi.postMessage({ type: 'requestTooltipBorder' });

installDebugApi();
