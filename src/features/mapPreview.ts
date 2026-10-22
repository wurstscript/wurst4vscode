'use strict';

/**
 * Experimental map terrain and placement editor (`wurst.mapPlacementEditor`, opened by `wurst.previewMap`).
 *
 * A custom editor on an exploded map's `war3mapUnits.doo`: the document is the unit/item placement
 * list (casc-ts `parseDoo`/`serializeDoo`) on the shared `EditableBinaryEditorProvider`, so select,
 * move, place and delete go through VS Code undo/redo, dirty state and save. The rest of the map
 * folder is read-only scene context: `war3map.w3e` terrain with WC3 tile textures and cliff/ramp
 * data, `war3map.doo` doodads, `.w3u`/`.w3t` custom objects for the placement picker and
 * `war3map.w3i` for the player layout. The page script is src/webview/mapPreviewWebview.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DooDoodad, DooFile, DooUnit, ObjModEntry, parseDoo, parseObjMod, parseW3i, serializeDoo } from 'casc-ts/formats';
import { buildPage, scriptSafeJson } from './webviewShared';
import { escapeHtml, makeNonce } from './webviewUtils';
import { findGameTexture } from './preview/cascStorage';
import { loadTerrainWaterLevel, loadTilesetBlightTexture, parseSlk, readGameData, slkField } from './preview/wc3Data';
import { decodeToRgba } from './preview/imageDecoders';
import { encodePng, scaleDown } from './imageAssetSupport';
import { getObjectCatalog, normalizeModelPath, ObjectRef } from './preview/objectCatalog';
import { loadCompilerKnowledgeBase } from './preview/compilerKnowledgeBase';
import { loadTriggerStringsForUri, resolveTriggerString, TriggerStringTable } from './preview/triggerStrings';
import { buildErrorHtml, buildLoadingHtml, EditableBinaryDocument, EditableBinaryEditorProvider } from './preview/framework';
import { offerIssueReport } from './issueReporting';
import { postModelToWebview, postTexturesToWebview } from './preview/modelPreviewHost';
import { normalizeAssetPath } from '../webview/assetPathUtils';
import MAP_PREVIEW_CSS from '../webview/mapPreview.css';

const TILE = 128;
const GROUND_CENTER = 0x2000;
const TILE_TEXTURE_SIZE = 256;

interface Terrain {
    version: number;
    tileset: string;
    customTileset: boolean;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    groundTiles: string[];
    cliffTiles: string[];
    heights: Int16Array;
    water: Int16Array;
    ground: Uint8Array;
    cliff: Uint8Array;
    layer: Uint8Array;
    flags: Uint8Array;
    detail: Uint8Array;
    waterMask: Uint8Array;
    min: number;
    max: number;
}

interface ModelPlacement {
    modelPath?: string;
    modelFallback?: string;
    replaceableId?: number;
    replaceableTexture?: string;
    angle?: number;
    scale?: number[];
}

interface DoodadMarker extends ModelPlacement {
    z?: number;
    x: number;
    y: number;
    id: string;
    label: string;
}

/** Map overrides and skin overrides sit on top of the shared stock catalog. */
async function mapObjectCatalog(dir: string): Promise<Map<string, ObjectRef>> {
    const catalog = new Map(await getObjectCatalog());
    for (const ext of ['w3u', 'w3t', 'w3b', 'w3d']) {
        for (const prefix of ['war3map', 'war3mapSkin']) {
            const file = findFileCI(dir, `${prefix}.${ext}`);
            if (!file) continue;
            try {
                const parsed = parseObjMod(await fs.promises.readFile(file), `.${ext}`);
                for (const entry of [...parsed.origObjs, ...parsed.customObjs]) mergeMapObject(catalog, entry);
            } catch { /* A broken optional object-data file must not hide the terrain. */ }
        }
    }
    return catalog;
}

function mergeMapObject(catalog: Map<string, ObjectRef>, entry: ObjModEntry): void {
    const id = (entry.newId || entry.baseId).toLowerCase();
    const ref = { ...catalog.get(entry.baseId.toLowerCase()), ...catalog.get(id) };
    const numericArt: Record<string, 'modelScale' | 'modelVariations' | 'replaceableId'> = {
        usca: 'modelScale', isca: 'modelScale', bsca: 'modelScale', dsca: 'modelScale', bvar: 'modelVariations', btxi: 'replaceableId',
    };
    for (const mod of entry.mods) {
        if (['umdl', 'ifil', 'bfil', 'dfil'].includes(mod.fieldId)) ref.modelPath = normalizeModelPath(String(mod.value));
        if (['unam', 'inam', 'bnam', 'dnam'].includes(mod.fieldId)) ref.name = String(mod.value);
        if (numericArt[mod.fieldId] && typeof mod.value === 'number') ref[numericArt[mod.fieldId]] = mod.value;
        if (mod.fieldId === 'btxf') ref.replaceableTexture = String(mod.value);
    }
    catalog.set(id, ref);
}

function markerModel(ref: ObjectRef | undefined, placement: { angle?: number; scaleX?: number; scaleY?: number; scaleZ?: number; variation?: number }, doodad: boolean): ModelPlacement {
    const base = ref?.modelPath;
    const varied = doodad && ref?.modelVariations !== 1;
    return {
        modelPath: base && varied ? base.replace(/\.(mdx|mdl)$/i, `${placement.variation ?? 0}.$1`) : base,
        modelFallback: varied ? base : undefined,
        replaceableId: ref?.replaceableId,
        replaceableTexture: ref?.replaceableTexture,
        angle: placement.angle ?? 0,
        scale: [placement.scaleX ?? 1, placement.scaleY ?? 1, placement.scaleZ ?? 1].map(value => value * (ref?.modelScale ?? 1)),
    };
}

interface TileTexture {
    id: string;
    label: string;
    path?: string;
    dataUri?: string;
    extended: boolean;
    color: string;
}

interface TerrainMaterials {
    textures: TileTexture[];
    cliffToGround: number[];
    blightTexture: number;
}

type SlkRows = Map<string, Record<string, string>>;

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
async function parseW3eTerrain(data: Buffer): Promise<Terrain> {
    let p = 0;
    const id = () => { const start = p; p += 4; return data.toString('latin1', start, p); };
    const i32 = () => { const v = data.readInt32LE(p); p += 4; return v; };
    const f32 = () => { const v = data.readFloatLE(p); p += 4; return v; };

    const magic = id();
    if (magic !== 'W3E!') throw new Error(`Unexpected magic "${magic}", expected "W3E!"`);
    const version = i32();
    const tileset = String.fromCharCode(data.readUInt8(p)); p += 1;
    const customTileset = i32() !== 0;
    const groundCount = i32();
    const groundTiles: string[] = [];
    for (let i = 0; i < groundCount; i++) groundTiles.push(id());
    const cliffCount = i32();
    const cliffTiles: string[] = [];
    for (let i = 0; i < cliffCount; i++) cliffTiles.push(id());
    const width = i32();
    const height = i32();
    const centerX = f32();
    const centerY = f32();

    const count = width * height;
    const stride = version >= 12 ? 8 : 7;
    const remaining = data.length - p;
    if (p + count * stride > data.length) {
        throw new Error(`Tilepoint data truncated (need ${count * stride} bytes, have ${remaining}).`);
    }
    const waterLevel = await loadTerrainWaterLevel(tileset);
    const heights = new Int16Array(count);
    const water = new Int16Array(count);
    const ground = new Uint8Array(count);
    const cliff = new Uint8Array(count);
    const layer = new Uint8Array(count);
    const flags = new Uint8Array(count);
    const detail = new Uint8Array(count);
    const waterMask = new Uint8Array(count);
    let min = Infinity;
    let max = -Infinity;

    for (let k = 0; k < count; k++) {
        const groundHeight = data.readInt16LE(p);
        const waterAndFlags = data.readUInt16LE(p + 2);
        let groundTexture: number;
        let normalizedFlags: number;
        let textureDetails: number;
        let cliffAndLayer: number;
        if (version >= 12) {
            const textureAndFlags = data.readUInt16LE(p + 4);
            groundTexture = textureAndFlags & 0x3f;
            normalizedFlags = (textureAndFlags & 0x0040 ? 0x10 : 0) |
                (textureAndFlags & 0x0080 ? 0x20 : 0) |
                (textureAndFlags & 0x0100 ? 0x40 : 0) |
                (textureAndFlags & 0x0200 ? 0x80 : 0);
            textureDetails = data.readUInt8(p + 6);
            cliffAndLayer = data.readUInt8(p + 7);
        } else {
            const textureAndFlags = data.readUInt8(p + 4);
            groundTexture = (textureAndFlags >> 4) & 0x0f;
            const rawFlags = textureAndFlags & 0x0f;
            normalizedFlags = (rawFlags & 0x08 ? 0x10 : 0) |
                (rawFlags & 0x04 ? 0x20 : 0) |
                (rawFlags & 0x02 ? 0x40 : 0) |
                (rawFlags & 0x01 ? 0x80 : 0);
            textureDetails = data.readUInt8(p + 5);
            cliffAndLayer = data.readUInt8(p + 6);
        }
        p += stride;

        const layerHeight = cliffAndLayer & 0x0f;
        const z = (groundHeight - GROUND_CENTER) / 4 + (layerHeight - 2) * TILE;
        const zi = Math.max(-32768, Math.min(32767, Math.round(z)));
        const wz = ((waterAndFlags & 0x7fff) - GROUND_CENTER) / 4 + waterLevel;
        const wi = Math.max(-32768, Math.min(32767, Math.round(wz)));
        heights[k] = zi;
        water[k] = wi;
        ground[k] = groundTexture;
        flags[k] = normalizedFlags;
        cliff[k] = (cliffAndLayer >> 4) & 0x0f;
        layer[k] = layerHeight;
        detail[k] = textureDetails;
        waterMask[k] = (flags[k] & 0x40) !== 0 ? 1 : 0;
        if (zi < min) min = zi;
        if (zi > max) max = zi;
    }

    if (!Number.isFinite(min)) { min = 0; max = 0; }
    return { version, tileset, customTileset, width, height, centerX, centerY, groundTiles, cliffTiles, heights, water, ground, cliff, layer, flags, detail, waterMask, min, max };
}

/** Read-only doodad markers from `war3map.doo`, and whether that file stores skin ids. */
function readDoodads(dir: string, catalog: Map<string, ObjectRef>): { markers: DoodadMarker[]; usesSkins?: boolean } {
    const dooPath = findFileCI(dir, 'war3map.doo');
    if (!dooPath) return { markers: [] };
    try {
        const parsed = parseDoo(fs.readFileSync(dooPath), 'war3map.doo');
        const label = (id: string) => catalog.get(id.toLowerCase())?.name || id;
        const doodads = parsed.doodads ?? [];
        const markers = [...doodads, ...(parsed.specialDoodads ?? [])]
            .map((d) => ({ x: d.x, y: d.y, z: d.z, id: d.typeId, label: label(d.typeId),
                ...markerModel(catalog.get(('skinId' in d && typeof d.skinId === 'string' ? d.skinId : d.typeId).toLowerCase()) ?? catalog.get(d.typeId.toLowerCase()), 'variation' in d ? d as DooDoodad : {}, 'variation' in d),
            }));
        return { markers, usesSkins: doodads.length ? doodads.some((d) => d.skinId !== undefined) : undefined };
    } catch {
        // Doodads are context only; the editor still opens without them.
        return { markers: [] };
    }
}

function findFileCI(dir: string, name: string): string | undefined {
    try {
        const lower = name.toLowerCase();
        const hit = fs.readdirSync(dir).find((e) => e.toLowerCase() === lower);
        return hit ? path.join(dir, hit) : undefined;
    } catch {
        return undefined;
    }
}

function findMapW3e(startFsPath?: string): string | undefined {
    const candidates: string[] = [];
    if (startFsPath) {
        let dir: string;
        try { dir = fs.statSync(startFsPath).isDirectory() ? startFsPath : path.dirname(startFsPath); }
        catch { dir = path.dirname(startFsPath); }
        for (let i = 0; i < 8 && dir; i++) {
            candidates.push(dir);
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) candidates.push(f.uri.fsPath);

    for (const dir of candidates) {
        const w3e = findFileCI(dir, 'war3map.w3e');
        if (w3e) return w3e;
    }
    return undefined;
}

function activeResourcePath(resource?: vscode.Uri): string | undefined {
    if (resource?.fsPath) return resource.fsPath;
    const editor = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (editor) return editor;
    const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as { uri?: vscode.Uri } | undefined;
    return input?.uri?.fsPath;
}

async function loadSlkRows(assetPath: string): Promise<SlkRows> {
    const buf = await readGameData(assetPath);
    if (!buf) return new Map();
    return parseSlk(buf.toString('utf8')).rows;
}

async function buildTerrainMaterials(terrain: Terrain): Promise<TerrainMaterials> {
    const rows = await loadSlkRows('TerrainArt\\Terrain.slk');
    const cliffRows = await loadSlkRows('TerrainArt\\CliffTypes.slk');
    const textures: TileTexture[] = [];
    for (let i = 0; i < Math.max(1, terrain.groundTiles.length); i++) {
        const id = terrain.groundTiles[i] ?? '';
        const row = getRowCI(rows, id);
        const candidates = terrainTextureCandidates(row);
        const resolved = await resolveTerrainTexture(candidates);
        textures.push({
            id,
            label: slkField(row, ['comment', 'name']) || id || `Tile ${i}`,
            path: resolved?.path,
            dataUri: resolved?.dataUri,
            extended: resolved?.extended ?? false,
            color: fallbackTileColor(id || String(i), i),
        });
    }

    let blightTexture = -1;
    const blightPath = await loadTilesetBlightTexture(terrain.tileset);
    if (blightPath) {
        const resolved = await resolveTerrainTexture([blightPath]);
        blightTexture = textures.length;
        textures.push({
            id: 'blight',
            label: 'Blight',
            path: resolved?.path,
            dataUri: resolved?.dataUri,
            extended: resolved?.extended ?? false,
            color: '#665f45',
        });
    }

    const groundIndex = new Map<string, number>();
    terrain.groundTiles.forEach((id, index) => groundIndex.set(id.toLowerCase(), index));
    const cliffToGround = terrain.cliffTiles.map((id) => {
        const row = getRowCI(cliffRows, id);
        const groundTile = slkField(row, ['groundtile']);
        if (!groundTile) return 0;
        return groundIndex.get(groundTile.toLowerCase()) ?? 0;
    });

    return { textures, cliffToGround, blightTexture };
}

function getRowCI(rows: SlkRows, id: string): Record<string, string> | undefined {
    const exact = rows.get(id) ?? rows.get(id.toLowerCase());
    if (exact) return exact;
    const lower = id.toLowerCase();
    return Array.from(rows.entries()).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function terrainTextureCandidates(row: Record<string, string> | undefined): string[] {
    const dir = slkField(row, ['dir', 'directory']);
    const file = slkField(row, ['file', 'texture', 'texFile', 'art']);
    const candidates: string[] = [];
    const add = (candidate: string | undefined) => {
        if (!candidate) return;
        const normalized = candidate.replace(/\//g, '\\').replace(/^\\+/, '');
        if (!candidates.some((c) => c.toLowerCase() === normalized.toLowerCase())) candidates.push(normalized);
    };

    if (dir && file) add(`TerrainArt\\${dir}\\${file}`);
    if (file) add(file.includes('\\') ? file : `TerrainArt\\${file}`);
    return candidates;
}

async function resolveTerrainTexture(candidates: string[]): Promise<{ path: string; dataUri: string; extended: boolean } | undefined> {
    for (const candidate of candidates) {
        const texture = await findGameTexture(candidate, (msg) => {
            if (process.env.WURST_CASC_DEBUG === '1') console.log(`[wurst-map-preview] ${msg}`);
        });
        if (!texture) continue;
        try {
            const decoded = decodeToRgba(texture.buf, `.${texture.ext}`);
            const extended = decoded.width === decoded.height * 2;
            const scaled = scaleDown(decoded.rgba, decoded.width, decoded.height, TILE_TEXTURE_SIZE);
            const png = encodePng(scaled.w, scaled.h, scaled.rgba);
            return { path: candidate, dataUri: `data:image/png;base64,${png.toString('base64')}`, extended };
        } catch {
            // Try the next candidate.
        }
    }
    return undefined;
}

function fallbackTileColor(id: string, index: number): string {
    let h = 2166136261 ^ index;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    const palettes = [
        [74, 132, 74],
        [108, 98, 65],
        [116, 109, 82],
        [72, 114, 98],
        [138, 124, 78],
        [88, 111, 69],
    ];
    const p = palettes[Math.abs(h) % palettes.length];
    const n = ((h >>> 8) & 31) - 15;
    return `#${hex(p[0] + n)}${hex(p[1] + n)}${hex(p[2] + n)}`;
}

function hex(v: number): string {
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
}

function b64(bytes: ArrayBufferView): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}



/** Terrain height at a map position: bilinear over the tilepoint grid, the same surface the page draws. */
function terrainHeightAt(terrain: Terrain, x: number, y: number): number {
    const gi = Math.min(Math.max((x - terrain.centerX) / TILE, 0), terrain.width - 1);
    const gj = Math.min(Math.max((y - terrain.centerY) / TILE, 0), terrain.height - 1);
    const i0 = Math.floor(gi);
    const j0 = Math.floor(gj);
    const i1 = Math.min(i0 + 1, terrain.width - 1);
    const j1 = Math.min(j0 + 1, terrain.height - 1);
    const tx = gi - i0;
    const tz = gj - j0;
    const at = (i: number, j: number) => terrain.heights[j * terrain.width + i];
    return at(i0, j0) * (1 - tx) * (1 - tz) + at(i1, j0) * tx * (1 - tz) + at(i0, j1) * (1 - tx) * tz + at(i1, j1) * tx * tz;
}

// ── Placement editor ─────────────────────────────────────────────────────────

const MAP_EDITOR_VIEW_TYPE = 'wurst.mapPlacementEditor';
const UNITS_FILE = 'war3mapUnits.doo';
const START_LOCATION = 'sloc';
/** Facing World Editor gives freshly placed units and items (270°), as the f32 it writes. */
const DEFAULT_FACING = Math.fround(Math.PI * 1.5);
/** Last World Editor build before 1.29. The player limit (12 or 24) follows the build a map was saved with. */
const LAST_12_PLAYER_EDITOR = 6060;

type PlacementKind = 'unit' | 'item' | 'start';

interface PlacementType {
    id: string;
    name: string;
    kind: 'unit' | 'item';
    custom: boolean;
}

/** What the placement editor needs from `war3map.w3i`. */
interface MapInfo {
    version: number;
    editorVersion: number;
    playerNumbers: number[];
}

/** Player slots and neutral owner indices as `war3mapUnits.doo` stores them. */
interface OwnerLayout {
    players: number;
    neutralHostile: number;
    neutralPassive: number;
}

interface MapScene {
    terrain: Terrain;
    materials: TerrainMaterials;
    doodads: DoodadMarker[];
    /** Placeable unit and item types by exact rawcode: game data plus the map's custom objects. */
    types: Map<string, PlacementType>;
    catalog: Map<string, ObjectRef>;
    owners: OwnerLayout;
    /** Whether new placements get a skin id, matching how this map stores its existing ones. */
    usesSkins: boolean;
}

type PlacementFile = DooFile & {
    /** Set when the file does not re-serialize byte-for-byte; the editor then refuses every edit. */
    readOnlyReason?: string;
};

class MapPlacementDocument extends EditableBinaryDocument<PlacementFile> {
    scene?: MapScene;
    sceneError?: string;
    /** Placement index the next state push selects (-1 clears the selection). */
    selectHint?: number;

    get units(): DooUnit[] {
        return this.file.units ?? [];
    }
}

type PlacementProvider = EditableBinaryEditorProvider<PlacementFile, MapPlacementDocument>;

interface PlacementMessage {
    type?: string;
    index?: unknown;
    /** Creation number of the unit at `index` when the page sent the message. */
    editorId?: unknown;
    x?: unknown;
    y?: unknown;
    typeId?: unknown;
    owner?: unknown;
}

function parsePlacements(data: Buffer): PlacementFile {
    const file: PlacementFile = parseDoo(data, UNITS_FILE);
    if (!file.error && !serializeDoo(file).equals(data)) {
        file.readOnlyReason = `${UNITS_FILE} does not re-serialize byte-for-byte, so it opened read-only instead of risking a lossy save.`;
    }
    return file;
}

/** Field-order independent JSON, so a re-parsed unit compares equal to the model it was written from. */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
        return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));
    });
}

/** Safety gate: never write a unit file that does not read back as exactly the edited placements. */
function serializeValidatedPlacements(file: PlacementFile, name: string): Buffer {
    if (file.error) throw new Error(`Refusing to save ${name}: the source file did not parse (${file.error}).`);
    if (file.readOnlyReason) throw new Error(`Refusing to save ${name}: ${file.readOnlyReason}`);
    const bytes = serializeDoo(file);
    const reparsed = parseDoo(bytes, UNITS_FILE);
    if (reparsed.error) throw new Error(`Refusing to save ${name}: serialized data did not re-parse (${reparsed.error}).`);
    const empty = Buffer.alloc(0);
    if (reparsed.version !== file.version || reparsed.subVersion !== file.subVersion ||
        canonicalJson(reparsed.units) !== canonicalJson(file.units ?? []) || !(reparsed.tail ?? empty).equals(file.tail ?? empty)) {
        throw new Error(`Refusing to save ${name}: round-trip verification failed.`);
    }
    return bytes;
}

function readMapInfo(dir: string): MapInfo {
    const w3iPath = findFileCI(dir, 'war3map.w3i');
    try {
        // The header is read before anything that can fail; players are best-effort and may be missing.
        const w3i = w3iPath ? parseW3i(fs.readFileSync(w3iPath)) : undefined;
        return { version: w3i?.version ?? 0, editorVersion: w3i?.editorVersion ?? 0, playerNumbers: (w3i?.players ?? []).map((p) => p.num) };
    } catch {
        return { version: 0, editorVersion: 0, playerNumbers: [] };
    }
}

/**
 * Maps saved by a 1.29+ editor have 24 players and keep the neutrals at 24/27; older ones at 12/15.
 * A player slot above 12 or an owner above 15 gives a 24-player map away even without a usable w3i.
 */
function ownerLayout(info: MapInfo, units: DooUnit[]): OwnerLayout {
    return info.editorVersion > LAST_12_PLAYER_EDITOR || info.version >= 28 ||
        info.playerNumbers.some((n) => n > 11) || units.some((u) => u.ownerIndex > 15)
        ? { players: 24, neutralHostile: 24, neutralPassive: 27 }
        : { players: 12, neutralHostile: 12, neutralPassive: 15 };
}

function validOwner(layout: OwnerLayout, owner: unknown): number | undefined {
    if (!Number.isInteger(owner)) return undefined;
    const value = owner as number;
    return (value >= 0 && value < layout.players) || value === layout.neutralHostile || value === layout.neutralPassive ? value : undefined;
}

function ownerOptions(layout: OwnerLayout): Array<{ value: number; label: string }> {
    return [
        ...Array.from({ length: layout.players }, (_, i) => ({ value: i, label: `Player ${i + 1}` })),
        { value: layout.neutralHostile, label: 'Neutral Hostile' },
        { value: layout.neutralPassive, label: 'Neutral Passive' },
    ];
}

function stripColorCodes(text: string): string {
    return text.replace(/\|c[0-9a-f]{8}|\|r/gi, '').trim();
}

/** Custom units (`.w3u`) or items (`.w3t`) the map defines, named by their `unam` field. */
function readCustomTypes(dir: string, kind: 'unit' | 'item', wts: TriggerStringTable, baseName: (id: string) => string): PlacementType[] {
    const ext = kind === 'unit' ? '.w3u' : '.w3t';
    const filePath = findFileCI(dir, `war3map${ext}`);
    if (!filePath) return [];
    try {
        const parsed = parseObjMod(fs.readFileSync(filePath), ext);
        if (parsed.error) return [];
        return parsed.customObjs.flatMap((entry) => {
            if (!entry.newId) return [];
            const nameMod = entry.mods.find((mod) => mod.fieldId === 'unam');
            const raw = typeof nameMod?.value === 'string' ? String(resolveTriggerString(nameMod.value, wts).value ?? '') : '';
            return [{ id: entry.newId, name: stripColorCodes(raw) || `${baseName(entry.baseId)} (custom)`, kind, custom: true }];
        });
    } catch {
        return [];
    }
}

async function loadPlacementTypes(uri: vscode.Uri, dir: string, catalog: Map<string, ObjectRef>): Promise<Map<string, PlacementType>> {
    const kb = await loadCompilerKnowledgeBase();
    const baseIds = kb
        ? { unit: Object.keys(kb.objects.unit), item: Object.keys(kb.objects.item) }
        : { unit: Array.from((await loadSlkRows('Units\\UnitData.slk')).keys()), item: Array.from((await loadSlkRows('Units\\ItemData.slk')).keys()) };
    const types = new Map<string, PlacementType>();
    const nameOf = (id: string) => types.get(id)?.name || catalog.get(id.toLowerCase())?.name || id;
    for (const kind of ['unit', 'item'] as const) {
        for (const id of baseIds[kind]) types.set(id, { id, name: nameOf(id), kind, custom: false });
    }
    const wts = loadTriggerStringsForUri(uri);
    for (const kind of ['unit', 'item'] as const) {
        for (const type of readCustomTypes(dir, kind, wts, nameOf)) types.set(type.id, type);
    }
    types.delete(START_LOCATION);
    return types;
}

/** Loads everything around the placement list: terrain, doodads, object types, player layout. */
async function loadScene(doc: MapPlacementDocument): Promise<void> {
    if (doc.loadError || doc.file.error || doc.scene) return;
    const dir = path.dirname(doc.uri.fsPath);
    const w3ePath = findFileCI(dir, 'war3map.w3e');
    if (!w3ePath) {
        doc.sceneError = `There is no war3map.w3e next to ${doc.fileName}. The placement editor needs the exploded map folder.`;
        return;
    }
    try {
        const terrain = await parseW3eTerrain(fs.readFileSync(w3ePath));
        const catalog = await mapObjectCatalog(dir).catch(() => new Map<string, ObjectRef>());
        const [materials, types] = await Promise.all([buildTerrainMaterials(terrain), loadPlacementTypes(doc.uri, dir, catalog)]);
        const doodads = readDoodads(dir, catalog);
        const mapInfo = readMapInfo(dir);
        const units = doc.units;
        doc.scene = {
            terrain, materials, types, catalog,
            doodads: doodads.markers,
            owners: ownerLayout(mapInfo, units),
            // Reforged (w3i v31) added skin ids; follow the map's own files before guessing from the version.
            usesSkins: units.length ? units.some((u) => u.skinId !== undefined) : doodads.usesSkins ?? mapInfo.version >= 31,
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        doc.sceneError = `Failed to parse terrain: ${message}`;
        offerIssueReport({
            area: 'map placement editor',
            message,
            resource: vscode.Uri.file(w3ePath),
            details: e instanceof Error ? e.stack : undefined,
        });
    }
}

function placementKind(scene: MapScene, typeId: string): PlacementKind {
    if (typeId === START_LOCATION) return 'start';
    return scene.types.get(typeId)?.kind === 'item' ? 'item' : 'unit';
}

function placementName(scene: MapScene, typeId: string): string {
    if (typeId === START_LOCATION) return 'Start Location';
    return scene.types.get(typeId)?.name || scene.catalog.get(typeId.toLowerCase())?.name || typeId;
}

function placementSummaries(doc: MapPlacementDocument, scene: MapScene) {
    return doc.units.map((u) => ({
        id: u.typeId, name: placementName(scene, u.typeId), kind: placementKind(scene, u.typeId),
        owner: u.ownerIndex, x: u.x, y: u.y, z: u.z, editorId: u.editorId,
        ...(u.typeId === START_LOCATION ? {} : markerModel(scene.catalog.get((u.skinId || u.typeId).toLowerCase()) ?? scene.catalog.get(u.typeId.toLowerCase()), u, false)),
    }));
}

function buildMapEditorHtml(doc: MapPlacementDocument, scene: MapScene, scriptUri: string, cspSource = "'self'"): string {
    const { terrain, materials } = scene;
    const nonce = makeNonce();
    const loadedTextures = materials.textures.filter((t) => t.dataUri).length;
    const textureStatus = loadedTextures ? `${loadedTextures}/${materials.textures.length} textures` : 'texture fallback colors';
    const meta = `${terrain.width - 1}x${terrain.height - 1} tiles | ${terrain.groundTiles.length} ground tiles | ${terrain.cliffTiles.length} cliff tiles | ${scene.doodads.length} doodads | ${textureStatus}`;
    const readOnly = doc.file.readOnlyReason;
    const initialJson = scriptSafeJson({
        terrain: {
            w: terrain.width,
            h: terrain.height,
            cx: terrain.centerX,
            cy: terrain.centerY,
            min: terrain.min,
            max: terrain.max,
            tile: TILE,
            heights: b64(terrain.heights),
            water: b64(terrain.water),
            ground: b64(terrain.ground),
            cliff: b64(terrain.cliff),
            layer: b64(terrain.layer),
            flags: b64(terrain.flags),
            detail: b64(terrain.detail),
            waterMask: b64(terrain.waterMask),
            cliffToGround: materials.cliffToGround,
            blightTexture: materials.blightTexture,
            textures: materials.textures,
            sceneWorkerUri: scriptUri.replace('mapPreviewWebview.js', 'mapSceneWorker.js'),
            assetWorkerUri: scriptUri.replace('mapPreviewWebview.js', 'mapAssetWorker.js'),
        },
        doodads: scene.doodads,
        placements: placementSummaries(doc, scene),
        owners: ownerOptions(scene.owners),
        readOnly: readOnly ?? null,
    });

    return buildPage({
        csp: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; worker-src blob:; connect-src ${cspSource} data:;`,
        title: escapeHtml(doc.fileName),
        extraCss: MAP_PREVIEW_CSS,
        body: `<div class="mp-shell">
  <div class="wv-toolbar">
    <div class="mp-legend">
      <label><input type="checkbox" id="t-terrain" checked> Terrain</label>
      <label><input type="checkbox" id="t-cliffs" checked><span class="mp-swatch" style="background:#7a6a50"></span>Cliffs</label>
      <label><input type="checkbox" id="t-water" checked><span class="mp-swatch" style="background:#3aa7cc"></span>Water</label>
      <label><input type="checkbox" id="mp-models" checked>Models</label>
      <label><input type="checkbox" id="mp-animate" checked>Animate</label>
      <label><input type="checkbox" id="mp-xray">Markers through terrain</label>
      <label><input type="checkbox" id="t-doodads" checked><span class="mp-swatch" style="background:#5dd35d"></span>Doodads</label>
      <label><input type="checkbox" id="t-units" checked><span class="mp-swatch" style="background:#ffb14e"></span>Units</label>
      <label><input type="checkbox" id="t-items" checked><span class="mp-swatch" style="background:#d9a6ff"></span>Items</label>
      <label><input type="checkbox" id="t-sloc" checked><span class="mp-swatch" style="background:#4ec9ff"></span>Start</label>
    </div>
    <span class="wv-sep"></span>
    <label class="mp-range">Height x<input type="range" id="mp-exag" min="0.5" max="6" step="0.25" value="1"></label>
    <button class="wv-btn" id="mp-reset" type="button">Reset view</button>
    <button class="wv-btn" id="mp-top" type="button">Top view</button>
    <span id="mp-dirty" class="wv-dirty"${doc.isDirty ? '' : ' hidden'}>Modified</span>
  </div>
  <div class="mp-body">
    <div class="mp-main">
      <canvas id="mp-canvas" aria-label="Map view. F focuses selection; Escape clears it."></canvas>
      <div id="mp-selection-ring" hidden></div>
      <div class="mp-mode" id="mp-mode" role="status" hidden></div>
      <div class="mp-tip" id="mp-tip"></div>
      <div class="mp-err" id="mp-err">WebGL is not available in this webview.</div>
    </div>
    <aside class="mp-side" aria-label="Placements">
      ${readOnly ? `<div class="mp-readonly" role="note">${escapeHtml(readOnly)}</div>` : ''}
      <section class="mp-section mp-browse">
    <label for="mp-placement-search">Placed objects</label>
    <input class="wv-input" id="mp-placement-search" type="search" placeholder="Search name or rawcode" aria-label="Search placed objects">
    <label for="mp-placement-owner">Owner</label>
    <select class="wv-input" id="mp-placement-owner"><option value="all">All owners</option></select>
    <label><input type="checkbox" id="mp-isolate">Only selected placement</label>
    <div id="mp-count" role="status"></div>
    <div id="mp-objects" role="group" aria-label="Matching placements"></div>
    <button class="wv-btn" id="mp-more" type="button" hidden>Show more</button>
    <div class="mp-details" id="mp-details">Select a marker or a placement in the list.</div>
    <div class="mp-actions">
      <button class="wv-btn wv-btn-primary" id="mp-focus" type="button" disabled>Focus (F)</button>
      <button class="wv-btn" id="mp-clear" type="button" disabled>Clear</button>
    </div>
      </section>
      <section class="mp-section">
        <h2 class="mp-section-title">Selection</h2>
        <div id="mp-selection"></div>
      </section>
      <section class="mp-section mp-place">
        <h2 class="mp-section-title">Place</h2>
        <div class="mp-kinds">
          <button type="button" class="wv-btn active" data-kind="unit" aria-pressed="true">Units</button>
          <button type="button" class="wv-btn" data-kind="item" aria-pressed="false">Items</button>
        </div>
        <input id="mp-search" class="wv-input" type="search" placeholder="Search name or rawcode" spellcheck="false" aria-label="Search object types">
        <label class="mp-field">Owner <select id="mp-owner" class="wv-input"></select></label>
        <div id="mp-types" class="mp-types wv-scroll" role="listbox" aria-label="Object types"></div>
      </section>
    </aside>
  </div>
  <div class="wv-toolbar"><span class="mp-meta">${escapeHtml(meta)}</span><span id="mp-model-status" role="status">Loading scene…</span><span class="mp-hint">drag = orbit | right-drag = pan | scroll = zoom | drag a selected marker to move it | Del = delete | Esc = cancel</span></div>
</div>
<script nonce="${nonce}">window.__MAP_PREVIEW_INITIAL__ = ${initialJson};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>`,
    });
}

/**
 * The unit a message targets, if it is a unit or item; start locations stay read-only. The creation
 * number must still match, so a message sent against an older list (a held Delete key repeats faster
 * than the state round trip) cannot hit whichever unit has moved into that index since.
 */
function editableUnit(doc: MapPlacementDocument, msg: PlacementMessage): DooUnit | undefined {
    if (!Number.isInteger(msg.index)) return undefined;
    const unit = doc.units[msg.index as number];
    return unit && unit.editorId === msg.editorId && unit.typeId !== START_LOCATION ? unit : undefined;
}

/** A webview-supplied position clamped to the map and snapped to whole units, with z on the terrain. */
function groundPosition(terrain: Terrain, x: unknown, y: unknown): { x: number; y: number; z: number } | undefined {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const gx = Math.round(Math.min(Math.max(x, terrain.centerX), terrain.centerX + (terrain.width - 1) * TILE));
    const gy = Math.round(Math.min(Math.max(y, terrain.centerY), terrain.centerY + (terrain.height - 1) * TILE));
    return { x: gx, y: gy, z: Math.fround(terrainHeightAt(terrain, gx, gy)) };
}

/** A unit or item record carrying the values World Editor writes for a fresh placement. */
function newPlacement(doc: MapPlacementDocument, scene: MapScene, typeId: string, at: { x: number; y: number; z: number }, ownerIndex: number): DooUnit {
    const subV11 = doc.file.subVersion >= 11;
    return {
        typeId, variation: 0, ...at, angle: DEFAULT_FACING, scaleX: 1, scaleY: 1, scaleZ: 1,
        skinId: scene.usesSkins ? typeId : undefined,
        flags: 2, ownerIndex, unknownA: 0, unknownB: 0, lifePerc: -1, manaPerc: -1,
        itemTablePtr: subV11 ? -1 : undefined, drops: [],
        resourcesAmount: 12500, targetAcquisition: -1, heroLevel: 1,
        heroStr: subV11 ? 0 : undefined, heroAgi: subV11 ? 0 : undefined, heroInt: subV11 ? 0 : undefined,
        invItems: [], abilities: [], randType: 'any', randLevel: 1, randClass: 0,
        customColor: -1, waygateTargetRectIndex: -1,
        editorId: doc.units.reduce((max, u) => Math.max(max, u.editorId), -1) + 1,
    };
}

function moveUnit(doc: MapPlacementDocument, scene: MapScene, provider: PlacementProvider, msg: PlacementMessage): void {
    const unit = editableUnit(doc, msg);
    const to = unit && groundPosition(scene.terrain, msg.x, msg.y);
    if (!unit || !to || (to.x === unit.x && to.y === unit.y && to.z === unit.z)) return;
    const from = { x: unit.x, y: unit.y, z: unit.z };
    provider.pushEdit(doc, `Move ${placementName(scene, unit.typeId)}`, {
        apply: () => { Object.assign(unit, to); doc.selectHint = doc.units.indexOf(unit); },
        revert: () => { Object.assign(unit, from); doc.selectHint = doc.units.indexOf(unit); },
    });
}

function deleteUnit(doc: MapPlacementDocument, scene: MapScene, provider: PlacementProvider, msg: PlacementMessage): void {
    const unit = editableUnit(doc, msg);
    if (!unit) return;
    const index = doc.units.indexOf(unit);
    provider.pushEdit(doc, `Delete ${placementName(scene, unit.typeId)}`, {
        apply: () => { doc.units.splice(index, 1); doc.selectHint = -1; },
        revert: () => { doc.units.splice(index, 0, unit); doc.selectHint = index; },
    });
}

function placeUnit(doc: MapPlacementDocument, scene: MapScene, provider: PlacementProvider, msg: PlacementMessage): void {
    const type = typeof msg.typeId === 'string' ? scene.types.get(msg.typeId) : undefined;
    const at = type && groundPosition(scene.terrain, msg.x, msg.y);
    if (!type || !at) return;
    // World Editor has no owner choice for items: they always belong to Neutral Passive.
    const owner = type.kind === 'item' ? scene.owners.neutralPassive : validOwner(scene.owners, msg.owner) ?? 0;
    const unit = newPlacement(doc, scene, type.id, at, owner);
    provider.pushEdit(doc, `Place ${type.name}`, {
        apply: () => { doc.units.push(unit); doc.selectHint = doc.units.length - 1; },
        revert: () => { doc.units.splice(doc.units.indexOf(unit), 1); doc.selectHint = -1; },
    });
}

function setOwner(doc: MapPlacementDocument, scene: MapScene, provider: PlacementProvider, msg: PlacementMessage): void {
    const unit = editableUnit(doc, msg);
    const owner = validOwner(scene.owners, msg.owner);
    if (!unit || owner === undefined || owner === unit.ownerIndex || placementKind(scene, unit.typeId) === 'item') return;
    const before = unit.ownerIndex;
    provider.pushEdit(doc, `Change owner of ${placementName(scene, unit.typeId)}`, {
        apply: () => { unit.ownerIndex = owner; doc.selectHint = doc.units.indexOf(unit); },
        revert: () => { unit.ownerIndex = before; doc.selectHint = doc.units.indexOf(unit); },
    });
}

function postPlacementTypes(doc: MapPlacementDocument, scene: MapScene): void {
    const types = Array.from(scene.types.values())
        .sort((a, b) => Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    void doc.webview?.postMessage({ type: 'placementTypes', types });
}
async function postSceneAsset(message: { type?: unknown; path?: unknown; paths?: unknown; key?: unknown }, doc: MapPlacementDocument): Promise<void> {
    const scene = doc.scene, webview = doc.webview;
    if (!scene || !webview || typeof message.path !== 'string') return;
    const requested = message.path;
    const key = normalizeAssetPath(requested);
    const replyKey = typeof message.key === 'string' ? message.key : requested;
    const target = { postMessage: (payload: Record<string, unknown>) => webview.postMessage({ ...payload,
        ...(payload.type === 'mdxModel' || payload.type === 'mdxModelMissing' ? { path: replyKey } : {}),
        ...(payload.thumbKey ? { thumbKey: replyKey } : {}),
    }) };
    const doodad = scene.doodads.find(d => d.modelPath && normalizeAssetPath(d.modelPath) === key);
    const allowed = doodad || [...scene.catalog.values()].some(ref => ref.modelPath && normalizeAssetPath(ref.modelPath) === key);
    try {
        if (!allowed) throw new Error('Unknown scene model');
        if (message.type === 'loadMapModel') {
            await postModelToWebview(requested, doc.uri, target, doodad?.modelFallback ? [doodad.modelFallback] : []);
        } else if (Array.isArray(message.paths) && message.paths.every(p => typeof p === 'string')) {
            await postTexturesToWebview(message.paths, doc.uri, target, replyKey, true, 256);
        }
    } catch {
        void webview.postMessage(message.type === 'loadMapModel'
            ? { type: 'mdxModelMissing', path: replyKey }
            : { type: 'modelThumbTexturesComplete', thumbKey: replyKey });
    }
}

function handlePlacementMessage(message: unknown, doc: MapPlacementDocument, provider: PlacementProvider): void {
    const scene = doc.scene;
    if (!message || typeof message !== 'object' || !scene) return;
    const msg = message as PlacementMessage;
    if (msg.type === 'loadMapModel' || msg.type === 'loadMapTextures') { void postSceneAsset(message, doc); return; }
    if (msg.type === 'requestTypes') {
        postPlacementTypes(doc, scene);
        return;
    }
    if (doc.file.readOnlyReason) return;
    if (msg.type === 'move') moveUnit(doc, scene, provider, msg);
    else if (msg.type === 'delete') deleteUnit(doc, scene, provider, msg);
    else if (msg.type === 'place') placeUnit(doc, scene, provider, msg);
    else if (msg.type === 'setOwner') setOwner(doc, scene, provider, msg);
}

function postPlacementState(doc: MapPlacementDocument): void {
    const select = doc.selectHint;
    doc.selectHint = undefined;
    if (!doc.scene) return;
    void doc.webview?.postMessage({ type: 'placementsChanged', placements: placementSummaries(doc, doc.scene), isDirty: doc.isDirty, select });
}

class MapPlacementEditorProvider extends EditableBinaryEditorProvider<PlacementFile, MapPlacementDocument> {
    constructor(extensionUri: vscode.Uri) {
        const bundleDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
        super({
            label: 'unit placements',
            parse: parsePlacements,
            serialize: serializeValidatedPlacements,
            createDocument: (uri, file) => new MapPlacementDocument(uri, file),
            webviewOptions: { enableScripts: true, localResourceRoots: [bundleDir] },
            render: (doc) => doc.scene
                ? buildMapEditorHtml(doc, doc.scene, doc.webview!.asWebviewUri(vscode.Uri.joinPath(bundleDir, 'mapPreviewWebview.js')).toString(), doc.webview!.cspSource)
                : buildErrorHtml(doc.fileName, doc.sceneError ?? 'The map terrain did not load.', 'Could not open the map placement editor'),
            postState: postPlacementState,
            handleMessage: handlePlacementMessage,
        });
    }

    override async resolveCustomEditor(doc: MapPlacementDocument, panel: vscode.WebviewPanel): Promise<void> {
        if (!doc.scene && !doc.sceneError) {
            panel.webview.html = buildLoadingHtml(doc.fileName);
            await loadScene(doc);
        }
        await super.resolveCustomEditor(doc, panel);
    }
}

async function openMapEditor(resource?: vscode.Uri): Promise<void> {
    let w3ePath = findMapW3e(activeResourcePath(resource));
    if (!w3ePath) {
        const hits = await vscode.workspace.findFiles('**/war3map.w3e', '**/node_modules/**', 1);
        w3ePath = hits[0]?.fsPath;
    }
    if (!w3ePath) {
        vscode.window.showWarningMessage(
            'Map editor: no war3map.w3e found near the active file or in the workspace. Open a folder containing an exploded map.',
        );
        return;
    }
    const mapDir = path.dirname(w3ePath);
    let unitsPath = findFileCI(mapDir, UNITS_FILE);
    if (!unitsPath) {
        const create = `Create ${UNITS_FILE}`;
        const choice = await vscode.window.showInformationMessage(
            `${path.basename(mapDir)} has no ${UNITS_FILE} yet. Create an empty one to place units and items?`, create,
        );
        if (choice !== create) return;
        unitsPath = path.join(mapDir, UNITS_FILE);
        await vscode.workspace.fs.writeFile(vscode.Uri.file(unitsPath), serializeDoo({ kind: 'units', version: 8, subVersion: 11, units: [] }));
    }
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(unitsPath), MAP_EDITOR_VIEW_TYPE);
}

export function registerMapPreview(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.Disposable.from(
        vscode.window.registerCustomEditorProvider(MAP_EDITOR_VIEW_TYPE, new MapPlacementEditorProvider(context.extensionUri), {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('wurst.previewMap', openMapEditor),
    );
}
