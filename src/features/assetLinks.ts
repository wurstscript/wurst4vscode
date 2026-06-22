'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { gatherImportedAssets, getCandidateRoots, requestPreviewIcon, resolveAssetPath as resolveAssetPathString, resolveAssetPathWithCasc } from './imageAssetSupport';
import { loadObjValueCatalog, type ValueOption } from './objModPreview';
import { cacheModelThumbnail, markModelThumbnailBad, postTexturesToWebview, requestModelThumbnail } from './preview/modelPreviewHost';
import { isSoundAssetPath, playSoundInline } from './soundPreview';
import { buildPage, ICON_INLINE_CSS, PREVIEW_ICON_CSP } from './webviewShared';
import { escapeHtml } from './webviewUtils';

// Asset file extensions we want to linkify inside string literals
const ASSET_EXTS = new Set([
    'blp', 'dds', 'tga', 'png', 'jpg', 'jpeg',
    'mdx', 'mdl',
    'mp3', 'wav', 'ogg', 'flac',
    'slk', 'txt', 'fdf', 'toc',
    'w3i', 'w3u', 'w3t', 'w3a', 'w3b', 'w3d', 'w3h', 'w3q', 'w3o', 'w3e',
    'w3r', 'w3c', 'w3s', 'w3l', 'imp', 'wtg', 'wct', 'wts',
    'wpm', 'shd', 'mmp', 'doo',
]);

// Matches string literals: "some\\path\\file.ext"
const STRING_LITERAL_RE = /"([^"\r\n]+\.([a-zA-Z0-9]+))"/g;

// Matches bare FDF paths in .toc files (each non-empty, non-comment line)
const TOC_LINE_RE = /^[ \t]*([^\s/][^\r\n]*\.fdf)[ \t]*$/gim;

// Matches IncludeFile paths in .fdf files: IncludeFile "path\to\file.fdf",
const FDF_INCLUDE_RE = /\bIncludeFile\s+"([^"\r\n]+\.fdf)"/g;

function isAssetExt(ext: string): boolean {
    return ASSET_EXTS.has(ext.toLowerCase());
}

function isModelExt(ext: string): boolean {
    const lower = ext.toLowerCase();
    return lower === 'mdx' || lower === 'mdl';
}

function isSoundExt(ext: string): boolean {
    const lower = ext.toLowerCase();
    return lower === 'mp3' || lower === 'wav' || lower === 'ogg' || lower === 'flac';
}

type BrowseAssetKind = 'icon' | 'model' | 'sound';

interface BrowseAssetTarget {
    uri: vscode.Uri;
    range: vscode.Range;
    kind: BrowseAssetKind;
    currentValue: string;
}

async function candidateRoots(document: vscode.TextDocument): Promise<string[]> {
    return getCandidateRoots(document.uri.fsPath);
}

async function candidateRootsForFsPath(fsPath?: string): Promise<string[]> {
    return getCandidateRoots(fsPath || path.join(process.cwd(), 'dummy'));
}

async function resolveAssetPath(assetPath: string, roots: string[]): Promise<vscode.Uri | undefined> {
    const resolved = await resolveAssetPathString(assetPath, roots);
    return resolved ? vscode.Uri.file(resolved) : undefined;
}

function addLink(
    links: vscode.DocumentLink[],
    document: vscode.TextDocument,
    _text: string,
    startOffset: number,
    length: number,
    target: vscode.Uri,
): void {
    const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(startOffset + length),
    );
    const link = new vscode.DocumentLink(range, target);
    link.tooltip = target.fsPath;
    links.push(link);
}

function addLazyCascLink(
    links: vscode.DocumentLink[],
    document: vscode.TextDocument,
    startOffset: number,
    length: number,
    assetPath: string,
): void {
    const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(startOffset + length),
    );
    const args = encodeURIComponent(JSON.stringify([assetPath]));
    const target = vscode.Uri.parse(`command:wurst.openAssetFromString?${args}`);
    const link = new vscode.DocumentLink(range, target);
    link.tooltip = `Open ${assetPath}`;
    links.push(link);
}

function findAssetStringAt(document: vscode.TextDocument, range: vscode.Range): BrowseAssetTarget | undefined {
    const offset = document.offsetAt(range.start);
    return findAssetStrings(document).find((target) => {
        const start = document.offsetAt(target.range.start) - 1;
        const end = document.offsetAt(target.range.end) + 1;
        return offset >= start && offset <= end;
    });
}

function findAssetStrings(document: vscode.TextDocument): BrowseAssetTarget[] {
    const text = document.getText();
    const targets: BrowseAssetTarget[] = [];
    STRING_LITERAL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STRING_LITERAL_RE.exec(text)) !== null) {
        const assetPath = match[1];
        const ext = match[2].toLowerCase();
        const innerStart = match.index + 1;
        const innerEnd = innerStart + assetPath.length;
        if (!isAssetExt(ext)) continue;
        const kind: BrowseAssetKind = isModelExt(ext) ? 'model' : isSoundExt(ext) ? 'sound' : 'icon';
        targets.push({
            uri: document.uri,
            range: new vscode.Range(document.positionAt(innerStart), document.positionAt(innerEnd)),
            kind,
            currentValue: assetPath,
        });
    }
    return targets;
}

function escapeWurstStringAssetPath(assetPath: string): string {
    return assetPath
        .replace(/\//g, '\\')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

function assetBrowserItems(options: readonly ValueOption[]): Array<{ value: string; label: string; detail: string; iconPath?: string }> {
    return options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        detail: option.detail || option.value,
        iconPath: option.iconPath,
    }));
}

async function replaceAssetString(target: BrowseAssetTarget, assetPath: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, target.range, escapeWurstStringAssetPath(assetPath));
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        void vscode.window.showWarningMessage(`Could not replace asset path: ${assetPath}`);
        return;
    }
    const doc = await vscode.workspace.openTextDocument(target.uri);
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
}

async function openCodeAssetBrowser(context: vscode.ExtensionContext, target: BrowseAssetTarget): Promise<void> {
    const [catalog, imported] = await Promise.all([
        loadObjValueCatalog(),
        gatherImportedAssets(target.uri.fsPath),
    ]);
    const panel = vscode.window.createWebviewPanel(
        'wurst.assetBrowser',
        'Choose Warcraft III Asset',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri, vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
        },
    );
    const mdxViewerUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'mdxViewer.js')).toString();
    const initial = {
        activeTab: target.kind,
        currentValue: target.currentValue,
        tabs: {
            icon: assetBrowserItems(dedupeAssetOptions([...imported.icon, ...catalog.icons])),
            model: assetBrowserItems(dedupeAssetOptions([...imported.model, ...catalog.models])),
            sound: assetBrowserItems(dedupeAssetOptions([...imported.sound, ...catalog.sounds])),
        },
    };
    const initialJson = JSON.stringify(initial)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
    panel.webview.html = buildAssetBrowserHtml(initialJson, target.currentValue, panel.webview.cspSource, mdxViewerUri);
    panel.webview.onDidReceiveMessage((message) => {
        const msg = message || {};
        if (msg.type === 'selectAsset' && typeof msg.value === 'string') {
            void replaceAssetString(target, msg.value).then(() => panel.dispose());
        } else if (msg.type === 'loadObjectIcon' && typeof msg.iconPath === 'string' && typeof msg.key === 'string') {
            void requestPreviewIcon(msg.iconPath, msg.key, panel.webview, target.uri);
        } else if (msg.type === 'loadModelThumb' && typeof msg.path === 'string' && typeof msg.key === 'string') {
            void requestModelThumbnail(msg.path, msg.key, target.uri, panel.webview);
        } else if (msg.type === 'requestTextures' && Array.isArray(msg.paths)) {
            void postTexturesToWebview(
                msg.paths.filter((candidate: unknown): candidate is string => typeof candidate === 'string'),
                target.uri,
                panel.webview,
                typeof msg.thumbKey === 'string' ? msg.thumbKey : undefined,
            );
        } else if (msg.type === 'modelThumbRendered' && typeof msg.key === 'string' && typeof msg.cacheKey === 'string' && typeof msg.webpBase64 === 'string') {
            void cacheModelThumbnail(msg.key, msg.cacheKey, msg.webpBase64, panel.webview, typeof msg.aliasKey === 'string' ? msg.aliasKey : undefined);
        } else if (msg.type === 'modelThumbFailed' && typeof msg.key === 'string') {
            markModelThumbnailBad(msg.key, typeof msg.cacheKey === 'string' ? msg.cacheKey : undefined, typeof msg.aliasKey === 'string' ? msg.aliasKey : undefined, typeof msg.reason === 'string' ? msg.reason : undefined);
        }
    });
}

function dedupeAssetOptions(options: readonly ValueOption[]): ValueOption[] {
    const seen = new Set<string>();
    const out: ValueOption[] = [];
    for (const option of options) {
        const key = option.value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(option);
    }
    return out;
}

function buildAssetBrowserHtml(initialJson: string, currentValue: string, cspSource: string, mdxViewerUri: string): string {
    return buildPage({
        csp: PREVIEW_ICON_CSP.replace("script-src 'unsafe-inline';", `script-src 'unsafe-inline' ${cspSource};`),
        title: 'Choose Warcraft III Asset',
        extraCss: `
${ICON_INLINE_CSS}
:root { --obj-icon-size: 42px; }
.browser { height: 100%; display: grid; grid-template-rows: auto auto 1fr; min-height: 0; }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--sidebar); }
.tab { min-width: 78px; justify-content: center; }
.search { flex: 1; min-width: 120px; height: 28px; padding: 3px 8px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--input-fg); border-radius: 3px; font-family: var(--font); }
.meta { padding: 6px 10px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.grid { overflow: auto; padding: 8px; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; align-content: start; }
.card { min-width: 0; display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; align-items: center; padding: 7px; border: 1px solid var(--border); background: transparent; color: var(--fg); border-radius: 4px; cursor: pointer; text-align: left; font-family: var(--font); }
.card:hover, .card:focus-visible { background: var(--hover); border-color: var(--vscode-focusBorder, #007fd4); outline: none; }
.card-text { display: block; min-width: 0; overflow: hidden; }
.card-name { display: block; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-path { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.model-thumb { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 3px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; color: var(--muted); font-size: 13px; font-weight: 700; }
.model-thumb::before { content: '3D'; }
.model-thumb.pending::before { content: ''; width: 16px; height: 16px; border: 2px solid color-mix(in srgb, var(--fg) 18%, transparent); border-top-color: var(--fg); border-radius: 50%; animation: wv-spin .8s linear infinite; }
.model-thumb.missing::before { content: '?'; }
.model-thumb.loaded::before { content: none; }
.model-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sound-thumb { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 700; }
.thumb-render-canvas { position: fixed; left: -10000px; top: -10000px; width: 96px; height: 96px; pointer-events: none; opacity: 0; }
.empty { color: var(--muted); padding: 24px; text-align: center; }
`,
        body: `<div class="browser">
  <div class="toolbar">
    <button id="tab-icon" class="wv-btn tab" type="button" data-tab="icon">Icons</button>
    <button id="tab-model" class="wv-btn tab" type="button" data-tab="model">Models</button>
    <button id="tab-sound" class="wv-btn tab" type="button" data-tab="sound">Sounds</button>
    <input id="search" class="search" type="search" placeholder="Search assets..." aria-label="Search assets">
  </div>
  <div class="meta">Replacing ${escapeHtml(currentValue)}</div>
  <div id="grid" class="grid"></div>
</div>
<canvas id="model-thumb-canvas" class="thumb-render-canvas" width="96" height="96" aria-hidden="true"></canvas>
<div id="model-thumb-viewport" class="thumb-render-canvas" aria-hidden="true"></div>
<script src="${escapeHtml(mdxViewerUri)}"></script>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var initial = ${initialJson};
  var activeTab = initial.activeTab || 'icon';
  var query = '';
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
  var modelInited = false;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fuzzy(q, text) {
    q = String(q || '').toLowerCase().trim();
    if (!q) return true;
    text = String(text || '').toLowerCase();
    var pos = 0;
    for (var i = 0; i < q.length; i++) {
      pos = text.indexOf(q[i], pos);
      if (pos < 0) return false;
      pos++;
    }
    return true;
  }
  function list() {
    var items = (initial.tabs[activeTab] || []);
    if (!query) return items.slice(0, 500);
    return items.filter(function (item) { return fuzzy(query, item.label + ' ' + item.detail + ' ' + item.value); }).slice(0, 500);
  }
  function render() {
    document.querySelectorAll('.tab').forEach(function (btn) { btn.classList.toggle('active', btn.getAttribute('data-tab') === activeTab); });
    var grid = document.getElementById('grid');
    var items = list();
    if (!items.length) { grid.innerHTML = '<div class="empty">No matching assets</div>'; return; }
    grid.innerHTML = items.map(function (item, index) {
      var icon = activeTab === 'sound'
        ? '<span class="sound-thumb">AUD</span>'
        : activeTab === 'icon' && item.iconPath
        ? '<span class="object-icon" data-key="asset:' + index + ':' + esc(item.iconPath) + '" data-icon="' + esc(item.iconPath) + '"></span>'
        : '<span class="model-thumb pending" data-key="asset-model:' + index + ':' + esc(item.value) + '" data-model="' + esc(item.value) + '"></span>';
      return '<button class="card" type="button" data-value="' + esc(item.value) + '">' +
        icon + '<span class="card-text"><span class="card-name">' + esc(item.label) + '</span><span class="card-path">' + esc(item.value) + '</span></span></button>';
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
    document.querySelectorAll('.model-thumb[data-key]').forEach(function (el) {
      if ((el.getAttribute('data-key') || '') === key) fn(el);
    });
  }
  function completeModelRequest(key) {
    if (!modelPending.has(key)) return;
    modelPending.delete(key);
    modelBusy = false;
    pumpModelQueue();
  }
  function mpvViewer() { return window.War3Viewer || null; }
  function ensureModelRenderer() {
    var v = mpvViewer();
    if (!v) return false;
    if (modelInited) return true;
    var canvas = document.getElementById('model-thumb-canvas');
    var viewport = document.getElementById('model-thumb-viewport');
    if (!canvas || !viewport) return false;
    var gizmo = document.createElement('canvas');
    gizmo.width = 1; gizmo.height = 1;
    v.init({
      canvas3d: canvas,
      gizmo: gizmo,
      viewport: viewport,
      vscodeApi: { postMessage: function (msg) {
        if (msg && msg.type === 'requestTextures') {
          if (!modelJob) return;
          var paths = (msg.paths || []).filter(Boolean).map(String);
          modelJob.requestedTextures = new Set(paths);
          modelJob.pendingTextures = new Set(paths.filter(function (p) { return !modelJob.receivedTextures || !modelJob.receivedTextures.has(p); }));
          vscode.postMessage(Object.assign({}, msg, { paths: paths, thumbKey: modelJob.key }));
          return;
        }
        vscode.postMessage(msg);
      } },
      callbacks: {
        onModelLoaded: function (info) { onThumbModelLoaded((info && info.sequences) || [], (info && info.texturePaths) || []); },
        onFrameUpdate: function () {},
        onDebug: function () {},
        onError: function () { finishModelRender(false, 'load-error'); }
      }
    });
    modelInited = true;
    return true;
  }
  function pickStandSequence(seqs) {
    var pick = 0, best = Infinity;
    seqs.forEach(function (s, i) {
      var n = String(s.name || '').toLowerCase();
      if (n.indexOf('stand') >= 0 && n.length < best) { best = n.length; pick = i; }
    });
    return pick;
  }
  function onThumbModelLoaded(seqs, texturePaths) {
    if (!modelJob) return;
    var v = mpvViewer();
    if (v && seqs.length) {
      var pick = pickStandSequence(seqs);
      var seq = seqs[pick];
      try {
        v.setSequence(pick);
        v.setFrame(seq ? Math.round(seq.start + Math.max(0, seq.end - seq.start) * 0.2) : 0);
        v.resetCamera();
        v.zoomOut();
        v.zoomOut();
        v.setAutoplay(false);
      } catch (e) {}
    }
    var requested = modelJob.requestedTextures ? Array.from(modelJob.requestedTextures) : (texturePaths || []).filter(Boolean).map(String);
    modelJob.pendingTextures = new Set(requested.filter(function (p) { return !modelJob.receivedTextures || !modelJob.receivedTextures.has(p); }));
    if (!modelJob.pendingTextures.size) scheduleModelCapture(0, 1);
  }
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function loadModelBytes(job) {
    return base64ToArrayBuffer(job.mdxBase64 || '');
  }
  function renderModelThumb(job) {
    if (!ensureModelRenderer()) { markModelFailed(job.key, 'renderer-missing'); return; }
    modelJob = job;
    modelJob.receivedTextures = new Set();
    modelJob.requestedTextures = null;
    modelJob.pendingTextures = new Set();
    try {
      mpvViewer().loadModel(loadModelBytes(job), job.fileName || '', job.format || 'mdx', { autoplay: false });
    } catch (e) {
      markModelFailed(job.key, 'load-error');
    }
  }
  function scheduleModelCapture(delayMs, frames) {
    if (!modelJob) return;
    var waitFrames = Math.max(0, frames == null ? 1 : frames);
    var run = function () {
      var remaining = waitFrames;
      var step = function () {
        if (!modelJob) return;
        if (remaining-- > 0) requestAnimationFrame(step);
        else captureModelThumb();
      };
      requestAnimationFrame(step);
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else run();
  }
  function applyMdxTexture(msg) {
    var v = mpvViewer();
    if (!v || !msg || !msg.path) return;
    try {
      if (msg.ddsBase64 && typeof v.onTextureDds === 'function') {
        v.onTextureDds(msg.path, base64ToArrayBuffer(msg.ddsBase64));
      } else if (msg.rgbaBase64 && msg.width && msg.height && typeof v.onTextureImageData === 'function') {
        v.onTextureImageData(msg.path, new Uint8Array(base64ToArrayBuffer(msg.rgbaBase64)), msg.width, msg.height);
      } else if (msg.blpBase64 && typeof v.onTexture === 'function') {
        v.onTexture(msg.path, base64ToArrayBuffer(msg.blpBase64));
      }
    } catch (e) {}
  }
  function captureModelThumb() {
    if (!modelJob) return;
    if (modelJob.pendingTextures && modelJob.pendingTextures.size > 0) {
      return;
    }
    var canvas = document.getElementById('model-thumb-canvas');
    try {
      var v = mpvViewer();
      if (v && typeof v.renderStillFrame === 'function') v.renderStillFrame();
      var dataUrl = canvas.toDataURL('image/webp', 0.58);
      var marker = 'data:image/webp;base64,';
      if (!dataUrl || dataUrl.indexOf(marker) !== 0) { finishModelRender(false, 'encode-failed'); return; }
      var key = modelJob.key;
      modelLoaded.set(key, dataUrl);
      eachModel(key, function (el) { setModelLoaded(el, dataUrl); });
      vscode.postMessage({ type: 'modelThumbRendered', key: key, cacheKey: modelJob.cacheKey, aliasKey: modelJob.aliasKey, webpBase64: dataUrl.slice(marker.length) });
      finishModelRender(true, '', dataUrl);
    } catch (e) {
      finishModelRender(false, 'capture-error');
    }
  }
  function markModelFailed(key, reason) {
    modelMissing.set(key, { reason: reason || 'failed' });
    eachModel(key, function (el) { setModelMissing(el, modelMissing.get(key)); });
    vscode.postMessage({ type: 'modelThumbFailed', key: key, cacheKey: modelJob && modelJob.cacheKey, aliasKey: modelJob && modelJob.aliasKey, reason: reason || 'failed' });
    completeModelRequest(key);
    modelJob = null;
  }
  function finishModelRender(rendered, reason) {
    if (!modelJob) return;
    var key = modelJob.key;
    if (!rendered) markModelFailed(key, reason || 'failed');
    else {
      completeModelRequest(key);
      modelJob = null;
    }
  }
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function renderDataUrl(data) {
    try {
      var canvas = document.createElement('canvas'); canvas.width = data.width; canvas.height = data.height;
      var ctx = canvas.getContext('2d');
      if (data.mode === 'rgba') {
        var rgba = b64ToBytes(data.rgbaBase64);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), data.width, data.height), 0, 0);
        return Promise.resolve(canvas.toDataURL('image/png'));
      }
      return createImageBitmap(new Blob([b64ToBytes(data.jpegBase64)], { type: 'image/jpeg' })).then(function (bmp) {
        ctx.drawImage(bmp, 0, 0);
        return canvas.toDataURL('image/png');
      });
    } catch (e) { return Promise.resolve(''); }
  }
  function setIcon(el, uri) { el.innerHTML = '<img src="' + esc(uri) + '" alt="">'; }
  function eachIcon(key, fn) { document.querySelectorAll('.object-icon[data-key]').forEach(function (el) { if ((el.getAttribute('data-key') || '') === key) fn(el); }); }
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () { activeTab = btn.getAttribute('data-tab') || 'icon'; render(); });
  });
  document.getElementById('search').addEventListener('input', function (event) { query = event.target.value || ''; render(); });
  document.getElementById('grid').addEventListener('click', function (event) {
    var card = event.target.closest('.card[data-value]');
    if (card) vscode.postMessage({ type: 'selectAsset', value: card.getAttribute('data-value') || '' });
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
    } else if (msg.type === 'mdxTexture') {
      if (!modelJob || (msg.thumbKey && msg.thumbKey !== modelJob.key)) return;
      if (msg.path) {
        if (modelJob.receivedTextures) modelJob.receivedTextures.add(String(msg.path));
        if (modelJob.pendingTextures) modelJob.pendingTextures.delete(String(msg.path));
      }
      applyMdxTexture(msg);
      if (!modelJob.pendingTextures || modelJob.pendingTextures.size === 0) scheduleModelCapture(0, 1);
    }
  });
  render();
  document.getElementById('search').focus();
})();
</script>`,
    });
}

class WurstAssetCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const target = findAssetStringAt(document, range);
        if (!target) return [];
        const action = new vscode.CodeAction('Browse Warcraft III assets...', vscode.CodeActionKind.RefactorRewrite);
        action.command = {
            command: 'wurst.browseAssetForString',
            title: 'Browse Warcraft III assets...',
            arguments: [target],
        };
        return [action];
    }
}

class WurstAssetCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        for (const target of findAssetStrings(document)) {
            if (target.kind === 'sound') {
                lenses.push(new vscode.CodeLens(target.range, {
                    command: 'wurst.openAssetFromString',
                    title: '▶ Play sound',
                    arguments: [target.currentValue],
                }));
            }
            lenses.push(new vscode.CodeLens(target.range, {
                command: 'wurst.browseAssetForString',
                title: target.kind === 'model' ? 'Browse model...' : target.kind === 'sound' ? 'Browse sound...' : 'Browse asset...',
                arguments: [target],
            }));
        }
        return lenses;
    }
}

// ── Wurst / JASS: string literals containing asset paths ─────────────────────

class WurstAssetLinkProvider implements vscode.DocumentLinkProvider {
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        STRING_LITERAL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_LITERAL_RE.exec(text)) !== null) {
            const [, assetPath, ext] = m;
            if (!isAssetExt(ext)) continue;
            if (isSoundExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
                continue;
            }
            const target = await resolveAssetPath(assetPath, roots);
            if (target) {
                addLink(links, document, text, m.index + 1, assetPath.length, target);
                continue;
            }
            if (isModelExt(ext) || isSoundExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
            }
        }

        return links;
    }
}

// ── FDF: IncludeFile paths ────────────────────────────────────────────────────

class FdfLinkProvider implements vscode.DocumentLinkProvider {
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        // IncludeFile links
        FDF_INCLUDE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FDF_INCLUDE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = await resolveAssetPath(assetPath, roots);
            if (!target) continue;
            // point at the path inside the quotes
            const startOffset = m.index + m[0].indexOf('"') + 1;
            addLink(links, document, text, startOffset, assetPath.length, target);
        }

        // Also linkify any other quoted asset paths in the file
        STRING_LITERAL_RE.lastIndex = 0;
        while ((m = STRING_LITERAL_RE.exec(text)) !== null) {
            const [, assetPath, ext] = m;
            if (!isAssetExt(ext)) continue;
            if (isSoundExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
                continue;
            }
            const target = await resolveAssetPath(assetPath, roots);
            if (target) {
                addLink(links, document, text, m.index + 1, assetPath.length, target);
                continue;
            }
            if (isModelExt(ext) || isSoundExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
            }
        }

        return links;
    }
}

// ── TOC: bare path lines ──────────────────────────────────────────────────────

class TocLinkProvider implements vscode.DocumentLinkProvider {
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        TOC_LINE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOC_LINE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = await resolveAssetPath(assetPath, roots);
            if (!target) continue;
            // Offset of the captured path within the full match
            const startOffset = m.index + m[0].indexOf(m[1]);
            addLink(links, document, text, startOffset, assetPath.length, target);
        }

        return links;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAssetLinks(context: vscode.ExtensionContext): vscode.Disposable {
    const openAsset = vscode.commands.registerCommand('wurst.openAssetFromString', async (assetPath: string) => {
        if (!assetPath) return;
        const ext = path.extname(assetPath).slice(1).toLowerCase();
        const kind = isModelExt(ext) ? 'model' : isSoundExt(ext) ? 'sound' : 'any';
        const resolved = await resolveAssetPathWithCasc(
            assetPath,
            await candidateRootsForFsPath(vscode.window.activeTextEditor?.document.uri.fsPath),
            kind,
        );
        const target = resolved ? vscode.Uri.file(resolved) : undefined;
        if (!target) {
            vscode.window.showWarningMessage(`Could not resolve asset: ${assetPath}`);
            return;
        }
        const resolvedExt = path.extname(target.fsPath).toLowerCase();
        if (resolvedExt === '.mdx' || resolvedExt === '.mdl') {
            await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.blpPreview');
            return;
        }
        if (isSoundAssetPath(target.fsPath)) {
            await playSoundInline(target);
            return;
        }
        await vscode.commands.executeCommand('vscode.open', target);
    });

    const browseAsset = vscode.commands.registerCommand('wurst.browseAssetForString', async (target: BrowseAssetTarget) => {
        if (!target?.uri || !target.range) return;
        await openCodeAssetBrowser(context, target);
    });

    const wurst = vscode.languages.registerDocumentLinkProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        new WurstAssetLinkProvider(),
    );

    const fdf = vscode.languages.registerDocumentLinkProvider(
        [{ language: 'wc3-fdf' }, { pattern: '**/*.fdf' }],
        new FdfLinkProvider(),
    );

    const toc = vscode.languages.registerDocumentLinkProvider(
        [{ language: 'wc3-toc' }, { pattern: '**/*.toc' }],
        new TocLinkProvider(),
    );

    const codeActions = vscode.languages.registerCodeActionsProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        new WurstAssetCodeActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    );

    const codeLens = vscode.languages.registerCodeLensProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        new WurstAssetCodeLensProvider(),
    );

    return vscode.Disposable.from(openAsset, browseAsset, wurst, fdf, toc, codeActions, codeLens);
}
