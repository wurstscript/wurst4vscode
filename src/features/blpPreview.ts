'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeNonce, escapeHtml } from './webviewUtils';
import {
    getCascCacheDir,
    findCascTexture,
    findCascAsset,
    findLocalTexture,
} from './preview/cascStorage';
import {
    DecodedBlpImage,
    decodeDds,
    decodeTga,
    decodeBlp,
} from './preview/imageDecoders';

// Re-exported for backwards-compat with existing callers that import from blpPreview.
export { decodeRasterPreview, decodeToRgba, writeJpegPreviewFile } from './preview/imageDecoders';
export { ensureCascCached, ensureCascAssetCached } from './preview/cascStorage';

type BlpDocument = vscode.CustomDocument;

const BLP_VIEW_TYPE = 'wurst.blpPreview';

export function registerBlpPreview(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new BlpPreviewProvider(context.extensionUri);
    const editorDisposable = vscode.window.registerCustomEditorProvider(BLP_VIEW_TYPE, provider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
    });

    const testDisposable = vscode.commands.registerCommand('wurst.testCascExtraction', async () => {
        const output = vscode.window.createOutputChannel('Wurst CASC Smoketest');
        output.show(true);
        const log = (msg: string) => { output.appendLine(msg); };

        log('=== CASC Smoketest ===');
        const wc3path = vscode.workspace.getConfiguration('wurst').get<string>('wc3path', '');
        log(`wurst.wc3path setting: "${wc3path || '(not set)'}"`);
        log(`cache dir: ${getCascCacheDir()}`);

        const textureTests = [
            'Textures\\Abomination.blp',
        ];
        const assetTests = [
            'Abilities\\Weapons\\ZigguratFrostMissile\\ZigguratFrostMissile.mdx',
            'Abilities\\Weapons\\ZigguratMissile\\ZigguratMissile.mdx',
            'Abilities\\Spells\\Demon\\DarkConversion\\ZombifyTarget.mdx',
        ];

        let passed = 0;
        let failed = 0;

        log('\n--- Texture Tests ---');
        for (const testPath of textureTests) {
            log(`\nExtracting texture: ${testPath}`);
            const textureResult = await findCascTexture(testPath, log);
            if (textureResult) {
                passed++;
                log(`PASS texture: ${testPath} -> ${textureResult.ext} ${textureResult.buf.length} bytes`);
            } else {
                failed++;
                log(`FAIL texture: ${testPath}`);
            }
        }

        log('\n--- Asset Tests ---');
        for (const testPath of assetTests) {
            log(`\nExtracting asset: ${testPath}`);
            const assetResult = await findCascAsset(testPath, log);
            if (assetResult) {
                passed++;
                log(`PASS asset: ${testPath} -> ${assetResult.length} bytes`);
            } else {
                failed++;
                log(`FAIL asset: ${testPath}`);
            }
        }

        log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
        if (failed === 0) {
            vscode.window.showInformationMessage(`CASC smoketest OK: ${passed} passed`);
        } else {
            vscode.window.showWarningMessage(`CASC smoketest: ${passed} passed, ${failed} failed. See output for details.`);
        }
    });

    return vscode.Disposable.from(editorDisposable, testDisposable);
}


class BlpPreviewProvider implements vscode.CustomReadonlyEditorProvider<BlpDocument> {
    constructor(private readonly extensionUri: vscode.Uri) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<BlpDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: BlpDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const viewerScriptUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'mdxViewer.js')
        );
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
        };

        const getFileName = () => path.basename(document.uri.fsPath || document.uri.path);
        webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, getFileName(), viewerScriptUri);
        let requestId = 0;
        let webviewReady = false;
        let pendingRender = true;
        let cachedBytes: Uint8Array | undefined;
        const dbg = (msg: string) => console.log(`[wurst-preview] ${msg}`);
        dbg(`resolve editor for ${document.uri.toString()}`);

        const render = async (opts?: { showLoading?: boolean; preferCached?: boolean }) => {
            const showLoading = opts?.showLoading ?? true;
            const preferCached = opts?.preferCached ?? false;
            const id = ++requestId;
            const fileName = getFileName();
            dbg(`render start #${id} for ${fileName}`);
            if (showLoading) {
                await webviewPanel.webview.postMessage({ type: 'loading', fileName });
            }
            try {
                let bytes = cachedBytes;
                if (!preferCached || !bytes) {
                    bytes = await vscode.workspace.fs.readFile(document.uri);
                    cachedBytes = bytes;
                    dbg(`read ${bytes.byteLength} bytes for ${fileName}`);
                }
                const decoded = decodePreview(bytes, document.uri);
                if (id !== requestId) return;
                if (decoded.kind === 'mdx-raw') {
                    await webviewPanel.webview.postMessage({ type: 'mdx', mdxBase64: decoded.mdxBase64, fileName: decoded.fileName });
                } else {
                    await webviewPanel.webview.postMessage({ type: 'image', fileName, decoded });
                }
                dbg(`posted payload for ${fileName}`);
            } catch (error) {
                if (id !== requestId) return;
                const message = error instanceof Error ? error.message : String(error);
                await webviewPanel.webview.postMessage({ type: 'error', fileName, message });
                dbg(`render error for ${fileName}: ${message}`);
            }
        };

        const requestRender = (opts?: { showLoading?: boolean; preferCached?: boolean }) => {
            if (!webviewReady) {
                pendingRender = true;
                dbg(`render queued until webview ready`);
                return;
            }
            void render(opts);
        };
        requestRender();
        setTimeout(() => {
            if (!webviewReady) {
                dbg(`webview did not send ready within 3000ms`);
                void webviewPanel.webview.postMessage({
                    type: 'error',
                    fileName: getFileName(),
                    message: 'Webview script did not initialize (no ready handshake). Open Developer Tools for details.',
                });
            }
        }, 3000);

        const filePath = document.uri.fsPath;
        if (document.uri.scheme === 'file' && filePath) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
            );
            const rerender = () => { cachedBytes = undefined; requestRender(); };
            watcher.onDidChange(rerender);
            watcher.onDidCreate(rerender);
            webviewPanel.onDidDispose(() => watcher.dispose());
        }

        webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
            if (typeof msg !== 'object' || !msg) return;
            const type = (msg as { type?: string }).type;
            if (type === 'ready') {
                webviewReady = true;
                dbg(`webview ready`);
                if (pendingRender) { pendingRender = false; await render(); }
                return;
            }
            if (type === 'debug') {
                dbg(`webview: ${(msg as { message?: string }).message ?? ''}`);
                return;
            }
            if (type === 'refresh') {
                dbg(`refresh requested`);
                cachedBytes = undefined;
                requestRender();
                return;
            }
            if (type === 'requestTextures') {
                const rawPaths = (msg as { paths?: unknown }).paths;
                if (!Array.isArray(rawPaths)) return;
                const texPaths: string[] = rawPaths.filter((p): p is string => typeof p === 'string');
                const mdxFsPath = document.uri.scheme === 'file' ? document.uri.fsPath : '';
                dbg(`texture request: ${texPaths.length} paths`);

                // Resolve textures concurrently
                await Promise.all(texPaths.map(async (texPath) => {
                    try {
                        let texBuf: Buffer | null = null;
                        let texExt: 'blp' | 'dds' | null = null;
                        let resolvedFsPath: string | null = null;

                        // 1. Local file lookup (also tries .dds for .blp references)
                        if (mdxFsPath) {
                            const found = findLocalTexture(texPath, mdxFsPath);
                            if (found) {
                                texBuf = found.buf;
                                texExt = found.foundPath.toLowerCase().endsWith('.dds') ? 'dds' : 'blp';
                                resolvedFsPath = found.foundPath;
                            }
                        }

                        // 2. CASC local archive fallback (uses wurst.wc3path)
                        if (!texBuf) {
                            const casc = await findCascTexture(texPath, dbg);
                            if (casc) {
                                texBuf = casc.buf;
                                texExt = casc.ext;
                                // Reconstruct the cache path so the webview can offer an "open" link
                                const cacheDir = getCascCacheDir();
                                const normalized = texPath.replace(/\//g, '\\').toLowerCase();
                                const rel = texExt === 'dds' ? normalized.replace(/\.blp$/, '.dds') : normalized;
                                resolvedFsPath = path.join(cacheDir, rel);
                            }
                        }

                        if (!texBuf || !texExt) {
                            await webviewPanel.webview.postMessage({ type: 'texture', path: texPath, resolvedFsPath: null, blpBase64: null });
                            dbg(`texture ${texPath}: not found`);
                            return;
                        }

                        if (texExt === 'dds') {
                            const decoded = decodeDds(new Uint8Array(texBuf));
                            if (decoded.mode === 'rgba') {
                                await webviewPanel.webview.postMessage({
                                    type: 'texture', path: texPath, resolvedFsPath,
                                    blpBase64: null, rgbaBase64: decoded.rgbaBase64,
                                    width: decoded.width, height: decoded.height,
                                });
                            } else {
                                await webviewPanel.webview.postMessage({ type: 'texture', path: texPath, resolvedFsPath, blpBase64: null });
                            }
                        } else {
                            await webviewPanel.webview.postMessage({ type: 'texture', path: texPath, resolvedFsPath, blpBase64: texBuf.toString('base64') });
                        }
                        dbg(`texture ${texPath}: found (${texExt})`);
                    } catch (e) {
                        dbg(`texture error ${texPath}: ${String(e)}`);
                        await webviewPanel.webview.postMessage({ type: 'texture', path: texPath, resolvedFsPath: null, blpBase64: null });
                    }
                }));
                return;
            }
            if (type === 'openTexture') {
                const fsPath = (msg as { fsPath?: unknown }).fsPath;
                if (typeof fsPath === 'string' && fsPath && fs.existsSync(fsPath)) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath));
                }
                return;
            }
        });
    }

    private buildHtml(webview: vscode.Webview, initialFileName: string, viewerScriptUri: vscode.Uri): string {
        const nonce = makeNonce();
        const fileName = escapeHtml(initialFileName);
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} blob: data:`,
            `script-src ${webview.cspSource} 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --warn: var(--vscode-editorWarning-foreground);
      --border: var(--vscode-panel-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --cb-a: color-mix(in srgb, var(--vscode-editorWidget-background) 65%, transparent);
      --cb-b: color-mix(in srgb, var(--vscode-editorWidget-border) 55%, transparent);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      flex-shrink: 0;
      min-width: 0;
    }
    .meta {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta strong { color: var(--text); font-size: 13px; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; }
    button {
      border: none;
      background: transparent;
      color: var(--muted);
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
    }
    button:hover { background: color-mix(in srgb, var(--btn-bg) 60%, transparent); color: var(--text); }
    button.active { background: var(--btn-bg); color: var(--btn-fg); }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    .zoom-label {
      min-width: 38px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .content-area {
      flex: 1;
      display: flex;
      min-height: 0;
      overflow: hidden;
    }
    /* ── Sidebar ── */
    .sidebar {
      width: 210px;
      min-width: 210px;
      display: none;
      flex-direction: column;
      overflow-y: auto;
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 70%, transparent);
      padding: 10px;
      gap: 12px;
      flex-shrink: 0;
    }
    .sidebar.visible { display: flex; }
    .sb-section { display: flex; flex-direction: column; gap: 5px; }
    .sb-label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      opacity: 0.7;
    }
    .sb-name { font-weight: 600; font-size: 13px; color: var(--text); word-break: break-word; }
    .sb-info { font-size: 11px; color: var(--muted); line-height: 1.4; }
    .sb-divider { height: 1px; background: var(--border); opacity: 0.5; margin: 2px 0; }
    .anim-select {
      width: 100%;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      padding: 4px 6px;
      font-size: 12px;
    }
    .autoplay-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .autoplay-row input { cursor: pointer; }
    .frame-label {
      font-size: 11px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .seq-slider { width: 100%; cursor: pointer; }
    .seq-name {
      font-size: 11px;
      color: var(--text);
      opacity: 0.8;
      word-break: break-word;
    }
    .tex-list { display: flex; flex-direction: column; gap: 3px; }
    .tex-item {
      font-size: 11px;
      color: var(--muted);
      word-break: break-all;
      line-height: 1.4;
    }
    .tex-item a {
      color: var(--vscode-textLink-foreground, #4da3ff);
      text-decoration: none;
      cursor: pointer;
    }
    .tex-item a:hover { text-decoration: underline; }
    .tex-item.missing { opacity: 0.45; }
    /* When alpha mode is off, draw a solid bg behind the canvas */
    .viewport.alpha-off { background: #1e1e1e; }
    /* ── Canvas area ── */
    .canvas-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      padding: 12px;
      gap: 8px;
      overflow: hidden;
    }
    .viewport {
      flex: 1;
      position: relative;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: repeating-conic-gradient(var(--cb-a) 0% 25%, var(--cb-b) 0% 50%) 50% / 20px 20px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .gizmo {
      position: absolute;
      right: 8px;
      bottom: 8px;
      width: 80px;
      height: 80px;
      border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      border-radius: 6px;
      background: color-mix(in srgb, var(--panel) 55%, transparent);
      pointer-events: none;
    }
    .viewport.dragging { cursor: grabbing; }
    .stage {
      position: absolute;
      left: 0; top: 0;
      transform-origin: 0 0;
      will-change: transform;
      transition: opacity 130ms ease;
    }
    canvas { display: block; image-rendering: pixelated; image-rendering: crisp-edges; }
    .stage-canvas { position: static; width: auto; height: auto; }
    .viewport.model-mode { background: color-mix(in srgb, var(--vscode-editor-background) 85%, #000); }
    .viewport.model-mode > .stage { width: 100%; height: 100%; }
    .viewport.model-mode #canvas3d { width: 100%; height: 100%; }
    .warnings {
      color: var(--warn);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      flex-shrink: 0;
    }
    .debuglog {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      white-space: pre-wrap;
      max-height: 130px;
      overflow: auto;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: 4px;
      padding: 6px 8px;
      background: color-mix(in srgb, var(--panel) 60%, transparent);
      display: none;
      flex-shrink: 0;
    }
    .debuglog.visible { display: block; }
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      gap: 10px;
      background: color-mix(in srgb, var(--bg) 60%, transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity 130ms ease;
    }
    .loading-overlay.visible { opacity: 1; }
    .spinner {
      width: 22px; height: 22px;
      border: 2px solid color-mix(in srgb, var(--text) 20%, transparent);
      border-top-color: var(--text);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .loading-text { font-size: 12px; color: var(--muted); text-align: center; }
    .loading-stage { opacity: 0.4; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 640px) {
      .content-area { flex-direction: column; }
      .sidebar { width: 100%; min-width: 0; border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; }
      .sidebar.visible { display: flex; }
    }
  </style>
</head>
<body>
  <header>
    <div class="meta">
      <strong id="fileName">${fileName}</strong>
      <span id="fileMeta"> &mdash; Loading...</span>
    </div>
    <div class="toolbar">
      <button id="zoomOutBtn" type="button" title="Zoom out">&minus;</button>
      <button id="zoomInBtn" type="button" title="Zoom in">+</button>
      <span id="zoomLabel" class="zoom-label">100%</span>
      <div class="sep" id="imgSep"></div>
      <button id="fitBtn" type="button" title="Fit to viewport">Fit</button>
      <button id="alphaBtn" type="button" title="Toggle alpha channel display">Alpha</button>
      <div class="sep" id="modelSep" style="display:none"></div>
      <button id="resetCamBtn" type="button" title="Reset camera" style="display:none">&#8635; Reset</button>
      <button id="renderModeBtn" type="button" title="Toggle wireframe" style="display:none">Fill</button>
      <div class="sep"></div>
      <button id="debugBtn" type="button" title="Toggle debug log">&#8801;</button>
    </div>
  </header>
  <div class="content-area">
    <aside id="sidebar" class="sidebar">
      <div class="sb-section">
        <div id="sbName" class="sb-name"></div>
        <div id="sbInfo" class="sb-info"></div>
      </div>
      <div class="sb-divider"></div>
      <div class="sb-section">
        <div class="sb-label">Team Color</div>
        <select id="teamColorSelect" class="anim-select">
          <option value="#ff0303">1 Red</option>
          <option value="#0042ff">2 Blue</option>
          <option value="#1ce6b9">3 Teal</option>
          <option value="#540081">4 Purple</option>
          <option value="#fffc00">5 Yellow</option>
          <option value="#fe8a0e">6 Orange</option>
          <option value="#20c000">7 Green</option>
          <option value="#e55bb0">8 Pink</option>
          <option value="#959697">9 Gray</option>
          <option value="#7ebff1">10 Light Blue</option>
          <option value="#106246">11 Dark Green</option>
          <option value="#4e2a04">12 Brown</option>
        </select>
      </div>
      <div class="sb-divider"></div>
      <div class="sb-section">
        <div class="sb-label">Animation</div>
        <select id="animSelect" class="anim-select"></select>
        <label class="autoplay-row"><input id="autoplayChk" type="checkbox" checked><span>Auto play</span></label>
      </div>
      <div class="sb-divider" id="seqDivider" style="display:none"></div>
      <div class="sb-section" id="seqSection" style="display:none">
        <div class="sb-label">Timeline</div>
        <div id="seqFrameLabel" class="frame-label">frame: &mdash;</div>
        <input id="seqSlider" class="seq-slider" type="range" min="0" max="1" step="1" value="0" />
        <div id="seqStats" class="seq-name"></div>
      </div>
      <div class="sb-divider" id="texListDivider" style="display:none"></div>
      <div class="sb-section" id="texListSection" style="display:none">
        <div class="sb-label">Textures</div>
        <div id="texList" class="tex-list"></div>
      </div>
    </aside>
    <div class="canvas-area">
      <div id="viewport" class="viewport">
        <div id="stage" class="stage">
          <canvas id="canvas2d" class="stage-canvas" width="1" height="1"></canvas>
          <canvas id="canvas3d" class="stage-canvas" width="1" height="1" style="display:none;"></canvas>
        </div>
        <canvas id="gizmo" class="gizmo" width="80" height="80"></canvas>
        <div id="loadingOverlay" class="loading-overlay visible">
          <div class="spinner"></div>
          <div id="loadingText" class="loading-text">Loading...</div>
        </div>
      </div>
      <div id="warnings" class="warnings"></div>
      <div id="debugLog" class="debuglog"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${viewerScriptUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const w3v = window.War3Viewer;
    let isModelMode = false;
    let currentFileName = '';
    const debugLines = [];
    const debugLimit = 200;

    function debug(msg) {
      const now = new Date();
      const ts = now.toISOString().slice(11, 19);
      const line = '[' + ts + '] ' + msg;
      debugLines.push(line);
      if (debugLines.length > debugLimit) debugLines.shift();
      const el = document.getElementById('debugLog');
      el.textContent = debugLines.join('\\n');
      // don't auto-show debug log — user must toggle it
      try { vscode.postMessage({ type: 'debug', message: line }); } catch {}
    }

    function base64ToBytes(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    function base64ToArrayBuffer(base64) {
      const bytes = base64ToBytes(base64);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    function showWarnings(messages) {
      const el = document.getElementById('warnings');
      if (!messages || !messages.length) {
        el.textContent = '';
        debug('warnings cleared');
        return;
      }
      el.textContent = messages.map((w) => '- ' + w).join('\\n');
      debug('warnings: ' + messages.length);
    }

    function setLoading(isLoading, text) {
      const overlay = document.getElementById('loadingOverlay');
      const loadingText = document.getElementById('loadingText');
      if (text) loadingText.textContent = text;
      if (isLoading) {
        overlay.classList.add('visible');
        stage.classList.add('loading-stage');
        debug('loading on: ' + (text || ''));
      } else {
        overlay.classList.remove('visible');
        stage.classList.remove('loading-stage');
        debug('loading off');
      }
    }

    function setMeta(fileName, metaText) {
      document.getElementById('fileName').textContent = fileName;
      document.getElementById('fileMeta').textContent = ' \u2014 ' + metaText;
      debug('meta: ' + fileName + ' | ' + metaText);
    }

    function setSidebarVisible(visible) {
      const sb = document.getElementById('sidebar');
      if (visible) sb.classList.add('visible');
      else sb.classList.remove('visible');
    }

    function setModelButtons(visible) {
      document.getElementById('modelSep').style.display = visible ? '' : 'none';
      document.getElementById('resetCamBtn').style.display = visible ? '' : 'none';
      document.getElementById('renderModeBtn').style.display = visible ? '' : 'none';
      document.getElementById('imgSep').style.display = visible ? 'none' : '';
      document.getElementById('fitBtn').style.display = visible ? 'none' : '';
      document.getElementById('alphaBtn').style.display = visible ? 'none' : '';
    }

    // ── War3Viewer init ────────────────────────────────────────────────────────
    if (w3v) {
      w3v.init({
        canvas3d: document.getElementById('canvas3d'),
        gizmo: document.getElementById('gizmo'),
        viewport: document.getElementById('viewport'),
        vscodeApi: vscode,
        callbacks: {
          onModelLoaded(info) {
            isModelMode = true;
            setMeta(info.name || 'Model', 'geosets: ' + info.geosetCount + ' · textures: ' + info.textureCount);
            document.getElementById('sbName').textContent = info.name || 'Model';
            document.getElementById('sbInfo').textContent = info.geosetCount + ' geosets · ' + info.textureCount + ' textures';
            animSelect.innerHTML = '';
            if (!info.sequences.length) {
              const opt = document.createElement('option');
              opt.textContent = 'Bind pose';
              animSelect.appendChild(opt);
            } else {
              for (const seq of info.sequences) {
                const opt = document.createElement('option');
                opt.textContent = seq.name + ' [' + seq.start + '\u2013' + seq.end + ']' + (seq.looping ? '' : ' \u2205');
                animSelect.appendChild(opt);
              }
              animSelect.selectedIndex = 0;
            }
            setSidebarVisible(true);
            if (w3v) w3v.setTeamColor(teamColorSelect.value);
            if (info.sequences.length) {
              const s = info.sequences[0];
              document.getElementById('seqSection').style.display = '';
              document.getElementById('seqDivider').style.display = '';
              seqSlider.min = String(s.start);
              seqSlider.max = String(s.end);
              seqSlider.value = String(s.start);
              seqStats.textContent = s.name;
            }
            // Build texture list (items get updated with links when textures resolve)
            const texList = document.getElementById('texList');
            texList.innerHTML = '';
            if (info.texturePaths && info.texturePaths.length) {
              document.getElementById('texListSection').style.display = '';
              document.getElementById('texListDivider').style.display = '';
              for (const tp of info.texturePaths) {
                const item = document.createElement('div');
                item.className = 'tex-item missing';
                item.dataset.path = tp;
                item.textContent = tp.split(/[\\\\/]/).pop() || tp;
                item.title = tp;
                texList.appendChild(item);
              }
            }
            stage.style.transform = 'translate(0px, 0px) scale(1)';
            zoomLabel.textContent = '3D';
            setModelButtons(true);
            setLoading(false);
          },
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
          },
          onDebug(msg) { debug('w3v: ' + msg); },
        },
      });
    }

    async function renderCurrent(data) {
      debug('renderCurrent kind=' + data.kind);
      const canvas2d = document.getElementById('canvas2d');
      const canvas3d = document.getElementById('canvas3d');
      canvas3d.style.display = 'none';
      canvas2d.style.display = '';
      setModelButtons(false);
      document.getElementById('seqSection').style.display = 'none';
      document.getElementById('seqDivider').style.display = 'none';
      document.getElementById('texListSection').style.display = 'none';
      document.getElementById('texListDivider').style.display = 'none';
      const ctx = canvas2d.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('2D canvas context is unavailable.');
      canvas2d.width = data.width;
      canvas2d.height = data.height;
      ctx.clearRect(0, 0, canvas2d.width, canvas2d.height);
      if (data.mode === 'rgba') {
        const rgba = base64ToBytes(data.rgbaBase64);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), data.width, data.height), 0, 0);
      } else {
        const blob = new Blob([base64ToBytes(data.jpegBase64)], { type: 'image/jpeg' });
        const objectUrl = URL.createObjectURL(blob);
        const image = await createImageBitmap(blob);
        try {
          ctx.drawImage(image, 0, 0, data.width, data.height);
          const img = ctx.getImageData(0, 0, data.width, data.height);
          const px = img.data;
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i]; px[i] = px[i + 2]; px[i + 2] = r;
          }
          ctx.putImageData(img, 0, 0);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
      showWarnings(data.warnings);
      debug('raster rendered');
    }

    const viewport = document.getElementById('viewport');
    const stage = document.getElementById('stage');
    const zoomLabel = document.getElementById('zoomLabel');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const fitBtn = document.getElementById('fitBtn');
    const renderModeBtn = document.getElementById('renderModeBtn');
    const alphaBtn = document.getElementById('alphaBtn');
    const teamColorSelect = document.getElementById('teamColorSelect');
    const animSelect = document.getElementById('animSelect');
    const autoplayChk = document.getElementById('autoplayChk');
    const seqSlider = document.getElementById('seqSlider');
    const seqFrameLabel = document.getElementById('seqFrameLabel');
    const seqStats = document.getElementById('seqStats');

    let showAlpha = true;
    let zoom = 1;
    let tx = 0;
    let ty = 0;
    let dragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragTx = 0;
    let dragTy = 0;
    let modelRenderMode = 'fill'; // fill | wire
    let lastRasterWidth = 1;
    let lastRasterHeight = 1;

    function updateRenderModeUi() {
      renderModeBtn.textContent = modelRenderMode === 'fill' ? 'Fill' : 'Wire';
    }

    function applyAlphaMode() {
      if (showAlpha) {
        viewport.classList.remove('alpha-off');
      } else {
        viewport.classList.add('alpha-off');
      }
      alphaBtn.classList.toggle('active', showAlpha);
    }

    function clampZoom(value) {
      return Math.min(64, Math.max(0.05, value));
    }

    function applyTransform() {
      stage.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')';
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }

    function zoomAt(factor, clientX, clientY) {
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

    function zoomByStep(direction) {
      const factor = direction > 0 ? 1.2 : 1 / 1.2;
      const rect = viewport.getBoundingClientRect();
      zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    function centerImage() {
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      tx = (vw - lastRasterWidth * zoom) / 2;
      ty = (vh - lastRasterHeight * zoom) / 2;
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

    function stopDrag(ev) {
      if (!dragActive) return;
      dragActive = false;
      viewport.classList.remove('dragging');
      try { viewport.releasePointerCapture(ev.pointerId); } catch {}
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
    document.getElementById('resetCamBtn').addEventListener('click', () => {
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

    document.getElementById('debugBtn').addEventListener('click', () => {
      const el = document.getElementById('debugLog');
      el.classList.toggle('visible');
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

    window.addEventListener('message', async (event) => {
      const msg = event.data || {};
      debug('message: ' + (msg.type || 'unknown'));
      if (msg.type === 'loading') {
        setMeta(msg.fileName || 'Image', 'Loading...');
        setLoading(true, 'Loading image...');
        return;
      }
      if (msg.type === 'error') {
        setMeta(msg.fileName || 'Image', 'Failed to load');
        showWarnings([msg.message || 'Unknown error']);
        setLoading(false);
        return;
      }
      if (msg.type === 'mdx') {
        isModelMode = true;
        viewport.classList.add('model-mode');
        document.getElementById('canvas2d').style.display = 'none';
        document.getElementById('canvas3d').style.display = '';
        stage.style.transform = 'translate(0px, 0px) scale(1)';
        zoomLabel.textContent = '3D';
        setMeta(msg.fileName || 'Model', 'Loading model...');
        setLoading(true, 'Loading model...');
        if (w3v) w3v.loadModel(base64ToArrayBuffer(msg.mdxBase64), msg.fileName || '');
        return;
      }
      if (msg.type === 'texture') {
        if (w3v) {
          if (msg.rgbaBase64 && msg.width && msg.height) {
            const rgba = base64ToBytes(msg.rgbaBase64);
            const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer), msg.width, msg.height);
            w3v.onTextureImageData(msg.path, imageData);
          } else {
            const buf = msg.blpBase64 ? base64ToArrayBuffer(msg.blpBase64) : null;
            w3v.onTexture(msg.path, buf);
          }
        }
        // Update texture list item with resolved path (or mark as missing)
        const item = document.querySelector('.tex-item[data-path="' + CSS.escape(msg.path) + '"]');
        if (item) {
          if (msg.resolvedFsPath) {
            item.classList.remove('missing');
            const a = item.querySelector('a') || document.createElement('a');
            a.textContent = msg.path.split(/[\\\\/]/).pop() || msg.path;
            a.title = msg.resolvedFsPath;
            a.href = '#';
            a.onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openTexture', fsPath: msg.resolvedFsPath }); };
            if (!item.querySelector('a')) {
              item.textContent = '';
              item.appendChild(a);
              const full = document.createElement('span');
              full.style.cssText = 'display:block;opacity:0.55;font-size:10px;margin-top:1px;word-break:break-all;';
              full.textContent = msg.path;
              item.appendChild(full);
            }
          } else {
            item.classList.add('missing');
          }
        }
        return;
      }
      if (msg.type === 'image') {
        isModelMode = false;
        viewport.classList.remove('model-mode');
        setSidebarVisible(false);
        setModelButtons(false);
        const data = msg.decoded;
        lastRasterWidth = data.width;
        lastRasterHeight = data.height;
        setMeta(msg.fileName || 'Image', data.description + ' · ' + data.width + ' × ' + data.height);
        try {
          await renderCurrent(data);
          zoom = 1;
          centerImage();
          setLoading(false);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          showWarnings(['Render error: ' + message]);
          setMeta(msg.fileName || 'Image', 'Render failed');
          setLoading(false);
          debug('render exception: ' + message);
        }
      }
    });

    window.addEventListener('error', (event) => {
      const message = event && event.message ? event.message : 'Unknown webview error';
      showWarnings(['Webview error: ' + message]);
      setLoading(false);
      debug('window error: ' + message);
    });

    debug('script boot');
    updateRenderModeUi();
    applyAlphaMode();
    vscode.postMessage({ type: 'ready' });
    debug('ready posted');
  </script>
</body>
</html>`;
    }

}

function decodePreview(sourceBytes: Uint8Array, uri: vscode.Uri): DecodedBlpImage {
    const ext = path.extname(uri.fsPath || uri.path).toLowerCase();
    if (ext === '.dds') {
        return decodeDds(sourceBytes);
    }
    if (ext === '.tga') {
        return decodeTga(sourceBytes);
    }
    if (ext === '.mdx') {
        const mdxBase64 = Buffer.from(sourceBytes).toString('base64');
        const fileName = path.basename(uri.fsPath || uri.path);
        return { kind: 'mdx-raw', mdxBase64, fileName };
    }
    return decodeBlp(sourceBytes);
}
