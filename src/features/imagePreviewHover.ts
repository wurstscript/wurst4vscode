'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { decodeRasterPreview, ensureCascCached, getCascCacheDir, writeJpegPreviewPngSync } from './blpPreview';

// Image extensions we can preview
const PREVIEW_EXTS = new Set(['blp', 'dds', 'tga', 'png', 'jpg', 'jpeg']);

// Max dimension for the hover thumbnail (px) — keeps PNGs tiny
const MAX_PREVIEW_DIM = 128;

// Cache: resolved fs path → { pngPath, mtime, origW, origH, description }
interface CacheEntry { pngPath: string; mtime: number; origW: number; origH: number; description: string; }
const previewCache = new Map<string, CacheEntry>();

// ── PNG encoder ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32(buf: Buffer, start = 0, end = buf.length): number {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 6; // RGBA colour type

    // Scanlines: filter byte (0 = None) + row pixels
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4;
            const dst = y * (width * 4 + 1) + 1 + x * 4;
            raw[dst]     = rgba[src];
            raw[dst + 1] = rgba[src + 1];
            raw[dst + 2] = rgba[src + 2];
            raw[dst + 3] = rgba[src + 3];
        }
    }

    const compressed = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdrData),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Nearest-neighbour scale-down ──────────────────────────────────────────────

function scaleDown(rgba: Uint8Array, srcW: number, srcH: number, maxDim: number): { rgba: Uint8Array; w: number; h: number } {
    if (srcW <= maxDim && srcH <= maxDim) return { rgba, w: srcW, h: srcH };
    const scale = maxDim / Math.max(srcW, srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const out = new Uint8Array(dstW * dstH * 4);
    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const dst = (y * dstW + x) * 4;
            const srcX = (x + 0.5) / scale - 0.5;
            const srcY = (y + 0.5) / scale - 0.5;
            const x0 = Math.max(0, Math.floor(srcX));
            const y0 = Math.max(0, Math.floor(srcY));
            const x1 = Math.min(srcW - 1, x0 + 1);
            const y1 = Math.min(srcH - 1, y0 + 1);
            const tx = Math.max(0, Math.min(1, srcX - x0));
            const ty = Math.max(0, Math.min(1, srcY - y0));
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

// ── Resolution (shared with assetLinks) ──────────────────────────────────────

function cascCacheDir(): string {
    return getCascCacheDir();
}

function candidateRoots(document: vscode.TextDocument): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    const add = (p: string) => { if (!seen.has(p)) { seen.add(p); roots.push(p); } };

    add(path.dirname(document.uri.fsPath));

    for (const wsf of vscode.workspace.workspaceFolders ?? []) {
        const root = wsf.uri.fsPath;
        add(root);
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets', 'UI']) add(path.join(root, sub));
        try {
            for (const entry of fs.readdirSync(root)) {
                const lower = entry.toLowerCase();
                if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) {
                    const full = path.join(root, entry);
                    try { if (fs.statSync(full).isDirectory()) add(full); } catch { /* skip */ }
                }
            }
        } catch { /* skip */ }
    }
    add(cascCacheDir());
    return roots;
}

function resolveAssetPath(assetPath: string, roots: string[]): string | undefined {
    const normalised = assetPath.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep);
    const lower = normalised.toLowerCase();
    const lowerDds = lower.replace(/\.blp$/, '.dds');
    for (const root of roots) {
        const candidate = path.join(root, normalised);
        if (fs.existsSync(candidate)) return candidate;
        if (lower !== normalised) {
            const candidateLower = path.join(root, lower);
            if (fs.existsSync(candidateLower)) return candidateLower;
        }
        if (lowerDds !== lower) {
            const candidateDds = path.join(root, lowerDds);
            if (fs.existsSync(candidateDds)) return candidateDds;
        }
    }

    const fileName = path.basename(normalised);
    for (const root of roots) {
        const candidate = path.join(root, fileName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

// ── Preview builder ───────────────────────────────────────────────────────────

const hoverCacheDir = path.join(os.tmpdir(), 'wurst_hover_preview');

function isFreshPreviewFile(previewPath: string, sourceMtime: number): boolean {
    try {
        return fs.statSync(previewPath).mtimeMs >= sourceMtime;
    } catch {
        return false;
    }
}

function buildPreviewPng(fsPath: string): CacheEntry | undefined {
    const ext = path.extname(fsPath).toLowerCase();
    if (!PREVIEW_EXTS.has(ext.slice(1))) return undefined;

    let mtime = 0;
    try { mtime = fs.statSync(fsPath).mtimeMs; } catch { return undefined; }

    const cached = previewCache.get(fsPath);
    if (cached && cached.mtime === mtime && isFreshPreviewFile(cached.pngPath, mtime)) return cached;

    // Standard formats VSCode can render natively — no conversion needed
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        const entry: CacheEntry = { pngPath: fsPath, mtime, origW: 0, origH: 0, description: ext.slice(1).toUpperCase() };
        previewCache.set(fsPath, entry);
        return entry;
    }

    // BLP / DDS / TGA → decode → scale → encode PNG to temp file
    try {
        fs.mkdirSync(hoverCacheDir, { recursive: true });
        const hash = crypto.createHash('sha1').update(fsPath).digest('hex');
        const previewPath = path.join(hoverCacheDir, hash + '.png');
        if (isFreshPreviewFile(previewPath, mtime)) {
            const entry: CacheEntry = {
                pngPath: previewPath,
                mtime,
                origW: 0,
                origH: 0,
                description: ext.slice(1).toUpperCase(),
            };
            previewCache.set(fsPath, entry);
            return entry;
        }

        const bytes = new Uint8Array(fs.readFileSync(fsPath));
        const decoded = decodeRasterPreview(bytes, ext);

        if (decoded.mode === 'jpeg') {
            writeJpegPreviewPngSync(decoded.jpegBase64, MAX_PREVIEW_DIM, previewPath);
        } else {
            const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
            const png = decoded.width <= MAX_PREVIEW_DIM && decoded.height <= MAX_PREVIEW_DIM
                ? encodePng(decoded.width, decoded.height, rgba)
                : (() => {
                    const scaled = scaleDown(rgba, decoded.width, decoded.height, MAX_PREVIEW_DIM);
                    return encodePng(scaled.w, scaled.h, scaled.rgba);
                })();
            fs.writeFileSync(previewPath, png);
        }

        const entry: CacheEntry = {
            pngPath: previewPath,
            mtime,
            origW: decoded.width,
            origH: decoded.height,
            description: decoded.description,
        };
        previewCache.set(fsPath, entry);
        return entry;
    } catch {
        return undefined;
    }
}

export function getImageHoverMarkdown(fsPath: string): vscode.MarkdownString | undefined {
    const entry = buildPreviewPng(fsPath);
    if (!entry) return undefined;

    const imgUri = vscode.Uri.file(entry.pngPath).toString();
    const label = entry.origW > 0
        ? `${entry.description} - ${entry.origW}x${entry.origH}`
        : path.basename(fsPath);

    const md = new vscode.MarkdownString(`![${label}](${imgUri})\n\n*${label}*`);
    md.isTrusted = true;
    md.supportHtml = true;
    return md;
}

// ── Hover provider ────────────────────────────────────────────────────────────

// Matches image string literals on the current line
const IMAGE_STRING_RE = /"([^"\r\n]+\.(blp|dds|tga|png|jpg|jpeg))"/gi;

class ImagePreviewHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position).text;
        const col = position.character;

        IMAGE_STRING_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = IMAGE_STRING_RE.exec(line)) !== null) {
            const start = m.index + 1; // inside opening quote
            const end = start + m[1].length;
            if (col < start || col > end) continue;

            const roots = candidateRoots(document);
            let fsPath = resolveAssetPath(m[1], roots);

            // Not in local roots — try CASC extraction on demand
            if (!fsPath) {
                fsPath = await ensureCascCached(m[1]) ?? undefined;
            }
            if (!fsPath) return undefined;

            const directMd = getImageHoverMarkdown(fsPath);
            if (directMd) {
                const range = new vscode.Range(position.line, start, position.line, end);
                return new vscode.Hover(directMd, range);
            }

            const entry = buildPreviewPng(fsPath);
            if (!entry) return undefined;

            const imgUri = vscode.Uri.file(entry.pngPath).toString();
            const label = entry.origW > 0
                ? `${entry.description} — ${entry.origW}×${entry.origH}`
                : path.basename(fsPath);

            const md = new vscode.MarkdownString(`![${label}](${imgUri})\n\n*${label}*`);
            md.isTrusted = true;
            md.supportHtml = true;

            const range = new vscode.Range(position.line, start, position.line, end);
            return new vscode.Hover(md, range);
        }
        return undefined;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerImagePreviewHover(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.languages.registerHoverProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { language: 'wc3-fdf' },
            { pattern: '**/*.j' },
        ],
        new ImagePreviewHoverProvider(),
    );
}
