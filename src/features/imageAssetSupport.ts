'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';

import { decodeRasterPreview, ensureGameAssetCached } from './blpPreview';
import { getGameAssetCacheDir, ensureGameTextureCached } from './preview/cascStorage';

export const IMAGE_EXTS = new Set(['blp', 'dds', 'tga', 'png', 'jpg', 'jpeg']);
export const SOUND_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac']);

export interface PreviewCacheEntry {
    previewPath: string;
    mtime: number;
    origW: number;
    origH: number;
    description: string;
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }
    return table;
})();

export function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

export function fastByteHash(bytes: Uint8Array): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x27d4eb2d;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + b, 0x85ebca6b) >>> 0;
        h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
    }
    return `${bytes.length.toString(16)}-${h1.toString(16).padStart(8, '0')}-${h2.toString(16).padStart(8, '0')}`;
}

export function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const checksumBuffer = Buffer.alloc(4);
    checksumBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([lengthBuffer, typeBuffer, data, checksumBuffer]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;

    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4;
            const dst = y * (width * 4 + 1) + 1 + x * 4;
            raw[dst] = rgba[src];
            raw[dst + 1] = rgba[src + 1];
            raw[dst + 2] = rgba[src + 2];
            raw[dst + 3] = rgba[src + 3];
        }
    }

    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

export function scaleDown(rgba: Uint8Array, srcW: number, srcH: number, maxDim: number): { rgba: Uint8Array; w: number; h: number } {
    if (srcW <= maxDim && srcH <= maxDim) {
        return { rgba, w: srcW, h: srcH };
    }

    const scale = maxDim / Math.max(srcW, srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const out = new Uint8Array(dstW * dstH * 4);

    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const srcX = (x + 0.5) / scale - 0.5;
            const srcY = (y + 0.5) / scale - 0.5;
            const x0 = Math.max(0, Math.floor(srcX));
            const y0 = Math.max(0, Math.floor(srcY));
            const x1 = Math.min(srcW - 1, x0 + 1);
            const y1 = Math.min(srcH - 1, y0 + 1);
            const tx = Math.max(0, Math.min(1, srcX - x0));
            const ty = Math.max(0, Math.min(1, srcY - y0));
            const dst = (y * dstW + x) * 4;

            for (let c = 0; c < 4; c++) {
                const p00 = rgba[(y0 * srcW + x0) * 4 + c];
                const p10 = rgba[(y0 * srcW + x1) * 4 + c];
                const p01 = rgba[(y1 * srcW + x0) * 4 + c];
                const p11 = rgba[(y1 * srcW + x1) * 4 + c];
                const top = p00 + (p10 - p00) * tx;
                const bottom = p01 + (p11 - p01) * tx;
                out[dst + c] = Math.round(top + (bottom - top) * ty);
            }
        }
    }

    return { rgba: out, w: dstW, h: dstH };
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function isFreshPreviewFile(previewPath: string, sourceMtime: number): Promise<boolean> {
    try {
        return (await fs.promises.stat(previewPath)).mtimeMs >= sourceMtime;
    } catch {
        return false;
    }
}

async function getFreshPreviewPath(basePath: string, sourceMtime: number): Promise<string | undefined> {
    for (const ext of ['.png', '.jpg']) {
        const candidate = basePath + ext;
        if (await isFreshPreviewFile(candidate, sourceMtime)) {
            return candidate;
        }
    }
    return undefined;
}

const candidateRootsCache = new Map<string, Promise<string[]>>();

export async function getCandidateRoots(documentFsPath: string): Promise<string[]> {
    const workspaceKey = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath).join('|');
    const cacheKey = `${documentFsPath}|${workspaceKey}`;
    let promise = candidateRootsCache.get(cacheKey);
    if (!promise) {
        promise = getCandidateRootsUncached(documentFsPath);
        candidateRootsCache.set(cacheKey, promise);
    }
    return [...await promise];
}

async function getCandidateRootsUncached(documentFsPath: string): Promise<string[]> {
    const seen = new Set<string>();
    const roots: string[] = [];
    const add = (candidate: string) => {
        if (candidate && !seen.has(candidate)) {
            seen.add(candidate);
            roots.push(candidate);
        }
    };
    const addAssetSubdirs = (base: string) => {
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets', 'UI']) {
            add(path.join(base, sub));
        }
    };
    const addMapFolderRoot = (candidate: string) => {
        add(candidate);
        addAssetSubdirs(candidate);
    };

    const documentDir = path.dirname(documentFsPath);
    add(documentDir);
    if (/\.(w3x|w3m)$/i.test(documentDir)) {
        addAssetSubdirs(documentDir);
    }

    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
        const root = folder.uri.fsPath;
        add(root);
        addAssetSubdirs(root);
        try {
            const entries = await fs.promises.readdir(root);
            await Promise.all(entries.map(async (entry) => {
                const lower = entry.toLowerCase();
                if (!lower.endsWith('.w3x') && !lower.endsWith('.w3m')) {
                    return;
                }
                const full = path.join(root, entry);
                try {
                    if ((await fs.promises.stat(full)).isDirectory()) {
                        addMapFolderRoot(full);
                    }
                } catch {
                    return;
                }
            }));
        } catch {
            return;
        }
    }));

    add(getGameAssetCacheDir());
    return roots;
}

export interface ImportedAsset { value: string; label: string; iconPath?: string; source: 'import'; hash?: string; }

const IMPORT_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'out', 'build', '_build', 'target', '.wurst', 'wurst', '.idea', '.vscode']);

async function hashImportedAsset(fullPath: string): Promise<string | undefined> {
    try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile()) return undefined;
        return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
        return undefined;
    }
}

/**
 * Enumerate user-imported asset files (models + textures + sounds) under the project's local roots, so the
 * asset browser can offer them alongside the WC3 game catalog. Paths are returned relative to their
 * root (map-relative, WC3 style) so they resolve and serialize correctly. Bounded to keep it cheap.
 */
export async function gatherImportedAssets(documentFsPath: string): Promise<{ model: ImportedAsset[]; icon: ImportedAsset[]; sound: ImportedAsset[] }> {
    const cacheDir = getGameAssetCacheDir();
    const roots = (await getCandidateRoots(documentFsPath)).filter((r) => r !== cacheDir);
    const model: ImportedAsset[] = [];
    const icon: ImportedAsset[] = [];
    const sound: ImportedAsset[] = [];
    const seenValue = new Set<string>();
    let budget = 4000;

    const walk = async (root: string, dir: string, depth: number): Promise<void> => {
        if (budget <= 0 || depth > 8) return;
        let entries: import('fs').Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (budget <= 0) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IMPORT_SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
                await walk(root, full, depth + 1);
                continue;
            }
            budget--;
            const ext = path.extname(entry.name).slice(1).toLowerCase();
            const isModel = ext === 'mdx' || ext === 'mdl';
            const isTex = ext === 'blp' || ext === 'dds' || ext === 'tga';
            const isSound = SOUND_EXTS.has(ext);
            if (!isModel && !isTex && !isSound) continue;
            const rel = path.relative(root, full).replace(/\//g, '\\');
            const key = rel.toLowerCase();
            if (seenValue.has(key)) continue;
            seenValue.add(key);
            const hash = await hashImportedAsset(full);
            const opt: ImportedAsset = { value: rel, label: entry.name, source: 'import', hash };
            if (isTex) { opt.iconPath = rel; icon.push(opt); }
            else if (isSound) { sound.push(opt); }
            else { model.push(opt); }
        }
    };

    for (const root of roots) {
        if (budget <= 0) break;
        await walk(root, root, 0);
    }
    const byLabel = (a: ImportedAsset, b: ImportedAsset) => a.label.localeCompare(b.label);
    return { model: model.sort(byLabel), icon: icon.sort(byLabel), sound: sound.sort(byLabel) };
}

// WC3 resolves assets by name, ignoring the requested extension: models use
// .mdx/.mdl, textures use .blp/.dds/.tga. Reforged material paths often name
// source .tif files even though CASC/local assets are shipped as .dds.
const MODEL_EXTS = ['mdx', 'mdl'];
const TEXTURE_EXTS = ['blp', 'dds', 'tga'];
const TEXTURE_SOURCE_EXTS = [...TEXTURE_EXTS, 'tif'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac'];

function assetExt(assetPath: string): string {
    const slash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
    const dot = assetPath.lastIndexOf('.');
    return dot > slash ? assetPath.slice(dot + 1).toLowerCase() : '';
}

export type AssetKind = 'model' | 'texture' | 'sound' | 'any';

function stripKnownAssetExt(assetPath: string, kind: AssetKind): string {
    const ext = assetExt(assetPath);
    const strip = kind === 'model' ? ext !== ''
        : kind === 'texture' ? ext !== ''
        : kind === 'sound' ? ext !== ''
        : MODEL_EXTS.includes(ext) || TEXTURE_SOURCE_EXTS.includes(ext) || AUDIO_EXTS.includes(ext);
    return strip ? assetPath.slice(0, assetPath.length - ext.length - 1) : assetPath;
}

function lookupExtsForKind(kind: AssetKind, ext: string): string[] {
    if (kind === 'model') return MODEL_EXTS;
    if (kind === 'texture') return TEXTURE_EXTS;
    if (kind === 'sound') return AUDIO_EXTS;
    if (MODEL_EXTS.includes(ext)) return MODEL_EXTS;
    if (TEXTURE_SOURCE_EXTS.includes(ext)) return TEXTURE_EXTS;
    if (AUDIO_EXTS.includes(ext)) return AUDIO_EXTS;
    if (ext === '') return [...MODEL_EXTS, ...TEXTURE_EXTS];
    return [];
}

async function findCaseInsensitiveChild(dir: string, name: string): Promise<string | undefined> {
    try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const lower = name.toLowerCase();
        const found = entries.find((entry) => entry.name.toLowerCase() === lower);
        return found ? path.join(dir, found.name) : undefined;
    } catch {
        return undefined;
    }
}

async function resolveDirectoryCaseInsensitive(root: string, relDir: string): Promise<string | undefined> {
    if (!relDir || relDir === '.') return root;
    const exact = path.join(root, relDir);
    try {
        if ((await fs.promises.stat(exact)).isDirectory()) return exact;
    } catch {}

    let current = root;
    for (const part of relDir.split(/[\\/]+/).filter(Boolean)) {
        const next = await findCaseInsensitiveChild(current, part);
        if (!next) return undefined;
        try {
            if (!(await fs.promises.stat(next)).isDirectory()) return undefined;
        } catch {
            return undefined;
        }
        current = next;
    }
    return current;
}

async function resolveAssetPathByClass(assetPath: string, roots: readonly string[], kind: AssetKind): Promise<string | undefined> {
    const ext = assetExt(assetPath);
    const allowedExts = lookupExtsForKind(kind, ext);
    if (!allowedExts.length) return undefined;

    const normalized = stripKnownAssetExt(assetPath.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep), kind);
    const relDir = path.dirname(normalized);
    const requestedStem = path.basename(normalized).toLowerCase();
    const allowed = new Set(allowedExts);

    for (const root of roots) {
        const dir = await resolveDirectoryCaseInsensitive(root, relDir);
        if (!dir) continue;
        let entries: import('fs').Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const entryExt = path.extname(entry.name).slice(1).toLowerCase();
            if (!allowed.has(entryExt)) continue;
            const entryStem = entry.name.slice(0, entry.name.length - entryExt.length - 1).toLowerCase();
            if (entryStem === requestedStem) {
                return path.join(dir, entry.name);
            }
        }
    }

    return undefined;
}

export async function resolveAssetPath(assetPath: string, roots: readonly string[], kind: AssetKind = 'any'): Promise<string | undefined> {
    const normalized = assetPath.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep);
    const lower = normalized.toLowerCase();
    const lowerDds = lower.replace(/\.blp$/, '.dds');

    for (const root of roots) {
        const exact = path.join(root, normalized);
        if (await pathExists(exact)) {
            return exact;
        }

        if (lower !== normalized) {
            const lowerCandidate = path.join(root, lower);
            if (await pathExists(lowerCandidate)) {
                return lowerCandidate;
            }
        }

        if (lowerDds !== lower) {
            const ddsCandidate = path.join(root, lowerDds);
            if (await pathExists(ddsCandidate)) {
                return ddsCandidate;
            }
        }
    }

    const fileName = path.basename(normalized);
    for (const root of roots) {
        const fallback = path.join(root, fileName);
        if (await pathExists(fallback)) {
            return fallback;
        }
    }

    return resolveAssetPathByClass(assetPath, roots, kind);
}

/**
 * Candidate paths to try for an asset, accounting for WC3's extension-agnostic lookup.
 * The original path is tried first, then the sibling extensions for its asset class.
 *
 * `kind` constrains the class: `'model'` only ever yields .mdx/.mdl, `'texture'` only
 * .blp/.dds/.tga. This matters for extension-less paths (e.g. a `umdl` value like
 * `Buildings\Undead\Graveyard\Graveyard`) — a model lookup must NOT fall back to a
 * same-named texture and then mis-feed it to the MDX parser. `'any'` infers from the ext.
 */
export function assetPathVariants(assetPath: string, kind: AssetKind = 'any'): string[] {
    const ext = assetExt(assetPath);
    const exts = lookupExtsForKind(kind, ext);
    if (!exts.length) return [assetPath];

    const base = stripKnownAssetExt(assetPath, kind);
    const variants: string[] = [];
    if (MODEL_EXTS.includes(ext) || TEXTURE_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) variants.push(assetPath);
    for (const e of exts) {
        const v = `${base}.${e}`;
        if (!variants.includes(v)) variants.push(v);
    }
    return variants;
}

async function resolveCachedGameAsset(variant: string): Promise<string | undefined> {
    const normalized = variant.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep).toLowerCase();
    const candidate = path.join(getGameAssetCacheDir(), normalized);
    return await pathExists(candidate) ? candidate : undefined;
}

/**
 * Resolve an asset to a concrete file using WC3-style precedence: game data first, then
 * project-local roots (map folder/imports/workspace). Pass `kind` to constrain a model/texture
 * lookup to its own extension class.
 */
export async function resolveAssetPathWithCasc(assetPath: string, roots: readonly string[], kind: AssetKind = 'any'): Promise<string | undefined> {
    const variants = assetPathVariants(assetPath, kind);
    for (const variant of variants) {
        const cached = await resolveCachedGameAsset(variant);
        if (cached) return cached;
    }
    for (const variant of variants) {
        const cached = TEXTURE_EXTS.includes(assetExt(variant))
            ? await ensureGameTextureCached(variant)
            : await ensureGameAssetCached(variant);
        if (cached) return cached;
    }
    for (const variant of variants) {
        const resolved = await resolveAssetPath(variant, roots);
        if (resolved) return resolved;
    }
    return undefined;
}

export async function getCachedPreview(
    fsPath: string,
    cacheDir: string,
    cache: Map<string, PreviewCacheEntry>,
    log?: (message: string) => void,
): Promise<PreviewCacheEntry | undefined> {
    const ext = path.extname(fsPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext.slice(1))) {
        return undefined;
    }

    let mtime = 0;
    try {
        mtime = (await fs.promises.stat(fsPath)).mtimeMs;
    } catch {
        return undefined;
    }

    const cached = cache.get(fsPath);
    if (cached && cached.mtime === mtime && await isFreshPreviewFile(cached.previewPath, mtime)) {
        log?.(`preview cache hit: ${path.basename(fsPath)}`);
        return cached;
    }

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        const entry: PreviewCacheEntry = {
            previewPath: fsPath,
            mtime,
            origW: 0,
            origH: 0,
            description: ext.slice(1).toUpperCase(),
        };
        cache.set(fsPath, entry);
        return entry;
    }

    try {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        // Version the generated raster cache so pre-fix JPEG-backed BLP previews
        // (which contained unswapped BGR channels) are never reused.
        const key = crypto.createHash('sha1').update('rgba-v2\0').update(fsPath).digest('hex');
        const previewPath = await getFreshPreviewPath(path.join(cacheDir, key), mtime);
        if (!previewPath) {
            return undefined;
        }

        const entry: PreviewCacheEntry = {
            previewPath,
            mtime,
            origW: 0,
            origH: 0,
            description: ext.slice(1).toUpperCase(),
        };
        cache.set(fsPath, entry);
        log?.(`preview disk cache hit: ${path.basename(fsPath)}`);
        return entry;
    } catch {
        return undefined;
    }
}

export async function ensurePreview(
    fsPath: string,
    cacheDir: string,
    maxDim: number,
    cache: Map<string, PreviewCacheEntry>,
    log?: (message: string) => void,
): Promise<PreviewCacheEntry | undefined> {
    const cached = await getCachedPreview(fsPath, cacheDir, cache, log);
    if (cached) {
        return cached;
    }

    const ext = path.extname(fsPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext.slice(1))) {
        return undefined;
    }

    let mtime = 0;
    try {
        mtime = (await fs.promises.stat(fsPath)).mtimeMs;
    } catch {
        return undefined;
    }

    try {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const key = crypto.createHash('sha1').update('rgba-v2\0').update(fsPath).digest('hex');
        const previewBasePath = path.join(cacheDir, key);
        const bytes = new Uint8Array(await fs.promises.readFile(fsPath));
        const decoded = decodeRasterPreview(bytes, ext);
        const previewPath = `${previewBasePath}.png`;
        const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
        const scaled = scaleDown(rgba, decoded.width, decoded.height, maxDim);
        await fs.promises.writeFile(previewPath, encodePng(scaled.w, scaled.h, scaled.rgba));

        const entry: PreviewCacheEntry = {
            previewPath,
            mtime,
            origW: decoded.width,
            origH: decoded.height,
            description: decoded.description,
        };
        cache.set(fsPath, entry);
        log?.(`preview generated: ${path.basename(fsPath)}`);
        return entry;
    } catch {
        return undefined;
    }
}

export function getTempPreviewDir(name: string): string {
    return path.join(os.tmpdir(), name);
}

/**
 * Shared lazy icon loader for parsed-data webviews. Resolves an icon path against
 * the document's local roots (then CASC), decodes it through the central raster
 * pipeline, and posts the result to the webview keyed by `key`. Pair with the
 * client-side ICON_LAZYLOAD_SCRIPT in webviewShared.ts.
 *
 * Posts `{ type: 'objectIconLoaded', key, mode, ... }` on success, or
 * `{ type: 'objectIconMissing', key }` when the asset can't be found/decoded.
 */
export async function requestPreviewIcon(
    iconPath: string,
    key: string,
    webview: vscode.Webview,
    documentUri: vscode.Uri,
): Promise<void> {
    const roots = await getCandidateRoots(documentUri.fsPath);
    const fsPath = await resolveAssetPathWithCasc(iconPath, roots, 'texture');
    if (!fsPath) {
        await webview.postMessage({ type: 'objectIconMissing', key });
        return;
    }
    try {
        const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
        const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
        const decoded = decodeRasterPreview(bytes, ext);
        await webview.postMessage({
            type: 'objectIconLoaded', key, mode: 'rgba', rgbaBase64: decoded.rgbaBase64,
            width: decoded.width, height: decoded.height,
        });
    } catch {
        await webview.postMessage({ type: 'objectIconMissing', key });
    }
}

/** The in-game unit-tooltip's own subtle fill texture (a small repeatable tile, not a full illustrated
 *  panel — confirmed by decoding it directly). Used as the objmod editor's tooltip-preview background,
 *  in place of a flat color, so the preview reads a little closer to the real in-game tooltip. */
const TOOLTIP_BACKDROP_PATH = 'UI\\Widgets\\ToolTips\\Human\\human-tooltip-background.blp';

/**
 * Posts `{ type: 'tooltipBackdropLoaded', mode: 'rgba', rgbaBase64, width, height }` on success, or
 * `{ type: 'tooltipBackdropMissing' }` when Warcraft III's game data can't be found — callers should
 * keep whatever plain-color fallback they already show in that case.
 */
export async function requestTooltipBackdrop(webview: vscode.Webview, documentUri: vscode.Uri): Promise<void> {
    const roots = await getCandidateRoots(documentUri.fsPath);
    const fsPath = await resolveAssetPathWithCasc(TOOLTIP_BACKDROP_PATH, roots, 'texture');
    if (!fsPath) {
        // Silent by design everywhere else this pipeline is used (a missing icon just shows a "?"), but
        // that makes a from-scratch failure indistinguishable from "haven't looked yet" — log it so it's
        // at least visible in Help > Toggle Developer Tools > Console (or "Log (Extension Host)").
        console.error('[wurst-tooltip-backdrop] texture not found:', TOOLTIP_BACKDROP_PATH, 'candidate roots:', roots);
        await webview.postMessage({ type: 'tooltipBackdropMissing' });
        return;
    }
    try {
        const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
        const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
        const decoded = decodeRasterPreview(bytes, ext);
        await webview.postMessage({
            type: 'tooltipBackdropLoaded', mode: 'rgba', rgbaBase64: decoded.rgbaBase64,
            width: decoded.width, height: decoded.height,
        });
    } catch (err) {
        console.error('[wurst-tooltip-backdrop] decode failed for', fsPath, err);
        await webview.postMessage({ type: 'tooltipBackdropMissing' });
    }
}

/**
 * The gold ornamental tooltip border, as an 8x 16px-wide tile strip (128x16 total) — not a single
 * panel graphic. Decoded and confirmed directly: tiles 0/2 are a plain repeatable left-edge line,
 * tiles 1/3 the same for the right edge, and tiles 4-7 are the TL/TR/BL/BR corners (each blending
 * into the matching straight-edge tile on its far side). There's no separate top/bottom edge tile —
 * the game's frame engine reuses the left/right edge tiles rotated 90° for those, which the webview
 * side replicates via canvas rotation (see applyTooltipBorder in messageHandler.ts).
 */
const TOOLTIP_BORDER_PATH = 'UI\\Widgets\\ToolTips\\Human\\human-tooltip-border.blp';

/**
 * Posts `{ type: 'tooltipBorderLoaded', mode: 'rgba', rgbaBase64, width, height }` (the full, un-sliced
 * 128x16 atlas — slicing happens client-side) on success, or `{ type: 'tooltipBorderMissing' }`.
 */
export async function requestTooltipBorder(webview: vscode.Webview, documentUri: vscode.Uri): Promise<void> {
    const roots = await getCandidateRoots(documentUri.fsPath);
    const fsPath = await resolveAssetPathWithCasc(TOOLTIP_BORDER_PATH, roots, 'texture');
    if (!fsPath) {
        console.error('[wurst-tooltip-border] texture not found:', TOOLTIP_BORDER_PATH, 'candidate roots:', roots);
        await webview.postMessage({ type: 'tooltipBorderMissing' });
        return;
    }
    try {
        const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
        const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
        const decoded = decodeRasterPreview(bytes, ext);
        await webview.postMessage({
            type: 'tooltipBorderLoaded', mode: 'rgba', rgbaBase64: decoded.rgbaBase64,
            width: decoded.width, height: decoded.height,
        });
    } catch (err) {
        console.error('[wurst-tooltip-border] decode failed for', fsPath, err);
        await webview.postMessage({ type: 'tooltipBorderMissing' });
    }
}
