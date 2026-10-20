/**
 * Map terrain and placement editor webview. Bundled to dist/webview/mapPreviewWebview.js by webpack
 * and loaded by mapPreview.ts, which hands over the scene through `window.__MAP_PREVIEW_INITIAL__`.
 * The WebGL scene lives in mapTerrainScene.ts; this file owns selection, dragging, the placement
 * picker and the host protocol. Every edit is a host round trip, so undo/redo stay VS Code's:
 *   webview → host  { type: 'requestTypes' } | { type: 'move', index, editorId, x, y } | { type: 'delete', index, editorId }
 *                   | { type: 'place', typeId, owner, x, y } | { type: 'setOwner', index, editorId, owner }
 * `editorId` (the creation number) lets the host ignore a message sent against an outdated list.
 *   host → webview  { type: 'placementTypes', types } | { type: 'placementsChanged', placements, isDirty, select? }
 */

import { esc } from './webviewUtils';
import { createTerrainScene, MarkerPoint, TerrainData } from './mapTerrainScene';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): any;
  setState(state: any): void;
};

type PlacementKind = 'unit' | 'item' | 'start';

interface Placement {
  id: string;
  name: string;
  kind: PlacementKind;
  owner: number;
  x: number;
  y: number;
  z: number;
  editorId: number;
}

interface PlacementType {
  id: string;
  name: string;
  kind: 'unit' | 'item';
  custom: boolean;
}

interface MapPreviewInitial {
  terrain: TerrainData;
  doodads: Array<{ x: number; y: number; id: string; label: string }>;
  placements: Placement[];
  owners: Array<{ value: number; label: string }>;
  readOnly: string | null;
}

/** Pointer travel (px) before a press turns into a drag rather than a click. */
const DRAG_THRESHOLD = 4;
const PICK_RADIUS = 14;
const MAX_LISTED_TYPES = 200;
const PLAYER_COLORS = [
  [1, 0.01, 0.01], [0, 0.26, 1], [0.11, 0.9, 0.73], [0.33, 0, 0.5], [1, 0.99, 0], [1, 0.54, 0.06],
  [0.13, 0.75, 0], [0.9, 0.36, 0.69], [0.58, 0.59, 0.59], [0.49, 0.75, 0.95], [0.06, 0.38, 0.27], [0.31, 0.16, 0.02],
  [0.61, 0, 0], [0, 0, 0.76], [0, 0.92, 1], [0.75, 0, 1], [0.92, 0.8, 0.53], [0.97, 0.64, 0.55],
  [0.75, 1, 0.5], [0.86, 0.73, 0.92], [0.16, 0.16, 0.16], [0.92, 0.94, 1], [0, 0.47, 0.12], [0.64, 0.44, 0.2],
];
const NEUTRAL_COLOR = [0.2, 0.2, 0.2];
const ITEM_COLOR = [0.85, 0.65, 1];
const START_COLOR = [0.3, 0.8, 1];
const DOODAD_COLOR = [0.36, 0.83, 0.36];
const GHOST_COLOR = [1, 1, 1];

const api = acquireVsCodeApi();
const initial = (window as any).__MAP_PREVIEW_INITIAL__ as MapPreviewInitial;
const readOnly = initial.readOnly;
const ownerLabels = new Map(initial.owners.map((o) => [o.value, o.label]));

const canvas = document.getElementById('mp-canvas') as HTMLCanvasElement;
const tip = document.getElementById('mp-tip');
const modeBanner = document.getElementById('mp-mode');
const dirtyBadge = document.getElementById('mp-dirty');
const selectionBox = document.getElementById('mp-selection');
const placeSection = document.querySelector('.mp-place') as HTMLElement;
const searchInput = document.getElementById('mp-search') as HTMLInputElement;
const ownerSelect = document.getElementById('mp-owner') as HTMLSelectElement;
const typeList = document.getElementById('mp-types');
const toggles = {
  terrain: document.getElementById('t-terrain') as HTMLInputElement,
  cliffs: document.getElementById('t-cliffs') as HTMLInputElement,
  water: document.getElementById('t-water') as HTMLInputElement,
  doodads: document.getElementById('t-doodads') as HTMLInputElement,
  units: document.getElementById('t-units') as HTMLInputElement,
  items: document.getElementById('t-items') as HTMLInputElement,
  sloc: document.getElementById('t-sloc') as HTMLInputElement,
};

const scene = createTerrainScene(canvas, initial.terrain, () => ({
  terrain: toggles.terrain.checked,
  cliffs: toggles.cliffs.checked,
  water: toggles.water.checked,
}));

let placements: Placement[] = initial.placements;
let selected = -1;
let types: PlacementType[] | null = null;
let pickerKind: 'unit' | 'item' = 'unit';
/** The type being placed while place mode is on. */
let placing: PlacementType | null = null;
/** Map position under the cursor in place mode, drawn as a ghost marker. */
let ghost: { x: number; y: number } | null = null;
/** Live position of the selected placement while it is being dragged. */
let dragPosition: { x: number; y: number } | null = null;

interface Press {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Placement under the pointer at press time, or -1. */
  hit: number;
  mode: 'press' | 'orbit' | 'pan' | 'move';
}
let press: Press | null = null;

function ownerLabel(owner: number): string {
  return ownerLabels.get(owner) || `Player index ${owner}`;
}

function ownerColor(owner: number): number[] {
  return PLAYER_COLORS[owner] && owner < initial.owners.length - 2 ? PLAYER_COLORS[owner] : NEUTRAL_COLOR;
}

function isEditable(index: number): boolean {
  const p = placements[index];
  return !readOnly && !!p && p.kind !== 'start';
}

function kindVisible(kind: PlacementKind): boolean {
  if (kind === 'unit') return toggles.units.checked;
  if (kind === 'item') return toggles.items.checked;
  return toggles.sloc.checked;
}

function placementPosition(index: number): { x: number; y: number } {
  return index === selected && dragPosition ? dragPosition : placements[index];
}

function markerFor(p: Placement, index: number): MarkerPoint {
  const pos = placementPosition(index);
  const ring = index === selected;
  if (p.kind === 'start') return { x: pos.x, y: pos.y, color: START_COLOR, size: ring ? 17 : 13, ring };
  if (p.kind === 'item') return { x: pos.x, y: pos.y, color: ITEM_COLOR, size: ring ? 12 : 6, ring };
  return { x: pos.x, y: pos.y, color: ownerColor(p.owner), size: ring ? 13 : 7, ring };
}

function refreshMarkers(): void {
  if (!scene) return;
  const points: MarkerPoint[] = [];
  if (toggles.doodads.checked) {
    for (const d of initial.doodads) points.push({ x: d.x, y: d.y, color: DOODAD_COLOR, size: 4 });
  }
  placements.forEach((p, index) => {
    if (kindVisible(p.kind) || index === selected) points.push(markerFor(p, index));
  });
  if (placing && ghost) points.push({ x: ghost.x, y: ghost.y, color: GHOST_COLOR, size: 9, ring: true });
  scene.setMarkers(points);
}

/** Nearest visible placement marker within the pick radius of a client position, or -1. */
function pickPlacement(clientX: number, clientY: number): number {
  if (!scene) return -1;
  let best = -1;
  let bestD = PICK_RADIUS * PICK_RADIUS;
  placements.forEach((p, index) => {
    if (!kindVisible(p.kind) && index !== selected) return;
    const pos = placementPosition(index);
    const s = scene.markerScreenPosition(pos.x, pos.y);
    if (!s) return;
    const d = (s.x - clientX) ** 2 + (s.y - clientY) ** 2;
    if (d < bestD) { bestD = d; best = index; }
  });
  return best;
}

function pickDoodad(clientX: number, clientY: number): { id: string; label: string; x: number; y: number } | null {
  if (!scene || !toggles.doodads.checked) return null;
  let best = null;
  let bestD = PICK_RADIUS * PICK_RADIUS;
  for (const d of initial.doodads) {
    const s = scene.markerScreenPosition(d.x, d.y);
    if (!s) continue;
    const dist = (s.x - clientX) ** 2 + (s.y - clientY) ** 2;
    if (dist < bestD) { bestD = dist; best = d; }
  }
  return best;
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

// ── Selection panel ──────────────────────────────────────────────────────────

function ownerSelectHtml(id: string, owner: number): string {
  const options = initial.owners.map((o) => `<option value="${o.value}"${o.value === owner ? ' selected' : ''}>${esc(o.label)}</option>`);
  if (!ownerLabels.has(owner)) options.push(`<option value="${owner}" selected>${esc(ownerLabel(owner))}</option>`);
  return `<select id="${id}" class="wv-input">${options.join('')}</select>`;
}

function renderSelection(): void {
  const p = placements[selected];
  if (!p) {
    selectionBox.innerHTML = '<p class="mp-empty">Click a unit or item to select it, then drag it to move it.</p>';
    return;
  }
  const editable = isEditable(selected);
  const ownerCell = editable && p.kind === 'unit' ? ownerSelectHtml('mp-sel-owner', p.owner) : esc(ownerLabel(p.owner));
  const note = p.kind === 'start' ? '<p class="mp-empty">Start locations are read-only here; their position also lives in war3map.w3i.</p>' : '';
  selectionBox.innerHTML = `<div class="mp-sel-name" title="${esc(p.name)}">${esc(p.name)}</div>
<div class="mp-sel-id">${esc(p.id)} · ${p.kind === 'start' ? 'start location' : p.kind}</div>
<dl class="mp-props">
  <dt>Owner</dt><dd>${ownerCell}</dd>
  <dt>X</dt><dd id="mp-sel-x">${fmt(p.x)}</dd>
  <dt>Y</dt><dd id="mp-sel-y">${fmt(p.y)}</dd>
  <dt>Z</dt><dd id="mp-sel-z">${fmt(p.z)}</dd>
</dl>
${note}<button type="button" class="wv-btn-secondary" id="mp-delete"${editable ? '' : ' disabled'}>Delete</button>`;
  const owner = document.getElementById('mp-sel-owner') as HTMLSelectElement | null;
  if (owner) owner.addEventListener('change', () => api.postMessage({ type: 'setOwner', index: selected, editorId: p.editorId, owner: Number(owner.value) }));
  document.getElementById('mp-delete').addEventListener('click', deleteSelected);
}

function select(index: number): void {
  selected = index >= 0 && index < placements.length ? index : -1;
  renderSelection();
  refreshMarkers();
}

function deleteSelected(): void {
  if (!isEditable(selected)) return;
  api.postMessage({ type: 'delete', index: selected, editorId: placements[selected].editorId });
  // Deselect now: a held Delete key repeats faster than the host's state arrives.
  select(-1);
}

// ── Placement picker ─────────────────────────────────────────────────────────

function renderTypes(): void {
  if (!types) {
    typeList.innerHTML = '<div class="mp-types-note">Loading object types…</div>';
    return;
  }
  const needle = searchInput.value.trim().toLowerCase();
  const matches = types.filter((t) => t.kind === pickerKind && (!needle || t.id.toLowerCase().includes(needle) || t.name.toLowerCase().includes(needle)));
  const shown = matches.slice(0, MAX_LISTED_TYPES);
  const rows = shown.map((t) => `<button type="button" class="mp-type${placing && placing.id === t.id ? ' active' : ''}" role="option" data-type="${esc(t.id)}" aria-selected="${placing && placing.id === t.id ? 'true' : 'false'}">
  <span class="mp-type-name">${esc(t.name)}</span>${t.custom ? '<span class="mp-type-tag">custom</span>' : ''}<span class="mp-type-id">${esc(t.id)}</span></button>`);
  if (!matches.length) rows.push('<div class="mp-types-note">No matching object types.</div>');
  else if (matches.length > shown.length) rows.push(`<div class="mp-types-note">${matches.length - shown.length} more; refine the search.</div>`);
  typeList.innerHTML = rows.join('');
}

function setPlacing(type: PlacementType | null): void {
  placing = type;
  ghost = null;
  canvas.classList.toggle('placing', !!type);
  if (type) {
    const owner = type.kind === 'item' ? 'Neutral Passive' : ownerLabel(Number(ownerSelect.value));
    modeBanner.textContent = `Placing ${type.name} (${type.id}) for ${owner}: click the terrain, Esc to stop`;
  }
  modeBanner.hidden = !type;
  renderTypes();
  refreshMarkers();
}

function setPickerKind(kind: 'unit' | 'item'): void {
  pickerKind = kind;
  document.querySelectorAll<HTMLButtonElement>('.mp-kinds [data-kind]').forEach((button) => {
    const active = button.dataset.kind === kind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  ownerSelect.disabled = kind === 'item';
  if (placing && placing.kind !== kind) setPlacing(null);
  else renderTypes();
}

ownerSelect.innerHTML = initial.owners.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
document.querySelectorAll<HTMLButtonElement>('.mp-kinds [data-kind]').forEach((button) => {
  button.addEventListener('click', () => setPickerKind(button.dataset.kind as 'unit' | 'item'));
});
searchInput.addEventListener('input', renderTypes);
ownerSelect.addEventListener('change', () => { if (placing) setPlacing(placing); });
typeList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('[data-type]') as HTMLElement | null;
  if (!row || !types) return;
  const type = types.find((t) => t.id === row.dataset.type);
  setPlacing(type && (!placing || placing.id !== type.id) ? type : null);
});
if (readOnly) {
  placeSection.classList.add('disabled');
  searchInput.disabled = true;
  ownerSelect.disabled = true;
}

// ── Pointer interaction ──────────────────────────────────────────────────────

function hideTip(): void { tip.style.display = 'none'; }

function showTip(e: MouseEvent): void {
  const index = pickPlacement(e.clientX, e.clientY);
  canvas.classList.toggle('over-marker', index >= 0);
  const p = index >= 0 ? placements[index] : null;
  const d = p ? null : pickDoodad(e.clientX, e.clientY);
  if (!p && !d) { hideTip(); return; }
  const title = p ? p.name : d.label;
  const kind = p ? (p.kind === 'start' ? 'Start location' : p.kind === 'item' ? 'Item' : 'Unit') : 'Doodad';
  const owner = p && p.kind !== 'item' ? ' | ' + ownerLabel(p.owner) : '';
  const pos = p || d;
  tip.innerHTML = `<div class="mp-tip-title">${esc(title || (p ? p.id : d.id))}</div><div class="mp-tip-sub">${esc(kind + ' ' + (p ? p.id : d.id) + owner)}<br>x ${fmt(pos.x)}, y ${fmt(pos.y)}</div>`;
  tip.style.left = Math.round(e.clientX + 14) + 'px';
  tip.style.top = Math.round(e.clientY + 14) + 'px';
  tip.style.display = 'block';
}

function updateSelectionReadout(pos: { x: number; y: number }): void {
  const x = document.getElementById('mp-sel-x');
  const y = document.getElementById('mp-sel-y');
  if (x) x.textContent = fmt(pos.x);
  if (y) y.textContent = fmt(pos.y);
}

function beginDrag(p: Press): void {
  if (p.button === 2 || p.button === 1) p.mode = 'pan';
  else if (p.hit >= 0 && p.hit === selected && isEditable(p.hit)) p.mode = 'move';
  else p.mode = 'orbit';
  canvas.classList.add(p.mode === 'move' ? 'moving' : 'grabbing');
}

canvas.addEventListener('mousedown', (e) => {
  if (!scene) return;
  e.preventDefault();
  canvas.focus();
  hideTip();
  const hit = e.button === 0 ? pickPlacement(e.clientX, e.clientY) : -1;
  // Grabbing a marker selects it straight away, so press-and-drag moves it in one gesture.
  if (hit >= 0 && hit !== selected) select(hit);
  press = { button: e.button, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, hit, mode: 'press' };
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('mousemove', (e) => {
  if (!scene) return;
  if (!press) {
    if (placing) {
      ghost = scene.groundAt(e.clientX, e.clientY);
      refreshMarkers();
    }
    showTip(e);
    return;
  }
  if (press.mode === 'press') {
    if (Math.abs(e.clientX - press.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - press.startY) < DRAG_THRESHOLD) return;
    beginDrag(press);
  }
  const dx = e.clientX - press.lastX;
  const dy = e.clientY - press.lastY;
  press.lastX = e.clientX;
  press.lastY = e.clientY;
  if (press.mode === 'pan') scene.pan(dx, dy);
  else if (press.mode === 'orbit') scene.orbit(dx, dy);
  else if (press.mode === 'move') {
    const at = scene.groundAt(e.clientX, e.clientY);
    if (at) {
      dragPosition = at;
      updateSelectionReadout(at);
      refreshMarkers();
    }
  }
});

window.addEventListener('mouseup', (e) => {
  const finished = press;
  press = null;
  canvas.classList.remove('grabbing', 'moving');
  if (!finished || !scene) return;
  if (finished.mode === 'move') {
    const at = dragPosition;
    dragPosition = null;
    if (at) {
      // Show the drop position until the host's authoritative state (snapped, with z) arrives.
      Object.assign(placements[selected], at);
      api.postMessage({ type: 'move', index: selected, editorId: placements[selected].editorId, x: at.x, y: at.y });
    }
    refreshMarkers();
    return;
  }
  if (finished.mode !== 'press' || finished.button !== 0) return;
  if (placing && finished.hit < 0) {
    const at = scene.groundAt(e.clientX, e.clientY);
    if (at && !readOnly) api.postMessage({ type: 'place', typeId: placing.id, owner: Number(ownerSelect.value), x: at.x, y: at.y });
  } else if (finished.hit < 0) {
    select(-1);
  }
});

canvas.addEventListener('mouseleave', () => {
  hideTip();
  if (placing && ghost) { ghost = null; refreshMarkers(); }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  scene?.zoom(e.deltaY < 0);
}, { passive: false });

function cancelDrag(): boolean {
  if (!press || press.mode !== 'move') return false;
  press = null;
  dragPosition = null;
  canvas.classList.remove('moving');
  renderSelection();
  refreshMarkers();
  return true;
}

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape' && placing) setPlacing(null);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === 'Escape') {
    if (cancelDrag()) return;
    if (placing) setPlacing(null);
    else select(-1);
  }
});

for (const key of Object.keys(toggles)) toggles[key].addEventListener('change', () => { refreshMarkers(); });
document.getElementById('mp-reset').addEventListener('click', () => scene?.resetView());
document.getElementById('mp-exag').addEventListener('input', (e) => {
  scene?.setExaggeration(parseFloat((e.target as HTMLInputElement).value) || 1);
});
window.addEventListener('resize', () => scene?.resize());

// ── Host messages ────────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'placementTypes') {
    types = msg.types;
    renderTypes();
  } else if (msg.type === 'placementsChanged') {
    placements = msg.placements;
    dirtyBadge.hidden = !msg.isDirty;
    if (typeof msg.select === 'number') select(msg.select);
    else select(selected < placements.length ? selected : -1);
  }
});

// Read-only hook for the Playwright suite: maps between map coordinates and the screen, which a
// test cannot otherwise know for an orbit camera.
(window as any).__wurstMapEditorDebug = {
  markerScreenPosition: (x: number, y: number) => scene && scene.markerScreenPosition(x, y),
  groundScreenPosition: (x: number, y: number) => scene && scene.groundScreenPosition(x, y),
  groundAt: (clientX: number, clientY: number) => scene && scene.groundAt(clientX, clientY),
  state: () => ({ selected, placing: placing && placing.id, placements }),
};

if (!scene) {
  document.getElementById('mp-err').style.display = 'grid';
} else {
  canvas.tabIndex = 0;
  scene.resize();
  refreshMarkers();
}
renderSelection();
renderTypes();
api.postMessage({ type: 'requestTypes' });
