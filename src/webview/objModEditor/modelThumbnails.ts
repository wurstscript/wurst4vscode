import { esc, base64ToBytes } from '../objModWebviewUtils';
import { vscodeApi } from './state';
import { mpvViewer, mpvB64ToArrayBuffer } from './modelViewerShared';
import { abActiveTab } from './assetBrowser';
import { resetMpvInited } from './modelPreviewPanel';

let modelThumbObserver: IntersectionObserver | undefined;
export const pendingModelThumbs = new Set<string>();
export const loadedModelThumbs = new Map<string, string>();
export const missingModelThumbs = new Set<string>();
export const missingModelThumbReasons = new Map<string, any>();
export const modelThumbRequestQueue: any[] = [];
export const modelThumbHostInflight = new Set<string>();
export const modelThumbQueue: any[] = [];
let modelThumbJob: any = null;
let modelThumbAwaitingDecisionKey = '';
let modelThumbSeq = 0;
let modelThumbInited = false;
let modelThumbTextureTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelThumbIdleTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelThumbCancelGeneration = 0;
export const modelThumbEvents: any[] = [];
const MODEL_THUMB_HOST_CONCURRENCY = 1;
const MODEL_THUMB_ZERO_ALPHA_RETRIES = 0;
const MODEL_THUMB_MIN_VISIBLE_PIXELS = 4;

export function nextModelThumbSeq() {
  return modelThumbSeq++;
}

export function clearAwaitingDecisionKey(key) {
  if (modelThumbAwaitingDecisionKey === key) modelThumbAwaitingDecisionKey = '';
}

export function getAwaitingDecisionKey() {
  return modelThumbAwaitingDecisionKey;
}

export function getActiveModelThumbJobKey() {
  return modelThumbJob ? modelThumbJob.key : '';
}

// Scope the scan to the just-rendered subtree (tree / details / a single cell) instead of the whole
// document — a .w3a file can have hundreds of icons and a full-document scan ran on every render.

// Decode an icon to a data URL using the browser — same pipeline as the BLP viewer (handles BGR
// jpeg-content BLPs by swapping R/B after decode, plus 4-component jpegs the browser supports).
export function observeModelThumbs(root) {
  if (!modelThumbObserver) {
    modelThumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (!isModelThumbActuallyVisible(entry.target)) continue;
        modelThumbObserver.unobserve(entry.target);
        requestModelThumb(entry.target);
      }
    }, { root: null, rootMargin: '0px' });
  }
  for (const el of (root || document).querySelectorAll('.model-thumb[data-model]')) {
    const key = el.getAttribute('data-key') || '';
    if (loadedModelThumbs.has(key)) {
      setModelThumbLoaded(el, loadedModelThumbs.get(key));
    } else if (missingModelThumbs.has(key)) {
      setModelThumbMissing(el, missingModelThumbReasons.get(key));
    } else if (isModelThumbActuallyVisible(el)) {
      requestModelThumb(el);
    } else {
      modelThumbObserver.observe(el);
    }
  }
}

export function requestVisibleModelThumbs(root) {
  for (const el of (root || document).querySelectorAll('.model-thumb[data-model]')) {
    const key = el.getAttribute('data-key') || '';
    if (!key || pendingModelThumbs.has(key) || loadedModelThumbs.has(key) || missingModelThumbs.has(key)) continue;
    if (isModelThumbActuallyVisible(el)) requestModelThumb(el);
  }
}

export function isAssetBrowserModelKey(key) {
  return String(key || '').indexOf('ab-model:') === 0;
}

export function isAssetBrowserOpen() {
  const ov = document.getElementById('ab-overlay');
  return !!ov && !ov.hidden;
}

export function rectsIntersect(a, b) {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

export function isModelThumbActuallyVisible(el) {
  if (!el || !el.isConnected) return false;
  const key = el.getAttribute('data-key') || '';
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (isAssetBrowserModelKey(key)) {
    if (!isAssetBrowserOpen() || abActiveTab.peek() !== 'model') return false;
    const grid = document.getElementById('ab-grid');
    if (!grid || !grid.contains(el)) return false;
    return rectsIntersect(rect, grid.getBoundingClientRect());
  }
  return rectsIntersect(rect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
}

export function hasVisibleModelThumbElement(key) {
  for (const el of modelThumbElementsForKey(key)) {
    if (isModelThumbActuallyVisible(el)) return true;
  }
  return false;
}

export function reobserveModelThumbKey(key) {
  for (const el of modelThumbElementsForKey(key)) {
    if (!loadedModelThumbs.has(key) && !missingModelThumbs.has(key) && modelThumbObserver && el.isConnected) {
      modelThumbObserver.observe(el);
    }
  }
}

export function cancelPendingModelThumb(key) {
  pendingModelThumbs.delete(key);
  cancelQueuedModelThumbRequest(key);
  updateModelThumbElements(key, setModelThumbQueuedOrCancelled);
  reobserveModelThumbKey(key);
}

export function shouldPruneQueuedModelThumb(key) {
  return !!key && !loadedModelThumbs.has(key) && !missingModelThumbs.has(key) && !hasVisibleModelThumbElement(key);
}

export function pruneInvisibleQueuedModelThumbs() {
  const keys = new Set();
  for (const req of modelThumbRequestQueue) {
    if (req && shouldPruneQueuedModelThumb(req.key)) keys.add(req.key);
  }
  for (const job of modelThumbQueue) {
    if (job && shouldPruneQueuedModelThumb(job.key)) keys.add(job.key);
  }
  for (const key of keys) {
    for (let i = modelThumbQueue.length - 1; i >= 0; i--) {
      if (modelThumbQueue[i] && modelThumbQueue[i].key === key) modelThumbQueue.splice(i, 1);
    }
    cancelPendingModelThumb(key);
  }
}

export function recordModelThumbEvent(type, key, extra = {}) {
  modelThumbEvents.push(Object.assign({ type, key: key || '', at: Math.round(performance.now()) }, extra || {}));
  if (modelThumbEvents.length > 10000) modelThumbEvents.splice(0, modelThumbEvents.length - 10000);
}

export function scheduleModelThumbQueues(delay) {
  if (modelThumbIdleTimer) clearTimeout(modelThumbIdleTimer);
  modelThumbIdleTimer = setTimeout(() => {
    modelThumbIdleTimer = 0;
    processModelThumbRequestQueue();
    processModelThumbQueue();
  }, Math.max(0, delay || 0));
}

export function noteModelThumbUserActivity() {
  requestVisibleModelThumbs(document);
  pruneInvisibleQueuedModelThumbs();
  scheduleModelThumbQueues(0);
}

function requestModelThumb(el) {
  const key = el.getAttribute('data-key') || '';
  const modelPath = el.getAttribute('data-model') || '';
  if (!isModelThumbActuallyVisible(el)) return;
  if (isAssetBrowserModelKey(key) && !isAssetBrowserOpen()) return;
  if (!key || !modelPath || pendingModelThumbs.has(key) || loadedModelThumbs.has(key) || missingModelThumbs.has(key)) return;
  pendingModelThumbs.add(key);
  el.classList.add('pending');
  modelThumbRequestQueue.push({ key, path: modelPath, seq: modelThumbSeq++ });
  recordModelThumbEvent('queued', key);
  scheduleModelThumbQueues(0);
}

export function sortModelThumbQueueByDom(queue) {
  const order = new Map();
  Array.prototype.slice.call(document.querySelectorAll('.model-thumb[data-key]')).forEach((el, index) => {
    const key = el.getAttribute('data-key') || '';
    if (key && !order.has(key)) order.set(key, index);
  });
  queue.sort((a, b) => {
    const ai = order.has(a.key) ? order.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.key) ? order.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ai - bi || (a.seq || 0) - (b.seq || 0);
  });
}

function processModelThumbRequestQueue() {
  pruneInvisibleQueuedModelThumbs();
  if (modelThumbAwaitingDecisionKey || modelThumbJob || modelThumbQueue.length) return;
  sortModelThumbQueueByDom(modelThumbRequestQueue);
  while (modelThumbHostInflight.size < MODEL_THUMB_HOST_CONCURRENCY && modelThumbRequestQueue.length) {
    const req = modelThumbRequestQueue.shift();
    if (!req || !req.key || loadedModelThumbs.has(req.key) || missingModelThumbs.has(req.key) || !pendingModelThumbs.has(req.key)) continue;
    if (!hasVisibleModelThumbElement(req.key)) {
      cancelPendingModelThumb(req.key);
      continue;
    }
    modelThumbHostInflight.add(req.key);
    updateModelThumbElements(req.key, el => el.classList.add('pending'));
    recordModelThumbEvent('host-start', req.key);
    vscodeApi.postMessage({ type: 'loadModelThumb', key: req.key, path: req.path });
  }
}

export function completeModelThumbHostRequest(key) {
  modelThumbHostInflight.delete(key);
  scheduleModelThumbQueues(0);
}

export function cancelQueuedModelThumbRequest(key) {
  for (let i = modelThumbRequestQueue.length - 1; i >= 0; i--) {
    if (modelThumbRequestQueue[i] && modelThumbRequestQueue[i].key === key) {
      modelThumbRequestQueue.splice(i, 1);
    }
  }
  modelThumbHostInflight.delete(key);
}

export function setModelThumbLoaded(el, uri) {
  el.classList.remove('pending', 'missing');
  el.innerHTML = '<img loading="lazy" src="' + esc(uri) + '" alt="' + esc(el.getAttribute('data-model') || '') + '">';
}

export function setModelThumbQueuedOrCancelled(el) {
  el.classList.remove('pending');
}

function describeModelThumbMissing(reason) {
  if (!reason) return 'Thumbnail unavailable';
  if (reason.reason === 'not-found') return 'Model not found in map or game files';
  if (reason.reason === 'not-model') return 'Resolved asset is not a model';
  if (reason.reason === 'error') return 'Thumbnail failed';
  return 'Thumbnail unavailable: ' + reason.reason;
}

function setModelThumbMissing(el, reason) {
  el.classList.remove('pending');
  el.classList.add('missing');
  el.title = describeModelThumbMissing(reason);
}

export function markModelThumbMissing(key, reason) {
  pendingModelThumbs.delete(key);
  missingModelThumbs.add(key);
  missingModelThumbReasons.set(key, reason || { reason: 'missing' });
  updateModelThumbElements(key, el => setModelThumbMissing(el, missingModelThumbReasons.get(key)));
}

export function updateModelThumbElements(key, updater) {
  for (const el of modelThumbElementsForKey(key)) updater(el);
}

function modelThumbElementsForKey(key) {
  return Array.prototype.slice.call(document.querySelectorAll('.model-thumb[data-key]')).filter(el => (el.getAttribute('data-key') || '') === key);
}

function modelThumbProfile(phase, detail = '') {
  if (!modelThumbJob) return;
  const now = performance.now();
  const previous = modelThumbJob.lastMarkAt || modelThumbJob.startedAt || now;
  modelThumbJob.lastMarkAt = now;
  vscodeApi.postMessage({
    type: 'modelThumbProfile',
    key: modelThumbJob.key,
    phase: phase,
    elapsedMs: Math.round(now - modelThumbJob.startedAt),
    deltaMs: Math.round(now - previous),
    detail: detail || '',
  });
  recordModelThumbEvent('profile:' + phase, modelThumbJob.key, { elapsedMs: Math.round(now - modelThumbJob.startedAt), detail: detail || '' });
}

async function modelThumbJobBytes(job) {
  if (job.modelUri) {
    const response = await fetch(job.modelUri);
    if (!response.ok) throw new Error('fetch ' + response.status);
    return response.arrayBuffer();
  }
  return mpvB64ToArrayBuffer(job.mdxBase64 || '');
}

export function modelThumbEnsureInit() {
  const v = mpvViewer();
  if (!v) return false;
  if (modelThumbInited) return true;
  const canvas = document.getElementById('model-thumb-canvas');
  const viewport = document.getElementById('model-thumb-viewport');
  if (!canvas || !viewport) return false;
  const gizmo = document.createElement('canvas');
  gizmo.width = 1; gizmo.height = 1;
  window.__WAR3_MODEL_DEBUG = true;
  v.init({
    canvas3d: canvas,
    gizmo: gizmo,
    viewport: viewport,
    vscodeApi: {
      postMessage(msg) {
        if (msg && msg.type === 'requestTextures') {
          if (!modelThumbJob) return;
          const paths = modelThumbTexturePaths(msg.paths || []);
          modelThumbJob.requestedTextures = new Set(paths);
          modelThumbJob.pendingTextures = new Set(paths.filter(path => !modelThumbJob.receivedTextures || !modelThumbJob.receivedTextures.has(path)));
          vscodeApi.postMessage(Object.assign({}, msg, { paths, thumbKey: modelThumbJob ? modelThumbJob.key : '' }));
        } else {
          vscodeApi.postMessage(msg);
        }
      },
    },
    callbacks: {
      onModelLoaded(info) { modelThumbOnLoaded((info && info.sequences) || [], (info && info.texturePaths) || []); },
      onFrameUpdate() {},
      onDebug(msg) {
        const text = String(msg || '');
        if (/Uploading compressed texture|^texture(?: \(dds\)| \(rgba\))? ok:|^texture not found:|Missing HD |Rendering SD |SD material layer setup|Missing SD /i.test(text)) return;
        modelThumbProfile('viewer-debug', text);
      },
      onError() { finishModelThumb(false); },
    },
  });
  modelThumbInited = true;
  resetMpvInited();
  return true;
}

export function resetModelThumbInited() {
  modelThumbInited = false;
}

function modelThumbTexturePaths(texturePaths) {
  return (texturePaths || []).filter(path => {
    const lower = String(path || '').replace(/\\/g, '/').toLowerCase();
    const name = lower.split('/').pop() || lower;
    if (/(?:^|[_-])(?:normal|orm)(?:\.|_|-)/.test(name)) return false;
    if (/(?:^|[_-])emissive(?:\.|_|-)/.test(name)) return false;
    if (name === 'environmentmap.blp' || name === 'environmentmap.dds' || name === 'environmentmap.tga') return false;
    if (/(?:^|[_-])corpse(?:[_-]|\.|$)/.test(name) || /(?:[_-])corpse(?:[_-])/.test(name)) return false;
    return true;
  });
}

export function pickStandSequence(seqs) {
  let pick = 0, best = Infinity;
  seqs.forEach((s, i) => {
    const n = (s.name || '').toLowerCase();
    if (n.indexOf('stand') >= 0 && n.length < best) { best = n.length; pick = i; }
  });
  return pick;
}

function modelThumbOnLoaded(seqs, texturePaths) {
  if (!modelThumbJob) return;
  const thumbTextures = modelThumbTexturePaths(texturePaths || []);
  modelThumbProfile('model-loaded', 'textures=' + thumbTextures.length + '/' + ((texturePaths && texturePaths.length) || 0));
  const v = mpvViewer();
  if (v && seqs.length) {
    const pick = pickStandSequence(seqs);
    const seq = seqs[pick];
    try {
      v.setSequence(pick);
      v.setFrame(seq ? Math.round(seq.start + Math.max(0, seq.end - seq.start) * 0.2) : 0);
      v.resetCamera();
      v.zoomOut();
      v.zoomOut();
      v.setAutoplay(false);
    } catch (e) {}
  }
  const requested = modelThumbJob.requestedTextures ? Array.from(modelThumbJob.requestedTextures) : thumbTextures;
  modelThumbJob.pendingTextures = new Set(requested.filter(path => !modelThumbJob.receivedTextures || !modelThumbJob.receivedTextures.has(path)));
  modelThumbJob.textureFailures = modelThumbJob.textureFailures || 0;
  if (modelThumbJob.pendingTextures.size === 0) scheduleModelThumbCapture(0, 1);
  else modelThumbProfile('wait-textures', 'remaining=' + modelThumbJob.pendingTextures.size);
}

function scheduleModelThumbCapture(timeoutMs, frames) {
  if (!modelThumbJob) return;
  if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
    cancelCurrentModelThumb('not-visible-before-capture');
    return;
  }
  modelThumbProfile('schedule-capture', 'delay=' + timeoutMs + 'ms pendingTextures=' + (modelThumbJob.pendingTextures ? modelThumbJob.pendingTextures.size : 0));
  clearTimeout(modelThumbTextureTimer);
  const waitFrames = Math.max(0, frames == null ? 1 : frames);
  const arm = () => {
    let remaining = waitFrames;
    const tick = () => {
      if (!modelThumbJob) return;
      if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
        cancelCurrentModelThumb('not-visible-capture');
        return;
      }
      if (remaining-- > 0) requestAnimationFrame(tick);
      else captureModelThumb();
    };
    requestAnimationFrame(tick);
  };
  if (timeoutMs > 0) modelThumbTextureTimer = setTimeout(arm, timeoutMs);
  else arm();
}

function captureModelThumb() {
  if (!modelThumbJob) return;
  if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
    cancelCurrentModelThumb('not-visible-capture-start');
    return;
  }
  if (modelThumbJob.pendingTextures && modelThumbJob.pendingTextures.size > 0) {
    modelThumbProfile('capture-blocked-textures', 'remaining=' + modelThumbJob.pendingTextures.size);
    return;
  }
  modelThumbProfile('capture-start');
  const canvas = document.getElementById('model-thumb-canvas');
  if (!canvas) { finishModelThumb(false, 'no-canvas'); return; }
  try {
    const v = mpvViewer();
    if (v && typeof v.renderStillFrame === 'function') v.renderStillFrame();
    const out = cropModelThumbCanvas(canvas);
    const quality = modelThumbQuality(out);
    if (quality.alphaPixels < MODEL_THUMB_MIN_VISIBLE_PIXELS) {
      modelThumbJob.blackRetries = (modelThumbJob.blackRetries || 0) + 1;
      modelThumbProfile('capture-empty', 'retry=' + modelThumbJob.blackRetries + ' alpha=' + quality.alphaPixels);
      if (modelThumbJob.blackRetries <= MODEL_THUMB_ZERO_ALPHA_RETRIES) {
        scheduleModelThumbCapture(50, 1);
      } else {
        finishModelThumb(false, 'empty');
      }
      return;
    }
    if (quality.tooDark) {
      // Some valid WC3 models render as very dark silhouettes in the thumbnail light/camera setup.
      // Prefer caching a visible thumbnail over spending a render cycle and ending as a permanent "?".
      modelThumbProfile('capture-dark-accepted', 'alpha=' + quality.alphaPixels + ' avg=' + Math.round(quality.avgLuma) + ' max=' + quality.maxLuma);
    }
    const dataUrl = out.toDataURL('image/webp', 0.58);
    const marker = 'data:image/webp;base64,';
    if (!dataUrl || dataUrl.indexOf(marker) !== 0) { finishModelThumb(false, 'encode-failed'); return; }
    vscodeApi.postMessage({
      type: 'modelThumbRendered',
      key: modelThumbJob.key,
      cacheKey: modelThumbJob.cacheKey,
      aliasKey: modelThumbJob.aliasKey,
      webpBase64: dataUrl.slice(marker.length),
    });
    modelThumbProfile('capture-posted', 'bytes=' + Math.round((dataUrl.length - marker.length) * 0.75));
    finishModelThumb(true, '', dataUrl);
  } catch (e) {
    modelThumbProfile('capture-error', e instanceof Error ? e.message : String(e));
    finishModelThumb(false, 'capture-error');
  }
}

export function modelThumbQuality(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { tooDark: true, alphaPixels: 0, avgLuma: 0, maxLuma: 0 };
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = id.data;
  let alphaPixels = 0;
  let lumaSum = 0;
  let maxLuma = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a <= 12) continue;
    const luma = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    alphaPixels++;
    lumaSum += luma;
    if (luma > maxLuma) maxLuma = luma;
  }
  const avgLuma = alphaPixels ? lumaSum / alphaPixels : 0;
  return {
    tooDark: alphaPixels >= MODEL_THUMB_MIN_VISIBLE_PIXELS && avgLuma < 10 && maxLuma < 34,
    alphaPixels,
    avgLuma,
    maxLuma,
  };
}

export function cropModelThumbCanvas(canvas) {
  const id = readModelThumbFrame(canvas);
  const w = id.width, h = id.height;
  const px = id.data;
  normalizeAdditivePixels(px);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d')!;
  sctx.putImageData(id, 0, 0);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      if (!isModelThumbPixelVisible(px[off], px[off + 1], px[off + 2], px[off + 3])) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return src;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const pad = Math.ceil(Math.max(bw, bh) * 0.16);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = 96; out.height = 96;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  const scale = Math.min(96 / cw, 96 / ch);
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  octx.clearRect(0, 0, 96, 96);
  octx.drawImage(src, minX, minY, cw, ch, Math.round((96 - dw) / 2), Math.round((96 - dh) / 2), dw, dh);
  return out;
}

export function readModelThumbFrame(canvas) {
  const v = mpvViewer();
  if (v && typeof v.readPixelsImageData === 'function') {
    const frame = v.readPixelsImageData();
    if (frame) return frame;
  }
  const src = document.createElement('canvas');
  src.width = canvas.width;
  src.height = canvas.height;
  const sctx = src.getContext('2d')!;
  sctx.drawImage(canvas, 0, 0);
  return sctx.getImageData(0, 0, src.width, src.height);
}

export function isModelThumbPixelVisible(r, g, b, a) {
  return a > 8 || (r + g + b) > 24;
}

export function normalizeAdditivePixels(px) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a > 8) continue;
    const rgbAlpha = Math.max(px[i], px[i + 1], px[i + 2]);
    if (rgbAlpha > 8) px[i + 3] = rgbAlpha;
  }
}

export function finishModelThumb(rendered, reason = '', localUri = '') {
  if (!modelThumbJob) return;
  const key = modelThumbJob.key;
  const cacheKey = modelThumbJob.cacheKey;
  const aliasKey = modelThumbJob.aliasKey;
  clearTimeout(modelThumbTextureTimer);
  if (!rendered) {
    vscodeApi.postMessage({ type: 'modelThumbFailed', key, cacheKey, aliasKey, reason: reason || 'failed' });
    cancelQueuedModelThumbRequest(key);
    markModelThumbMissing(key, { reason: reason || 'failed' });
    recordModelThumbEvent('failed', key, { reason: reason || 'failed' });
  } else if (localUri) {
    pendingModelThumbs.delete(key);
    loadedModelThumbs.set(key, localUri);
    updateModelThumbElements(key, el => setModelThumbLoaded(el, localUri));
    recordModelThumbEvent('loaded', key);
  } else {
    modelThumbAwaitingDecisionKey = key;
  }
  modelThumbJob = null;
  if (!rendered || localUri) scheduleModelThumbQueues(0);
}

function cancelCurrentModelThumb(reason) {
  if (!modelThumbJob) return;
  const key = modelThumbJob.key;
  modelThumbProfile(reason || 'cancelled');
  clearTimeout(modelThumbTextureTimer);
  pendingModelThumbs.delete(key);
  cancelQueuedModelThumbRequest(key);
  if (modelThumbAwaitingDecisionKey === key) modelThumbAwaitingDecisionKey = '';
  updateModelThumbElements(key, setModelThumbQueuedOrCancelled);
  recordModelThumbEvent('cancelled', key, { reason: reason || 'cancelled' });
  reobserveModelThumbKey(key);
  modelThumbJob = null;
  scheduleModelThumbQueues(0);
}

export function cancelAssetBrowserModelThumbs() {
  modelThumbCancelGeneration++;
  modelThumbRequestQueue.splice(0, modelThumbRequestQueue.length, ...modelThumbRequestQueue.filter(req => !isAssetBrowserModelKey(req.key)));
  modelThumbQueue.splice(0, modelThumbQueue.length, ...modelThumbQueue.filter(job => !isAssetBrowserModelKey(job.key)));
  for (const key of Array.from(pendingModelThumbs)) {
    if (isAssetBrowserModelKey(key)) {
      cancelPendingModelThumb(key);
    }
  }
  if (modelThumbJob && isAssetBrowserModelKey(modelThumbJob.key)) {
    cancelCurrentModelThumb('cancelled');
  }
  scheduleModelThumbQueues(0);
}

function processModelThumbQueue() {
  pruneInvisibleQueuedModelThumbs();
  if (modelThumbJob || !modelThumbQueue.length) return;
  if (modelThumbAwaitingDecisionKey) return;
  const box = document.getElementById('mpv-box');
  if (box && !box.hidden) return;
  sortModelThumbQueueByDom(modelThumbQueue);
  const job = modelThumbQueue.shift();
  if (job && !hasVisibleModelThumbElement(job.key)) {
    cancelPendingModelThumb(job.key);
    scheduleModelThumbQueues(0);
    return;
  }
  if (!job || loadedModelThumbs.has(job.key) || missingModelThumbs.has(job.key)) {
    scheduleModelThumbQueues(0);
    return;
  }
  if (!modelThumbEnsureInit()) {
    cancelQueuedModelThumbRequest(job.key);
    markModelThumbMissing(job.key, { reason: 'viewer-init-failed' });
    scheduleModelThumbQueues(0);
    return;
  }
  modelThumbJob = job;
  updateModelThumbElements(job.key, el => el.classList.add('pending'));
  recordModelThumbEvent('render-start', job.key);
  modelThumbJob.startedAt = performance.now();
  modelThumbJob.lastMarkAt = modelThumbJob.startedAt;
  modelThumbJob.generation = modelThumbCancelGeneration;
  modelThumbJob.receivedTextures = new Set();
  modelThumbJob.requestedTextures = null;
  modelThumbJob.textureFailures = 0;
  modelThumbProfile('fetch-start', job.modelUri ? 'uri' : 'base64');
  modelThumbJobBytes(job).then(buffer => {
    if (!modelThumbJob || modelThumbJob !== job) return;
    modelThumbProfile('load-start', String(job.fileName || ''));
    try {
      mpvViewer().loadModel(buffer, job.fileName || '', job.format || 'mdx', { autoplay: false });
    } catch (e) {
      finishModelThumb(false);
    }
  }).catch(e => {
    if (!modelThumbJob || modelThumbJob !== job) return;
    modelThumbProfile('fetch-error', String(e && e.message ? e.message : e));
    finishModelThumb(false);
  });
}

export function applyMdxTexture(msg) {
  const v = mpvViewer();
  if (!v) return;
  if (msg.ddsBase64) {
    v.onTextureDds(msg.path, mpvB64ToArrayBuffer(msg.ddsBase64));
  } else if (msg.rgbaBase64 && msg.width && msg.height) {
    const rgba = base64ToBytes(msg.rgbaBase64);
    v.onTextureImageData(msg.path, new ImageData(new Uint8ClampedArray(Array.from(rgba)), msg.width, msg.height));
  } else {
    v.onTexture(msg.path, msg.blpBase64 ? mpvB64ToArrayBuffer(msg.blpBase64) : null);
  }
}

// Handles the 'mdxTexture' host message. Kept here (rather than inlined in the message listener)
// because it reads/writes modelThumbJob internals directly — those aren't exposed outside this module.
export function handleMdxTextureMessage(msg) {
  if (modelThumbJob) {
    if (msg.thumbKey && msg.thumbKey !== modelThumbJob.key) return;
    if (!modelThumbJob.receivedTextures) modelThumbJob.receivedTextures = new Set();
    modelThumbJob.receivedTextures.add(msg.path);
    if (!msg.thumbKey && modelThumbJob.pendingTextures && modelThumbJob.pendingTextures.has(msg.path)) return;
    if (modelThumbJob.pendingTextures && !modelThumbJob.pendingTextures.has(msg.path)) return;
    if (msg.missing || msg.unsupported || msg.error) {
      modelThumbJob.textureFailures = (modelThumbJob.textureFailures || 0) + 1;
    } else {
      applyMdxTexture(msg);
    }
    if (modelThumbJob.pendingTextures) modelThumbJob.pendingTextures.delete(msg.path);
    modelThumbProfile('texture-received', 'remaining=' + (modelThumbJob.pendingTextures ? modelThumbJob.pendingTextures.size : 0) + ' failures=' + (modelThumbJob.textureFailures || 0) + ' path=' + (msg.path || ''));
    if (!modelThumbJob.pendingTextures || modelThumbJob.pendingTextures.size === 0) scheduleModelThumbCapture(0, 1);
    return;
  }
  if (msg.thumbKey) return;
  applyMdxTexture(msg);
}
