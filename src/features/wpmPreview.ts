'use strict';

/** VS Code preview for WC3 war3map.wpm (pathing). Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseWpm, serializeWpm, WpmFile } from 'casc-ts/formats';
import { EditableBinaryDocument, EditableBinaryEditorProvider } from './preview/framework';
import { escapeHtml, makeNonce } from './webviewUtils';
import { buildPage, scriptSafeJson, sep } from './webviewShared';
import WPM_EDITOR_CSS from '../webview/wpmEditor.css';
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
    const initialJson = scriptSafeJson({
        width: wpm.width,
        height: wpm.height,
        dataBase64: wpm.data.toString('base64'),
        colorTable,
        flagDefinitions: WPM_FLAG_DEFS.map(({ bit, label }) => ({ bit, label })),
    });
    const paletteFlagsHtml = WPM_FLAG_DEFS.map((definition) => {
        const [r, g, b] = wpmCellRgb(definition.bit);
        return `<label class="flag-card" title="${escapeHtml(definition.description)}"><input type="checkbox" data-brush-bit="${definition.bit}"${definition.bit === 0x02 || definition.bit === 0x08 ? ' checked' : ''}><span class="swatch" style="background:rgb(${r},${g},${b})"></span><span class="flag-copy"><strong>${escapeHtml(definition.label)}</strong><small>0x${definition.bit.toString(16).padStart(2, '0').toUpperCase()}</small></span></label>`;
    }).join('');

    const versionWarning = wpm.version === WPM_KNOWN_VERSION
        ? ''
        : `<span class="version-warning" title="Only WPM version 0 has a documented byte layout. The editor preserves this version and its bytes.">Unverified WPM v${wpm.version}</span>`;

    return buildPage({
        csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`,
        title: escapeHtml(fileName),
        extraCss: WPM_EDITOR_CSS,
        body: `
  <header class="wv-header">
    <span class="title">${escapeHtml(fileName)}</span>
    <span class="meta">${wpm.width} × ${wpm.height} &nbsp;·&nbsp; WPM v${wpm.version}</span>
    ${versionWarning}
    <span id="dirtyBadge" class="wv-dirty"${isDirty ? '' : ' hidden'}>Modified</span>
    <div class="toolbar">
      <button id="btnZoomOut" class="wv-btn" title="Zoom out">−</button>
      <span id="zoomLabel">–</span>
      <button id="btnZoomIn" class="wv-btn" title="Zoom in">+</button>
      ${sep()}
      <button id="btnZoomFit" class="wv-btn">Fit</button>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>`,
    });
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
