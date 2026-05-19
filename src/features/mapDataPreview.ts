'use strict';

/** VS Code previews for compact WC3 map data files without text syntax. */

import * as path from 'path';
import * as vscode from 'vscode';
import { BinReader } from 'casc-ts/formats';
import { registerParsedPreviewer } from './preview/framework';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';

type MapDataFile =
    | { kind: 'mmp'; version: number; icons: MmpIcon[]; error?: string }
    | { kind: 'shd'; width: number; height: number; bytes: Buffer; error?: string }
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
    loadingModel?: string;
    loadingTitle?: string;
    loadingText?: string;
    loadingSubtitle?: string;
    gameDataSet?: number;
    prologueTitle?: string;
    prologueText?: string;
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
    return { kind: 'shd', width, height, bytes: data };
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

        const loadingBackground = r.readI32();
        if (info.version >= 25) info.loadingModel = r.readString();
        info.loadingText = r.readString();
        info.loadingTitle = r.readString();
        info.loadingSubtitle = r.readString();
        info.gameDataSet = r.readI32();

        r.readString(); // prologue path
        info.prologueText = r.readString();
        info.prologueTitle = r.readString();
        r.readString(); // prologue subtitle

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

        void loadingBackground;
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

function renderMapData(parsed: MapDataFile, fileName: string): string {
    if (parsed.kind === 'mmp') return renderMmp(parsed, fileName);
    if (parsed.kind === 'shd') return renderShd(parsed, fileName);
    if (parsed.kind === 'w3c') return renderW3c(parsed, fileName);
    if (parsed.kind === 'w3i') return renderW3i(parsed, fileName);
    if (parsed.kind === 'w3r') return renderW3r(parsed, fileName);
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
.content { flex: 1; overflow: auto; padding: 14px 16px; }
h1 { font-size: 15px; margin: 0 0 3px; color: var(--vscode-textLink-foreground, var(--fg)); }
.subtitle { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
.error { color: var(--vscode-errorForeground, #f14c4c); border: 1px solid currentColor; padding: 6px 9px; margin-bottom: 12px; border-radius: 3px; }
.empty { color: var(--muted); font-style: italic; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th { text-align: left; background: var(--vscode-editorGroupHeader-tabsBackground, #252526); border-bottom: 1px solid var(--border); padding: 5px 8px; }
td { border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); padding: 4px 8px; vertical-align: top; }
td.num { text-align: right; font-family: var(--mono); }
td.mono { font-family: var(--mono); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px 18px; margin-bottom: 14px; }
.kv { min-width: 0; }
.k { color: var(--muted); font-size: 11px; margin-bottom: 2px; }
.v { word-break: break-word; }
canvas { image-rendering: pixelated; max-width: min(100%, 768px); border: 1px solid var(--border); background: #000; }
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
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 minimap icons - v${parsed.version}</div>
${errorBanner(parsed.error)}
${parsed.icons.length ? `<table><thead><tr><th>#</th><th>Type</th><th>X</th><th>Y</th><th>Color</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No minimap icons</p>'}`);
}

function renderShd(parsed: Extract<MapDataFile, { kind: 'shd' }>, fileName: string): string {
    const base64 = parsed.bytes.toString('base64');
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 shadow map - ${parsed.width} x ${parsed.height} - ${parsed.bytes.length} bytes</div>
${errorBanner(parsed.error)}
<canvas id="shdCanvas" width="${parsed.width}" height="${parsed.height}"></canvas>
<script>
const raw = atob("${base64}");
const w = ${parsed.width};
const h = ${parsed.height};
const canvas = document.getElementById('shdCanvas');
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(w, h);
for (let i = 0; i < w * h; i++) {
  const v = i < raw.length ? raw.charCodeAt(i) : 0;
  const p = i * 4;
  img.data[p] = 0;
  img.data[p + 1] = 0;
  img.data[p + 2] = 0;
  img.data[p + 3] = v;
}
ctx.putImageData(img, 0, 0);
</script>`, '', true);
}

function renderW3c(parsed: Extract<MapDataFile, { kind: 'w3c' }>, fileName: string): string {
    const rows = parsed.cameras.map((camera, index) => `<tr>
  <td class="num">${index}</td>
  <td>${escapeHtml(camera.name || '(unnamed)')}</td>
  <td class="num">${fmt(camera.targetX)}</td>
  <td class="num">${fmt(camera.targetY)}</td>
  <td class="num">${fmt(camera.zOffset)}</td>
  <td class="num">${fmt(camera.rotation)}</td>
  <td class="num">${fmt(camera.angleOfAttack)}</td>
  <td class="num">${fmt(camera.distance)}</td>
  <td class="num">${fmt(camera.fieldOfView)}</td>
</tr>`).join('');
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 cameras - v${parsed.version}</div>
${errorBanner(parsed.error)}
${parsed.cameras.length ? `<table><thead><tr><th>#</th><th>Name</th><th>Target X</th><th>Target Y</th><th>Z</th><th>Rot</th><th>AoA</th><th>Dist</th><th>FOV</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No cameras</p>'}`);
}

function renderW3i(parsed: Extract<MapDataFile, { kind: 'w3i' }>, fileName: string): string {
    const info = parsed.info;
    const fields: Array<[string, string | number | undefined]> = [
        ['Format version', info.version],
        ['Editor version', info.editorVersion],
        ['Game version', info.gameVersion],
        ['Map name', info.name],
        ['Author', info.author],
        ['Recommended players', info.recommendedPlayers],
        ['Size', info.width && info.height ? `${info.width} x ${info.height}` : undefined],
        ['Tileset', info.tileset],
        ['Flags', `0x${(info.flags >>> 0).toString(16).padStart(8, '0')}`],
        ['Script', info.scriptLang],
        ['Graphics', info.graphics],
        ['Game data', info.gameDataVersion],
        ['Players', info.playersCount],
        ['Forces', info.forcesCount],
    ];
    const loadingFields: Array<[string, string | undefined]> = [
        ['Model', info.loadingModel],
        ['Title', info.loadingTitle],
        ['Text', info.loadingText],
        ['Subtitle', info.loadingSubtitle],
        ['Prologue title', info.prologueTitle],
        ['Prologue text', info.prologueText],
    ];
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 map information</div>
${errorBanner(parsed.error)}
<div class="grid">${fields.map(renderKv).join('')}</div>
<h1>Loading / Prologue</h1>
<div class="grid">${loadingFields.map(renderKv).join('')}</div>
<h1>Description</h1>
<p>${escapeHtml(info.description || '') || '<span class="empty">No description</span>'}</p>`);
}

function renderW3r(parsed: Extract<MapDataFile, { kind: 'w3r' }>, fileName: string): string {
    const rows = parsed.regions.map((region) => `<tr>
  <td class="num">${region.index}</td>
  <td>${escapeHtml(region.name || '(unnamed)')}</td>
  <td class="num">${fmt(region.minX)}</td>
  <td class="num">${fmt(region.maxX)}</td>
  <td class="num">${fmt(region.minY)}</td>
  <td class="num">${fmt(region.maxY)}</td>
  <td class="mono">${escapeHtml(region.weatherId || '-')}</td>
  <td>${escapeHtml(region.sound || '-')}</td>
  <td><span class="swatch" style="background:${region.color}"></span>${escapeHtml(region.color)}</td>
</tr>`).join('');
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 regions - v${parsed.version}</div>
${errorBanner(parsed.error)}
${parsed.regions.length ? `<table><thead><tr><th>#</th><th>Name</th><th>Min X</th><th>Max X</th><th>Min Y</th><th>Max Y</th><th>Weather</th><th>Sound</th><th>Color</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No regions</p>'}`);
}

function renderW3e(parsed: Extract<MapDataFile, { kind: 'w3e' }>, fileName: string): string {
    const info = parsed.info;
    const fields: Array<[string, string | number | undefined]> = [
        ['Magic', info.magic],
        ['Version', info.version],
        ['Tileset', info.tileset],
        ['Custom tileset', info.customTileset ? 'yes' : 'no'],
        ['Size', info.width && info.height ? `${info.width} x ${info.height}` : undefined],
        ['Center', `${fmt(info.centerX)}, ${fmt(info.centerY)}`],
        ['Ground tiles', info.groundTiles.join(', ')],
        ['Cliff tiles', info.cliffTiles.join(', ')],
        ['Tile payload', `${info.payloadBytes} bytes`],
    ];
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">WC3 terrain data</div>
${errorBanner(parsed.error)}
<div class="grid">${fields.map(renderKv).join('')}</div>`);
}

function renderGeneric(parsed: Extract<MapDataFile, { kind: 'generic' }>, fileName: string): string {
    const preview = Array.from(parsed.bytes.subarray(0, 128))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join(' ');
    return page(fileName, `
<h1>${escapeHtml(fileName)}</h1>
<div class="subtitle">${escapeHtml(parsed.label)} - ${parsed.bytes.length} bytes</div>
${errorBanner(parsed.error)}
<p>${escapeHtml(parsed.note)}</p>
<h1>Header Bytes</h1>
<p class="mono">${escapeHtml(preview || '(empty)')}</p>`);
}

function renderKv([key, value]: [string, string | number | undefined]): string {
    return `<div class="kv"><div class="k">${escapeHtml(key)}</div><div class="v">${value === undefined || value === '' ? '<span class="empty">-</span>' : escapeHtml(String(value))}</div></div>`;
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
