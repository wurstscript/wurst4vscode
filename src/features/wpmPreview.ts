'use strict';

/** VS Code preview for WC3 war3map.wpm (pathing). Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseWpm, serializeWpm, WpmFile } from 'casc-ts/formats';
import { EditableBinaryDocument, EditableBinaryEditorProvider } from './preview/framework';
import { escapeHtml, makeNonce } from './webviewUtils';
export { WpmFile } from 'casc-ts/formats';

export interface WpmFlagDefinition {
    bit: number;
    label: string;
    description: string;
    color: [number, number, number];
    primary?: boolean;
}

/** The only WPM header version with a documented byte layout. */
export const WPM_KNOWN_VERSION = 0;

export const WPM_FLAG_DEFS: readonly WpmFlagDefinition[] = [
    { bit: 0x01, label: 'Reserved', description: 'Reserved bit; standard maps normally leave it clear.', color: [160, 160, 160] },
    { bit: 0x02, label: 'Unwalkable', description: 'Ground units cannot walk through this cell.', color: [255, 0, 0], primary: true },
    { bit: 0x04, label: 'Unflyable', description: 'Flying units cannot pass through this cell.', color: [0, 255, 0], primary: true },
    { bit: 0x08, label: 'Unbuildable', description: 'Buildings cannot be placed on this cell.', color: [0, 0, 255], primary: true },
    { bit: 0x10, label: 'No Peon Harvest', description: 'Peons cannot harvest resources from this cell.', color: [240, 170, 40] },
    { bit: 0x20, label: 'Blighted', description: 'The cell is marked as blight.', color: [190, 80, 0] },
    { bit: 0x40, label: 'No Water / Unfloatable', description: 'The WC3 pathing state for no water / unfloatable movement. It is commonly set on ordinary dry ground; terrain water is stored in W3E.', color: [120, 120, 120] },
    { bit: 0x80, label: 'Unamphibious', description: 'The WC3 pathing state for amphibious movement.', color: [180, 80, 220] },
];

function blendWpmColor(base: [number, number, number], overlay: [number, number, number]): [number, number, number] {
    return [(base[0] + overlay[0]) >> 1, (base[1] + overlay[1]) >> 1, (base[2] + overlay[2]) >> 1];
}

export function wpmCellRgb(flag: number): [number, number, number] {
    let rgb: [number, number, number] = [0, 0, 0];
    for (const definition of WPM_FLAG_DEFS) {
        if ((flag & definition.bit) === 0) continue;
        if (definition.primary) {
            rgb = [
                definition.bit === 0x02 ? definition.color[0] : rgb[0],
                definition.bit === 0x04 ? definition.color[1] : rgb[1],
                definition.bit === 0x08 ? definition.color[2] : rgb[2],
            ];
        } else {
            rgb = blendWpmColor(rgb, definition.color);
        }
    }
    return rgb;
}

export function wpmFlagLabels(flag: number): string[] {
    return WPM_FLAG_DEFS.filter((definition) => (flag & definition.bit) !== 0).map((definition) => definition.label);
}

export function wpmColorTable(): Array<[number, number, number]> {
    return Array.from({ length: 256 }, (_, flag) => wpmCellRgb(flag));
}

// ── HTML Rendering ────────────────────────────────────────────────────────────

function buildWpmHtml(wpm: WpmFile, fileName: string, isDirty: boolean, scriptUri: string): string {
    const nonce = makeNonce();
    const colorTable = wpmColorTable();
    const initialJson = JSON.stringify({
        width: wpm.width,
        height: wpm.height,
        dataBase64: wpm.data.toString('base64'),
        colorTable,
        flagDefinitions: WPM_FLAG_DEFS.map(({ bit, label }) => ({ bit, label })),
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const paletteFlagsHtml = WPM_FLAG_DEFS.map((definition) => {
        const [r, g, b] = wpmCellRgb(definition.bit);
        return `<label class="flag-card" title="${escapeHtml(definition.description)}"><input type="checkbox" data-brush-bit="${definition.bit}"${definition.bit === 0x02 || definition.bit === 0x08 ? ' checked' : ''}><span class="swatch" style="background:rgb(${r},${g},${b})"></span><span class="flag-copy"><strong>${escapeHtml(definition.label)}</strong><small>0x${definition.bit.toString(16).padStart(2, '0').toUpperCase()}</small></span></label>`;
    }).join('');

    const versionWarning = wpm.version === WPM_KNOWN_VERSION
        ? ''
        : `<span class="version-warning" title="Only WPM version 0 has a documented byte layout. The editor preserves this version and its bytes.">Unverified WPM v${wpm.version}</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${escapeHtml(fileName)}</title>
<style>
  :root {
    --bg:       var(--vscode-editor-background);
    --panel:    var(--vscode-sideBar-background);
    --text:     var(--vscode-editor-foreground);
    --muted:    var(--vscode-descriptionForeground);
    --border:   var(--vscode-panel-border);
    --btn-bg:   var(--vscode-button-background);
    --btn-fg:   var(--vscode-button-foreground);
    --panel-strong: color-mix(in srgb, var(--panel) 84%, var(--bg));
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body {
    background: var(--bg); color: var(--text);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex-shrink: 0; min-width: 0;
  }
  .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { flex: 1; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .version-warning { color: var(--vscode-charts-orange); font-size: 11px; white-space: nowrap; }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex-shrink: 0; }
  .toolbar { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  button {
    border: none; background: transparent; color: var(--muted);
    padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: color-mix(in srgb, var(--btn-bg) 55%, transparent); color: var(--text); }
  button.active { background: var(--btn-bg); color: var(--btn-fg); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .dirty { color: var(--vscode-charts-orange); font-size: 11px; }
  #zoomLabel { min-width: 56px; text-align: center; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  #workspace { display: flex; flex: 1; min-height: 0; }
  #viewport {
    flex: 1; min-width: 0; overflow: hidden; position: relative;
    background: color-mix(in srgb, var(--bg) 60%, #000);
    cursor: grab;
  }
  #wpmCanvas { display: block; position: absolute; top: 0; left: 0; image-rendering: pixelated; }
  #tooltip {
    position: fixed; pointer-events: none;
    background: var(--panel); border: 1px solid var(--border);
    padding: 7px 10px; border-radius: 4px; font-size: 11px; display: none; z-index: 10;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); line-height: 1.7;
  }
  #palette {
    width: 238px; flex: 0 0 238px; padding: 12px 10px; overflow: auto;
    border-left: 1px solid var(--border); background: var(--panel); order: 2;
  }
  .palette-section { padding: 0 0 14px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
  .palette-section:last-child { border-bottom: 0; margin-bottom: 0; }
  .section-title { color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }
  .tools { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .tool { display: flex; align-items: center; gap: 7px; padding: 7px 8px; text-align: left; border: 1px solid transparent; }
  .tool .tool-icon { width: 18px; color: var(--muted); font-size: 15px; text-align: center; }
  .tool.active { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--btn-bg) 35%, transparent); color: var(--text); }
  .tool.active .tool-icon { color: var(--btn-fg); }
  .brush-size { display: flex; align-items: center; gap: 8px; }
  .brush-size input { flex: 1; min-width: 0; accent-color: var(--vscode-focusBorder); }
  .brush-size output { min-width: 35px; color: var(--text); font: 12px var(--vscode-editor-font-family); text-align: right; }
  .flag-grid { display: grid; gap: 4px; }
  .flag-card { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 4px; cursor: pointer; }
  .flag-card:hover { background: color-mix(in srgb, var(--btn-bg) 25%, transparent); }
  .flag-card input { margin: 0; accent-color: var(--vscode-focusBorder); }
  .swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(255,255,255,.25); flex: 0 0 16px; }
  .flag-copy { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; min-width: 0; flex: 1; }
  .flag-copy strong { font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flag-copy small { color: var(--muted); font: 10px var(--vscode-editor-font-family); }
  .brush-readout { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding: 7px 8px; border-radius: 4px; background: var(--panel-strong); }
  #brushValue { color: var(--text); font: 12px var(--vscode-editor-font-family); }
  #brushLabel { color: var(--muted); font-size: 11px; }
  .legend-list { display: grid; gap: 5px; }
  .legend-item { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 10px; }
  .legend-item .swatch { width: 12px; height: 12px; flex-basis: 12px; }
  .edit-hint { color: var(--muted); font-size: 10px; line-height: 1.45; }
  .edit-hint kbd { border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; color: var(--text); }
  @media (max-width: 680px) {
    #workspace { flex-direction: column; }
    #palette { width: 100%; flex-basis: auto; max-height: 270px; border-left: 0; border-top: 1px solid var(--border); }
    .flag-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
  <header>
    <span class="title">${escapeHtml(fileName)}</span>
    <span class="meta">${wpm.width} × ${wpm.height} &nbsp;·&nbsp; WPM v${wpm.version}</span>
    ${versionWarning}
    <span id="dirtyBadge" class="dirty"${isDirty ? '' : ' hidden'}>Modified</span>
    <div class="toolbar">
      <button id="btnZoomOut" title="Zoom out">−</button>
      <span id="zoomLabel">–</span>
      <button id="btnZoomIn" title="Zoom in">+</button>
      <div class="sep"></div>
      <button id="btnZoomFit">Fit</button>
    </div>
  </header>

  <div id="workspace">
    <div id="viewport">
      <canvas id="wpmCanvas"></canvas>
    </div>
    <aside id="palette" aria-label="Pathing paint palette">
      <section class="palette-section">
        <h2 class="section-title">Tools</h2>
        <div class="tools">
          <button type="button" class="tool active" data-tool="pan" title="Drag to move around the map"><span class="tool-icon">✥</span>Pan</button>
          <button type="button" class="tool" data-tool="paint" title="Paint the selected flags"><span class="tool-icon">✎</span>Brush</button>
          <button type="button" class="tool" data-tool="line" title="Draw a straight line"><span class="tool-icon">╱</span>Line</button>
          <button type="button" class="tool" data-tool="fill" title="Fill connected cells with the selected flags"><span class="tool-icon">▧</span>Fill</button>
          <button type="button" class="tool" data-tool="erase" title="Clear all flags"><span class="tool-icon">⌫</span>Erase</button>
        </div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Brush size</h2>
        <div class="brush-size"><input id="brushSize" type="range" min="1" max="32" value="1"><output id="brushSizeValue">1 × 1</output></div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Pathing flags</h2>
        <div class="flag-grid">${paletteFlagsHtml}</div>
        <div class="brush-readout"><span id="brushLabel">Selected</span><span id="brushValue">0x0A</span></div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">How to paint</h2>
        <div class="edit-hint"><kbd>Alt</kbd>-click any cell to sample its complete byte. Drag with Brush; click-drag with Line; click with Fill. Each gesture is one undo step.</div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Cell colors</h2>
        <div class="legend-list">${WPM_FLAG_DEFS.map((definition) => {
            const [r, g, b] = wpmCellRgb(definition.bit);
            return `<div class="legend-item" title="${escapeHtml(definition.description)}"><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${escapeHtml(definition.label)}</div>`;
        }).join('')}</div>
      </section>
    </aside>
  </div>
  <div id="tooltip"></div>

  <script nonce="${nonce}">window.__WPM_INITIAL__ = ${initialJson};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Editable document ─────────────────────────────────────────────────────────

class WpmDocument extends EditableBinaryDocument<WpmFile> {}

interface WpmRequestedRun {
    start: number;
    length: number;
    value: number;
}

interface WpmRunChange extends WpmRequestedRun {
    before: number;
    after: number;
}

interface WpmEditMessage {
    type?: string;
    changes?: Array<{ index?: number; value?: number }>;
    runs?: Array<{ start?: number; length?: number; value?: number }>;
}

function compactWpmRuns(changes: Array<{ index: number; value: number }>): WpmRequestedRun[] {
    const sorted = changes.slice().sort((a, b) => a.index - b.index);
    const runs: WpmRequestedRun[] = [];
    for (const change of sorted) {
        const previous = runs[runs.length - 1];
        if (previous && previous.start + previous.length === change.index && previous.value === change.value) {
            previous.length++;
        } else {
            runs.push({ start: change.index, length: 1, value: change.value });
        }
    }
    return runs;
}

function collectWpmCellRequests(changes: Array<{ index?: number; value?: number }>, dataLength: number): Map<number, number> {
    const requested = new Map<number, number>();
    for (const change of changes) {
        if (Number.isInteger(change.index) && Number.isInteger(change.value) &&
            (change.index as number) >= 0 && (change.index as number) < dataLength &&
            (change.value as number) >= 0 && (change.value as number) <= 0xff) {
            requested.set(change.index as number, change.value as number);
        }
    }
    return requested;
}

function collectWpmRunRequests(runs: Array<{ start?: number; length?: number; value?: number }>, dataLength: number): WpmRequestedRun[] {
    const requested: WpmRequestedRun[] = [];
    for (const run of runs) {
        const valid = Number.isInteger(run.start) && Number.isInteger(run.length) && Number.isInteger(run.value) &&
            (run.start as number) >= 0 && (run.length as number) >= 1 &&
            (run.start as number) + (run.length as number) <= dataLength &&
            (run.value as number) >= 0 && (run.value as number) <= 0xff;
        if (valid) requested.push({ start: run.start as number, length: run.length as number, value: run.value as number });
    }
    return requested.sort((a, b) => a.start - b.start);
}

function collectWpmRequests(message: WpmEditMessage, dataLength: number): WpmRequestedRun[] {
    if (message.type === 'editCells' && Array.isArray(message.changes)) {
        const requested = collectWpmCellRequests(message.changes, dataLength);
        return compactWpmRuns(Array.from(requested, ([index, value]) => ({ index, value })));
    }
    if (message.type === 'editRuns' && Array.isArray(message.runs)) {
        return collectWpmRunRequests(message.runs, dataLength);
    }
    return [];
}

function buildWpmRunChanges(data: Buffer, requested: WpmRequestedRun[]): WpmRunChange[] {
    const changes: WpmRunChange[] = [];
    for (const run of requested) {
        let start = run.start;
        let before = data[start];
        let length = 1;
        for (let offset = 1; offset < run.length; offset++) {
            const nextBefore = data[run.start + offset];
            if (nextBefore === before) {
                length++;
                continue;
            }
            if (before !== run.value) changes.push({ start, length, value: run.value, before, after: run.value });
            start = run.start + offset;
            before = nextBefore;
            length = 1;
        }
        if (before !== run.value) changes.push({ start, length, value: run.value, before, after: run.value });
    }
    return changes;
}

function wpmRunCellCount(changes: WpmRunChange[]): number {
    return changes.reduce((total, change) => total + change.length, 0);
}

/** Write one direction of a run change into the grid and mirror it to the webview canvas. */
function applyWpmRuns(doc: WpmDocument, changes: WpmRunChange[], useBefore: boolean): void {
    const patches: WpmRequestedRun[] = [];
    for (const change of changes) {
        const value = useBefore ? change.before : change.after;
        for (let index = change.start; index < change.start + change.length; index++) doc.file.data[index] = value;
        patches.push({ start: change.start, length: change.length, value });
    }
    void doc.webview?.postMessage({ type: 'applyRuns', runs: patches });
}

function handleWpmMessage(message: unknown, doc: WpmDocument, provider: WpmEditorProvider): void {
    if (!message || typeof message !== 'object') return;
    const requested = collectWpmRequests(message as WpmEditMessage, doc.file.data.length);
    if (!requested.length) return;
    const changes = buildWpmRunChanges(doc.file.data, requested);
    if (!changes.length) return;
    const changedCells = wpmRunCellCount(changes);
    const verb = changes.every((change) => change.after === 0) ? 'Erase' : 'Paint';
    provider.pushEdit(doc, `${verb} ${changedCells} pathing cell${changedCells === 1 ? '' : 's'}`, {
        apply: () => applyWpmRuns(doc, changes, false),
        revert: () => applyWpmRuns(doc, changes, true),
    });
}

class WpmEditorProvider extends EditableBinaryEditorProvider<WpmFile, WpmDocument> {
    constructor(extensionUri: vscode.Uri) {
        const bundleDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
        super({
            label: 'pathing map',
            parse: parseWpm,
            serialize: serializeValidatedWpm,
            createDocument: (uri, file) => new WpmDocument(uri, file),
            webviewOptions: { enableScripts: true, localResourceRoots: [bundleDir] },
            render: (doc) => buildWpmHtml(
                doc.file, doc.fileName, doc.isDirty,
                doc.webview!.asWebviewUri(vscode.Uri.joinPath(bundleDir, 'wpmEditorWebview.js')).toString(),
            ),
            // The canvas is patched incrementally through `applyRuns`; only the badge needs the state.
            postState: (doc) => { void doc.webview?.postMessage({ type: 'dirtyStateChanged', isDirty: doc.isDirty }); },
            handleMessage: handleWpmMessage,
        });
    }
}

/** Safety gate: never write a WPM that does not reproduce the complete edited grid. */
function serializeValidatedWpm(file: WpmFile, name: string): Buffer {
    if (file.error) throw new Error(`Refusing to save ${name}: the source file did not parse (${file.error}).`);
    const bytes = serializeWpm(file);
    const reparsed = parseWpm(bytes);
    if (reparsed.error) throw new Error(`Refusing to save ${name}: serialized data did not re-parse (${reparsed.error}).`);
    if (reparsed.version !== file.version || reparsed.width !== file.width || reparsed.height !== file.height ||
        !reparsed.data.equals(file.data) || !reparsed.tail?.equals(file.tail ?? Buffer.alloc(0))) {
        throw new Error(`Refusing to save ${name}: round-trip verification failed.`);
    }
    return bytes;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerWpmPreview(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [vscode.window.registerCustomEditorProvider(
        'wurst.wpmPreview',
        new WpmEditorProvider(context.extensionUri),
        { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } },
    )];
}
