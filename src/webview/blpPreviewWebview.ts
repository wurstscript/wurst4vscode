/**
 * Image/model preview webview (BLP/DDS/TGA rasters, MDX/MDL models). Bundled to
 * dist/webview/blpPreviewWebview.js by webpack and loaded by blpPreview.ts after mdxViewer.js, whose
 * `window.War3Viewer` renders models. The page carries no initial data; everything arrives by message.
 *   webview → host  { type: 'ready' } | { type: 'debug', message } | { type: 'previewError', message }
 *                   | { type: 'requestTextures', paths } (from War3Viewer) | { type: 'openTexture', fsPath }
 *   host → webview  { type: 'loading' | 'error' | 'image' | 'mdx' | 'mdxTexture', ... }
 */

import { base64ToBytes } from './webviewUtils';
import type { ModelLoadedInfo, War3ViewerApi } from './mdxViewer';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface RasterData {
  kind?: string;
  mode: string;
  width: number;
  height: number;
  rgbaBase64: string;
  description: string;
  warnings?: string[];
}

const vscode = acquireVsCodeApi();
const w3v = window.War3Viewer as War3ViewerApi | undefined;
let isModelMode = false;
let currentFileName = '';
const debugLines: string[] = [];
const debugLimit = 200;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const viewport = byId('viewport');
const stage = byId('stage');
const canvas2d = byId<HTMLCanvasElement>('canvas2d');
const canvas3d = byId<HTMLCanvasElement>('canvas3d');
const zoomLabel = byId('zoomLabel');
const zoomInBtn = byId('zoomInBtn');
const zoomOutBtn = byId('zoomOutBtn');
const fitBtn = byId('fitBtn');
const renderModeBtn = byId('renderModeBtn');
const alphaBtn = byId('alphaBtn');
const teamColorSelect = byId<HTMLSelectElement>('teamColorSelect');
const animSelect = byId<HTMLSelectElement>('animSelect');
const autoplayChk = byId<HTMLInputElement>('autoplayChk');
const seqSlider = byId<HTMLInputElement>('seqSlider');
const seqFrameLabel = byId('seqFrameLabel');
const seqStats = byId('seqStats');
const debugLog = byId('debugLog');

function debug(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = '[' + ts + '] ' + msg;
  debugLines.push(line);
  if (debugLines.length > debugLimit) debugLines.shift();
  debugLog.textContent = debugLines.join('\n');
  // don't auto-show debug log — user must toggle it
  try { vscode.postMessage({ type: 'debug', message: line }); } catch { /* host gone */ }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = base64ToBytes(base64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function showWarnings(messages: string[] | undefined) {
  const el = byId('warnings');
  if (!messages || !messages.length) {
    el.textContent = '';
    debug('warnings cleared');
    return;
  }
  el.textContent = messages.map((w) => '- ' + w).join('\n');
  debug('warnings: ' + messages.length);
}

function setLoading(isLoading: boolean, text?: string) {
  const overlay = byId('loadingOverlay');
  if (text) byId('loadingText').textContent = text;
  overlay.classList.toggle('visible', isLoading);
  overlay.setAttribute('aria-busy', String(isLoading));
  overlay.setAttribute('aria-hidden', String(!isLoading));
  stage.classList.toggle('loading-stage', isLoading);
  debug(isLoading ? 'loading on: ' + (text || '') : 'loading off');
}

function setMeta(fileName: string, metaText: string) {
  byId('fileName').textContent = fileName;
  byId('fileMeta').textContent = ' — ' + metaText;
  debug('meta: ' + fileName + ' | ' + metaText);
}

function setSidebarVisible(visible: boolean) {
  byId('sidebar').classList.toggle('visible', visible);
}

function setShown(id: string, shown: boolean) {
  byId(id).style.display = shown ? '' : 'none';
}

function setModelButtons(visible: boolean) {
  setShown('modelSep', visible);
  setShown('resetCamBtn', visible);
  setShown('renderModeBtn', visible);
  setShown('imgSep', !visible);
  setShown('fitBtn', !visible);
  setShown('alphaBtn', !visible);
}

function textureFileName(texPath: string): string {
  return texPath.split(/[\\/]/).pop() || texPath;
}

// ── War3Viewer init ────────────────────────────────────────────────────────

function onModelLoaded(info: ModelLoadedInfo) {
  isModelMode = true;
  setMeta(info.name || 'Model', 'geosets: ' + info.geosetCount + ' · textures: ' + info.textureCount);
  byId('sbName').textContent = info.name || 'Model';
  byId('sbInfo').textContent = info.geosetCount + ' geosets · ' + info.textureCount + ' textures';
  animSelect.innerHTML = '';
  if (!info.sequences.length) {
    const opt = document.createElement('option');
    opt.textContent = 'Bind pose';
    animSelect.appendChild(opt);
  } else {
    for (const seq of info.sequences) {
      const opt = document.createElement('option');
      opt.textContent = seq.name + ' [' + seq.start + '–' + seq.end + ']' + (seq.looping ? '' : ' ∅');
      animSelect.appendChild(opt);
    }
    animSelect.selectedIndex = 0;
  }
  setSidebarVisible(true);
  if (w3v) w3v.setTeamColor(teamColorSelect.value);
  if (info.sequences.length) {
    const s = info.sequences[0];
    setShown('seqSection', true);
    setShown('seqDivider', true);
    seqSlider.min = String(s.start);
    seqSlider.max = String(s.end);
    seqSlider.value = String(s.start);
    seqStats.textContent = s.name;
  }
  // Build texture list (items get updated with links when textures resolve)
  const texList = byId('texList');
  texList.innerHTML = '';
  if (info.texturePaths && info.texturePaths.length) {
    setShown('texListSection', true);
    setShown('texListDivider', true);
    for (const tp of info.texturePaths) {
      const item = document.createElement('div');
      item.className = 'tex-item missing';
      item.dataset.path = tp;
      item.textContent = textureFileName(tp);
      item.title = tp;
      texList.appendChild(item);
    }
  }
  stage.style.transform = 'translate(0px, 0px) scale(1)';
  zoomLabel.textContent = '3D';
  setModelButtons(true);
  setLoading(false);
}

if (w3v) {
  w3v.init({
    canvas3d,
    gizmo: byId<HTMLCanvasElement>('gizmo'),
    viewport,
    vscodeApi: vscode,
    callbacks: {
      onModelLoaded,
      onFrameUpdate(frame, seqStart, seqEnd) {
        seqSlider.min = String(seqStart);
        seqSlider.max = String(seqEnd);
        seqSlider.value = String(Math.floor(frame));
        const tMs = Math.max(0, frame - seqStart);
        seqFrameLabel.textContent = Math.floor(frame) + ' · ' + Math.floor(tMs) + 'ms';
      },
      onError(message) {
        showWarnings(['Model error: ' + message]);
        setMeta(currentFileName || 'Model', 'Render failed');
        setLoading(false);
        debug('w3v error: ' + message);
        vscode.postMessage({ type: 'previewError', message });
      },
      onDebug(msg) { debug('w3v: ' + msg); },
    },
  });
}

function renderCurrent(data: RasterData) {
  debug('renderCurrent kind=' + data.kind);
  canvas3d.style.display = 'none';
  canvas2d.style.display = '';
  setModelButtons(false);
  setShown('seqSection', false);
  setShown('seqDivider', false);
  setShown('texListSection', false);
  setShown('texListDivider', false);
  const ctx = canvas2d.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('2D canvas context is unavailable.');
  canvas2d.width = data.width;
  canvas2d.height = data.height;
  ctx.clearRect(0, 0, canvas2d.width, canvas2d.height);
  if (data.mode !== 'rgba') throw new Error('Raster decoder returned a non-RGBA image');
  const rgba = base64ToBytes(data.rgbaBase64);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), data.width, data.height), 0, 0);
  showWarnings(data.warnings);
  debug('raster rendered');
}

// ── 2D pan/zoom ────────────────────────────────────────────────────────────

let showAlpha = true;
let zoom = 1;
let tx = 0;
let ty = 0;
let dragActive = false;
let dragStartX = 0;
let dragStartY = 0;
let dragTx = 0;
let dragTy = 0;
let modelRenderMode: 'fill' | 'wire' = 'fill';
let lastRasterWidth = 1;
let lastRasterHeight = 1;

function updateRenderModeUi() {
  renderModeBtn.textContent = modelRenderMode === 'fill' ? 'Fill' : 'Wire';
}

function applyAlphaMode() {
  viewport.classList.toggle('alpha-off', !showAlpha);
  alphaBtn.classList.toggle('active', showAlpha);
}

function clampZoom(value: number) {
  return Math.min(64, Math.max(0.05, value));
}

function applyTransform() {
  stage.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')';
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

function zoomAt(factor: number, clientX: number, clientY: number) {
  const rect = viewport.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const nextZoom = clampZoom(zoom * factor);
  if (nextZoom === zoom) return;
  const imageX = (px - tx) / zoom;
  const imageY = (py - ty) / zoom;
  zoom = nextZoom;
  tx = px - imageX * zoom;
  ty = py - imageY * zoom;
  applyTransform();
}

function zoomByStep(direction: number) {
  const factor = direction > 0 ? 1.2 : 1 / 1.2;
  const rect = viewport.getBoundingClientRect();
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function centerImage() {
  tx = (viewport.clientWidth - lastRasterWidth * zoom) / 2;
  ty = (viewport.clientHeight - lastRasterHeight * zoom) / 2;
  applyTransform();
}

function fitToView() {
  const vw = Math.max(1, viewport.clientWidth);
  const vh = Math.max(1, viewport.clientHeight);
  zoom = clampZoom(Math.min(vw / lastRasterWidth, vh / lastRasterHeight));
  centerImage();
}

viewport.addEventListener('pointerdown', (ev) => {
  if (isModelMode) return;
  dragActive = true;
  dragStartX = ev.clientX;
  dragStartY = ev.clientY;
  dragTx = tx;
  dragTy = ty;
  viewport.classList.add('dragging');
  viewport.setPointerCapture(ev.pointerId);
});

viewport.addEventListener('pointermove', (ev) => {
  if (isModelMode || !dragActive) return;
  tx = dragTx + (ev.clientX - dragStartX);
  ty = dragTy + (ev.clientY - dragStartY);
  applyTransform();
});

function stopDrag(ev: PointerEvent) {
  if (!dragActive) return;
  dragActive = false;
  viewport.classList.remove('dragging');
  try { viewport.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
}

viewport.addEventListener('pointerup', stopDrag);
viewport.addEventListener('pointercancel', stopDrag);
viewport.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (isModelMode) return;
  const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(factor, ev.clientX, ev.clientY);
}, { passive: false });

zoomInBtn.addEventListener('click', () => {
  if (isModelMode) { if (w3v) w3v.zoomIn(); return; }
  zoomByStep(1);
});
zoomOutBtn.addEventListener('click', () => {
  if (isModelMode) { if (w3v) w3v.zoomOut(); return; }
  zoomByStep(-1);
});
byId('resetCamBtn').addEventListener('click', () => {
  if (w3v) w3v.resetCamera();
});
fitBtn.addEventListener('click', () => {
  if (!isModelMode) fitToView();
});
window.addEventListener('resize', () => {
  if (!isModelMode) centerImage();
});

renderModeBtn.addEventListener('click', () => {
  modelRenderMode = modelRenderMode === 'fill' ? 'wire' : 'fill';
  updateRenderModeUi();
  if (w3v) w3v.setRenderMode(modelRenderMode);
});

alphaBtn.addEventListener('click', () => {
  showAlpha = !showAlpha;
  applyAlphaMode();
});

byId('debugBtn').addEventListener('click', () => {
  debugLog.classList.toggle('visible');
});

teamColorSelect.addEventListener('change', () => {
  if (w3v) w3v.setTeamColor(teamColorSelect.value);
});

animSelect.addEventListener('change', () => {
  if (w3v) w3v.setSequence(animSelect.selectedIndex);
});

autoplayChk.addEventListener('change', () => {
  if (w3v) w3v.setAutoplay(autoplayChk.checked);
});

seqSlider.addEventListener('input', () => {
  const frame = Math.floor(Number(seqSlider.value));
  if (autoplayChk.checked) autoplayChk.checked = false;
  if (w3v) w3v.setFrame(frame);
});

// ── Host messages ──────────────────────────────────────────────────────────

function onTextureMessage(msg: any) {
  if (w3v) {
    if (msg.ddsBase64) {
      w3v.onTextureDds(msg.path, base64ToArrayBuffer(msg.ddsBase64));
    } else if (msg.rgbaBase64 && msg.width && msg.height) {
      const rgba = base64ToBytes(msg.rgbaBase64);
      w3v.onTextureImageData(msg.path, new ImageData(new Uint8ClampedArray(rgba.buffer), msg.width, msg.height));
    } else {
      w3v.onTexture(msg.path, msg.blpBase64 ? base64ToArrayBuffer(msg.blpBase64) : null);
    }
  }
  // Update texture list item with resolved path (or mark as missing)
  const item = document.querySelector('.tex-item[data-path="' + CSS.escape(msg.path) + '"]');
  if (!item) return;
  if (!msg.resolvedFsPath) {
    item.classList.add('missing');
    return;
  }
  item.classList.remove('missing');
  const existing = item.querySelector('a');
  const a = existing || document.createElement('a');
  a.textContent = textureFileName(msg.path);
  a.title = msg.resolvedFsPath;
  a.href = '#';
  a.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openTexture', fsPath: msg.resolvedFsPath }); };
  if (!existing) {
    item.textContent = '';
    item.appendChild(a);
    const full = document.createElement('span');
    full.className = 'tex-full';
    full.textContent = msg.path;
    item.appendChild(full);
  }
}

function onImageMessage(msg: any) {
  isModelMode = false;
  viewport.classList.remove('model-mode');
  setSidebarVisible(false);
  setModelButtons(false);
  const data = msg.decoded as RasterData;
  lastRasterWidth = data.width;
  lastRasterHeight = data.height;
  setMeta(msg.fileName || 'Image', data.description + ' · ' + data.width + ' × ' + data.height);
  try {
    renderCurrent(data);
    zoom = 1;
    centerImage();
    setLoading(false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showWarnings(['Render error: ' + message]);
    setMeta(msg.fileName || 'Image', 'Render failed');
    setLoading(false);
    debug('render exception: ' + message);
    vscode.postMessage({ type: 'previewError', message });
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  debug('message: ' + (msg.type || 'unknown'));
  if (msg.type === 'loading') {
    setMeta(msg.fileName || 'Image', 'Loading...');
    setLoading(true, 'Loading image...');
  } else if (msg.type === 'error') {
    setMeta(msg.fileName || 'Image', 'Failed to load');
    showWarnings([msg.message || 'Unknown error']);
    setLoading(false);
  } else if (msg.type === 'mdx') {
    isModelMode = true;
    viewport.classList.add('model-mode');
    canvas2d.style.display = 'none';
    canvas3d.style.display = '';
    stage.style.transform = 'translate(0px, 0px) scale(1)';
    zoomLabel.textContent = '3D';
    currentFileName = msg.fileName || '';
    setMeta(msg.fileName || 'Model', 'Loading model...');
    setLoading(true, 'Loading model...');
    if (w3v) w3v.loadModel(base64ToArrayBuffer(msg.mdxBase64), msg.fileName || '', msg.format || 'mdx');
  } else if (msg.type === 'mdxTexture') {
    onTextureMessage(msg);
  } else if (msg.type === 'image') {
    onImageMessage(msg);
  }
});

window.addEventListener('error', (event) => {
  const message = event && event.message ? event.message : 'Unknown webview error';
  showWarnings(['Webview error: ' + message]);
  setLoading(false);
  debug('window error: ' + message);
  vscode.postMessage({ type: 'previewError', message });
});

debug('script boot');
updateRenderModeUi();
applyAlphaMode();
vscode.postMessage({ type: 'ready' });
debug('ready posted');
