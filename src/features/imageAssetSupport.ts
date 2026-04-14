'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as zlib from 'zlib';

import { decodeRasterPreview, getCascCacheDir, writeJpegPreviewFile } from './blpPreview';

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

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const checksumBuffer = Buffer.alloc(4);
    checksumBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([lengthBuffer, typeBuffer, data, checksumBuffer]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
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

function scaleDown(rgba: Uint8Array, srcW: number, srcH: number, maxDim: number): { rgba: Uint8Array; w: number; h: number } {
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

    add(getCascCacheDir());
    return roots;
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
