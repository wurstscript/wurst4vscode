// @ts-nocheck
import { objects, ui, vscodeApi, details, search } from './objModEditor/state';
import { commitActiveEditor } from './objModEditor/fieldDisplay';
import { matches, setupTree, render } from './objModEditor/objectTree';
import { setupDetails } from './objModEditor/detailsPanel';
import { setupAssetBrowser } from './objModEditor/assetBrowser';
import { setupModelPreviewPanel } from './objModEditor/modelPreviewPanel';
import { setupMessageHandler } from './objModEditor/messageHandler';
import { modelThumbEnsureInit } from './objModEditor/modelThumbnails';
import { installDebugApi } from './objModEditor/debugApi';

let searchRaf = 0;
function applySearch() {
  searchRaf = 0;
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
  render();
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

function setupSplitter() {
  const editor = document.getElementById('object-editor');
  const splitter = document.getElementById('splitter');
  if (!editor || !splitter) return;
  const isStacked = () => editor.classList.contains('narrow') || (window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  const applySavedWidth = () => {
    const saved = vscodeApi.getState() || {};
    if (isStacked()) editor.style.removeProperty('--list-w');
    else if (saved.listW) editor.style.setProperty('--list-w', saved.listW + 'px');
  };
  const saved = vscodeApi.getState() || {};
  if (saved.listW && !isStacked()) editor.style.setProperty('--list-w', saved.listW + 'px');
  window.addEventListener('resize', applySavedWidth);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(entries => {
      const rect = entries[0] && entries[0].contentRect;
      if (!rect) return;
      editor.classList.toggle('narrow', ui.e2eForcedNarrowLayout || rect.width <= 720);
      applySavedWidth();
    });
    ro.observe(editor);
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
    const max = Math.max(170, rect.width - 260);
    const w = Math.max(170, Math.min(max, e.clientX - rect.left));
    editor.style.setProperty('--list-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const cur = parseInt(editor.style.getPropertyValue('--list-w'), 10) || 260;
    vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { listW: cur }));
  });
}
setupSplitter();

// Close any open color popup when clicking outside its bar.
document.addEventListener('mousedown', e => {
  for (const pop of details.querySelectorAll('.tt-pop')) {
    if (pop.hidden) continue;
    const bar = pop.closest('.tt-bar');
    if (!bar || !bar.contains(e.target)) pop.hidden = true;
  }
});

// Forward undo/redo to the host (so the custom-document edit stack drives them) — except while a
// text field is focused, where the browser's native text undo should win.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const ae = document.activeElement;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    commitActiveEditor();
    vscodeApi.postMessage({ type: 'save' });
    return;
  }
  if (ae && ae.classList && (ae.classList.contains('edit-raw') || ae.classList.contains('edit-rich'))) return;
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); vscodeApi.postMessage({ type: 'undo' }); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); vscodeApi.postMessage({ type: 'redo' }); }
});

setupTree();
setupDetails();
setupAssetBrowser();
setupModelPreviewPanel();
setupMessageHandler();
render();
setTimeout(() => { try { modelThumbEnsureInit(); } catch (e) {} }, 0);

installDebugApi();
