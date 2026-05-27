'use strict';

/** VS Code previews for compact WC3 map data files without text syntax. */

import * as path from 'path';
import * as vscode from 'vscode';
import { BinReader } from 'casc-ts/formats';
import { ParsedPreviewContext, registerParsedPreviewer } from './preview/framework';
import { loadTriggerStringsForUri, resolveTriggerString, ResolvedText, TriggerStringTable } from './preview/triggerStrings';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';

type MapDataFile =
    | { kind: 'mmp'; version: number; icons: MmpIcon[]; error?: string }
    | { kind: 'shd'; width: number; height: number; bytes: Buffer; min: number; max: number; error?: string }
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


function parseMapData(data: Buffer, fileName: string): MapDataFile {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.mmp') return parseMmp(data);
    if (ext === '.shd') return parseShd(data);
    if (ext === '.w3c') return parseW3c(data);
    if (ext === '.w3i') return parseW3i(data);
    if (ext === '.w3r') return parseW3r(data);
    if (ext === '.w3e') return parseW3e(data);
    return parseGeneric(data, ext);
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

function parseShd(data: Buffer): MapDataFile {
    const side = Math.sqrt(data.length);
    const width = Number.isInteger(side) ? side : 256;
    const height = Number.isInteger(side) ? side : Math.max(1, Math.ceil(data.length / width));
    let min = 255;
    let max = 0;
    for (const value of data) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (data.length === 0) min = 0;
    return { kind: 'shd', width, height, bytes: data, min, max };
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
for (let i = 0; i < w * h; i++) {
  const v = i < raw.length ? raw.charCodeAt(i) : 0;
  const shade = 255 - v;
  const p = i * 4;
  img.data[p] = shade;
  img.data[p + 1] = shade;
  img.data[p + 2] = shade;
  img.data[p + 3] = 255;
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

function renderHeader(fileName: string, meta: string): string {
    return `<div class="md-header">
  <div>
    <div class="md-title">${escapeHtml(fileName)}</div>
    <div class="md-meta">${escapeHtml(meta)}<span class="readonly-badge">read-only</span></div>
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

function renderSelect(label: string, value: string | number | undefined, options: SelectOption[]): string {
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

function renderFieldLabel(label: string, value: ResolvedText): string {
    const source = value.source
        ? `<span class="source-pill${value.missing ? ' missing' : ''}" title="${escapeHtml(value.missing ? `${value.source} not found in war3map.wts` : `Resolved from ${value.source}`)}">${escapeHtml(value.source)}</span>`
        : '';
    return `<span class="field-label"><span>${escapeHtml(label)}</span>${source}</span>`;
}

function renderResolvedInline(value: ResolvedText): string {
    const source = value.source
        ? ` <span class="source-pill${value.missing ? ' missing' : ''}" title="${escapeHtml(value.missing ? `${value.source} not found in war3map.wts` : `Resolved from ${value.source}`)}">${escapeHtml(value.source)}</span>`
        : '';
    return `${escapeHtml(controlValue(value.value))}${source}`;
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

function controlValue(value: string | number | undefined): string {
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
    return value.toFixed(3).replace(/\.?0+$/, '');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function registerMapDataPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return registerParsedPreviewer<MapDataFile>({
        viewType: 'wurst.mapDataPreview',
        parse: parseMapData,
        render: renderMapData,
        webviewOptions: { enableScripts: true },
    });
}
