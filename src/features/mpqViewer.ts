'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { MpqReader, MpqFileEntry } from './mpq/mpqReader';
import { makeNonce, escapeHtml } from './webviewUtils';

const MPQ_VIEW_TYPE = 'wurst.mpqViewer';

let _out: vscode.OutputChannel | null = null;
function getOut(): vscode.OutputChannel {
    if (!_out) _out = vscode.window.createOutputChannel('Wurst MPQ');
    return _out;
}
function log(msg: string): void {
    console.log('[MpqViewer] ' + msg);
    getOut().appendLine(msg);
}

// ---------------------------------------------------------------------------
// Custom document
// ---------------------------------------------------------------------------

interface MpqDocument extends vscode.CustomDocument {
    readonly entries: MpqFileEntry[];
    readonly reader: MpqReader | null;
    readonly parseError: string | null;
    readonly archiveSize: number;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class MpqViewerProvider implements vscode.CustomReadonlyEditorProvider<MpqDocument> {
    constructor(private readonly extensionUri: vscode.Uri) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<MpqDocument> {
        log(`openCustomDocument: ${uri.fsPath}`);
        let reader: MpqReader | null = null;
        let entries: MpqFileEntry[] = [];
        let parseError: string | null = null;
        let archiveSize = 0;

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            archiveSize = bytes.byteLength;
            const buf = Buffer.from(bytes);
            reader = MpqReader.open(buf);
            entries = reader.getFilesWithInfo();
            log(`MPQ opened: ${entries.length} files, ${archiveSize} bytes`);
        } catch (e) {
            parseError = e instanceof Error ? e.message : String(e);
            log(`ERROR in openCustomDocument: ${parseError}`);
        }

        return { uri, entries, reader, parseError, archiveSize, dispose() {} };
    }

    async resolveCustomEditor(
        document: MpqDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        log(`resolveCustomEditor: ${document.uri.fsPath}`);

        const scriptUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'mpqViewerWebview.js')
        );

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
        };

        const archiveName = path.basename(document.uri.fsPath || document.uri.path);
        const archiveDir  = path.dirname(document.uri.fsPath || document.uri.path);

        webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
            if (typeof msg !== 'object' || !msg) return;
            const type = (msg as { type?: string }).type;

            if (type === 'ready') {
                log('Webview ready');
                if (document.parseError) {
                    void webviewPanel.webview.postMessage({ type: 'error', message: document.parseError });
                } else {
                    void webviewPanel.webview.postMessage({
                        type: 'init',
                        entries: document.entries,
                        archiveSize: document.archiveSize,
                        archiveName,
                    });
                }
                return;
            }

            if (type === 'openFile') {
                const name = (msg as { name?: string }).name;
                if (!name || !document.reader) return;
                try {
                    const data = document.reader.readFile(name);
                    const tmpDir = path.join(os.tmpdir(), 'wurst_mpq_extract', archiveName);
                    const outPath = path.join(tmpDir, name.replace(/\\/g, path.sep));
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });
                    fs.writeFileSync(outPath, data);
                    void vscode.commands.executeCommand(
                        'vscode.open',
                        vscode.Uri.file(outPath),
                        { preview: false, preserveFocus: false }
                    );
                } catch (e) {
                    void vscode.window.showErrorMessage(
                        `Failed to extract ${name}: ${e instanceof Error ? e.message : String(e)}`
                    );
                }
                return;
            }

            if (type === 'extractAll') {
                if (!document.reader) return;
                const baseName = archiveName.replace(/\.[^.]+$/, '');
                const destDir = path.join(archiveDir, baseName + '-extracted');
                await extractAllFiles(document.reader, document.entries, destDir, `Extracted to ${destDir}`);
                return;
            }

            if (type === 'exportToMapFolder') {
                if (!document.reader) return;
                // Map folder mode: folder named exactly like the archive (e.g. MyMap.w3x/)
                // Since we can't have a file and folder with the same name, append -folder before ext
                const ext = path.extname(archiveName);
                const base = path.basename(archiveName, ext);
                const destDir = path.join(archiveDir, base + '-folder' + ext);
                await extractAllFiles(document.reader, document.entries, destDir,
                    `Map folder exported to ${destDir}\n\nThis folder can be used directly as a map in WC3 folder mode.`);
                return;
            }
        });

        webviewPanel.webview.html = buildHtml(webviewPanel.webview, archiveName, scriptUri);
        log('HTML set');
    }
}

async function extractAllFiles(
    reader: MpqReader,
    entries: MpqFileEntry[],
    destDir: string,
    successMessage: string,
): Promise<void> {
    try {
        fs.mkdirSync(destDir, { recursive: true });
        let failed = 0;
        for (const entry of entries) {
            try {
                const data = reader.readFile(entry.name);
                const outPath = path.join(destDir, entry.name.replace(/\\/g, path.sep));
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, data);
            } catch {
                failed++;
            }
        }
        const msg = failed > 0
            ? `${successMessage}\n\n${failed} file(s) could not be extracted.`
            : successMessage;
        const btn = await vscode.window.showInformationMessage(msg, 'Open Folder');
        if (btn === 'Open Folder') {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destDir));
        }
    } catch (e) {
        void vscode.window.showErrorMessage(
            `Extraction failed: ${e instanceof Error ? e.message : String(e)}`
        );
    }
}

// ---------------------------------------------------------------------------
// HTML shell — UI logic lives in dist/webview/mpqViewerWebview.js
// ---------------------------------------------------------------------------

function buildHtml(webview: vscode.Webview, archiveName: string, scriptUri: vscode.Uri): string {
    const nonce = makeNonce();
    const csp = [
        "default-src 'none'",
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(archiveName)}</title>
<style>
:root {
  --bg:         var(--vscode-editor-background);
  --sidebar:    var(--vscode-sideBar-background, var(--vscode-editor-background));
  --fg:         var(--vscode-editor-foreground);
  --muted:      var(--vscode-descriptionForeground);
  --border:     var(--vscode-panel-border, var(--vscode-widget-border, #454545));
  --hover:      var(--vscode-list-hoverBackground);
  --active:     var(--vscode-list-activeSelectionBackground);
  --active-fg:  var(--vscode-list-activeSelectionForeground, var(--vscode-editor-foreground));
  --input-bg:   var(--vscode-input-background);
  --input-fg:   var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border, transparent);
  --input-placeholder: var(--vscode-input-placeholderForeground);
  --icon-fg:    var(--vscode-icon-foreground, var(--vscode-editor-foreground));
  --btn-bg:     var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground));
  --btn-fg:     var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  --btn-hover:  var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-activeBackground));
  --font:       var(--vscode-font-family);
  --font-size:  var(--vscode-font-size, 13px);
  --mono:       var(--vscode-editor-font-family, monospace);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: var(--font-size);
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ── header ──────────────────────────────────────────────────────────────── */
.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
}
.header-icon { flex-shrink: 0; width: 20px; height: 20px; opacity: 0.85; }
.header-text { flex: 1; min-width: 0; }
.header-name {
  font-weight: 600;
  font-size: calc(var(--font-size) + 1px);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.header-stats { color: var(--muted); font-size: 11px; margin-top: 1px; }

/* ── toolbar ─────────────────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
}
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-family: var(--font);
  font-size: 11px;
  color: var(--btn-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.4;
}
.toolbar-btn svg { width: 13px; height: 13px; flex-shrink: 0; fill: currentColor; opacity: 0.85; }
.toolbar-btn:hover:not(:disabled) { background: var(--btn-hover); border-color: var(--border); }
.toolbar-btn:disabled { opacity: 0.4; cursor: default; }
.toolbar-sep { width: 1px; height: 16px; background: var(--border); margin: 0 2px; flex-shrink: 0; }

/* ── search ──────────────────────────────────────────────────────────────── */
.search-wrap {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
  display: flex; align-items: center; gap: 6px;
}
.search-icon { flex-shrink: 0; opacity: 0.5; }
.search-input {
  flex: 1;
  background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 3px;
  padding: 3px 7px;
  font-family: var(--font); font-size: var(--font-size);
  outline: none;
}
.search-input::placeholder { color: var(--input-placeholder); }
.search-input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.match-count { color: var(--muted); font-size: 11px; white-space: nowrap; }

/* ── tree ────────────────────────────────────────────────────────────────── */
.tree-wrap {
  flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 0;
}
.tree-wrap::-webkit-scrollbar { width: 8px; }
.tree-wrap::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4)); border-radius: 4px; }
.tree-wrap::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,.7)); }

.row {
  display: flex; align-items: center; gap: 5px;
  padding: 2px 4px 2px 0;
  cursor: pointer; user-select: none; min-height: 22px;
  position: relative;
}
.row:hover { background: var(--hover); }
.row.selected { background: var(--active); color: var(--active-fg); }
.row.selected .size, .row.selected .folder-meta { color: var(--active-fg); opacity: 0.75; }
.row.hidden { display: none !important; }

/* chevron */
.chevron {
  flex-shrink: 0; width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.12s ease;
  color: var(--icon-fg); opacity: 0.7;
}
.chevron svg { width: 10px; height: 10px; fill: currentColor; }
.collapsed .chevron { transform: rotate(-90deg); }

/* folder icon */
.folder-icon {
  flex-shrink: 0; width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  color: var(--vscode-symbolIcon-folderForeground, #dcb67a);
}
.folder-icon svg { width: 15px; height: 15px; fill: currentColor; }

.folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-meta { color: var(--muted); font-size: 11px; white-space: nowrap; flex-shrink: 0; margin-left: 4px; }

.children { overflow: hidden; }
.children.collapsed { display: none; }

/* badge */
.badge {
  flex-shrink: 0; font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
  padding: 1px 4px; border-radius: 3px; color: #fff;
  min-width: 26px; text-align: center; font-family: var(--mono);
}

.file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-desc {
  color: var(--muted);
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  color: var(--muted); font-size: 11px; white-space: nowrap;
  flex-shrink: 0; font-family: var(--mono); text-align: right; min-width: 52px;
}

/* inline open button — only shows on hover / selection */
.row-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  margin-left: 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  color: var(--icon-fg);
  opacity: 0;
  pointer-events: none;
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
}
.row-action svg { width: 13px; height: 13px; fill: currentColor; }
.row-action span { line-height: 1; }
.row:hover .row-action,
.row.selected .row-action {
  opacity: 0.92;
  pointer-events: auto;
}
.row-action:hover {
  background: var(--hover);
  border-color: var(--border);
  opacity: 1;
}
.row.selected .row-action:hover { background: rgba(255,255,255,0.15); }
.row.selected .file-desc,
.row.selected .size { color: var(--active-fg); opacity: 0.82; }

/* state / error */
.state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; gap: 8px; color: var(--muted); font-size: 13px; padding: 24px; text-align: center;
}
.state .err { color: var(--vscode-errorForeground, #f14c4c); font-size: 12px; max-width: 360px; }
</style>
</head>
<body>

<div class="header">
  <svg class="header-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1" y="3" width="14" height="11" rx="1.5" fill="var(--vscode-symbolIcon-folderForeground,#dcb67a)" opacity="0.9"/>
    <rect x="1" y="5" width="14" height="9" rx="1" fill="var(--vscode-symbolIcon-folderForeground,#dcb67a)"/>
    <rect x="1" y="2" width="6" height="4" rx="1" fill="var(--vscode-symbolIcon-folderForeground,#dcb67a)" opacity="0.7"/>
    <text x="8" y="11.5" text-anchor="middle" font-size="5" font-weight="bold" fill="#1e1e1e" font-family="monospace">MPQ</text>
  </svg>
  <div class="header-text">
    <div class="header-name" id="archiveName">Loading\u2026</div>
    <div class="header-stats" id="archiveStats"></div>
  </div>
</div>

<div class="toolbar">
  <button class="toolbar-btn" id="btnExtractAll" disabled title="Extract all files to a subfolder next to the archive">
    <svg viewBox="0 0 16 16"><path d="M8 1a.5.5 0 0 1 .5.5v7.793l2.646-2.647a.5.5 0 0 1 .708.708l-3.5 3.5a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L7.5 9.293V1.5A.5.5 0 0 1 8 1zM2.5 13a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11z"/></svg>
    Extract All
  </button>
  <div class="toolbar-sep"></div>
  <button class="toolbar-btn" id="btnExportFolder" disabled title="Export as map folder (WC3 folder mode) — creates a .w3x folder next to the archive">
    <svg viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.672a1.5 1.5 0 0 1 1.06.44l.83.83A1.5 1.5 0 0 0 9.12 3.7H13.5A1.5 1.5 0 0 1 15 5.2V5h-1v-.8a.5.5 0 0 0-.5-.5H9.12a2.5 2.5 0 0 1-1.768-.732l-.828-.828A.5.5 0 0 0 6.172 3H2.5a.5.5 0 0 0-.5.5V5H1V3.5zm0 2.5h14v6.5A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5V6zm6 2v2.293l-.646-.647a.5.5 0 0 0-.708.708l1.5 1.5a.5.5 0 0 0 .708 0l1.5-1.5a.5.5 0 0 0-.708-.708L8 10.293V8a.5.5 0 0 0-1 0z"/></svg>
    Export to Map Folder
  </button>
</div>

<div class="search-wrap">
  <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="var(--icon-fg)">
    <path d="M6.5 1a5.5 5.5 0 0 1 4.38 8.82l3.15 3.15-.71.71-3.15-3.15A5.5 5.5 0 1 1 6.5 1zm0 1a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/>
  </svg>
  <input class="search-input" id="searchInput" type="text" placeholder="Filter files\u2026" autocomplete="off" spellcheck="false">
  <span class="match-count" id="matchCount"></span>
</div>

<div class="tree-wrap" id="treeWrap">
  <div class="state"><span>Loading archive\u2026</span></div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMpqViewer(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new MpqViewerProvider(context.extensionUri);
    return vscode.window.registerCustomEditorProvider(MPQ_VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
    });
}
