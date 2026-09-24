'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeNonce, escapeHtml } from './webviewUtils';
import { buildPage, sep } from './webviewShared';
import { offerIssueReport } from './issueReporting';
import {
    getGameAssetCacheDir,
    findGameTexture,
    findGameAsset,
} from './preview/cascStorage';
import { DecodedBlpImage, decodeRasterPreview } from './preview/imageDecoders';
import { clearTextureMissCache, postTexturesToWebview } from './preview/modelPreviewHost';
import BLP_PREVIEW_CSS from '../webview/blpPreview.css';

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
        log(`cache dir: ${getGameAssetCacheDir()}`);

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
            const textureResult = await findGameTexture(testPath, log);
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
            const assetResult = await findGameAsset(testPath, log);
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
            const choice = await vscode.window.showWarningMessage(
                `CASC smoketest: ${passed} passed, ${failed} failed. See output for details.`,
                'View Logs',
            );
            if (choice === 'View Logs') output.show(true);
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
        const bundleDir = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
        const bundleUri = (name: string) => webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(bundleDir, name)).toString();
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [bundleDir],
        };

        const getFileName = () => path.basename(document.uri.fsPath || document.uri.path);
        webviewPanel.webview.html = this.buildHtml(
            webviewPanel.webview, getFileName(), bundleUri('mdxViewer.js'), bundleUri('blpPreviewWebview.js'),
        );
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
                    await webviewPanel.webview.postMessage({
                        type: 'mdx',
                        mdxBase64: decoded.mdxBase64,
                        fileName: decoded.fileName,
                        format: decoded.format,
                    });
                } else {
                    await webviewPanel.webview.postMessage({ type: 'image', fileName, decoded });
                }
                dbg(`posted payload for ${fileName}`);
            } catch (error) {
                if (id !== requestId) return;
                const message = error instanceof Error ? error.message : String(error);
                await webviewPanel.webview.postMessage({ type: 'error', fileName, message });
                dbg(`render error for ${fileName}: ${message}`);
                offerIssueReport({
                    area: 'image/model preview',
                    message,
                    resource: document.uri,
                    details: error instanceof Error ? error.stack : undefined,
                });
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
            // The file changed on disk; textures that were missing may have arrived with it.
            const rerender = () => { cachedBytes = undefined; clearTextureMissCache(); requestRender(); };
            watcher.onDidChange(rerender);
            watcher.onDidCreate(rerender);
            webviewPanel.onDidDispose(() => watcher.dispose());
        }

        // eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
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
                clearTextureMissCache();
                requestRender();
                return;
            }
            if (type === 'previewError') {
                const message = (msg as { message?: unknown }).message;
                if (typeof message === 'string' && message) {
                    offerIssueReport({ area: 'model preview renderer', message, resource: document.uri });
                }
                return;
            }
            if (type === 'requestTextures') {
                const rawPaths = (msg as { paths?: unknown }).paths;
                if (!Array.isArray(rawPaths)) return;
                const texPaths: string[] = rawPaths.filter((p): p is string => typeof p === 'string');
                dbg(`texture request: ${texPaths.length} paths`);
                // Same resolver, payload cache and concurrency limit as the object editor's inline
                // model preview and the asset browser — this viewer used to carry its own copy.
                await postTexturesToWebview(texPaths, document.uri, webviewPanel.webview);
                return;
            }
            if (type === 'openTexture') {
                const fsPath = (msg as { fsPath?: unknown }).fsPath;
                if (typeof fsPath === 'string' && fsPath && fs.existsSync(fsPath)) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath));
                }
            }
        });
    }

    private buildHtml(webview: vscode.Webview, initialFileName: string, viewerScriptUri: string, pageScriptUri: string): string {
        const nonce = makeNonce();
        const fileName = escapeHtml(initialFileName);
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} blob: data:`,
            `script-src ${webview.cspSource} 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
        ].join('; ');

        return buildPage({
            csp,
            title: fileName,
            extraCss: BLP_PREVIEW_CSS,
            body: `
  <div class="wv-header">
    <div class="meta">
      <strong id="fileName">${fileName}</strong>
      <span id="fileMeta"> &mdash; Loading...</span>
    </div>
    <div class="blp-toolbar">
      <button class="wv-btn" id="zoomOutBtn" type="button" title="Zoom out">&minus;</button>
      <button class="wv-btn" id="zoomInBtn" type="button" title="Zoom in">+</button>
      <span id="zoomLabel" class="zoom-label">100%</span>
      ${sep().replace('wv-sep"', 'wv-sep" id="imgSep"')}
      <button class="wv-btn" id="fitBtn" type="button" title="Fit to viewport">Fit</button>
      <button class="wv-btn" id="alphaBtn" type="button" title="Toggle alpha channel display">Alpha</button>
      <div class="wv-sep" id="modelSep" style="display:none"></div>
      <button class="wv-btn" id="resetCamBtn" type="button" title="Reset camera" style="display:none">&#8635; Reset</button>
      <button class="wv-btn" id="renderModeBtn" type="button" title="Toggle wireframe" style="display:none">Fill</button>
      ${sep()}
      <button class="wv-btn" id="debugBtn" type="button" title="Toggle debug log">&#8801;</button>
    </div>
  </div>
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
        <div id="loadingOverlay" class="wv-loading-overlay visible" role="status" aria-live="polite" aria-busy="true" aria-hidden="false">
          <div class="wv-spinner"></div>
          <div id="loadingText" class="wv-loading-text">Loading...</div>
        </div>
      </div>
      <div id="warnings" class="warnings"></div>
      <div id="debugLog" class="debuglog"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${viewerScriptUri}"></script>
  <script nonce="${nonce}" src="${pageScriptUri}"></script>`,
        });
    }

}

function decodePreview(sourceBytes: Uint8Array, uri: vscode.Uri): DecodedBlpImage {
    const ext = path.extname(uri.fsPath || uri.path).toLowerCase();
    if (ext === '.mdx' || ext === '.mdl') {
        const mdxBase64 = Buffer.from(sourceBytes).toString('base64');
        const fileName = path.basename(uri.fsPath || uri.path);
        return { kind: 'mdx-raw', mdxBase64, fileName, format: ext === '.mdl' ? 'mdl' : 'mdx' };
    }
    return decodeRasterPreview(sourceBytes, ext);
}
