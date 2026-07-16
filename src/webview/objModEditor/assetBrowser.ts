import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc } from '../objModWebviewUtils';
import { effect, signal } from '../signals';
import { detailCache, details, ui, vscodeApi, iconLoader } from './state';
import { observeModelThumbs, requestVisibleModelThumbs, isAssetBrowserOpen, cancelAssetBrowserModelThumbs, noteModelThumbUserActivity } from './modelThumbnails';
import { setModValue, postEdit } from './fieldDisplay';
import { markModified, collapseCell } from './detailsPanel';
import type { AssetCatalog, AssetOption } from './types';

// ── Asset browser (rich visual picker over WC3 game data, by category) ────────
let abMi = -1;
export const abActiveTab = signal('model');
export const abSearchQuery = signal('');
export const abSourceFilter = signal('all');
let abCatalog: AssetCatalog | null = null; // { model: [], icon: [], sound: [], pathing: [] } - fetched once from the host

export function setAssetCatalog(catalog) {
  abCatalog = catalog;
}

export function getAssetCatalog() {
  return abCatalog;
}

function requestAssetCatalog() {
  const grid = document.getElementById('ab-grid');
  if (grid) grid.innerHTML = '<div class="ab-empty">Loading game assets…</div>';
  vscodeApi.postMessage({ type: 'requestAssetCatalog' });
}

// Without this the grid was stuck on "Loading game assets…" forever if the host-side catalog build
// threw (missing game data, bad CASC install) — there was no way out short of closing the editor.
export function handleAssetCatalogFailed(reason) {
  if (!isAssetBrowserOpen()) return;
  const grid = document.getElementById('ab-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="ab-empty ab-error">' +
    '<div>Couldn\'t load game assets.</div>' +
    (reason ? '<div class="details-error-reason">' + esc(reason) + '</div>' : '') +
    '<button type="button" id="ab-catalog-retry" class="browse-btn">Retry</button>' +
  '</div>';
}

export function openAssetBrowser(mi) {
  const mods = detailCache.get(ui.selectedKey) || [];
  const mod = mods[mi];
  if (!mod) return;
  abMi = mi;
  // A model field defaults to Models; only icon/pathing fields default elsewhere — never offer the
  // wrong asset class by default.
  abActiveTab.value = (mod.assetType === 'icon' || mod.assetType === 'sound' || mod.assetType === 'pathing') ? mod.assetType : 'model';
  abSearchQuery.value = '';
  const search = document.getElementById('ab-search');
  if (search) search.value = '';
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = false;
  if (abCatalog) {
    renderAssetGrid();
  } else {
    requestAssetCatalog();
  }
  if (search) search.focus();
}

export function openModelAssetBrowserForE2e() {
  abMi = 0;
  abActiveTab.value = 'model';
  abSearchQuery.value = '';
  abSourceFilter.value = 'all';
  const search = document.getElementById('ab-search');
  if (search) search.value = '';
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = false;
  if (abCatalog) {
    renderAssetGrid();
  } else {
    requestAssetCatalog();
  }
}

export function searchModelAssetBrowserForE2e(value) {
  abActiveTab.value = 'model';
  abSearchQuery.value = String(value || '');
  const search = document.getElementById('ab-search');
  if (search) search.value = String(value || '');
  if (isAssetBrowserOpen() && abCatalog) renderAssetGrid();
}

export function forceNarrowLayoutForE2e(on) {
  ui.e2eForcedNarrowLayout = !!on;
  const editor = document.getElementById('object-editor');
  if (editor) editor.classList.toggle('narrow', !!on);
}

export function updateAbTabs() {
  const tabs = document.getElementById('ab-tabs');
  if (!tabs) return;
  for (const b of tabs.querySelectorAll('.ab-tab')) b.classList.toggle('active', b.getAttribute('data-tab') === abActiveTab.value);
}

export function renderAssetGrid() {
  const grid = document.getElementById('ab-grid');
  if (!grid) return;
  const activeTab = abActiveTab.value;
  const opts = (abCatalog && abCatalog[activeTab]) || [];
  const sourceFilter = abSourceFilter.value;
  const query = abSearchQuery.value.trim();
  const matches: AssetOption[] = [];
  let matchedCount = 0;
  for (const o of opts) {
    if (sourceFilter === 'import' && o.source !== 'import') continue;
    if (sourceFilter === 'wc3' && o.source === 'import') continue;
    if (query && !fuzzyMatch(query, o.label + ' ' + o.value + ' ' + (o.detail || ''))) continue;
    matchedCount++;
    if (matches.length < 600) matches.push(o);
  }
  const count = document.getElementById('ab-count');
  if (count) count.textContent = matches.length + (matchedCount > 600 ? '+' : '') + ' / ' + opts.length;
  if (!matches.length) { grid.innerHTML = '<div class="ab-empty">No matching assets</div>'; return; }
  grid.innerHTML = matches.map(o => {
    const icon = activeTab === 'model'
      ? '<span class="object-icon model-thumb pending" data-key="ab-model:' + esc(o.value) + '" data-model="' + esc(o.value) + '"></span>'
      : activeTab === 'sound'
        ? '<span class="object-icon sound-thumb">AUD</span>'
      : (o.iconPath
        ? '<span class="object-icon" data-key="ab:' + esc(o.value) + '" data-icon="' + esc(o.iconPath) + '"></span>'
        : '<span class="object-icon missing"></span>');
    return '<div class="ab-card" data-value="' + esc(o.value) + '" title="' + esc(o.label + ' — ' + o.value) + '">' +
      icon + '<span class="ab-card-label">' + esc(o.label) + '</span></div>';
  }).join('');
  iconLoader.observe(grid);
  if (activeTab === 'model') {
    observeModelThumbs(grid);
    requestAnimationFrame(() => requestVisibleModelThumbs(grid));
  }
}

export function closeAssetBrowser() {
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = true;
  cancelAssetBrowserModelThumbs();
  abMi = -1; // keep abCatalog cached for next time
}

export function pickAsset(value) {
  const mods = detailCache.get(ui.selectedKey) || [];
  const mi = abMi;
  const mod = mods[mi];
  closeAssetBrowser();
  if (!mod) return;
  setModValue(mod, value);
  const anchor = details.querySelector('[data-mi="' + mi + '"]');
  if (anchor) markModified(anchor, mod);
  postEdit(mod);
  // Re-render the whole cell so the decorated value + model/icon badge (data-model-preview) reflect
  // the new pick. updateFieldCell only patches an open input's value, leaving the badge/preview stale.
  const cell = anchor ? anchor.closest('td') : null;
  if (cell) { cell._refocusOnCollapse = false; collapseCell(cell, mi); }
}

export function setupAssetBrowser() {
  const ov = document.getElementById('ab-overlay');
  const search = document.getElementById('ab-search');
  const close = document.getElementById('ab-close');
  const grid = document.getElementById('ab-grid');
  const tabs = document.getElementById('ab-tabs');
  let abSearchRaf = 0;
  if (close) close.addEventListener('click', closeAssetBrowser);
  if (ov) ov.addEventListener('mousedown', e => { if (e.target === ov) closeAssetBrowser(); });
  if (search) search.addEventListener('input', () => {
    noteModelThumbUserActivity();
    if (abSearchRaf) cancelAnimationFrame(abSearchRaf);
    abSearchRaf = requestAnimationFrame(() => {
      abSearchRaf = 0;
      abSearchQuery.value = search.value;
    });
  });
  const source = document.getElementById('ab-source');
  if (source) source.addEventListener('change', () => { abSourceFilter.value = source.value || 'all'; });
  if (tabs) tabs.addEventListener('click', e => {
    const tab = e.target.closest('.ab-tab[data-tab]');
    if (!tab) return;
    if (abActiveTab.value === 'model' && tab.getAttribute('data-tab') !== 'model') cancelAssetBrowserModelThumbs();
    abActiveTab.value = tab.getAttribute('data-tab');
  });
  if (grid) grid.addEventListener('click', e => {
    if (e.target.closest('#ab-catalog-retry')) { requestAssetCatalog(); return; }
    const card = e.target.closest('.ab-card[data-value]');
    if (card) pickAsset(card.getAttribute('data-value'));
  });
  if (grid) {
    grid.addEventListener('scroll', noteModelThumbUserActivity, { passive: true });
    grid.addEventListener('wheel', noteModelThumbUserActivity, { passive: true });
    grid.addEventListener('pointerdown', noteModelThumbUserActivity, { passive: true });
  }
  if (search) {
    search.addEventListener('keydown', noteModelThumbUserActivity, { passive: true });
  }
  document.addEventListener('scroll', noteModelThumbUserActivity, { passive: true, capture: true });
  document.addEventListener('wheel', noteModelThumbUserActivity, { passive: true });
  document.addEventListener('keydown', noteModelThumbUserActivity, { passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov && !ov.hidden) closeAssetBrowser(); });
  effect(() => {
    abActiveTab.value;
    abSearchQuery.value;
    abSourceFilter.value;
    updateAbTabs();
    if (isAssetBrowserOpen() && abCatalog) renderAssetGrid();
  });
}
