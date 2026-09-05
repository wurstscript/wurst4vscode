/**
 * Pathing-map (.wpm) editor webview. Bundled to dist/webview/wpmEditorWebview.js by webpack and
 * loaded by wpmPreview.ts, which hands over the grid through `window.__WPM_INITIAL__`. Host protocol:
 *   webview → host  { type: 'editCells', changes } | { type: 'editRuns', runs }
 *   host → webview  { type: 'applyRuns', runs } | { type: 'dirtyStateChanged', isDirty }
 */

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): any;
  setState(state: any): void;
};

interface WpmInitialData {
  width: number;
  height: number;
  dataBase64: string;
  colorTable: number[][];
  flagDefinitions: Array<{ bit: number; label: string }>;
}

const api = acquireVsCodeApi();
const initial = (window as any).__WPM_INITIAL__ as WpmInitialData;
const W = initial.width;
const H = initial.height;
const raw = atob(initial.dataBase64);
const colorTable = initial.colorTable;
const flagDefinitions = initial.flagDefinitions;
const data = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);

const canvas    = document.getElementById('wpmCanvas') as HTMLCanvasElement;
const ctx       = canvas.getContext('2d');
const viewport  = document.getElementById('viewport');
const zoomLabel = document.getElementById('zoomLabel');

// ── Render map into offscreen ImageData ────────────────────────────────────
const offscreen = document.createElement('canvas');
offscreen.width = W; offscreen.height = H;
const offCtx = offscreen.getContext('2d');
const img = offCtx.createImageData(W, H);
const px  = img.data;
function writePixel(index) {
    const dataY = Math.floor(index / W);
    const x = index % W;
    const dispY = H - 1 - dataY; // WC3 row 0 = bottom of map, flip for screen
    const flag = data[index];
    const i = (dispY * W + x) * 4;
    if (flag === 0) { px[i] = 0; px[i+1] = 0; px[i+2] = 0; px[i+3] = 0; return; }
    const [r, g, b] = colorTable[flag] || [0, 0, 0];
    px[i]=r; px[i+1]=g; px[i+2]=b; px[i+3]=230;
}
for (let index = 0; index < data.length; index++) writePixel(index);
offCtx.putImageData(img, 0, 0);

// ── Camera state ───────────────────────────────────────────────────────────
// camX/camY: which offscreen pixel is at the screen centre (float)
// zoom: screen pixels per map cell (float, stepless)
const savedState = api.getState() || {};
let camX = Number.isFinite(savedState.camX) ? savedState.camX : W / 2;
let camY = Number.isFinite(savedState.camY) ? savedState.camY : H / 2;
let zoom = Number.isFinite(savedState.zoom) ? savedState.zoom : 1;
let tool = ['pan', 'paint', 'line', 'fill', 'erase'].includes(savedState.tool) ? savedState.tool : 'pan';
let brushSize = Number.isInteger(savedState.brushSize) ? Math.max(1, Math.min(32, savedState.brushSize)) : 1;
const MIN_ZOOM = 0.05, MAX_ZOOM = 64;

function persistView() { api.setState({ camX, camY, zoom, tool, brushSize }); }

function clampCam() {
  const vw = canvas.width, vh = canvas.height;
  camX = Math.max(0, Math.min(W, camX));
  camY = Math.max(0, Math.min(H, camY));
}

function fitToView() {
  const vw = canvas.width || viewport.clientWidth;
  const vh = canvas.height || viewport.clientHeight;
  zoom = Math.min(vw / W, vh / H);
  camX = W / 2; camY = H / 2;
}

// ── Draw ───────────────────────────────────────────────────────────────────
// The display canvas is fixed to the viewport size — it NEVER resizes on zoom.
// Zoom/pan = update camera, call draw() once. Draw = one drawImage (GPU blit).
function draw() {
  const vw = canvas.width, vh = canvas.height;
  ctx.clearRect(0, 0, vw, vh);

  // Source rect in offscreen coords
  const srcX = camX - vw / (2 * zoom);
  const srcY = camY - vh / (2 * zoom);
  const srcW = vw / zoom;
  const srcH = vh / zoom;

  ctx.imageSmoothingEnabled = zoom < 1;
  ctx.drawImage(offscreen, srcX, srcY, srcW, srcH, 0, 0, vw, vh);

  // Grid — only when cells are large enough to see individually
  if (zoom >= 6) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.ceil(srcX), x1 = Math.floor(srcX + srcW) + 1;
    const y0 = Math.ceil(srcY), y1 = Math.floor(srcY + srcH) + 1;
    for (let cx = x0; cx <= x1; cx++) {
      const sx = Math.round((cx - srcX) * zoom) + 0.5;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, vh);
    }
    for (let cy = y0; cy <= y1; cy++) {
      const sy = Math.round((cy - srcY) * zoom) + 0.5;
      ctx.moveTo(0, sy); ctx.lineTo(vw, sy);
    }
    ctx.stroke();
  }

  if (lineStart && lineCurrent && tool === 'line') {
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = brushColor();
    lineCells(lineStart.x, lineStart.y, lineCurrent.x, lineCurrent.y, (x, y) => paintBrushPreview(x, y));
    ctx.globalAlpha = 1;
  }

  zoomLabel.textContent = zoom >= 1
    ? zoom.toFixed(zoom < 10 ? 1 : 0) + ' px/cell'
    : (zoom * 100).toFixed(0) + '%';
}

let dirtyMinX = W, dirtyMinY = H, dirtyMaxX = -1, dirtyMaxY = -1;
function refreshCell(index) {
  writePixel(index);
  const x = index % W, y = Math.floor(index / W);
  dirtyMinX = Math.min(dirtyMinX, x);
  dirtyMaxX = Math.max(dirtyMaxX, x);
  dirtyMinY = Math.min(dirtyMinY, y);
  dirtyMaxY = Math.max(dirtyMaxY, y);
}

function flushImage() {
  if (dirtyMaxX < dirtyMinX || dirtyMaxY < dirtyMinY) return;
  offCtx.putImageData(img, 0, 0, dirtyMinX, H - 1 - dirtyMaxY,
    dirtyMaxX - dirtyMinX + 1, dirtyMaxY - dirtyMinY + 1);
  dirtyMinX = W; dirtyMinY = H; dirtyMaxX = -1; dirtyMaxY = -1;
}

let rafId = null;
function scheduleDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = null; draw(); });
}

// ── Resize: canvas always matches viewport, never zoom-driven ─────────────
function resizeCanvas() {
  canvas.width  = viewport.clientWidth;
  canvas.height = viewport.clientHeight;
  scheduleDraw();
}
new ResizeObserver(resizeCanvas).observe(viewport);

// ── Wheel: smooth stepless zoom pinned to cursor ───────────────────────────
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const vw = canvas.width, vh = canvas.height;

  // Map coord under cursor before zoom
  const mapX = camX + (sx - vw / 2) / zoom;
  const mapY = camY + (sy - vh / 2) / zoom;

  zoom *= Math.pow(1.12, e.deltaY < 0 ? 1 : -1);
  zoom  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

  // Restore cursor's map coord to same screen position
  camX = mapX - (sx - vw / 2) / zoom;
  camY = mapY - (sy - vh / 2) / zoom;
  clampCam();
  persistView();
  scheduleDraw();
}, { passive: false });

// ── Pan and cell editing ───────────────────────────────────────────────────
let dragging = false, editing = false, dragSX = 0, dragSY = 0, dragCamX = 0, dragCamY = 0;
let gestureChanges = new Map(), lastEditX = -1, lastEditY = -1;
let gestureRuns = null;
let lineStart = null, lineCurrent = null;

function eventCell(e) {
  const rect = viewport.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const offX = Math.floor(camX + (sx - canvas.width / 2) / zoom);
  const offY = Math.floor(camY + (sy - canvas.height / 2) / zoom);
  const dataY = H - 1 - offY;
  if (offX < 0 || offX >= W || dataY < 0 || dataY >= H) return null;
  return { x: offX, y: dataY, index: dataY * W + offX };
}

function brushValue() {
  let value = 0;
  document.querySelectorAll<HTMLInputElement>('[data-brush-bit]:checked').forEach((input) => { value |= Number(input.dataset.brushBit); });
  return value;
}

function updateBrushValue() {
  document.getElementById('brushValue').textContent = '0x' + brushValue().toString(16).padStart(2, '0').toUpperCase();
}

function pickBrush(value) {
  document.querySelectorAll<HTMLInputElement>('[data-brush-bit]').forEach((input) => { input.checked = (value & Number(input.dataset.brushBit)) !== 0; });
  updateBrushValue();
  setTool('paint');
}

function brushColor() {
  const [r, g, b] = colorTable[tool === 'erase' ? 0 : brushValue()] || [255, 255, 255];
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function lineCells(fromX, fromY, toX, toY, visit) {
  const dx = Math.abs(toX - fromX), sx = fromX < toX ? 1 : -1;
  const dy = -Math.abs(toY - fromY), sy = fromY < toY ? 1 : -1;
  let x = fromX, y = fromY, err = dx + dy;
  while (true) {
    visit(x, y);
    if (x === toX && y === toY) break;
    const twice = 2 * err;
    if (twice >= dy) { err += dy; x += sx; }
    if (twice <= dx) { err += dx; y += sy; }
  }
}

function brushCells(x, y, visit) {
  const radius = Math.floor(brushSize / 2);
  for (let dy = -radius; dy < brushSize - radius; dy++) {
    for (let dx = -radius; dx < brushSize - radius; dx++) visit(x + dx, y + dy);
  }
}

function paintCell(x, y, next) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const index = y * W + x;
  if (!gestureChanges.has(index)) gestureChanges.set(index, data[index]);
  data[index] = next;
  refreshCell(index);
}

function paintBrush(x, y) {
  const next = tool === 'erase' ? 0 : brushValue();
  brushCells(x, y, (cellX, cellY) => paintCell(cellX, cellY, next));
}

function paintBrushPreview(x, y) {
  const srcX = camX - canvas.width / (2 * zoom);
  const srcY = camY - canvas.height / (2 * zoom);
  brushCells(x, y, (cellX, cellY) => {
    const offX = cellX, offY = H - 1 - cellY;
    const sx = (offX - srcX) * zoom, sy = (offY - srcY) * zoom;
    if (offX >= 0 && offX < W && cellY >= 0 && cellY < H) ctx.fillRect(sx, sy, zoom, zoom);
  });
}

function paintLine(fromX, fromY, toX, toY) {
  lineCells(fromX, fromY, toX, toY, paintBrush);
  flushImage();
  scheduleDraw();
}

function fillFrom(startIndex) {
  const replacement = tool === 'erase' ? 0 : brushValue();
  const source = data[startIndex];
  if (source === replacement) return [];
  const visited = new Uint8Array(data.length);
  const changed = new Uint8Array(data.length);
  const stack = [startIndex];
  visited[startIndex] = 1;
  const enqueue = (index) => {
    if (!visited[index] && data[index] === source) {
      visited[index] = 1;
      stack.push(index);
    }
  };
  while (stack.length) {
    const index = stack.pop();
    const x = index % W, y = Math.floor(index / W);
    data[index] = replacement;
    refreshCell(index);
    changed[index] = 1;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < W) enqueue(index + 1);
    if (y > 0) enqueue(index - W);
    if (y + 1 < H) enqueue(index + W);
  }
  flushImage();
  scheduleDraw();
  const runs = [];
  for (let index = 0; index < changed.length;) {
    if (!changed[index]) { index++; continue; }
    const start = index;
    while (index < changed.length && changed[index]) index++;
    runs.push({ start, length: index - start, value: replacement });
  }
  return runs;
}

function finishEdit() {
  if (!editing) return;
  editing = false;
  const runs = gestureRuns;
  const changes = [];
  gestureChanges.forEach((before, index) => {
    const value = data[index];
    if (value !== before) changes.push({ index, value });
  });
  gestureChanges = new Map();
  gestureRuns = null;
  if (runs) api.postMessage({ type: 'editRuns', runs });
  else if (changes.length) api.postMessage({ type: 'editCells', changes });
}

viewport.addEventListener('pointerdown', (e) => {
  const cell = eventCell(e);
  if (e.button === 0 && e.altKey && cell) { pickBrush(data[cell.index]); return; }
  if (tool !== 'pan' && e.button === 0 && cell) {
    editing = true; gestureChanges = new Map(); gestureRuns = null; lastEditX = cell.x; lastEditY = cell.y;
    viewport.setPointerCapture(e.pointerId);
    if (tool === 'line') {
      lineStart = cell; lineCurrent = cell; scheduleDraw();
    } else if (tool === 'fill') {
      gestureRuns = fillFrom(cell.index); finishEdit();
    } else {
      paintBrush(cell.x, cell.y); flushImage(); scheduleDraw();
    }
    return;
  }
  if (e.button !== 0 && e.button !== 1) return;
  dragging = true;
  dragSX = e.clientX; dragSY = e.clientY;
  dragCamX = camX;    dragCamY = camY;
  viewport.setPointerCapture(e.pointerId);
  viewport.style.cursor = 'grabbing';
});
viewport.addEventListener('pointermove', (e) => {
  if (editing) {
    const cell = eventCell(e);
    if (cell && tool === 'line') {
      lineCurrent = cell; scheduleDraw();
    } else if (cell && (cell.x !== lastEditX || cell.y !== lastEditY)) {
      paintLine(lastEditX, lastEditY, cell.x, cell.y);
      lastEditX = cell.x; lastEditY = cell.y;
    }
    return;
  }
  if (!dragging) return;
  camX = dragCamX - (e.clientX - dragSX) / zoom;
  camY = dragCamY - (e.clientY - dragSY) / zoom;
  clampCam();
  scheduleDraw();
});
const endDrag = () => {
  if (editing && tool === 'line' && lineStart && lineCurrent) {
    lineCells(lineStart.x, lineStart.y, lineCurrent.x, lineCurrent.y, paintBrush);
    flushImage();
    lineStart = null; lineCurrent = null;
    scheduleDraw();
  }
  finishEdit();
  dragging = false;
  persistView();
  viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
};
viewport.addEventListener('pointerup',     endDrag);
viewport.addEventListener('pointercancel', endDrag);

// ── Toolbar buttons ────────────────────────────────────────────────────────
document.getElementById('btnZoomIn').addEventListener('click', () => {
  zoom = Math.min(MAX_ZOOM, zoom * 1.5); persistView(); scheduleDraw();
});
document.getElementById('btnZoomOut').addEventListener('click', () => {
  zoom = Math.max(MIN_ZOOM, zoom / 1.5); persistView(); scheduleDraw();
});
document.getElementById('btnZoomFit').addEventListener('click', () => {
  fitToView(); persistView(); scheduleDraw();
});

function setTool(next) {
  tool = next;
  if (tool !== 'line') { lineStart = null; lineCurrent = null; }
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  persistView();
}
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll<HTMLInputElement>('[data-brush-bit]').forEach((input) => input.addEventListener('change', updateBrushValue));
const brushSizeInput = document.getElementById('brushSize') as HTMLInputElement;
const brushSizeValue = document.getElementById('brushSizeValue');
brushSizeInput.value = String(brushSize);
function updateBrushSize() {
  brushSize = Number(brushSizeInput.value);
  brushSizeValue.textContent = brushSize + ' × ' + brushSize;
  persistView();
  scheduleDraw();
}
brushSizeInput.addEventListener('input', updateBrushSize);

// ── Tooltip ────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
viewport.addEventListener('mousemove', (e) => {
  if (dragging) { tooltip.style.display = 'none'; return; }
  const rect = viewport.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const vw = canvas.width, vh = canvas.height;
  const offX = Math.floor(camX + (sx - vw / 2) / zoom);
  const offY = Math.floor(camY + (sy - vh / 2) / zoom);
  const dataX = offX, dataY = H - 1 - offY;
  if (dataX >= 0 && dataX < W && dataY >= 0 && dataY < H) {
    const flag = data[dataY * W + dataX];
    const parts = flagDefinitions.filter((definition) => flag & definition.bit).map((definition) => definition.label);
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top  = (e.clientY + 16) + 'px';
    tooltip.innerHTML = `<strong>(${dataX}, ${dataY})</strong>&ensp;0x${flag.toString(16).padStart(2,'0').toUpperCase()}<br>${parts.join(', ') || 'Walkable'}`;
  } else {
    tooltip.style.display = 'none';
  }
});
viewport.addEventListener('mouseleave', () => tooltip.style.display = 'none');

function applyChanges(changes) {
  changes.forEach((change) => {
    if (Number.isInteger(change.index) && change.index >= 0 && change.index < data.length) {
      data[change.index] = change.value & 0xff;
      refreshCell(change.index);
    }
  });
  flushImage();
  scheduleDraw();
}

function applyRuns(runs) {
  runs.forEach((run) => {
    if (!Number.isInteger(run.start) || !Number.isInteger(run.length) || !Number.isInteger(run.value) ||
        run.start < 0 || run.length < 1 || run.start + run.length > data.length) return;
    for (let index = run.start; index < run.start + run.length; index++) {
      data[index] = run.value & 0xff;
      refreshCell(index);
    }
  });
  flushImage();
  scheduleDraw();
}

window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'applyCells' && Array.isArray(message.changes)) {
    applyChanges(message.changes);
  } else if (message.type === 'applyRuns' && Array.isArray(message.runs)) {
    applyRuns(message.runs);
  } else if (message.type === 'dirtyStateChanged') {
    document.getElementById('dirtyBadge').hidden = !message.isDirty;
  }
});

// Init: size canvas then fit map
resizeCanvas();
if (!Number.isFinite(savedState.zoom)) fitToView();
setTool(tool);
updateBrushValue();
updateBrushSize();
draw();
