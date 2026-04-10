'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';

const BLP_VIEW_TYPE = 'wurst.blpPreview';
const CONTENT_JPEG = 0;
const CONTENT_DIRECT = 1;
const MAX_DIMENSION = 65535;
const DDS_MAGIC = 0x20534444;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

type BlpDocument = vscode.CustomDocument;

type DecodedRasterImage =
    | {
          kind: 'raster';
          mode: 'rgba';
          width: number;
          height: number;
          rgbaBase64: string;
          warnings: string[];
          description: string;
      }
    | {
          kind: 'raster';
          mode: 'jpeg';
          width: number;
          height: number;
          jpegBase64: string;
          warnings: string[];
          description: string;
      };

type DecodedMdxRaw = {
    kind: 'mdx-raw';
    mdxBase64: string;
    fileName: string;
};

type DecodedBlpImage = DecodedRasterImage | DecodedMdxRaw;

class ByteReader {
    private pos = 0;

    constructor(private readonly bytes: Uint8Array) {}

    readChar4(): string {
        const chunk = this.readStrict(4, 'magic');
        return String.fromCharCode(chunk[0], chunk[1], chunk[2], chunk[3]);
    }

    readU8(name: string): number {
        return this.readStrict(1, name)[0];
    }

    readI32LE(name: string): number {
        const chunk = this.readStrict(4, name);
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        return view.getInt32(0, true);
    }

    readPadded(size: number, _fieldName: string): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(safeSize);
        const read = this.read(available);
        out.set(read, 0);
        return out;
    }

    read(size: number): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(available);
        out.set(this.bytes.subarray(this.pos, this.pos + available), 0);
        this.pos += available;
        return out;
    }

    remaining(): number {
        return this.bytes.length - this.pos;
    }

    size(): number {
        return this.bytes.length;
    }

    copy(offset: number, size: number): Uint8Array {
        if (offset < 0 || size <= 0 || offset >= this.bytes.length) {
            return new Uint8Array(0);
        }
        const available = Math.min(size, this.bytes.length - offset);
        return this.bytes.slice(offset, offset + available);
    }

    private readStrict(size: number, fieldName: string): Uint8Array {
        if (size < 0 || this.remaining() < size) {
            throw new Error(`${fieldName} is truncated`);
        }
        return this.read(size);
    }
}

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
        log(`cache dir: ${getCacheDir()}`);

        const testBlpPath = 'Textures\\Abomination.blp';
        log(`\nExtracting: ${testBlpPath}`);
        const result = await findCascTexture(testBlpPath, log);
        if (result) {
            log(`\nSUCCESS: ${result.ext} ${result.buf.length} bytes`);
            vscode.window.showInformationMessage(`CASC smoketest OK: ${result.ext} (${result.buf.length} bytes)`);
        } else {
            log(`\nFAILED`);
            vscode.window.showWarningMessage('CASC smoketest failed — see output');
        }
    });

    return vscode.Disposable.from(editorDisposable, testDisposable);
}

const WC3_DEFAULT_PATHS = [
    'C:\\Program Files (x86)\\Warcraft III',
    'C:\\Program Files\\Warcraft III',
    'D:\\Program Files (x86)\\Warcraft III',
    'D:\\Program Files\\Warcraft III',
];

/** Walk up from `startPath` until we find a directory containing a `Data` subdirectory. */
function findCascDataRoot(startPath: string): string | null {
    let dir = startPath;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(dir, 'Data'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function getCacheDir(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ws ? path.join(ws, '_build', 'casc_cache') : path.join(os.tmpdir(), 'wurst_casc_cache');
}

function getCascDataRoot(log: (msg: string) => void): string | null {
    let wc3path = vscode.workspace.getConfiguration('wurst').get<string>('wc3path', '');
    if (!wc3path) {
        const found = WC3_DEFAULT_PATHS.find(p => fs.existsSync(p));
        if (found) { log(`CASC wc3path not set, using default: ${found}`); wc3path = found; }
        else { log(`CASC skip: wurst.wc3path not set and no default path found`); return null; }
    }
    const dataRoot = findCascDataRoot(wc3path);
    if (!dataRoot) { log(`CASC skip: no Data/ folder found walking up from: ${wc3path}`); return null; }
    if (dataRoot !== wc3path) { log(`CASC resolved data root: ${dataRoot} (from ${wc3path})`); }
    return dataRoot;
}

/** Spawn casc-extract-worker.js (plain Node) to extract one file from CASC into outputFile. */
function cascExtractViaWorker(wc3Root: string, cascPath: string, outputFile: string): Promise<number> {
    const workerScript = path.join(__dirname, 'casc-extract-worker.js');
    // Use system node, not process.execPath (which is Electron)
    const nodeBin = 'node';
    return new Promise((resolve, reject) => {
        execFile(nodeBin, [workerScript, wc3Root, cascPath, outputFile], { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr || err.message)); return; }
            resolve(parseInt(stdout.trim(), 10) || 0);
        });
    });
}

/** Look up a texture. Checks disk cache first; if missing, extracts via child process and caches. */
async function findCascTexture(texPath: string, log: (msg: string) => void): Promise<{ buf: Buffer; ext: 'dds' | 'blp' } | null> {
    if (process.platform !== 'win32') {
        log('CASC skip: texture extraction from the WC3 game files is only available on Windows');
        return null;
    }
    const cacheDir = getCacheDir();
    // CASC paths are lowercase with backslash separators
    const normalized = texPath.replace(/\//g, '\\').toLowerCase();
    const ddsPath = normalized.replace(/\.blp$/, '.dds');

    // Check disk cache
    for (const [rel, ext] of [[ddsPath, 'dds'], [normalized, 'blp']] as const) {
        const cachePath = path.join(cacheDir, rel);
        if (fs.existsSync(cachePath)) {
            log(`CASC cache hit: ${rel}`);
            return { buf: fs.readFileSync(cachePath), ext };
        }
    }

    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return null;

    const candidates: Array<[string, 'dds' | 'blp']> = [
        [`war3.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:_hd.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:${normalized}`, 'blp'],
    ];

    for (const [cascPath, ext] of candidates) {
        const rel = ext === 'dds' ? ddsPath : normalized;
        const cachePath = path.join(cacheDir, rel);
        try {
            const bytes = await cascExtractViaWorker(wc3Root, cascPath, cachePath);
            log(`CASC extracted: ${cascPath} (${bytes} bytes) → ${cachePath}`);
            return { buf: fs.readFileSync(cachePath), ext };
        } catch (e) {
            log(`CASC miss: ${cascPath} — ${String(e)}`);
        }
    }
    return null;
}

/** Try to read a texture file from the local filesystem relative to the MDX file.
 *  Returns the buffer and the actual path found (may differ in extension). */
function findLocalTexture(texPath: string, mdxFsPath: string): { buf: Buffer; foundPath: string } | null {
    const normalized = texPath.replace(/\\/g, '/');
    // When the model references a .blp, also try the Reforged .dds equivalent.
    const alternates = [normalized];
    if (normalized.toLowerCase().endsWith('.blp')) {
        alternates.push(normalized.slice(0, -4) + '.dds');
    }
    const mdxDir = path.dirname(mdxFsPath);

    let dir = mdxDir;
    for (let i = 0; i < 4; i++) {
        for (const alt of alternates) {
            const candidate = path.join(dir, alt);
            if (fs.existsSync(candidate)) {
                return { buf: fs.readFileSync(candidate), foundPath: candidate };
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
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
                                const cacheDir = getCacheDir();
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

function decodeBlp(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeBlpInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading BLP: ${message}`);
    }
}

function decodeDds(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeDdsInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading DDS: ${message}`);
    }
}

function decodeTga(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeTgaInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading TGA: ${message}`);
    }
}

function decodeTgaInternal(src: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    if (src.length < 18) throw new Error('TGA header is truncated');

    const idLen        = src[0];
    const colorMapType = src[1];
    const imageType    = src[2];
    // image descriptor bytes
    const width  = src[12] | (src[13] << 8);
    const height = src[14] | (src[15] << 8);
    const bpp    = src[16]; // bits per pixel
    const descriptor = src[17];
    const originTop  = (descriptor & 0x20) !== 0; // bit 5: top-left origin

    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`invalid TGA dimensions ${width}x${height}`);
    }
    if (colorMapType !== 0) throw new Error('colour-mapped TGA not supported');

    // Supported types: 2 = uncompressed RGB/RGBA, 3 = uncompressed greyscale,
    //                  10 = RLE RGB/RGBA, 11 = RLE greyscale
    const isRle       = imageType === 10 || imageType === 11;
    const isGrey      = imageType === 3  || imageType === 11;
    const isRgb       = imageType === 2  || imageType === 10;
    if (!isRgb && !isGrey) throw new Error(`unsupported TGA image type ${imageType}`);

    const bytesPerPixel = bpp >> 3; // 3 = BGR, 4 = BGRA, 1 = grey
    if (bytesPerPixel !== 1 && bytesPerPixel !== 3 && bytesPerPixel !== 4) {
        throw new Error(`unsupported TGA bpp ${bpp}`);
    }

    let offset = 18 + idLen; // skip header + image ID
    const pixelCount = width * height;
    const rgba = new Uint8Array(pixelCount * 4);

    const readPixel = (dst: Uint8Array, dstOff: number): void => {
        if (isGrey) {
            const v = src[offset++];
            dst[dstOff]     = v;
            dst[dstOff + 1] = v;
            dst[dstOff + 2] = v;
            dst[dstOff + 3] = 255;
        } else if (bytesPerPixel === 3) {
            dst[dstOff]     = src[offset + 2]; // R
            dst[dstOff + 1] = src[offset + 1]; // G
            dst[dstOff + 2] = src[offset];     // B
            dst[dstOff + 3] = 255;
            offset += 3;
        } else {
            dst[dstOff]     = src[offset + 2]; // R
            dst[dstOff + 1] = src[offset + 1]; // G
            dst[dstOff + 2] = src[offset];     // B
            dst[dstOff + 3] = src[offset + 3]; // A
            offset += 4;
        }
    };

    if (!isRle) {
        for (let i = 0; i < pixelCount; i++) readPixel(rgba, i * 4);
    } else {
        let i = 0;
        while (i < pixelCount) {
            const rep = src[offset++];
            const count = (rep & 0x7f) + 1;
            if (rep & 0x80) {
                // RLE packet — read one pixel, repeat it
                const tmp = new Uint8Array(4);
                readPixel(tmp, 0);
                for (let c = 0; c < count && i < pixelCount; c++, i++) {
                    rgba[i * 4]     = tmp[0];
                    rgba[i * 4 + 1] = tmp[1];
                    rgba[i * 4 + 2] = tmp[2];
                    rgba[i * 4 + 3] = tmp[3];
                }
            } else {
                // Raw packet
                for (let c = 0; c < count && i < pixelCount; c++, i++) readPixel(rgba, i * 4);
            }
        }
    }

    // TGA default origin is bottom-left; flip vertically unless top-left flag is set
    if (!originTop) {
        const rowBytes = width * 4;
        const tmp = new Uint8Array(rowBytes);
        for (let y = 0; y < Math.floor(height / 2); y++) {
            const top = y * rowBytes;
            const bot = (height - 1 - y) * rowBytes;
            tmp.set(rgba.subarray(top, top + rowBytes));
            rgba.copyWithin(top, bot, bot + rowBytes);
            rgba.set(tmp, bot);
        }
    }

    const hasAlpha = bytesPerPixel === 4;
    if (!hasAlpha) warnings.push('No alpha channel — opacity set to 100%.');

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `TGA ${isRle ? 'RLE ' : ''}${isGrey ? 'Greyscale' : bpp === 32 ? 'RGBA' : 'RGB'} ${width}×${height}`,
    };
}

function decodeDdsInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    const readU32 = (offset: number, label: string): number => {
        if (offset < 0 || offset + 4 > sourceBytes.length) {
            throw new Error(`${label} is truncated`);
        }
        const view = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + offset, 4);
        return view.getUint32(0, true);
    };

    if (sourceBytes.length < 128) {
        throw new Error('DDS header is truncated');
    }
    const magic = readU32(0, 'magic');
    if (magic !== DDS_MAGIC) {
        throw new Error('invalid DDS magic');
    }

    const headerSize = readU32(4, 'headerSize');
    if (headerSize !== 124) {
        warn(`Unexpected DDS header size ${headerSize}, expected 124.`);
    }

    const height = readU32(12, 'height');
    const width = readU32(16, 'width');
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`invalid DDS dimensions ${width}x${height}`);
    }

    const mipMapCountRaw = readU32(28, 'mipMapCount');
    const mipMapCount = Math.max(1, mipMapCountRaw || 1);

    const pfSize = readU32(76, 'pixelFormatSize');
    const pfFlags = readU32(80, 'pixelFormatFlags');
    const fourCC = readU32(84, 'fourCC');
    const rgbBitCount = readU32(88, 'rgbBitCount');
    const rMask = readU32(92, 'rMask');
    const gMask = readU32(96, 'gMask');
    const bMask = readU32(100, 'bMask');
    const aMask = readU32(104, 'aMask');

    if (pfSize !== 32) {
        warn(`Unexpected DDS pixel format size ${pfSize}, expected 32.`);
    }

    const payload = sourceBytes.subarray(128);

    if ((pfFlags & DDPF_FOURCC) !== 0) {
        const fourCCText = fourCCToText(fourCC);
        let rgba: Uint8Array;
        if (fourCCText === 'DXT1') {
            rgba = decodeDxt1(payload, width, height, warn);
        } else if (fourCCText === 'DXT3') {
            rgba = decodeDxt3(payload, width, height, warn);
        } else if (fourCCText === 'DXT5') {
            rgba = decodeDxt5(payload, width, height, warn);
        } else {
            throw new Error(`unsupported DDS compression ${fourCCText}`);
        }
        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `DDS ${fourCCText} | mipmaps: ${mipMapCount}`,
        };
    }

    if ((pfFlags & DDPF_RGB) === 0 || rgbBitCount !== 32) {
        throw new Error(`unsupported DDS pixel format (flags=${pfFlags}, rgbBitCount=${rgbBitCount})`);
    }

    const pixelCount = safePixelCount(width, height);
    const expectedSize = pixelCount * 4;
    const pixelBytes = resizeChunk(payload, expectedSize, 'DDS RGBA payload', warn);
    const rgba = new Uint8Array(expectedSize);
    const alphaDefault = (pfFlags & DDPF_ALPHAPIXELS) !== 0 ? 0 : 255;

    for (let i = 0; i < pixelCount; i++) {
        const base = i * 4;
        const px = readU32FromArray(pixelBytes, base);
        rgba[base] = extractMaskedChannel(px, rMask, 255);
        rgba[base + 1] = extractMaskedChannel(px, gMask, 255);
        rgba[base + 2] = extractMaskedChannel(px, bMask, 255);
        rgba[base + 3] = extractMaskedChannel(px, aMask, alphaDefault);
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `DDS RGBA${(pfFlags & DDPF_ALPHAPIXELS) !== 0 ? '' : ' (opaque)'} | mipmaps: ${mipMapCount}`,
    };
}

function decodeBlpInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const reader = new ByteReader(sourceBytes);
    const warn = (msg: string) => warnings.push(msg);

    const startToken = reader.readChar4();
    if (!startToken.startsWith('BLP')) {
        throw new Error(`Invalid BLP magic: ${startToken}`);
    }

    const version = startToken.charCodeAt(3) - '0'.charCodeAt(0);
    if (version < 0 || version > 2) {
        throw new Error(`Unsupported BLP version ${version}`);
    }
    if (version === 0) {
        throw new Error('BLP0 is not supported (external bXX mipmap files required)');
    }

    const typeRaw = reader.readI32LE('contentType');
    let type = typeRaw;
    if (type !== CONTENT_JPEG && type !== CONTENT_DIRECT) {
        warn(`Invalid content type ${typeRaw}; defaulting to JPEG.`);
        type = CONTENT_JPEG;
    }

    let hasMipmaps = false;
    let pixmapType = 1;
    let alphaBits = 0;
    if (version >= 2) {
        pixmapType = reader.readU8('pixmapType');
        if (pixmapType < 1 || pixmapType > 3) {
            warn(`Invalid pixmapType ${pixmapType} for BLP2, continuing.`);
        }
        alphaBits = normalizeAlphaBits(reader.readU8('alphaBits'), type, warn);
        reader.readU8('sampleType');
        hasMipmaps = reader.readU8('hasMipmaps') !== 0;
    } else {
        const rawAlphaBits = reader.readI32LE('alphaBits');
        let normalizedRawBits = rawAlphaBits;
        if (rawAlphaBits !== 0 && rawAlphaBits !== 1 && rawAlphaBits !== 4 && rawAlphaBits !== 8) {
            if ((rawAlphaBits & 0x8) > 0) {
                warn(`BLP1 alphaBits ${rawAlphaBits} looked flag-encoded; treating as 8-bit alpha.`);
                normalizedRawBits = 8;
            }
        }
        alphaBits = normalizeAlphaBits(normalizedRawBits, type, warn);
    }

    const width = validateDimension('width', reader.readI32LE('width'), version);
    const height = validateDimension('height', reader.readI32LE('height'), version);
    const hasAlpha = alphaBits > 0;

    if (version < 2) {
        reader.readI32LE('unknownField');
        hasMipmaps = reader.readI32LE('hasMipmaps') !== 0;
    }
    const mipmapCount = getMipmapLevelCount(width, height, hasMipmaps);

    const mipmapOffsets = new Array<number>(16).fill(0);
    const mipmapSizes = new Array<number>(16).fill(0);
    for (let i = 0; i < 16; i++) {
        mipmapOffsets[i] = reader.readI32LE(`mipmapOffset${i}`);
    }
    for (let i = 0; i < 16; i++) {
        mipmapSizes[i] = reader.readI32LE(`mipmapSize${i}`);
    }

    if (type === CONTENT_JPEG) {
        const headerSize = reader.readI32LE('jpegHeaderSize');
        if (headerSize < 0) {
            throw new Error(`Invalid JPEG header size: ${headerSize}`);
        }
        if (headerSize > 0x270) {
            warn(`JPEG header size ${headerSize} exceeds recommended max of 624 bytes.`);
        }
        const headerBytes = reader.readPadded(headerSize, 'jpegHeader');
        const mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid JPEG mipmap level 0.');
        }
        const jpegBytes = new Uint8Array(headerBytes.length + mipmapData0.length);
        jpegBytes.set(headerBytes, 0);
        jpegBytes.set(mipmapData0, headerBytes.length);

        return {
            kind: 'raster',
            mode: 'jpeg',
            width,
            height,
            jpegBase64: Buffer.from(jpegBytes).toString('base64'),
            warnings,
            description: `BLP${version} JPEG | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 3) {
        const pixelCount = safePixelCount(width, height);
        const expectedChunkSize = pixelCount * 4;
        let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid BGRA mipmap level 0.');
        }
        mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'BGRA mipmap 0 payload', warn);

        const rgba = new Uint8Array(expectedChunkSize);
        for (let src = 0, dst = 0; src < mipmapData0.length; src += 4, dst += 4) {
            const blue = mipmapData0[src];
            const green = mipmapData0[src + 1];
            const red = mipmapData0[src + 2];
            const alpha = mipmapData0[src + 3];
            rgba[dst] = red;
            rgba[dst + 1] = green;
            rgba[dst + 2] = blue;
            rgba[dst + 3] = alpha;
        }

        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `BLP${version} direct BGRA | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 2) {
        throw new Error('BLP2 compressed sample (pixmapType=2) is not supported yet.');
    }

    const colorTableBytes = reader.readPadded(256 * 4, 'direct color table');

    const pixelCount = safePixelCount(width, height);
    const alphaSize = hasAlpha ? Math.floor((pixelCount * alphaBits + 7) / 8) : 0;
    const expectedChunkSize = pixelCount + alphaSize;

    let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
    if (mipmapData0.length === 0) {
        throw new Error('Missing or invalid direct mipmap level 0.');
    }
    mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'direct mipmap 0 payload', warn);

    const indexList = mipmapData0.subarray(0, pixelCount);
    const alphaList = hasAlpha ? mipmapData0.subarray(pixelCount, pixelCount + alphaSize) : new Uint8Array(0);
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const colorIndex = indexList[i] & 0xff;
        const paletteOffset = colorIndex * 4;
        rgba[i * 4] = colorTableBytes[paletteOffset + 2];
        rgba[i * 4 + 1] = colorTableBytes[paletteOffset + 1];
        rgba[i * 4 + 2] = colorTableBytes[paletteOffset];
        rgba[i * 4 + 3] = hasAlpha ? readAlpha(alphaList, i, alphaBits) : 0xff;
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `BLP${version} indexed direct | mipmaps: ${mipmapCount}`,
    };
}

function readAlpha(alphaData: Uint8Array, pixelIndex: number, alphaBits: number): number {
    if (alphaBits <= 0) return 0xff;
    if (alphaBits === 1) {
        const byteIndex = Math.floor(pixelIndex / 8);
        if (byteIndex >= alphaData.length) return 0xff;
        const bit = (alphaData[byteIndex] >> (pixelIndex % 8)) & 0x1;
        return bit === 0 ? 0x00 : 0xff;
    }
    if (alphaBits === 4) {
        const byteIndex = Math.floor(pixelIndex / 2);
        if (byteIndex >= alphaData.length) return 0xff;
        const nibble = pixelIndex % 2 === 0 ? alphaData[byteIndex] & 0x0f : (alphaData[byteIndex] >> 4) & 0x0f;
        return Math.floor((nibble * 0xff) / 0x0f);
    }
    if (pixelIndex >= alphaData.length) return 0xff;
    return alphaData[pixelIndex] & 0xff;
}

function normalizeAlphaBits(rawAlphaBits: number, contentType: number, warn: (msg: string) => void): number {
    if (contentType === CONTENT_JPEG) {
        if (rawAlphaBits === 0 || rawAlphaBits === 8) return rawAlphaBits;
        warn(`Invalid alphaBits ${rawAlphaBits} for JPEG; treating as 0.`);
        return 0;
    }
    if (rawAlphaBits === 0 || rawAlphaBits === 1 || rawAlphaBits === 4 || rawAlphaBits === 8) {
        return rawAlphaBits;
    }
    warn(`Invalid alphaBits ${rawAlphaBits} for direct content; treating as 0.`);
    return 0;
}

function getMipmapLevelCount(width: number, height: number, hasMipmaps: boolean): number {
    if (!hasMipmaps) return 1;
    let levels = 1;
    let maxDim = Math.max(width, height);
    while (maxDim > 1 && levels < 16) {
        maxDim = Math.max(1, Math.floor(maxDim / 2));
        levels++;
    }
    return levels;
}

function validateDimension(fieldName: string, value: number, version: number): number {
    if (value <= 0) {
        throw new Error(`${fieldName} ${value} is invalid`);
    }
    if (value > MAX_DIMENSION) {
        throw new Error(`${fieldName} ${value} exceeds max ${MAX_DIMENSION}`);
    }
    if (version === 0 && value > 512) {
        // BLP0 is unsupported anyway; this mirrors the Java diagnostic behavior.
    }
    return value;
}

function safePixelCount(width: number, height: number): number {
    const pixelCount = width * height;
    if (!Number.isFinite(pixelCount) || pixelCount <= 0 || pixelCount > 0x7fffffff) {
        throw new Error(`pixelCount ${pixelCount} is too large`);
    }
    return pixelCount;
}

function getMipmapChunk(
    reader: ByteReader,
    mipmapOffsets: number[],
    mipmapSizes: number[],
    mipmapLevel: number,
    warn: (msg: string) => void
): Uint8Array {
    if (mipmapLevel < 0 || mipmapLevel >= 16) return new Uint8Array(0);
    const offset = mipmapOffsets[mipmapLevel];
    const size = mipmapSizes[mipmapLevel];
    if (offset <= 0 || size <= 0) {
        warn(`Mipmap ${mipmapLevel} has invalid location offset=${offset} size=${size}.`);
        return new Uint8Array(0);
    }
    if (offset >= reader.size()) {
        warn(`Mipmap ${mipmapLevel} offset ${offset} is past EOF ${reader.size()}.`);
        return new Uint8Array(0);
    }
    const available = Math.min(size, reader.size() - offset);
    if (available < size) {
        warn(`Mipmap ${mipmapLevel} truncated at EOF (expected ${size}, got ${available}).`);
    }
    return reader.copy(offset, available);
}

function resizeChunk(
    src: Uint8Array,
    expectedSize: number,
    label: string,
    warn: (msg: string) => void
): Uint8Array {
    if (src.length === expectedSize) return src;
    if (src.length < expectedSize) {
        warn(`${label} smaller than expected (expected ${expectedSize}, got ${src.length}), padding with zeros.`);
    } else {
        warn(`${label} larger than expected (expected ${expectedSize}, got ${src.length}), truncating.`);
    }
    const out = new Uint8Array(expectedSize);
    out.set(src.subarray(0, Math.min(src.length, expectedSize)), 0);
    return out;
}

function makeNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 20; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fourCCToText(fourCC: number): string {
    const a = String.fromCharCode(fourCC & 0xff);
    const b = String.fromCharCode((fourCC >> 8) & 0xff);
    const c = String.fromCharCode((fourCC >> 16) & 0xff);
    const d = String.fromCharCode((fourCC >> 24) & 0xff);
    return `${a}${b}${c}${d}`;
}

function readU16FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readU32FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decode565(v: number): [number, number, number] {
    const r = (v >> 11) & 0x1f;
    const g = (v >> 5) & 0x3f;
    const b = v & 0x1f;
    return [
        Math.floor((r * 255 + 15) / 31),
        Math.floor((g * 255 + 31) / 63),
        Math.floor((b * 255 + 15) / 31),
    ];
}

function decodeDxtColors(c0: number, c1: number, transparentIfLte: boolean): Array<[number, number, number, number]> {
    const [r0, g0, b0] = decode565(c0);
    const [r1, g1, b1] = decode565(c1);
    const colors: Array<[number, number, number, number]> = [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
    ];

    if (transparentIfLte && c0 <= c1) {
        colors[2] = [Math.floor((r0 + r1) / 2), Math.floor((g0 + g1) / 2), Math.floor((b0 + b1) / 2), 255];
        colors[3] = [0, 0, 0, 0];
    } else {
        colors[2] = [
            Math.floor((2 * r0 + r1) / 3),
            Math.floor((2 * g0 + g1) / 3),
            Math.floor((2 * b0 + b1) / 3),
            255,
        ];
        colors[3] = [
            Math.floor((r0 + 2 * r1) / 3),
            Math.floor((g0 + 2 * g1) / 3),
            Math.floor((b0 + 2 * b1) / 3),
            255,
        ];
    }

    return colors;
}

function decodeDxt1(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 8;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT1 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const c0 = readU16FromArray(data, p);
            const c1 = readU16FromArray(data, p + 2);
            const idx = readU32FromArray(data, p + 4);
            p += 8;

            const colors = decodeDxtColors(c0, c1, true);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const code = (idx >> (2 * (py * 4 + px))) & 0x03;
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = c[3];
                }
            }
        }
    }
    return rgba;
}

function decodeDxt3(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT3 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const alphaLo = readU32FromArray(data, p);
            const alphaHi = readU32FromArray(data, p + 4);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const alphaNybble = pix < 8
                        ? (alphaLo >> (4 * pix)) & 0x0f
                        : (alphaHi >> (4 * (pix - 8))) & 0x0f;
                    const alpha = Math.floor((alphaNybble * 255) / 15);
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alpha;
                }
            }
        }
    }
    return rgba;
}

function decodeDxt5(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT5 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const a0 = data[p];
            const a1 = data[p + 1];
            const alphaIdx = data.subarray(p + 2, p + 8);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const alphas = new Uint8Array(8);
            alphas[0] = a0;
            alphas[1] = a1;
            if (a0 > a1) {
                alphas[2] = Math.floor((6 * a0 + a1) / 7);
                alphas[3] = Math.floor((5 * a0 + 2 * a1) / 7);
                alphas[4] = Math.floor((4 * a0 + 3 * a1) / 7);
                alphas[5] = Math.floor((3 * a0 + 4 * a1) / 7);
                alphas[6] = Math.floor((2 * a0 + 5 * a1) / 7);
                alphas[7] = Math.floor((a0 + 6 * a1) / 7);
            } else {
                alphas[2] = Math.floor((4 * a0 + a1) / 5);
                alphas[3] = Math.floor((3 * a0 + 2 * a1) / 5);
                alphas[4] = Math.floor((2 * a0 + 3 * a1) / 5);
                alphas[5] = Math.floor((a0 + 4 * a1) / 5);
                alphas[6] = 0;
                alphas[7] = 255;
            }

            const alphaBitsLo = (alphaIdx[0] | (alphaIdx[1] << 8) | (alphaIdx[2] << 16)) >>> 0;
            const alphaBitsHi = (alphaIdx[3] | (alphaIdx[4] << 8) | (alphaIdx[5] << 16)) >>> 0;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const bitPos = 3 * pix;
                    let aCode: number;
                    if (bitPos <= 21) {
                        aCode = (alphaBitsLo >> bitPos) & 0x07;
                    } else if (bitPos >= 24) {
                        aCode = (alphaBitsHi >> (bitPos - 24)) & 0x07;
                    } else {
                        const lowPart = (alphaBitsLo >> bitPos) & 0x03;
                        const highPart = (alphaBitsHi & 0x01) << 2;
                        aCode = lowPart | highPart;
                    }
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alphas[aCode];
                }
            }
        }
    }
    return rgba;
}

function trailingZeroBits(mask: number): number {
    let shift = 0;
    let m = mask >>> 0;
    while (shift < 32 && (m & 1) === 0) {
        m >>>= 1;
        shift++;
    }
    return shift;
}

function bitCount(mask: number): number {
    let m = mask >>> 0;
    let count = 0;
    while (m !== 0) {
        count += m & 1;
        m >>>= 1;
    }
    return count;
}

function extractMaskedChannel(pixel: number, mask: number, fallback: number): number {
    if (mask === 0) return fallback;
    const shift = trailingZeroBits(mask);
    const bits = bitCount(mask);
    if (bits <= 0) return fallback;
    const value = (pixel & mask) >>> shift;
    const max = (1 << bits) - 1;
    if (max <= 0) return fallback;
    return Math.floor((value * 255 + Math.floor(max / 2)) / max);
}
