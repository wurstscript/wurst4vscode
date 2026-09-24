import { esc, base64ToBytes } from '../webviewUtils';
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
let modelThumbIdleTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelThumbCancelGeneration = 0;
export const modelThumbEvents: any[] = [];
const MODEL_THUMB_HOST_CONCURRENCY = 1;

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

export function getModelThumbWorkerState() {
  return { state: modelThumbWorkerStartupState, error: modelThumbWorkerStartupError };
}

function modelThumbTexturePaths(texturePaths) {
  return Array.from(new Set((texturePaths || []).filter(path => typeof path === 'string' && path)));
}

export function finishModelThumb(rendered, reason = '', localUri = '') {
  if (!modelThumbJob) return;
  const key = modelThumbJob.key;
  const cacheKey = modelThumbJob.cacheKey;
  const aliasKey = modelThumbJob.aliasKey;
  if (!rendered) {
    modelThumbWorker?.postMessage({ type: 'cancel', key });
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
    finishModelThumb(false, 'worker-missing');
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
    v.onTextureImageData(msg.path, new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), msg.width, msg.height));
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
  if (msg.thumbKey) return;
  applyMdxTexture(msg);
}

export function handleModelThumbTexturesComplete(msg) {
  if (!modelThumbJob || !msg.thumbKey || msg.thumbKey !== modelThumbJob.key) return;
  modelThumbWorker?.postMessage(Object.assign({}, msg, { type: 'texturesComplete' }));
}
