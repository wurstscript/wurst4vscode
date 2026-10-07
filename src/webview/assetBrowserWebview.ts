import { assetSearchScore, fuzzyMatch } from '../features/preview/fuzzy';
import { createModelThumbnailWorker, postThumbnailTexture } from './modelThumbnailWorkerClient';
import { assetDisplayName, assetCardActions } from './assetBrowserCards';
import { esc, base64ToBytes } from './webviewUtils';
declare function acquireVsCodeApi(): any;
const uiDocument: any = document;
(function () {
  var vscode = acquireVsCodeApi();
  var initial: any = (window as any).__WURST_ASSET_BROWSER_INITIAL__;
  var saved = vscode.getState?.() || {};
  var activeTab = initial.tabs[saved.activeTab] ? saved.activeTab : initial.activeTab || 'icon';
  var query = typeof saved.query === 'string' ? saved.query : '';
  function persist() {
    vscode.setState?.({ ...saved, activeTab: activeTab, query: query, browserContext: initial.browserContext,
      scrollTop: uiDocument.getElementById('grid').scrollTop });
  }
  var iconCache = new Map();
  var iconPending = new Set();
  var missingIcons = new Set();
  var observer = null;
  var modelObserver = null;
  var modelQueue = [];
  var modelPending = new Set();
  var modelLoaded = new Map();
  var modelMissing = new Map();
  var modelBusy = false;
  var modelJob = null;
  var modelWorker: Worker | null = null;
  var workerPromise: Promise<Worker> | null = null;
  function list() {
    var items = (initial.tabs[activeTab] || []);
    if (!query) return items.slice(0, 500);
    return items.map(function (item, index) {
      return { item: item, index: index, score: assetSearchScore(query, item.label, item.value, item.detail, fuzzyMatch) };
    }).filter(function (entry) {
      return Number.isFinite(entry.score);
    }).sort(function (a, b) {
      return a.score - b.score || a.index - b.index;
    }).slice(0, 500).map(function (entry) {
      return entry.item;
    });
  }
  function render() {
    uiDocument.querySelectorAll('.tab').forEach(function (btn) { btn.classList.toggle('active', btn.getAttribute('data-tab') === activeTab); });
    var grid = uiDocument.getElementById('grid');
    var items = list();
    if (!items.length) { grid.innerHTML = '<div class="empty">No matching assets</div>'; return; }
    grid.innerHTML = items.map(function (item, index) {
      var icon = activeTab === 'sound'
        ? '<span class="sound-thumb">AUD</span>'
        : activeTab === 'icon' && item.iconPath
        ? '<span class="object-icon" data-key="asset:' + index + ':' + esc(item.iconPath) + '" data-icon="' + esc(item.iconPath) + '"></span>'
        : '<span class="model-thumb" data-key="asset-model:' + index + ':' + esc(item.value) + '" data-model="' + esc(item.value) + '"></span>';
      var name = assetDisplayName(item.label, item.value);
      return '<div class="card" data-value="' + esc(item.value) + '" title="' + esc(item.value) + '">' +
        '<button class="asset-preview" type="button" data-action="open" aria-label="' + esc('Open ' + name) + '">' + icon + '</button>' +
        '<span class="card-name">' + esc(name) + '</span>' + assetCardActions(!initial.browseOnly) + '</div>';
    }).join('');
    observeIcons(grid);
    if (activeTab === 'model') observeModels(grid);
  }
  function observeIcons(root) {
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          requestIcon(entry.target);
        });
      }, { root: null, rootMargin: '120px' });
    }
    root.querySelectorAll('.object-icon[data-icon]').forEach(function (el) {
      var key = el.getAttribute('data-key') || '';
      if (iconCache.has(key)) setIcon(el, iconCache.get(key));
      else if (missingIcons.has(key)) el.classList.add('missing');
      else observer.observe(el);
    });
  }
  function requestIcon(el) {
    var key = el.getAttribute('data-key') || '';
    var iconPath = el.getAttribute('data-icon') || '';
    if (!key || !iconPath || iconPending.has(key) || iconCache.has(key) || missingIcons.has(key)) return;
    iconPending.add(key);
    vscode.postMessage({ type: 'loadObjectIcon', key: key, iconPath: iconPath });
  }
  function observeModels(root) {
    if (!modelObserver) {
      modelObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          modelObserver.unobserve(entry.target);
          requestModel(entry.target);
        });
      }, { root: null, rootMargin: '160px' });
    }
    root.querySelectorAll('.model-thumb[data-model]').forEach(function (el) {
      var key = el.getAttribute('data-key') || '';
      if (modelLoaded.has(key)) setModelLoaded(el, modelLoaded.get(key));
      else if (modelMissing.has(key)) setModelMissing(el, modelMissing.get(key));
      else if (modelPending.has(key)) el.classList.add('pending');
      else modelObserver.observe(el);
    });
  }
  function requestModel(el) {
    var key = el.getAttribute('data-key') || '';
    var path = el.getAttribute('data-model') || '';
    if (!key || !path || modelPending.has(key) || modelLoaded.has(key) || modelMissing.has(key)) return;
    modelPending.add(key);
    el.classList.add('pending');
    modelQueue.push({ key: key, path: path });
    pumpModelQueue();
  }
  function pumpModelQueue() {
    if (modelBusy || !modelQueue.length) return;
    var next = modelQueue.shift();
    modelBusy = true;
    vscode.postMessage({ type: 'loadModelThumb', key: next.key, path: next.path });
  }
  function setModelLoaded(el, uri) {
    el.classList.remove('pending', 'missing');
    el.classList.add('loaded');
    el.innerHTML = '<img src="' + esc(uri) + '" alt="">';
  }
  function setModelMissing(el, reason) {
    el.classList.remove('pending', 'loaded');
    el.classList.add('missing');
    el.title = reason && reason.reason ? String(reason.reason) : 'Thumbnail unavailable';
  }
  function eachModel(key, fn) {
    uiDocument.querySelectorAll('.model-thumb[data-key]').forEach(function (el) {
      if ((el.getAttribute('data-key') || '') === key) fn(el);
    });
  }
  function completeModelRequest(key) {
    if (!modelPending.has(key)) return;
    modelPending.delete(key);
    modelBusy = false;
    pumpModelQueue();
  }
  function base64ToArrayBuffer(b64) {
    return base64ToBytes(b64 || '').buffer;
  }
  // The host sends either a webview resource URI (fetched here) or, for test doubles, base64 bytes.
  function loadModelBytes(job) {
    if (job.modelUri) {
      return fetch(job.modelUri).then(function (response) {
        if (!response.ok) throw new Error('fetch ' + response.status);
        return response.arrayBuffer();
      });
    }
    return Promise.resolve(base64ToArrayBuffer(job.mdxBase64 || ''));
  }
  function ensureModelWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = createModelThumbnailWorker(initial.thumbnailWorkerUri).then(function (worker) {
      modelWorker = worker;
      worker.onmessage = function (event) {
        var msg = event.data || {};
        if (!modelJob || msg.key !== modelJob.key) return;
        if (msg.type === 'requestTextures') {
          vscode.postMessage({ type: 'requestTextures', paths: msg.paths, thumbKey: msg.key });
        } else if (msg.type === 'rendered') {
          var dataUrl = 'data:image/webp;base64,' + msg.webpBase64;
          modelLoaded.set(msg.key, dataUrl);
          eachModel(msg.key, function (el) { setModelLoaded(el, dataUrl); });
          vscode.postMessage({ type: 'modelThumbRendered', key: msg.key, cacheKey: modelJob.cacheKey,
            aliasKey: modelJob.aliasKey, webpBase64: msg.webpBase64 });
          modelJob = null;
          // Wait for the host cache acknowledgement before starting the next thumbnail.
        } else if (msg.type === 'failed') {
          markModelFailed(msg.key, msg.reason || 'worker-failed');
        }
      };
      worker.onerror = function () {
        worker.terminate();
        modelWorker = null;
        workerPromise = null;
        if (modelJob) markModelFailed(modelJob.key, 'worker-error');
      };
      return worker;
    }).catch(function (error) {
      workerPromise = null;
      throw error;
    });
    return workerPromise;
  }
  function renderModelThumb(job) {
    modelJob = job;
    Promise.all([ensureModelWorker(), loadModelBytes(job)]).then(function (values) {
      if (modelJob !== job) return;
      var worker = values[0] as Worker;
      var buffer = values[1] as ArrayBuffer;
      worker.postMessage({ type: 'render', job: { key: job.key, cacheKey: job.cacheKey,
        aliasKey: job.aliasKey, textureNamespace: job.textureNamespace, format: job.format || 'mdx', buffer: buffer } }, [buffer]);
    }).catch(function (error) {
      if (modelJob === job) markModelFailed(job.key, error.message || 'load-error');
    });
  }
  function markModelFailed(key, reason) {
    modelMissing.set(key, { reason: reason || 'failed' });
    eachModel(key, function (el) { setModelMissing(el, modelMissing.get(key)); });
    vscode.postMessage({ type: 'modelThumbFailed', key: key, cacheKey: modelJob && modelJob.cacheKey, aliasKey: modelJob && modelJob.aliasKey, reason: reason || 'failed' });
    modelWorker?.postMessage({ type: 'cancel', key: key });
    modelJob = null;
    completeModelRequest(key);
  }
  function renderDataUrl(data) {
    try {
      var canvas = uiDocument.createElement('canvas'); canvas.width = data.width; canvas.height = data.height;
      var ctx = canvas.getContext('2d');
      if (data.mode !== 'rgba') return Promise.resolve('');
      var rgba = base64ToBytes(data.rgbaBase64);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), data.width, data.height), 0, 0);
      return Promise.resolve(canvas.toDataURL('image/png'));
    } catch (e) { return Promise.resolve(''); }
  }
  function setIcon(el, uri) { el.innerHTML = '<img src="' + esc(uri) + '" alt="">'; }
  function eachIcon(key, fn) { uiDocument.querySelectorAll('.object-icon[data-key]').forEach(function (el) { if ((el.getAttribute('data-key') || '') === key) fn(el); }); }
  uiDocument.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () { activeTab = btn.getAttribute('data-tab') || 'icon'; render(); persist(); });
  });
  uiDocument.getElementById('search').addEventListener('input', function (event) { query = event.target.value || ''; render(); persist(); });
  uiDocument.getElementById('grid').addEventListener('click', function (event) {
    var card = event.target.closest('.card[data-value]');
    if (!card) return;
    var action = event.target.closest('[data-action]')?.getAttribute('data-action') || 'open';
    vscode.postMessage({ type: action === 'copy' ? 'copyAssetPath' : action === 'use' ? 'selectAsset' : 'openAsset',
      value: card.getAttribute('data-value') || '' });
  });
  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'objectIconLoaded') {
      iconPending.delete(msg.key);
      renderDataUrl(msg).then(function (uri) {
        if (!uri) { missingIcons.add(msg.key); eachIcon(msg.key, function (el) { el.classList.add('missing'); }); return; }
        iconCache.set(msg.key, uri);
        eachIcon(msg.key, function (el) { setIcon(el, uri); });
      });
    } else if (msg.type === 'objectIconMissing') {
      iconPending.delete(msg.key);
      missingIcons.add(msg.key);
      eachIcon(msg.key, function (el) { el.classList.add('missing'); });
    } else if (msg.type === 'modelThumbLoaded') {
      modelLoaded.set(msg.key, msg.uri);
      eachModel(msg.key, function (el) { setModelLoaded(el, msg.uri); });
      if (modelPending.has(msg.key)) completeModelRequest(msg.key);
    } else if (msg.type === 'modelThumbMissing') {
      modelMissing.set(msg.key, { reason: msg.reason || 'missing', bytes: msg.bytes, maxBytes: msg.maxBytes });
      eachModel(msg.key, function (el) { setModelMissing(el, modelMissing.get(msg.key)); });
      if (modelPending.has(msg.key)) completeModelRequest(msg.key);
    } else if (msg.type === 'modelThumbRender') {
      renderModelThumb(msg);
    } else if (msg.type === 'modelThumbTexturesComplete') {
      if (!modelJob || msg.thumbKey !== modelJob.key) return;
      modelWorker?.postMessage(Object.assign({}, msg, { type: 'texturesComplete' }));
    } else if (msg.type === 'mdxTexture') {
      if (!modelJob || msg.thumbKey !== modelJob.key || !modelWorker) return;
      postThumbnailTexture(modelWorker, msg);
    }
  });
  (window as any).__wurstCodeAssetBrowserDebug = {
    search: function (value) {
      query = String(value || '');
      uiDocument.getElementById('search').value = query;
      render();
    },
    state: function () {
      return {
        activeTab: activeTab,
        query: query,
        results: list().slice(0, 50).map(function (item) {
          return {
            label: item.label,
            value: item.value,
            score: assetSearchScore(query, item.label, item.value, item.detail, fuzzyMatch)
          };
        })
      };
    }
  };
  render();
  uiDocument.getElementById('search').value = query;
  uiDocument.getElementById('grid').scrollTop = Number(saved.scrollTop) || 0;
  uiDocument.getElementById('grid').addEventListener('scroll', persist, { passive: true });
  persist();
  uiDocument.getElementById('search').focus();
})();
