'use strict';

/** VS Code previews for compact WC3 map data files without text syntax. */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BinReader, parseW3i as parseW3iFile, serializeW3i, W3iFile, W3iPlayer, W3iForce } from 'casc-ts/formats';
import { ParsedPreviewContext, registerParsedPreviewer } from './preview/framework';
import {
    loadTriggerStringsForUri, resolveTriggerString, ResolvedText, TriggerStringTable,
    findWtsUri, applyWtsEdits,
} from './preview/triggerStrings';
import { getCandidateRoots, resolveAssetPathWithCasc } from './imageAssetSupport';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';

type MapDataFile =
    | { kind: 'imp'; version: number; imports: ImpEntry[]; error?: string }
    | { kind: 'mmp'; version: number; icons: MmpIcon[]; error?: string }
    | { kind: 'shd'; width: number; height: number; bytes: Buffer; min: number; max: number; dimensionsSource: string; error?: string }
    | { kind: 'w3c'; version: number; cameras: W3cCamera[]; error?: string }
    | { kind: 'w3i'; info: W3iInfo; error?: string }
    | { kind: 'w3r'; version: number; regions: W3rRegion[]; error?: string }
    | { kind: 'w3e'; info: W3eInfo; error?: string }
    | { kind: 'generic'; label: string; bytes: Buffer; note: string; error?: string };

interface MmpIcon {
    type: number;
    label: string;
    x: number;
    y: number;
    color: string | null;
}

interface ImpEntry {
    mode: number;
    modeLabel: string;
    storedPath: string;
    effectivePath: string;
    fileType: string;
}

interface W3cCamera {
    targetX: number;
    targetY: number;
    zOffset: number;
    rotation: number;
    angleOfAttack: number;
    distance: number;
    roll: number;
    fieldOfView: number;
    farZ: number;
    unknown: number;
    name: string;
}

interface W3iInfo {
    version: number;
    saves: number;
    editorVersion: number;
    gameVersion?: string;
    name: string;
    author: string;
    description: string;
    recommendedPlayers: string;
    width: number;
    height: number;
    flags: number;
    tileset: string;
    loadingBackground?: number;
    loadingModel?: string;
    loadingTitle?: string;
    loadingText?: string;
    loadingSubtitle?: string;
    gameDataSet?: number;
    prologueTitle?: string;
    prologueText?: string;
    prologueSubtitle?: string;
    scriptLang?: string;
    graphics?: string;
    gameDataVersion?: string;
    forceCameraZoom?: { default: number; max: number; min: number };
    playersCount?: number;
    forcesCount?: number;
}

interface W3rRegion {
    name: string;
    index: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    weatherId: string;
    sound: string;
    color: string;
}

interface W3eInfo {
    magic: string;
    version: number;
    tileset: string;
    customTileset: boolean;
    groundTiles: string[];
    cliffTiles: string[];
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    payloadBytes: number;
}


function parseMapData(data: Buffer, fileName: string, context: ParsedPreviewContext): MapDataFile {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.imp') return parseImp(data, fileName);
    if (ext === '.mmp') return parseMmp(data);
    if (ext === '.shd') return parseShd(data, context);
    if (ext === '.w3c') return parseW3c(data);
    if (ext === '.w3i') return parseW3i(data);
    if (ext === '.w3r') return parseW3r(data);
    if (ext === '.w3e') return parseW3e(data);
    return parseGeneric(data, ext);
}

function parseImp(data: Buffer, fileName: string): MapDataFile {
    const r = new BinReader(data);
    const imports: ImpEntry[] = [];
    try {
        const version = r.readI32();
        const count = r.readI32();
        const prefix = path.basename(fileName).toLowerCase().startsWith('war3campaign.')
            ? 'war3campaignImported\\'
            : 'war3mapImported\\';
        for (let i = 0; i < count && !r.eof; i++) {
            const mode = r.readU8();
            const storedPath = normalizeWc3Path(r.readString());
            const effectivePath = impModeUsesStandardPrefix(mode)
                ? normalizeWc3Path(`${prefix}${storedPath}`)
                : storedPath;
            imports.push({
                mode,
                modeLabel: impModeLabel(mode),
                storedPath,
                effectivePath,
                fileType: importFileType(effectivePath),
            });
        }
        return { kind: 'imp', version, imports };
    } catch (e) {
        return { kind: 'imp', version: 0, imports, error: errorMessage(e) };
    }
}

function parseMmp(data: Buffer): MapDataFile {
    const r = new BinReader(data);
    try {
        const version = r.readI32();
        const count = r.readI32();
        const icons: MmpIcon[] = [];
        for (let i = 0; i < count; i++) {
            const type = r.readI32();
            const x = r.readI32();
            const y = r.readI32();
            const blue = r.readU8();
            const green = r.readU8();
            const red = r.readU8();
            const alpha = r.readU8();
            const color = blue === 0xff && green === 0xff && red === 0xff && alpha === 0xff
                ? null
                : `rgba(${red},${green},${blue},${(alpha / 255).toFixed(3)})`;
            icons.push({ type, label: mmpIconLabel(type), x, y, color });
        }
        return { kind: 'mmp', version, icons };
    } catch (e) {
        return { kind: 'mmp', version: 0, icons: [], error: errorMessage(e) };
    }
}

function parseShd(data: Buffer, context: ParsedPreviewContext): MapDataFile {
    const dimensions = inferShdDimensions(data.length, context.uri);
    let min = 255;
    let max = 0;
    for (const value of data) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (data.length === 0) min = 0;
    return { kind: 'shd', width: dimensions.width, height: dimensions.height, bytes: data, min, max, dimensionsSource: dimensions.source };
}

function inferShdDimensions(byteLength: number, uri: vscode.Uri): { width: number; height: number; source: string } {
    const fromTerrain = readSiblingW3eDimensions(uri);
    if (fromTerrain) {
        const tileWidth = Math.max(0, fromTerrain.width - 1);
        const tileHeight = Math.max(0, fromTerrain.height - 1);
        const width = tileWidth * 4;
        const height = tileHeight * 4;
        if (width > 0 && height > 0 && width * height === byteLength) {
            return { width, height, source: 'war3map.w3e tile size' };
        }

        const vertexWidth = fromTerrain.width * 4;
        const vertexHeight = fromTerrain.height * 4;
        if (vertexWidth > 0 && vertexHeight > 0 && vertexWidth * vertexHeight === byteLength) {
            return { width: vertexWidth, height: vertexHeight, source: 'war3map.w3e vertex size' };
        }
    }

    const side = Math.sqrt(byteLength);
    if (Number.isInteger(side)) {
        return { width: side, height: side, source: 'square byte count' };
    }

    const fallback = factorDimensions(byteLength);
    return { ...fallback, source: 'inferred from byte count' };
}

function readSiblingW3eDimensions(uri: vscode.Uri): { width: number; height: number } | undefined {
    if (uri.scheme !== 'file' || !uri.fsPath) return undefined;

    try {
        const dir = path.dirname(uri.fsPath);
        const entry = fs.readdirSync(dir).find((name) => name.toLowerCase() === 'war3map.w3e');
        if (!entry) return undefined;
        const r = new BinReader(fs.readFileSync(path.join(dir, entry)));
        r.skip(4); // magic
        r.skip(4); // version
        r.skip(1); // tileset
        r.skip(4); // custom tileset
        const groundCount = r.readI32();
        r.skip(groundCount * 4);
        const cliffCount = r.readI32();
        r.skip(cliffCount * 4);
        return { width: r.readI32(), height: r.readI32() };
    } catch {
        return undefined;
    }
}

function factorDimensions(byteLength: number): { width: number; height: number } {
    if (byteLength <= 0) return { width: 1, height: 1 };

    let bestWidth = byteLength;
    let bestHeight = 1;
    let bestScore = Number.POSITIVE_INFINITY;
    const limit = Math.floor(Math.sqrt(byteLength));
    for (let factor = 1; factor <= limit; factor++) {
        if (byteLength % factor !== 0) continue;
        const height = factor;
        const width = byteLength / factor;
        const ratio = width / height;
        const score = Math.abs(ratio - 2);
        if (score < bestScore) {
            bestScore = score;
            bestWidth = width;
            bestHeight = height;
        }
    }
    return { width: bestWidth, height: bestHeight };
}

function parseW3c(data: Buffer): MapDataFile {
    const r = new BinReader(data);
    try {
        const version = r.readI32();
        const count = r.readI32();
        const cameras: W3cCamera[] = [];
        for (let i = 0; i < count; i++) {
            cameras.push({
                targetX: r.readF32(),
                targetY: r.readF32(),
                zOffset: r.readF32(),
                rotation: r.readF32(),
                angleOfAttack: r.readF32(),
                distance: r.readF32(),
                roll: r.readF32(),
                fieldOfView: r.readF32(),
                farZ: r.readF32(),
                unknown: r.readF32(),
                name: r.readString(),
            });
        }
        return { kind: 'w3c', version, cameras };
    } catch (e) {
        return { kind: 'w3c', version: 0, cameras: [], error: errorMessage(e) };
    }
}

function parseW3i(data: Buffer): MapDataFile {
    const r = new BinReader(data);
    const info: W3iInfo = {
        version: 0,
        saves: 0,
        editorVersion: 0,
        name: '',
        author: '',
        description: '',
        recommendedPlayers: '',
        width: 0,
        height: 0,
        flags: 0,
        tileset: '',
    };

    try {
        info.version = r.readI32();
        info.saves = r.readI32();
        info.editorVersion = r.readI32();

        if (info.version >= 28) {
            const major = r.readU32();
            const minor = r.readU32();
            const rev = r.readU32();
            const build = r.readU32();
            info.gameVersion = `${major}.${minor}.${rev}.${build}`;
        }

        info.name = r.readString();
        info.author = r.readString();
        info.description = r.readString();
        info.recommendedPlayers = r.readString();

        r.skip(8 * 4); // camera bounds
        r.skip(4 * 4); // margins
        info.width = r.readI32();
        info.height = r.readI32();
        info.flags = r.readI32();
        info.tileset = String.fromCharCode(r.readU8());

        info.loadingBackground = r.readI32();
        if (info.version >= 25) info.loadingModel = r.readString();
        info.loadingText = r.readString();
        info.loadingTitle = r.readString();
        info.loadingSubtitle = r.readString();
        info.gameDataSet = r.readI32();

        r.readString(); // prologue path
        info.prologueText = r.readString();
        info.prologueTitle = r.readString();
        info.prologueSubtitle = r.readString();

        r.skip(4 + 4 + 4 + 4 + 4); // fog type/start/end/density/color
        r.skip(4); // global weather id
        r.readString(); // sound environment
        r.skip(1); // light environment tileset
        r.skip(4); // water color

        if (info.version >= 28) {
            info.scriptLang = r.readU32() === 1 ? 'Lua' : 'JASS';
        }
        if (info.version >= 31) {
            info.graphics = graphicsLabel(r.readU32());
            info.gameDataVersion = r.readU32() === 1 ? 'TFT' : 'RoC';
        }
        if (info.version >= 33) {
            info.forceCameraZoom = { default: r.readI32(), max: r.readI32(), min: r.readI32() };
        }

        if (!r.eof) info.playersCount = r.readI32();
        skipW3iPlayers(r, info.version, info.playersCount ?? 0);
        if (!r.eof) info.forcesCount = r.readI32();

        return { kind: 'w3i', info };
    } catch (e) {
        return { kind: 'w3i', info, error: errorMessage(e) };
    }
}

function parseW3r(data: Buffer): MapDataFile {
    const r = new BinReader(data);
    try {
        const version = r.readI32();
        const count = r.readI32();
        const regions: W3rRegion[] = [];
        for (let i = 0; i < count; i++) {
            const minX = r.readF32();
            const maxX = r.readF32();
            const minY = r.readF32();
            const maxY = r.readF32();
            const name = r.readString();
            const index = r.readI32();
            const weatherId = r.readId().replace(/\0/g, '');
            const sound = r.readString();
            const blue = r.readU8();
            const green = r.readU8();
            const red = r.readU8();
            r.readU8(); // end token
            regions.push({ name, index, minX, maxX, minY, maxY, weatherId, sound, color: `rgb(${red},${green},${blue})` });
        }
        return { kind: 'w3r', version, regions };
    } catch (e) {
        return { kind: 'w3r', version: 0, regions: [], error: errorMessage(e) };
    }
}

function parseW3e(data: Buffer): MapDataFile {
    const r = new BinReader(data);
    const info: W3eInfo = {
        magic: '',
        version: 0,
        tileset: '',
        customTileset: false,
        groundTiles: [],
        cliffTiles: [],
        width: 0,
        height: 0,
        centerX: 0,
        centerY: 0,
        payloadBytes: 0,
    };
    try {
        info.magic = r.readId();
        info.version = r.readI32();
        info.tileset = String.fromCharCode(r.readU8());
        info.customTileset = r.readI32() !== 0;
        const groundCount = r.readI32();
        for (let i = 0; i < groundCount; i++) info.groundTiles.push(r.readId());
        const cliffCount = r.readI32();
        for (let i = 0; i < cliffCount; i++) info.cliffTiles.push(r.readId());
        info.width = r.readI32();
        info.height = r.readI32();
        info.centerX = r.readF32();
        info.centerY = r.readF32();
        info.payloadBytes = r.remaining;
        return { kind: 'w3e', info };
    } catch (e) {
        return { kind: 'w3e', info, error: errorMessage(e) };
    }
}

function parseGeneric(data: Buffer, ext: string): MapDataFile {
    const labels: Record<string, [string, string]> = {
        '.w3s': ['Sound editor data', 'No detailed sound-data parser is wired yet.'],
        '.w3l': ['Custom text trigger list', 'No detailed trigger-list parser is wired yet.'],
        '.w3o': ['Object data bundle', 'Open extracted contained object files for detailed previews.'],
    };
    const [label, note] = labels[ext] ?? ['WC3 binary data', 'No detailed parser is wired yet.'];
    return { kind: 'generic', label, note, bytes: data };
}

function skipW3iPlayers(r: BinReader, version: number, count: number): void {
    for (let i = 0; i < count && !r.eof; i++) {
        r.skip(4); // num
        r.skip(4); // type
        r.skip(4); // race
        r.skip(4); // fixed start
        r.readString(); // name
        r.skip(4 + 4); // start x/y
        r.skip(4 + 4); // ally low/high
        if (version >= 31) r.skip(4 + 4); // enemy low/high
    }
}

function renderMapData(parsed: MapDataFile, fileName: string, context: ParsedPreviewContext): string {
    const triggerStrings = loadTriggerStringsForUri(context.uri);
    if (parsed.kind === 'imp') return renderImp(parsed, fileName);
    if (parsed.kind === 'mmp') return renderMmp(parsed, fileName);
    if (parsed.kind === 'shd') return renderShd(parsed, fileName);
    if (parsed.kind === 'w3c') return renderW3c(parsed, fileName, triggerStrings);
    if (parsed.kind === 'w3i') return renderW3i(parsed, fileName, triggerStrings);
    if (parsed.kind === 'w3r') return renderW3r(parsed, fileName, triggerStrings);
    if (parsed.kind === 'w3e') return renderW3e(parsed, fileName);
    return renderGeneric(parsed, fileName);
}

function page(title: string, body: string, extraCss = '', scripts = false): string {
    return buildPage({
        csp: scripts
            ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
            : "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(title),
        extraCss: `
.content { flex: 1; overflow: auto; }
.md-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 9px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
}
.md-title {
  color: var(--vscode-textLink-foreground, var(--fg));
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.md-meta { color: var(--muted); font-size: 12px; margin-top: 1px; }
.readonly-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.dialog { max-width: 1060px; padding: 14px 16px 22px; }
h2 {
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 9px;
}
.section {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 14px;
}
.section:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 9px 12px;
}
.form-grid.compact { grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }
.field { min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  margin-bottom: 3px;
}
.source-pill {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 0 4px;
  color: var(--vscode-textLink-foreground, var(--muted));
  font-family: var(--mono);
  font-size: 10px;
}
.source-pill.missing {
  color: var(--vscode-errorForeground, #f14c4c);
}
.field-control {
  width: 100%;
  min-width: 0;
  height: 26px;
  padding: 3px 6px;
  color: var(--input-fg);
  background: var(--input-bg);
  border: 1px solid var(--input-border, var(--border));
  border-radius: 2px;
  font: inherit;
  line-height: 18px;
}
textarea.field-control {
  height: auto;
  min-height: 58px;
  resize: none;
  line-height: 1.35;
}
.field-control:disabled {
  opacity: 1;
  cursor: default;
}
.field-control.mono { font-family: var(--mono); }
.checkbox-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 7px 14px;
}
.check-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  min-width: 0;
  color: var(--fg);
}
.check-row input {
  flex: 0 0 auto;
  margin: 1px 0 0;
  accent-color: var(--vscode-checkbox-selectBackground, var(--vscode-button-background));
}
.check-row input:disabled { opacity: 1; }
.check-row span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.empty { color: var(--muted); font-style: italic; }
.error {
  color: var(--vscode-errorForeground, #f14c4c);
  border: 1px solid color-mix(in srgb, currentColor 65%, transparent);
  padding: 7px 9px;
  margin-bottom: 12px;
  border-radius: 2px;
}
.table-wrap {
  overflow: auto;
  border: 1px solid var(--border);
}
table { border-collapse: collapse; width: 100%; font-size: 12px; min-width: 620px; }
th {
  text-align: left;
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--sidebar));
  border-bottom: 1px solid var(--border);
  padding: 6px 8px;
  font-weight: 600;
}
td {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  padding: 5px 8px;
  vertical-align: top;
}
tbody tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-family: var(--mono); }
td.mono { font-family: var(--mono); }
.metric-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.metric {
  border: 1px solid var(--border);
  background: var(--input-bg);
  padding: 4px 7px;
  border-radius: 2px;
  color: var(--muted);
  font-size: 12px;
}
.metric strong { color: var(--fg); font-weight: 600; }
.tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
.tag {
  border: 1px solid var(--border);
  background: var(--input-bg);
  border-radius: 2px;
  padding: 2px 6px;
  font-family: var(--mono);
  font-size: 12px;
}
canvas {
  image-rendering: pixelated;
  max-width: min(100%, 768px);
  border: 1px solid var(--border);
  background: var(--vscode-editor-background, #1e1e1e);
}
.swatch { display:inline-block; width:12px; height:12px; border:1px solid var(--border); vertical-align:-2px; margin-right:6px; }
${extraCss}`,
        body: `<div class="content">${body}</div>`,
    });
}

function renderImp(parsed: Extract<MapDataFile, { kind: 'imp' }>, fileName: string): string {
    const standardCount = parsed.imports.filter((entry) => impModeUsesStandardPrefix(entry.mode)).length;
    const customCount = parsed.imports.filter((entry) => impModeUsesCustomPath(entry.mode)).length;
    const unknownCount = parsed.imports.length - standardCount - customCount;
    const rows = parsed.imports.map((entry, index) => `<tr>
  <td class="num">${index}</td>
  <td><span class="tag">${escapeHtml(entry.fileType)}</span></td>
  <td>${escapeHtml(entry.modeLabel)} <span class="source-pill" title="Raw import mode byte">${entry.mode}</span></td>
  <td class="mono">${escapeHtml(entry.storedPath || '-')}</td>
  <td class="mono">${escapeHtml(entry.effectivePath || '-')}</td>
</tr>`).join('');
    return page(fileName, `
${renderHeader(fileName, `WC3 import table - v${parsed.version}`)}
<div class="dialog">
${errorBanner(parsed.error)}
<div class="metric-strip">
  <span class="metric"><strong>${parsed.imports.length}</strong> import${parsed.imports.length === 1 ? '' : 's'}</span>
  <span class="metric"><strong>${standardCount}</strong> standard-path</span>
  <span class="metric"><strong>${customCount}</strong> custom-path</span>
  ${unknownCount ? `<span class="metric"><strong>${unknownCount}</strong> unknown-mode</span>` : ''}
</div>
${parsed.imports.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Type</th><th>Path Mode</th><th>Stored Path</th><th>Effective Map Path</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No imported files</p>'}
</div>`);
}

function renderMmp(parsed: Extract<MapDataFile, { kind: 'mmp' }>, fileName: string): string {
    const rows = parsed.icons.map((icon, index) => `<tr>
  <td class="num">${index}</td>
  <td>${escapeHtml(icon.label)}</td>
  <td class="num">${icon.x}</td>
  <td class="num">${icon.y}</td>
  <td>${icon.color ? `<span class="swatch" style="background:${icon.color}"></span>${escapeHtml(icon.color)}` : '<span class="empty">default</span>'}</td>
</tr>`).join('');
    return page(fileName, `
${renderHeader(fileName, `WC3 minimap icons - v${parsed.version}`)}
<div class="dialog">
${errorBanner(parsed.error)}
${parsed.icons.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Type</th><th>X</th><th>Y</th><th>Color</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No minimap icons</p>'}
</div>`);
}

function renderShd(parsed: Extract<MapDataFile, { kind: 'shd' }>, fileName: string): string {
    const base64 = parsed.bytes.toString('base64');
    return page(fileName, `
${renderHeader(fileName, 'WC3 shadow map')}
<div class="dialog">
${errorBanner(parsed.error)}
<div class="metric-strip">
  <span class="metric"><strong>${parsed.width} x ${parsed.height}</strong></span>
  <span class="metric"><strong>${parsed.bytes.length}</strong> bytes</span>
  <span class="metric">values <strong>${parsed.min}..${parsed.max}</strong></span>
  <span class="metric">size from <strong>${escapeHtml(parsed.dimensionsSource)}</strong></span>
</div>
<canvas id="shdCanvas" width="${parsed.width}" height="${parsed.height}"></canvas>
</div>
<script>
const raw = atob("${base64}");
const w = ${parsed.width};
const h = ${parsed.height};
const canvas = document.getElementById('shdCanvas');
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(w, h);
for (let y = 0; y < h; y++) {
  const srcRow = h - 1 - y;
  for (let x = 0; x < w; x++) {
    const i = srcRow * w + x;
    const v = i < raw.length ? raw.charCodeAt(i) : 0;
    const shade = 255 - v;
    const p = (y * w + x) * 4;
    img.data[p] = shade;
    img.data[p + 1] = shade;
    img.data[p + 2] = shade;
    img.data[p + 3] = 255;
  }
}
ctx.putImageData(img, 0, 0);
</script>`, '', true);
}

function renderW3c(parsed: Extract<MapDataFile, { kind: 'w3c' }>, fileName: string, triggerStrings: TriggerStringTable): string {
    const rows = parsed.cameras.map((camera, index) => `<tr>
  <td class="num">${index}</td>
  <td>${renderResolvedInline(resolveTriggerString(camera.name || '(unnamed)', triggerStrings))}</td>
  <td class="num">${fmt(camera.targetX)}</td>
  <td class="num">${fmt(camera.targetY)}</td>
  <td class="num">${fmt(camera.zOffset)}</td>
  <td class="num">${fmt(camera.rotation)}</td>
  <td class="num">${fmt(camera.angleOfAttack)}</td>
  <td class="num">${fmt(camera.distance)}</td>
  <td class="num">${fmt(camera.fieldOfView)}</td>
</tr>`).join('');
    return page(fileName, `
${renderHeader(fileName, `WC3 cameras - v${parsed.version}`)}
<div class="dialog">
${errorBanner(parsed.error)}
${parsed.cameras.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Target X</th><th>Target Y</th><th>Z</th><th>Rot</th><th>AoA</th><th>Dist</th><th>FOV</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No cameras</p>'}
</div>`);
}

function renderW3i(parsed: Extract<MapDataFile, { kind: 'w3i' }>, fileName: string, triggerStrings: TriggerStringTable): string {
    const info = parsed.info;
    return page(fileName, `
${renderHeader(fileName, 'WC3 map information')}
<div class="dialog">
${errorBanner(parsed.error)}
<section class="section">
  <h2>General</h2>
  <div class="form-grid">
    ${renderInput('Map name', resolveTriggerString(info.name, triggerStrings))}
    ${renderInput('Author', resolveTriggerString(info.author, triggerStrings))}
    ${renderInput('Recommended players', resolveTriggerString(info.recommendedPlayers, triggerStrings))}
    ${renderSelect('Tileset', info.tileset, tilesetOptions())}
    ${renderInput('Width', info.width || undefined, 'mono')}
    ${renderInput('Height', info.height || undefined, 'mono')}
    ${renderSelect('Script language', info.scriptLang, optionList(['JASS', 'Lua']))}
    ${renderSelect('Graphics mode', info.graphics, optionList(['SD', 'HD', 'SD and HD']))}
  </div>
</section>
<section class="section">
  <h2>Description</h2>
  ${renderTextarea('Description', resolveTriggerString(info.description, triggerStrings), true)}
</section>
<section class="section">
  <h2>Options</h2>
  <div class="checkbox-grid">
    ${W3I_FLAG_DEFS.map(([bit, label]) => renderCheckbox(label, (info.flags & bit) !== 0)).join('')}
  </div>
</section>
<section class="section">
  <h2>Loading Screen</h2>
  <div class="form-grid">
    ${renderSelect('Background', info.loadingBackground, loadingBackgroundOptions())}
    ${renderInput('Model', resolveTriggerString(info.loadingModel, triggerStrings))}
    ${renderInput('Title', resolveTriggerString(info.loadingTitle, triggerStrings))}
    ${renderInput('Subtitle', resolveTriggerString(info.loadingSubtitle, triggerStrings))}
    ${renderTextarea('Text', resolveTriggerString(info.loadingText, triggerStrings), true)}
  </div>
</section>
<section class="section">
  <h2>Prologue</h2>
  <div class="form-grid">
    ${renderInput('Title', resolveTriggerString(info.prologueTitle, triggerStrings))}
    ${renderInput('Subtitle', resolveTriggerString(info.prologueSubtitle, triggerStrings))}
    ${renderTextarea('Text', resolveTriggerString(info.prologueText, triggerStrings), true)}
  </div>
</section>
<section class="section">
  <h2>Technical</h2>
  <div class="form-grid compact">
    ${renderInput('Format version', info.version, 'mono')}
    ${renderInput('Editor version', info.editorVersion, 'mono')}
    ${renderInput('Game version', info.gameVersion, 'mono')}
    ${renderInput('Saves', info.saves, 'mono')}
    ${renderInput('Flags', `0x${(info.flags >>> 0).toString(16).padStart(8, '0')}`, 'mono')}
    ${renderSelect('Game data', info.gameDataVersion, optionList(['RoC', 'TFT']))}
    ${renderInput('Game data set', info.gameDataSet, 'mono')}
    ${renderInput('Camera zoom', info.forceCameraZoom ? `${info.forceCameraZoom.min}..${info.forceCameraZoom.max} (default ${info.forceCameraZoom.default})` : undefined, 'mono')}
    ${renderInput('Players', info.playersCount, 'mono')}
    ${renderInput('Forces', info.forcesCount, 'mono')}
  </div>
</section>
</div>`);
}

function renderW3r(parsed: Extract<MapDataFile, { kind: 'w3r' }>, fileName: string, triggerStrings: TriggerStringTable): string {
    const rows = parsed.regions.map((region) => `<tr>
  <td class="num">${region.index}</td>
  <td>${renderResolvedInline(resolveTriggerString(region.name || '(unnamed)', triggerStrings))}</td>
  <td class="num">${fmt(region.minX)}</td>
  <td class="num">${fmt(region.maxX)}</td>
  <td class="num">${fmt(region.minY)}</td>
  <td class="num">${fmt(region.maxY)}</td>
  <td class="mono">${escapeHtml(region.weatherId || '-')}</td>
  <td>${renderResolvedInline(resolveTriggerString(region.sound || '-', triggerStrings))}</td>
  <td><span class="swatch" style="background:${region.color}"></span>${escapeHtml(region.color)}</td>
</tr>`).join('');
    return page(fileName, `
${renderHeader(fileName, `WC3 regions - v${parsed.version}`)}
<div class="dialog">
${errorBanner(parsed.error)}
${parsed.regions.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Min X</th><th>Max X</th><th>Min Y</th><th>Max Y</th><th>Weather</th><th>Sound</th><th>Color</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No regions</p>'}
</div>`);
}

function renderW3e(parsed: Extract<MapDataFile, { kind: 'w3e' }>, fileName: string): string {
    const info = parsed.info;
    return page(fileName, `
${renderHeader(fileName, 'WC3 terrain data')}
<div class="dialog">
${errorBanner(parsed.error)}
<section class="section">
  <h2>Terrain</h2>
  <div class="form-grid compact">
    ${renderInput('Magic', info.magic, 'mono')}
    ${renderInput('Version', info.version, 'mono')}
    ${renderSelect('Tileset', info.tileset, tilesetOptions())}
    ${renderInput('Width', info.width || undefined, 'mono')}
    ${renderInput('Height', info.height || undefined, 'mono')}
    ${renderInput('Center', `${fmt(info.centerX)}, ${fmt(info.centerY)}`, 'mono')}
    ${renderInput('Tile payload', `${info.payloadBytes} bytes`, 'mono')}
  </div>
</section>
<section class="section">
  <h2>Tiles</h2>
  <div class="checkbox-grid">${renderCheckbox('Custom tileset', info.customTileset)}</div>
  <div class="form-grid">
    ${renderTagField('Ground tiles', info.groundTiles)}
    ${renderTagField('Cliff tiles', info.cliffTiles)}
  </div>
</section>
</div>`);
}

function renderGeneric(parsed: Extract<MapDataFile, { kind: 'generic' }>, fileName: string): string {
    const preview = Array.from(parsed.bytes.subarray(0, 128))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(' ');
    return page(fileName, `
${renderHeader(fileName, `${parsed.label} - ${parsed.bytes.length} bytes`)}
<div class="dialog">
${errorBanner(parsed.error)}
<section class="section">
  <h2>Summary</h2>
  ${renderTextarea('Status', parsed.note, true)}
</section>
<section class="section">
  <h2>Header Bytes</h2>
  ${renderTextarea('First 128 bytes', preview || '(empty)', true, 'mono')}
</section>
</div>`);
}

type SelectOption = { value: string; label: string };
type ControlValue = string | number | undefined;

function renderHeader(fileName: string, meta: string, editable = false): string {
    const badge = editable
        ? `<span class="dirty-badge" id="dirtyBadge" hidden>● unsaved</span>`
        : `<span class="readonly-badge">read-only</span>`;
    return `<div class="md-header">
  <div>
    <div class="md-title">${escapeHtml(fileName)}</div>
    <div class="md-meta">${escapeHtml(meta)}${badge}</div>
  </div>
</div>`;
}

function renderInput(label: string, value: string | number | ResolvedText | undefined, className = ''): string {
    const resolved = normalizeResolvedText(value);
    const classes = ['field-control', className].filter(Boolean).join(' ');
    return `<label class="field">
  ${renderFieldLabel(label, resolved)}
  <input class="${classes}" value="${escapeHtml(controlValue(resolved.value))}" placeholder="-" disabled>
</label>`;
}

function renderTextarea(label: string, value: string | ResolvedText | undefined, wide = false, className = ''): string {
    const resolved = normalizeResolvedText(value);
    const fieldClass = wide ? 'field wide' : 'field';
    const classes = ['field-control', className].filter(Boolean).join(' ');
    return `<label class="${fieldClass}">
  ${renderFieldLabel(label, resolved)}
  <textarea class="${classes}" placeholder="-" disabled>${escapeHtml(controlValue(resolved.value))}</textarea>
</label>`;
}

function renderSelect(label: string, value: ControlValue, options: SelectOption[]): string {
    const selected = controlValue(value);
    const normalizedOptions = options.some((option) => option.value === selected) || selected === ''
        ? options
        : [{ value: selected, label: selected }, ...options];
    const renderedOptions = [
        { value: '', label: '-' },
        ...normalizedOptions,
    ].map((option) => {
        const attr = option.value === selected ? ' selected' : '';
        return `<option value="${escapeHtml(option.value)}"${attr}>${escapeHtml(option.label)}</option>`;
    }).join('');
    return `<label class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <select class="field-control" disabled>${renderedOptions}</select>
</label>`;
}

function renderCheckbox(label: string, checked: boolean): string {
    return `<label class="check-row">
  <input type="checkbox" ${checked ? 'checked ' : ''}disabled>
  <span>${escapeHtml(label)}</span>
</label>`;
}

function sourcePillHtml(value: ResolvedText, leadingSpace: boolean): string {
    if (!value.source) return '';
    const missingClass = value.missing ? ' missing' : '';
    const title = value.missing ? `${value.source} not found in war3map.wts` : `Resolved from ${value.source}`;
    const prefix = leadingSpace ? ' ' : '';
    return `${prefix}<span class="source-pill${missingClass}" title="${escapeHtml(title)}">${escapeHtml(value.source)}</span>`;
}

function renderFieldLabel(label: string, value: ResolvedText): string {
    return `<span class="field-label"><span>${escapeHtml(label)}</span>${sourcePillHtml(value, false)}</span>`;
}

function renderResolvedInline(value: ResolvedText): string {
    return `${escapeHtml(controlValue(value.value))}${sourcePillHtml(value, true)}`;
}

function normalizeResolvedText(value: string | number | ResolvedText | undefined): ResolvedText {
    if (typeof value === 'object' && value !== null && 'value' in value) return value;
    return { value };
}

function renderTagField(label: string, values: string[]): string {
    const tags = values.length
        ? values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join('')
        : '<span class="empty">-</span>';
    return `<div class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <div class="tag-list">${tags}</div>
</div>`;
}

function controlValue(value: ControlValue): string {
    return value === undefined || value === '' ? '' : String(value);
}

function optionList(values: string[]): SelectOption[] {
    return values.map((value) => ({ value, label: value }));
}

function tilesetOptions(): SelectOption[] {
    return [
        ['A', 'Ashenvale'],
        ['B', 'Barrens'],
        ['C', 'Felwood'],
        ['D', 'Dungeon'],
        ['F', 'Lordaeron Fall'],
        ['G', 'Underground'],
        ['I', 'Icecrown Glacier'],
        ['J', 'Dalaran Ruins'],
        ['K', 'Black Citadel'],
        ['L', 'Lordaeron Summer'],
        ['N', 'Northrend'],
        ['O', 'Outland'],
        ['Q', 'Village Fall'],
        ['V', 'Village'],
        ['W', 'Lordaeron Winter'],
        ['X', 'Dalaran'],
        ['Y', 'Cityscape'],
        ['Z', 'Sunken Ruins'],
    ].map(([value, label]) => ({ value, label: `${label} (${value})` }));
}

function loadingBackgroundOptions(): SelectOption[] {
    return Array.from({ length: 14 }, (_, index) => ({
        value: String(index),
        label: `Preset ${index}`,
    }));
}

function impModeUsesStandardPrefix(mode: number): boolean {
    return mode === 5 || mode === 8;
}

function impModeUsesCustomPath(mode: number): boolean {
    return mode === 10 || mode === 13;
}

function impModeLabel(mode: number): string {
    if (mode === 5 || mode === 8) return 'Standard import path';
    if (mode === 10 || mode === 13) return 'Custom import path';
    return 'Unknown path mode';
}

function normalizeWc3Path(value: string): string {
    return value.replace(/\//g, '\\').replace(/^\\+/, '');
}

function importFileType(value: string): string {
    const ext = path.extname(value).replace(/^\./, '').toLowerCase();
    return ext || 'file';
}

function errorBanner(error?: string): string {
    return error ? `<div class="error">${escapeHtml(error)}</div>` : '';
}

function mmpIconLabel(type: number): string {
    if (type === 0) return 'Gold Mine';
    if (type === 1) return 'Neutral Building';
    if (type === 2) return 'Player Start';
    return `Unknown (${type})`;
}

function graphicsLabel(value: number): string {
    if (value === 1) return 'SD';
    if (value === 2) return 'HD';
    if (value === 3) return 'SD and HD';
    return `Unknown (${value})`;
}

const W3I_FLAG_DEFS: Array<[number, string]> = [
    [0x0001, 'Hide minimap in preview'],
    [0x0002, 'Modify ally priorities'],
    [0x0004, 'Melee map'],
    [0x0008, 'Masked areas partially visible'],
    [0x0010, 'Fixed player settings'],
    [0x0020, 'Custom forces'],
    [0x0040, 'Custom techtree'],
    [0x0080, 'Custom abilities'],
    [0x0100, 'Custom upgrades'],
    [0x0200, 'Map properties opened'],
    [0x0400, 'Water waves on cliff shores'],
    [0x0800, 'Water waves on rolling shores'],
];

function fmt(value: number): string {
    // eslint-disable-next-line sonarjs/super-linear-regex -- single quantified group anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
    return value.toFixed(3).replace(/\.?0+$/, '');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ════════════════════════════════════════════════════════════════════════════
// Editable .w3i map-info editor
//
// Backed by the casc-ts parse-prefix + opaque-tail w3i model: only the leading
// string/scalar fields are editable; everything else (players, forces, lists) is
// preserved verbatim in `file.tail`. TRIGSTR-backed strings edit war3map.wts;
// inline strings edit the w3i bytes. Saves pass a round-trip safety gate.
// ════════════════════════════════════════════════════════════════════════════

// Editable string fields that may be TRIGSTR-backed (edit wts) or inline (edit w3i bytes).
const W3I_STRING_FIELDS = new Set<keyof W3iFile>([
    'name', 'author', 'description', 'recommendedPlayers',
    'loadingModel', 'loadingTitle', 'loadingSubtitle', 'loadingText',
    'prologueTitle', 'prologueSubtitle', 'prologueText', 'prologuePath',
]);

const W3I_PLAYER_RACE = ['Selectable', 'Human', 'Orc', 'Undead', 'Night Elf'];
const W3I_PLAYER_TYPE = ['', 'User', 'Computer', 'Neutral', 'Rescuable'];

function w3iLabel(arr: string[], index: number): string {
    return arr[index] || `#${index}`;
}

class W3iDocument implements vscode.CustomDocument {
    editDepth = 0;
    savedDepth = 0;
    panelWebview?: vscode.Webview;
    reload?: () => Promise<void>;

    constructor(
        readonly uri: vscode.Uri,
        public file: W3iFile,
        public wtsTable: TriggerStringTable,
        public wtsUri: vscode.Uri | undefined,
        public wtsExists: boolean,
        public readonly wtsEdits: Map<number, string>,
    ) {}

    dispose(): void {}
}

/** Resolve a string field for display, overlaying any pending wts edits. */
function resolveW3iString(raw: string | undefined, doc: W3iDocument): ResolvedText {
    const trimmed = (raw ?? '').trim();
    const match = /^TRIGSTR_(\d+)$/i.exec(trimmed);
    if (!match) return { value: raw };
    const id = Number(match[1]);
    if (doc.wtsEdits.has(id)) return { value: doc.wtsEdits.get(id), source: trimmed };
    const resolved = resolveTriggerString(trimmed, doc.wtsTable);
    // For editing, show an empty box (not the raw TRIGSTR ref) when the string can't be resolved yet.
    return resolved.missing ? { value: '', source: trimmed, missing: true } : resolved;
}

function editInput(field: keyof W3iFile, label: string, resolved: ResolvedText, opts: { wide?: boolean; textarea?: boolean; mono?: boolean } = {}): string {
    const fieldClass = opts.wide || opts.textarea ? 'field wide' : 'field';
    const controlClass = ['field-control', opts.mono ? 'mono' : ''].filter(Boolean).join(' ');
    const value = escapeHtml(controlValue(resolved.value));
    const control = opts.textarea
        ? `<textarea class="${controlClass}" data-field="${field}" placeholder="-">${value}</textarea>`
        : `<input class="${controlClass}" data-field="${field}" value="${value}" placeholder="-">`;
    return `<label class="${fieldClass}">
  ${renderFieldLabel(label, resolved)}
  ${control}
</label>`;
}

function editSelectControl(field: keyof W3iFile, label: string, value: ControlValue, options: SelectOption[]): string {
    const selected = controlValue(value);
    const opts = options.some((o) => o.value === selected)
        ? options
        : [{ value: selected, label: selected || '-' }, ...options];
    const rendered = opts.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `<label class="field">
  <span class="field-label">${escapeHtml(label)}</span>
  <select class="field-control" data-select="${field}">${rendered}</select>
</label>`;
}

function editFlagCheckbox(bit: number, label: string, checked: boolean): string {
    return `<label class="check-row">
  <input type="checkbox" data-flag="${bit}"${checked ? ' checked' : ''}>
  <span>${escapeHtml(label)}</span>
</label>`;
}

function renderW3iPlayers(players: W3iPlayer[] | undefined): string {
    if (!players || !players.length) return '';
    const rows = players.map((p) => `<tr>
  <td class="num">${p.num + 1}</td>
  <td>${escapeHtml(p.name || '-')}</td>
  <td>${escapeHtml(w3iLabel(W3I_PLAYER_TYPE, p.type))}</td>
  <td>${escapeHtml(w3iLabel(W3I_PLAYER_RACE, p.race))}</td>
  <td>${p.fixedStart ? 'fixed' : '-'}</td>
</tr>`).join('');
    return `<section class="section">
  <h2>Players <span class="count">(${players.length})</span></h2>
  <div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Controller</th><th>Race</th><th>Start</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

function renderW3iForces(forces: W3iForce[] | undefined): string {
    if (!forces || !forces.length) return '';
    const players = (mask: number): string => {
        const list: number[] = [];
        for (let i = 0; i < 28; i++) if (mask & (1 << i)) list.push(i + 1);
        return list.length ? list.join(', ') : '-';
    };
    const rows = forces.map((f, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(f.name || '-')}</td>
  <td class="mono">${players(f.playerMask)}</td>
</tr>`).join('');
    return `<section class="section">
  <h2>Forces <span class="count">(${forces.length})</span></h2>
  <div class="table-wrap"><table><thead><tr><th>#</th><th>Name</th><th>Players</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

const W3I_EDITOR_CSS = `
.field-control:not(:disabled):hover { border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, #007fd4)); }
.field-control:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
.dirty-badge {
  display: inline-block;
  margin-left: 8px;
  color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
  font-size: 11px;
  font-weight: 600;
}
.open-asset {
  margin-top: 4px;
  font: inherit;
  font-size: 11px;
  color: var(--vscode-textLink-foreground);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 1px 7px;
  cursor: pointer;
}
.open-asset:hover { background: var(--hover); }
.hint { color: var(--muted); font-size: 11px; margin: 2px 0 0; }
`;

function renderW3iEditor(doc: W3iDocument, fileName: string): string {
    const f = doc.file;
    const s = (id: keyof W3iFile) => resolveW3iString(f[id] as string | undefined, doc);
    const loadingModelRaw = (f.loadingModel ?? '').trim();
    const openModelBtn = loadingModelRaw && !/^TRIGSTR_/i.test(loadingModelRaw)
        ? `<button type="button" class="open-asset" data-open-asset="${escapeHtml(loadingModelRaw)}">▶ Open model</button>`
        : '';

    const body = `
${renderHeader(fileName, `WC3 map information — v${f.version}`, true)}
<div class="dialog">
${errorBanner(f.error)}
<section class="section">
  <h2>General</h2>
  <div class="form-grid">
    ${editInput('name', 'Map name', s('name'))}
    ${editInput('author', 'Author', s('author'))}
    ${editInput('recommendedPlayers', 'Recommended players', s('recommendedPlayers'))}
    ${editSelectControl('tileset', 'Tileset', f.tileset, tilesetOptions())}
    ${renderInput('Dimensions', `${f.width} × ${f.height}`, 'mono')}
    ${editInput('gameDataSet' as keyof W3iFile, 'Game data set', { value: f.gameDataSet }, { mono: true })}
  </div>
</section>
<section class="section">
  <h2>Description</h2>
  ${editInput('description', 'Description', s('description'), { textarea: true })}
</section>
<section class="section">
  <h2>Options</h2>
  <div class="checkbox-grid">
    ${W3I_FLAG_DEFS.map(([bit, label]) => editFlagCheckbox(bit, label, (f.flags & bit) !== 0)).join('')}
  </div>
</section>
<section class="section">
  <h2>Loading Screen</h2>
  <div class="form-grid">
    ${editSelectControl('loadingBackground', 'Background', f.loadingBackground, loadingBackgroundOptions())}
    ${editInput('loadingTitle', 'Title', s('loadingTitle'))}
    ${editInput('loadingSubtitle', 'Subtitle', s('loadingSubtitle'))}
    <label class="field wide">
      ${renderFieldLabel('Custom model', resolveW3iString(f.loadingModel, doc))}
      <input class="field-control mono" data-field="loadingModel" value="${escapeHtml(controlValue(resolveW3iString(f.loadingModel, doc).value))}" placeholder="-">
      ${openModelBtn}
    </label>
    ${editInput('loadingText', 'Text', s('loadingText'), { textarea: true })}
  </div>
</section>
<section class="section">
  <h2>Prologue</h2>
  <div class="form-grid">
    ${editInput('prologueTitle', 'Title', s('prologueTitle'))}
    ${editInput('prologueSubtitle', 'Subtitle', s('prologueSubtitle'))}
    ${editInput('prologueText', 'Text', s('prologueText'), { textarea: true })}
  </div>
</section>
${renderW3iPlayers(f.players)}
${renderW3iForces(f.forces)}
<section class="section">
  <h2>Technical</h2>
  <div class="form-grid compact">
    ${renderInput('Format version', f.version, 'mono')}
    ${renderInput('Editor version', f.editorVersion, 'mono')}
    ${renderInput('Game version', f.gameVersion, 'mono')}
    ${renderInput('Saves', f.saves, 'mono')}
    ${renderInput('Flags', `0x${(f.flags >>> 0).toString(16).padStart(8, '0')}`, 'mono')}
  </div>
  <p class="hint">Strings shown with a <code>TRIGSTR_</code> pill are stored in war3map.wts and edited there on save.</p>
</div>
</div>
<script>
(function () {
  const api = acquireVsCodeApi();
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (t.matches('[data-field]')) api.postMessage({ type: 'edit', field: t.getAttribute('data-field'), value: t.value });
    else if (t.matches('[data-select]')) api.postMessage({ type: 'edit', field: t.getAttribute('data-select'), value: t.value });
    else if (t.matches('[data-flag]')) api.postMessage({ type: 'flag', bit: Number(t.getAttribute('data-flag')), on: t.checked });
  });
  document.addEventListener('click', function (e) {
    const o = e.target.closest('[data-open-asset]');
    if (o) api.postMessage({ type: 'openAsset', path: o.getAttribute('data-open-asset') });
  });
  window.addEventListener('message', function (event) {
    const msg = event.data || {};
    if (msg.type === 'dirtyStateChanged') {
      const badge = document.getElementById('dirtyBadge');
      if (badge) badge.hidden = !msg.isDirty;
    }
  });
})();
</script>`;

    return page(fileName, body, W3I_EDITOR_CSS, true);
}

interface W3iEdit { apply: () => void; revert: () => void; }

class W3iEditorProvider implements vscode.CustomEditorProvider<W3iDocument> {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<W3iDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChange.event;

    async openCustomDocument(uri: vscode.Uri): Promise<W3iDocument> {
        const file = parseW3iFile(Buffer.from(await vscode.workspace.fs.readFile(uri)));
        const wtsTable = loadTriggerStringsForUri(uri);
        const { uri: wtsUri, exists } = findWtsUri(uri);
        return new W3iDocument(uri, file, wtsTable, wtsUri, exists, new Map());
    }

    async resolveCustomEditor(doc: W3iDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = { enableScripts: true };
        doc.panelWebview = panel.webview;
        const fileName = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
        doc.reload = async () => { panel.webview.html = renderW3iEditor(doc, fileName); };
        panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, doc));
        await doc.reload();
    }

    private handleMessage(message: unknown, doc: W3iDocument): void {
        if (!message || typeof message !== 'object') return;
        const msg = message as { type?: string; field?: string; value?: string; bit?: number; on?: boolean; path?: string };

        if (msg.type === 'openAsset' && msg.path) {
            void openW3iAsset(msg.path, doc.uri);
            return;
        }
        if (msg.type === 'flag' && typeof msg.bit === 'number') {
            const prev = doc.file.flags;
            const next = msg.on ? (prev | msg.bit) : (prev & ~msg.bit);
            if (next === prev) return;
            this.pushEdit(doc, `Toggle flag`, { apply: () => { doc.file.flags = next; }, revert: () => { doc.file.flags = prev; } }, true);
            return;
        }
        if (msg.type === 'edit' && msg.field) {
            const edit = this.makeFieldEdit(doc, msg.field as keyof W3iFile, msg.value ?? '');
            if (edit) this.pushEdit(doc, `Edit ${msg.field}`, edit, false);
        }
    }

    /** Build an edit for a field. String fields may route to war3map.wts; selects/scalars edit the w3i struct. */
    private makeFieldEdit(doc: W3iDocument, field: keyof W3iFile, value: string): W3iEdit | undefined {
        if (W3I_STRING_FIELDS.has(field)) {
            const raw = ((doc.file[field] as string | undefined) ?? '').trim();
            const match = /^TRIGSTR_(\d+)$/i.exec(raw);
            if (match) {
                const id = Number(match[1]);
                const had = doc.wtsEdits.has(id);
                const prev = doc.wtsEdits.get(id);
                if (!had && resolveTriggerString(raw, doc.wtsTable).value === value) return undefined;
                return {
                    apply: () => { doc.wtsEdits.set(id, value); },
                    revert: () => { if (had) doc.wtsEdits.set(id, prev as string); else doc.wtsEdits.delete(id); },
                };
            }
            const prevVal = doc.file[field] as string | undefined;
            if ((prevVal ?? '') === value) return undefined;
            return {
                apply: () => { (doc.file as unknown as Record<string, unknown>)[field] = value; },
                revert: () => { (doc.file as unknown as Record<string, unknown>)[field] = prevVal; },
            };
        }
        // Scalar fields: tileset (char), loadingBackground / gameDataSet (int).
        const prevVal = doc.file[field];
        if (field === 'tileset') {
            const next = (value || ' ').charAt(0);
            if (next === prevVal) return undefined;
            return { apply: () => { doc.file.tileset = next; }, revert: () => { doc.file.tileset = prevVal as string; } };
        }
        const num = Number(value);
        if (!Number.isFinite(num) || num === prevVal) return undefined;
        return {
            apply: () => { (doc.file as unknown as Record<string, unknown>)[field] = num; },
            revert: () => { (doc.file as unknown as Record<string, unknown>)[field] = prevVal; },
        };
    }

    private pushEdit(doc: W3iDocument, label: string, edit: W3iEdit, reloadOnApply: boolean): void {
        edit.apply();
        doc.editDepth++;
        this.postDirtyState(doc);
        if (reloadOnApply) void doc.reload?.();
        this._onDidChange.fire({
            document: doc,
            label,
            undo: () => { edit.revert(); doc.editDepth--; this.postDirtyState(doc); void doc.reload?.(); },
            redo: () => { edit.apply(); doc.editDepth++; this.postDirtyState(doc); void doc.reload?.(); },
        });
    }

    private postDirtyState(doc: W3iDocument): void {
        void doc.panelWebview?.postMessage({ type: 'dirtyStateChanged', isDirty: doc.editDepth !== doc.savedDepth });
    }

    async saveCustomDocument(doc: W3iDocument): Promise<void> {
        try {
            await this.writeW3i(doc, doc.uri);
            await this.writeWts(doc, doc.wtsUri, doc.wtsExists);
            if (doc.wtsUri) doc.wtsExists = true;
            doc.savedDepth = doc.editDepth;
            this.postDirtyState(doc);
        } catch (err) {
            void vscode.window.showErrorMessage(`Map info not saved: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }

    async saveCustomDocumentAs(doc: W3iDocument, target: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.writeFile(target, serializeValidatedW3i(doc.file, target.path));
        const { uri: wtsUri, exists } = findWtsUri(target);
        await this.writeWts(doc, wtsUri, exists);
    }

    private async writeW3i(doc: W3iDocument, uri: vscode.Uri): Promise<void> {
        const bytes = serializeValidatedW3i(doc.file, uri.path);
        try {
            const existing = Buffer.from(await vscode.workspace.fs.readFile(uri));
            if (existing.equals(bytes)) return;
        } catch { /* missing → write */ }
        await vscode.workspace.fs.writeFile(uri, bytes);
    }

    private async writeWts(doc: W3iDocument, wtsUri: vscode.Uri | undefined, wtsExists: boolean): Promise<void> {
        if (!doc.wtsEdits.size || !wtsUri) return;
        let original = '';
        if (wtsExists) {
            try { original = Buffer.from(await vscode.workspace.fs.readFile(wtsUri)).toString('utf8'); } catch { /* create fresh */ }
        }
        await vscode.workspace.fs.writeFile(wtsUri, Buffer.from(applyWtsEdits(original, doc.wtsEdits), 'utf8'));
    }

    async revertCustomDocument(doc: W3iDocument): Promise<void> {
        doc.file = parseW3iFile(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)));
        doc.wtsTable = loadTriggerStringsForUri(doc.uri);
        doc.wtsEdits.clear();
        const { exists } = findWtsUri(doc.uri);
        doc.wtsExists = exists;
        doc.editDepth = 0;
        doc.savedDepth = 0;
        this.postDirtyState(doc);
        if (doc.reload) await doc.reload();
    }

    async backupCustomDocument(doc: W3iDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, serializeValidatedW3i(doc.file, doc.uri.path));
        return { id: context.destination.toString(), delete: () => vscode.workspace.fs.delete(context.destination).then(() => undefined, () => undefined) };
    }
}

/** Safety gate: never write a w3i we can't read back with the same prefix + preserved tail. */
function serializeValidatedW3i(file: W3iFile, name: string): Buffer {
    const bytes = serializeW3i(file);
    const reparsed = parseW3iFile(bytes);
    if (reparsed.error) throw new Error(`Refusing to save ${name}: serialized data did not re-parse (${reparsed.error}).`);
    if (!reparsed.tail.equals(file.tail) || reparsed.name !== file.name ||
        reparsed.width !== file.width || reparsed.height !== file.height || reparsed.version !== file.version) {
        throw new Error(`Refusing to save ${name}: round-trip verification failed.`);
    }
    return bytes;
}

async function openW3iAsset(assetPath: string, uri: vscode.Uri): Promise<void> {
    const resolved = await resolveAssetPathWithCasc(assetPath, await getCandidateRoots(uri.fsPath));
    if (!resolved) {
        void vscode.window.showWarningMessage(`Could not resolve asset: ${assetPath}`);
        return;
    }
    const target = vscode.Uri.file(resolved);
    const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase();
    if (['.mdx', '.mdl', '.blp', '.dds', '.tga'].includes(ext)) {
        await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.blpPreview');
    } else {
        await vscode.commands.executeCommand('vscode.open', target);
    }
}

export function registerMapDataPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    const readonly = registerParsedPreviewer<MapDataFile>({
        viewType: 'wurst.mapDataPreview',
        parse: parseMapData,
        render: renderMapData,
        webviewOptions: { enableScripts: true },
    });
    const w3iEditor = vscode.window.registerCustomEditorProvider(
        'wurst.w3iEditor',
        new W3iEditorProvider(),
        { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } },
    );
    return vscode.Disposable.from(readonly, w3iEditor);
}
