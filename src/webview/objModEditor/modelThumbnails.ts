import { esc, base64ToBytes } from '../objModWebviewUtils';
import { vscodeApi, assetBrowserUi, initial } from './state';
import { mpvViewer, mpvB64ToArrayBuffer } from './modelViewerShared';

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
let modelThumbWorker: Worker | null = null;
let modelThumbWorkerBlobUrl = '';
let modelThumbWorkerStartupState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let modelThumbWorkerStartupError = '';
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
    } else if (pendingModelThumbs.has(key)) {
      el.classList.add('pending');
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
  return assetBrowserUi.open;
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
    if (!isAssetBrowserOpen() || assetBrowserUi.activeTab !== 'model') return false;
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
  if (job.modelBuffer) return job.modelBuffer;
  if (job.modelUri) {
    const response = await fetch(job.modelUri);
    if (!response.ok) throw new Error('fetch ' + response.status);
    return response.arrayBuffer();
  }
  return mpvB64ToArrayBuffer(job.mdxBase64 || '');
}

function attachModelThumbWorker(worker: Worker) {
  modelThumbWorker = worker;
  worker.onmessage = event => {
        const msg = event.data || {};
        if (msg.type === 'requestTextures') {
          if (!modelThumbJob || msg.key !== modelThumbJob.key) return;
          const paths = modelThumbTexturePaths(msg.paths || []);
          modelThumbJob.requestedTextures = new Set(paths);
          modelThumbJob.pendingTextures = new Set(paths);
          vscodeApi.postMessage({ type: 'requestTextures', paths, thumbKey: modelThumbJob.key });
        } else if (msg.type === 'profile') {
          if (!modelThumbJob || msg.key !== modelThumbJob.key) return;
          const metrics = Object.assign({}, msg);
          delete metrics.type;
          delete metrics.key;
          delete metrics.phase;
          modelThumbProfile('worker-' + msg.phase, JSON.stringify(metrics));
        } else if (msg.type === 'rendered') {
          if (!modelThumbJob || msg.key !== modelThumbJob.key) return;
          const dataUrl = 'data:image/webp;base64,' + msg.webpBase64;
          vscodeApi.postMessage({
            type: 'modelThumbRendered',
            key: modelThumbJob.key,
            cacheKey: modelThumbJob.cacheKey,
            aliasKey: modelThumbJob.aliasKey,
            webpBase64: msg.webpBase64,
            avgLuma: msg.avgLuma,
            textureFailures: msg.textureFailures,
          });
          finishModelThumb(true, '', dataUrl);
        } else if (msg.type === 'failed') {
          if (!modelThumbJob || msg.key !== modelThumbJob.key) return;
          modelThumbProfile('worker-failed', JSON.stringify({ reason: msg.reason || 'failed' }));
          finishModelThumb(false, msg.reason || 'worker-failed');
        }
      };
  worker.onerror = event => {
        modelThumbProfile('worker-error', event.message || 'worker error');
        worker.terminate();
        if (modelThumbWorker === worker) modelThumbWorker = null;
        modelThumbWorker = null;
        modelThumbInited = false;
        modelThumbWorkerStartupState = 'failed';
        modelThumbWorkerStartupError = event.message || 'worker error';
        if (modelThumbJob) finishModelThumb(false, 'worker-error');
      };
}

function startModelThumbWorker() {
  if (modelThumbWorkerStartupState !== 'idle') return;
  modelThumbWorkerStartupState = 'loading';
  // VS Code webviews cannot construct a worker directly from a vscode-resource URL. Fetch the
  // single-file webpack bundle and launch the resulting Blob URL, as required by the webview API.
  void fetch(initial.thumbnailWorkerUri!)
    .then(response => {
      if (!response.ok) throw new Error('worker bundle fetch ' + response.status);
      return response.text();
    })
    .then(source => {
      modelThumbWorkerBlobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(modelThumbWorkerBlobUrl, { name: 'wurst-model-thumbnails' });
      attachModelThumbWorker(worker);
      modelThumbWorkerStartupState = 'ready';
      modelThumbInited = true;
      recordModelThumbEvent('worker-ready', '');
    })
    .catch(error => {
      modelThumbWorkerStartupState = 'failed';
      modelThumbWorkerStartupError = error instanceof Error ? error.message : String(error);
      console.error('[wurst-model-thumb] worker startup failed', error);
      recordModelThumbEvent('worker-startup-failed', '', { reason: modelThumbWorkerStartupError });
    })
    .finally(() => scheduleModelThumbQueues(0));
}

export function modelThumbEnsureInit() {
  if (modelThumbInited) return true;
  if (!initial.thumbnailWorkerUri || typeof Worker !== 'function') {
    modelThumbWorkerStartupState = 'failed';
    modelThumbWorkerStartupError = !initial.thumbnailWorkerUri
      ? 'thumbnail worker bundle unavailable'
      : 'Web Workers unavailable';
    return false;
  }
  startModelThumbWorker();
  return false;
}

export function resetModelThumbInited() {
  modelThumbWorker?.terminate();
  modelThumbWorker = null;
  if (modelThumbWorkerBlobUrl) URL.revokeObjectURL(modelThumbWorkerBlobUrl);
  modelThumbWorkerBlobUrl = '';
  modelThumbWorkerStartupState = 'idle';
  modelThumbWorkerStartupError = '';
  modelThumbInited = false;
}

export function getModelThumbWorkerState() {
  return { state: modelThumbWorkerStartupState, error: modelThumbWorkerStartupError };
}

function modelThumbTexturePaths(texturePaths) {
  return Array.from(new Set((texturePaths || []).filter(path => typeof path === 'string' && path)));
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
      modelThumbProfile('capture-dark-rejected', 'alpha=' + quality.alphaPixels + ' avg=' + Math.round(quality.avgLuma) + ' max=' + quality.maxLuma);
      if (!modelThumbJob.fullQualityRetry) {
        retryModelThumbAtFullTextureQuality();
      } else {
        // Never persist a texture-load failure as a valid thumbnail. The next editor session can
        // retry generation, while caching this frame would keep it black across restarts.
        finishModelThumb(false, 'dark-frame');
      }
      return;
    }
    const dataUrl = out.toDataURL('image/webp', 0.84);
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

function retryModelThumbAtFullTextureQuality() {
  const job = modelThumbJob;
  if (!job || !job.modelBuffer) {
    finishModelThumb(false, 'dark-frame');
    return;
  }
  job.fullQualityRetry = true;
  job.receivedTextures = new Set();
  job.requestedTextures = null;
  job.pendingTextures = null;
  job.textureFailures = 0;
  const v = mpvViewer();
  if (!v) {
    finishModelThumb(false, 'viewer-missing');
    return;
  }
  if (typeof v.clearTextureCache === 'function') v.clearTextureCache('thumbnail');
  modelThumbProfile('reload-full-textures');
  try {
    v.loadModel(job.modelBuffer, job.fileName || '', job.format || 'mdx', {
      autoplay: false,
      freezeAnimation: true,
      textureCacheKey: 'thumbnail',
    });
  } catch (e) {
    finishModelThumb(false, 'full-quality-reload');
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
  modelThumbWorker?.postMessage({ type: 'cancel', key });
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
    if (modelThumbWorkerStartupState === 'loading') {
      modelThumbQueue.unshift(job);
      return;
    }
    const reason = modelThumbWorkerStartupError
      ? 'worker-startup: ' + modelThumbWorkerStartupError
      : 'viewer-init-failed';
    vscodeApi.postMessage({ type: 'modelThumbFailed', key: job.key, cacheKey: job.cacheKey, aliasKey: job.aliasKey, reason });
    cancelQueuedModelThumbRequest(job.key);
    markModelThumbMissing(job.key, { reason });
    recordModelThumbEvent('failed', job.key, { reason });
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
    job.modelBuffer = buffer;
    modelThumbProfile('load-start', String(job.fileName || ''));
    if (modelThumbWorker) {
      modelThumbWorker.postMessage({
        type: 'render',
        job: {
          key: job.key,
          cacheKey: job.cacheKey,
          aliasKey: job.aliasKey,
          fileName: job.fileName || '',
          format: job.format || 'mdx',
          buffer,
        },
      }, [buffer]);
      return;
    }
    try {
      mpvViewer().loadModel(buffer, job.fileName || '', job.format || 'mdx', {
        autoplay: false,
        freezeAnimation: true,
        textureCacheKey: 'thumbnail',
        maxTextureDimension: 256,
      });
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
  if (modelThumbWorker && msg.thumbKey) {
    if (!modelThumbJob || msg.thumbKey !== modelThumbJob.key) return;
    if (msg.textureBytes) {
      const source = msg.textureBytes instanceof Uint8Array
        ? msg.textureBytes
        : new Uint8Array(msg.textureBytes);
      const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      modelThumbWorker.postMessage(Object.assign({}, msg, { type: 'texture', textureBytes: buffer }), [buffer]);
    } else {
      modelThumbWorker.postMessage(Object.assign({}, msg, { type: 'texture' }));
    }
    return;
  }
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

export function handleModelThumbTexturesComplete(msg) {
  if (!modelThumbJob || !msg.thumbKey || msg.thumbKey !== modelThumbJob.key) return;
  if (modelThumbWorker) {
    modelThumbWorker.postMessage(Object.assign({}, msg, { type: 'texturesComplete' }));
    return;
  }
  const remaining = modelThumbJob.pendingTextures ? modelThumbJob.pendingTextures.size : 0;
  if (remaining > 0) {
    modelThumbJob.textureFailures = (modelThumbJob.textureFailures || 0) + remaining;
    modelThumbJob.pendingTextures.clear();
  }
  modelThumbProfile('textures-complete', 'unresolved=' + remaining + ' failures=' + (modelThumbJob.textureFailures || 0));
  scheduleModelThumbCapture(0, 1);
}
