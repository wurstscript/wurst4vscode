'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';

import { decodeRasterPreview, ensureGameAssetCached, writeJpegPreviewFile } from './blpPreview';
import { getGameAssetCacheDir, ensureGameTextureCached } from './preview/cascStorage';

export const IMAGE_EXTS = new Set(['blp', 'dds', 'tga', 'png', 'jpg', 'jpeg']);

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

export async function getCandidateRoots(documentFsPath: string): Promise<string[]> {
    const seen = new Set<string>();
    const roots: string[] = [];
    const add = (candidate: string) => {
        if (candidate && !seen.has(candidate)) {
            seen.add(candidate);
            roots.push(candidate);
        }
    };

    add(path.dirname(documentFsPath));

    await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
        const root = folder.uri.fsPath;
        add(root);
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets', 'UI']) {
            add(path.join(root, sub));
        }
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
                        add(full);
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

function rotl32(value: number, bits: number): number {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function xxh32(bytes: Uint8Array, seed = 0): string {
    const p1 = 0x9e3779b1, p2 = 0x85ebca77, p3 = 0xc2b2ae3d, p4 = 0x27d4eb2f, p5 = 0x165667b1;
    let offset = 0;
    let h: number;
    const round = (acc: number, lane: number) => Math.imul(rotl32((acc + Math.imul(lane, p2)) >>> 0, 13), p1) >>> 0;
    if (bytes.length >= 16) {
        let v1 = (seed + p1 + p2) >>> 0;
        let v2 = (seed + p2) >>> 0;
        let v3 = seed >>> 0;
        let v4 = (seed - p1) >>> 0;
        const limit = bytes.length - 16;
        while (offset <= limit) {
            v1 = round(v1, readU32LE(bytes, offset)); offset += 4;
            v2 = round(v2, readU32LE(bytes, offset)); offset += 4;
            v3 = round(v3, readU32LE(bytes, offset)); offset += 4;
            v4 = round(v4, readU32LE(bytes, offset)); offset += 4;
        }
        h = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
    } else {
        h = (seed + p5) >>> 0;
    }
    h = (h + bytes.length) >>> 0;
    while (offset + 4 <= bytes.length) {
        h = Math.imul(rotl32((h + Math.imul(readU32LE(bytes, offset), p3)) >>> 0, 17), p4) >>> 0;
        offset += 4;
    }
    while (offset < bytes.length) {
        h = Math.imul(rotl32((h + Math.imul(bytes[offset], p5)) >>> 0, 11), p1) >>> 0;
        offset++;
    }
    h ^= h >>> 15;
    h = Math.imul(h, p2) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, p3) >>> 0;
    h ^= h >>> 16;
    return h.toString(16).padStart(8, '0');
}

async function hashImportedAsset(fullPath: string): Promise<string | undefined> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isFile()) return undefined;
        handle = await fs.promises.open(fullPath, 'r');
        const chunkSize = Math.min(65536, Math.max(0, stat.size));
        if (chunkSize === 0) return '0:00000000';
        const positions = stat.size <= chunkSize * 2
            ? [0]
            : [0, Math.max(0, Math.floor(stat.size / 2) - Math.floor(chunkSize / 2)), Math.max(0, stat.size - chunkSize)];
        const chunks: Buffer[] = [];
        for (const pos of positions) {
            const buf = Buffer.alloc(chunkSize);
            const read = await handle.read(buf, 0, chunkSize, pos);
            chunks.push(buf.subarray(0, read.bytesRead));
        }
        return `${stat.size}:${xxh32(Buffer.concat(chunks))}`;
    } catch {
        return undefined;
    } finally {
        try { await handle?.close(); } catch {}
    }
}

/**
 * Enumerate user-imported asset files (models + textures) under the project's local roots, so the
 * asset browser can offer them alongside the WC3 game catalog. Paths are returned relative to their
 * root (map-relative, WC3 style) so they resolve and serialize correctly. Bounded to keep it cheap.
 */
export async function gatherImportedAssets(documentFsPath: string): Promise<{ model: ImportedAsset[]; icon: ImportedAsset[] }> {
    const cacheDir = getGameAssetCacheDir();
    const roots = (await getCandidateRoots(documentFsPath)).filter((r) => r !== cacheDir);
    const model: ImportedAsset[] = [];
    const icon: ImportedAsset[] = [];
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
            if (!isModel && !isTex) continue;
            const rel = path.relative(root, full).replace(/\//g, '\\');
            const key = rel.toLowerCase();
            if (seenValue.has(key)) continue;
            seenValue.add(key);
            const hash = await hashImportedAsset(full);
            const opt: ImportedAsset = { value: rel, label: entry.name, source: 'import', hash };
            if (isTex) { opt.iconPath = rel; icon.push(opt); } else { model.push(opt); }
        }
    };

    for (const root of roots) {
        if (budget <= 0) break;
        await walk(root, root, 0);
    }
    const byLabel = (a: ImportedAsset, b: ImportedAsset) => a.label.localeCompare(b.label);
    return { model: model.sort(byLabel), icon: icon.sort(byLabel) };
}

export async function resolveAssetPath(assetPath: string, roots: readonly string[]): Promise<string | undefined> {
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

    return undefined;
}

// WC3 resolves assets by name, ignoring the requested extension — it probes a set of
// known endings. Models: .mdx/.mdl interchangeable; textures: .blp/.dds/.tga.
const MODEL_EXTS = ['mdx', 'mdl'];
const TEXTURE_EXTS = ['blp', 'dds', 'tga'];

function assetExt(assetPath: string): string {
    const slash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
    const dot = assetPath.lastIndexOf('.');
    return dot > slash ? assetPath.slice(dot + 1).toLowerCase() : '';
}

export type AssetKind = 'model' | 'texture' | 'any';

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
    let exts: string[];
    if (kind === 'model') exts = MODEL_EXTS;
    else if (kind === 'texture') exts = TEXTURE_EXTS;
    else if (MODEL_EXTS.includes(ext)) exts = MODEL_EXTS;
    else if (TEXTURE_EXTS.includes(ext)) exts = TEXTURE_EXTS;
    else if (ext === '') exts = [...MODEL_EXTS, ...TEXTURE_EXTS];
    else return [assetPath];

    const known = MODEL_EXTS.includes(ext) || TEXTURE_EXTS.includes(ext);
    const base = known ? assetPath.slice(0, assetPath.length - ext.length - 1) : assetPath;
    const variants: string[] = [];
    if (known) variants.push(assetPath);
    for (const e of exts) {
        const v = `${base}.${e}`;
        if (!variants.includes(v)) variants.push(v);
    }
    return variants;
}

/**
 * Resolve an asset to a concrete file, trying every extension variant against the local
 * roots (map folder, imports/, workspace, game cache) first, then the CASC game files.
 * Pass `kind` to constrain a model/texture lookup to its own extension class.
 */
export async function resolveAssetPathWithCasc(assetPath: string, roots: readonly string[], kind: AssetKind = 'any'): Promise<string | undefined> {
    const variants = assetPathVariants(assetPath, kind);
    for (const variant of variants) {
        const resolved = await resolveAssetPath(variant, roots);
        if (resolved) return resolved;
    }
    for (const variant of variants) {
        const cached = TEXTURE_EXTS.includes(assetExt(variant))
            ? await ensureGameTextureCached(variant)
            : await ensureGameAssetCached(variant);
        if (cached) return cached;
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
        const key = crypto.createHash('sha1').update(fsPath).digest('hex');
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
        const key = crypto.createHash('sha1').update(fsPath).digest('hex');
        const previewBasePath = path.join(cacheDir, key);
        const bytes = new Uint8Array(await fs.promises.readFile(fsPath));
        const decoded = decodeRasterPreview(bytes, ext);
        const previewPath = decoded.mode === 'jpeg' ? `${previewBasePath}.jpg` : `${previewBasePath}.png`;

        if (decoded.mode === 'jpeg') {
            await writeJpegPreviewFile(decoded.jpegBase64, previewPath);
        } else {
            const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
            const scaled = scaleDown(rgba, decoded.width, decoded.height, maxDim);
            await fs.promises.writeFile(previewPath, encodePng(scaled.w, scaled.h, scaled.rgba));
        }

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
        await webview.postMessage(decoded.mode === 'jpeg'
            ? { type: 'objectIconLoaded', key, mode: 'jpeg', jpegBase64: decoded.jpegBase64, width: decoded.width, height: decoded.height }
            : { type: 'objectIconLoaded', key, mode: 'rgba', rgbaBase64: decoded.rgbaBase64, width: decoded.width, height: decoded.height });
    } catch {
        await webview.postMessage({ type: 'objectIconMissing', key });
    }
}
