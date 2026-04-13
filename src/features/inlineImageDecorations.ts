'use strict';

/**
 * Inline image decorations — renders a tiny thumbnail before image path strings
 * in Wurst/JASS files, similar to VS Code's colour swatch decorators.
 *
 * Recognises two forms:
 *   1. Raw string literals:  "ReplaceableTextures\\CommandButtons\\BTNHeal.blp"
 *   2. Asset class members:  Icons.bTNHeal  (resolved via parsed .wurst asset files)
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { decodeRasterPreview, ensureCascCached, getCascCacheDir, writeJpegPreviewPngSync } from './blpPreview';
import { getImageHoverMarkdown } from './imagePreviewHover';
import * as zlib from 'zlib';

// ── Config ────────────────────────────────────────────────────────────────────

const THUMB_DIM = 16;          // thumbnail size in px
const ICON_CSS  = '12px';      // rendered size in editor
const IMAGE_EXTS = new Set(['blp', 'dds', 'tga', 'png', 'jpg', 'jpeg']);
const THUMB_DIR  = path.join(os.tmpdir(), 'wurst_inline_thumbs');
const MAX_CONCURRENT_THUMB_JOBS = 2;
const MAX_CONCURRENT_CASC_JOBS = 2;
const UPDATE_DEBOUNCE_MS = 120;

// Matches "some\\path\\file.blp" style strings
const STRING_IMAGE_RE  = /"([^"\r\n]+\.(blp|dds|tga|png|jpg|jpeg))"/gi;
// Matches ClassName.memberName  e.g. Icons.bTNHeal
const MEMBER_ACCESS_RE = /\b([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\b/g;

// ── Wurst asset class index ───────────────────────────────────────────────────
// Maps "ClassName.memberName" → raw asset path string

type AssetIndex = Map<string, string>;

let assetIndex: AssetIndex | null = null;
let assetIndexBuiltForWs: string | null = null;
const output = vscode.window.createOutputChannel('Wurst Inline Icons');

// static constant foo = "path"  (with optional public/private modifier)
const WURST_CONST_RE = /^\s*(?:(?:public|private|protected)\s+)?static\s+constant\s+(\w+)\s*=\s*"([^"]+\.(blp|dds|tga|png|jpg|jpeg))"/;

function buildAssetIndex(): AssetIndex {
    const index: AssetIndex = new Map();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return index;

    // Search for asset wurst files — typically under _build/dependencies
    const searchRoots = [wsRoot];
    // Recursively find *.wurst files that look like asset packages (by scanning _build/dependencies)
    const depsDir = path.join(wsRoot, '_build', 'dependencies');
    if (fs.existsSync(depsDir)) searchRoots.push(depsDir);

    for (const searchRoot of searchRoots) {
        findWurstFiles(searchRoot, (filePath) => {
            parseAssetFile(filePath, index);
        }, 8 /* max depth */);
    }

    return index;
}

function findWurstFiles(dir: string, cb: (p: string) => void, maxDepth: number): void {
    if (maxDepth <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            findWurstFiles(full, cb, maxDepth - 1);
        } else if (e.isFile() && e.name.endsWith('.wurst')) {
            cb(full);
        }
    }
}

function parseAssetFile(filePath: string, index: AssetIndex): void {
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }

    // Determine the class name from the file (first `class` or `public class` declaration)
    const classMatch = /^\s*(?:public\s+)?class\s+(\w+)/m.exec(text);
    if (!classMatch) return;
    const className = classMatch[1];

    for (const line of text.split('\n')) {
        const m = WURST_CONST_RE.exec(line);
        if (m) index.set(`${className}.${m[1]}`, m[2]);
    }
}

function getAssetIndex(): AssetIndex {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!assetIndex || assetIndexBuiltForWs !== wsRoot) {
        assetIndex = buildAssetIndex();
        assetIndexBuiltForWs = wsRoot;
    }
    return assetIndex;
}

function stripStringLiterals(text: string): string {
    return text.replace(/"([^"\\]|\\.)*"/g, '""');
}

function shouldUseAssetIndex(text: string): boolean {
    MEMBER_ACCESS_RE.lastIndex = 0;
    return MEMBER_ACCESS_RE.test(stripStringLiterals(text));
}

// ── Path resolution ───────────────────────────────────────────────────────────

function cascCacheDir(): string {
    return getCascCacheDir();
}

function candidateRoots(docFsPath: string): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    const add = (p: string) => { if (p && !seen.has(p)) { seen.add(p); roots.push(p); } };

    add(path.dirname(docFsPath));
    for (const wsf of vscode.workspace.workspaceFolders ?? []) {
        const root = wsf.uri.fsPath;
        add(root);
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets', 'UI']) add(path.join(root, sub));
        try {
            for (const entry of fs.readdirSync(root)) {
                const lower = entry.toLowerCase();
                if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) {
                    const full = path.join(root, entry);
                    try { if (fs.statSync(full).isDirectory()) add(full); } catch { /**/ }
                }
            }
        } catch { /**/ }
    }
    add(cascCacheDir());
    return roots;
}

function resolveImagePath(assetPath: string, roots: string[]): string | undefined {
    const norm  = assetPath.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep);
    const lower = norm.toLowerCase();
    // CASC cache stores BLPs converted to DDS — build the DDS variant of the lowercase path
    const lowerDds = lower.replace(/\.blp$/, '.dds');

    for (const root of roots) {
        // Exact case (local project files)
        const c = path.join(root, norm);
        if (fs.existsSync(c)) return c;
        // Lowercase (CASC cache — BLP still as BLP)
        if (lower !== norm) {
            const cl = path.join(root, lower);
            if (fs.existsSync(cl)) return cl;
        }
        // Lowercase with .blp → .dds (CASC cache — BLP converted to DDS)
        if (lowerDds !== lower) {
            const cd = path.join(root, lowerDds);
            if (fs.existsSync(cd)) return cd;
        }
    }

    // Fallback for imported assets stored flat in imports/ or war3mapImported/
    // but referenced via their in-game path.
    const fileName = path.basename(norm);
    for (const root of roots) {
        const candidate = path.join(root, fileName);
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

// ── PNG encoder (minimal — no deps) ──────────────────────────────────────────

const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([lb, tb, data, cb]);
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4, d = y * (w * 4 + 1) + 1 + x * 4;
            raw[d] = rgba[s]; raw[d+1] = rgba[s+1]; raw[d+2] = rgba[s+2]; raw[d+3] = rgba[s+3];
        }
    }
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 3 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function scaleDown(rgba: Uint8Array, sw: number, sh: number, dim: number): { rgba: Uint8Array; w: number; h: number } {
    if (sw <= dim && sh <= dim) return { rgba, w: sw, h: sh };
    const s = dim / Math.max(sw, sh);
    const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const srcX = (x + 0.5) / s - 0.5;
            const srcY = (y + 0.5) / s - 0.5;
            const x0 = Math.max(0, Math.floor(srcX));
            const y0 = Math.max(0, Math.floor(srcY));
            const x1 = Math.min(sw - 1, x0 + 1);
            const y1 = Math.min(sh - 1, y0 + 1);
            const tx = Math.max(0, Math.min(1, srcX - x0));
            const ty = Math.max(0, Math.min(1, srcY - y0));
            const dst = (y * dw + x) * 4;
            for (let c = 0; c < 4; c++) {
                const p00 = rgba[(y0 * sw + x0) * 4 + c];
                const p10 = rgba[(y0 * sw + x1) * 4 + c];
                const p01 = rgba[(y1 * sw + x0) * 4 + c];
                const p11 = rgba[(y1 * sw + x1) * 4 + c];
                const top = p00 + (p10 - p00) * tx;
                const bottom = p01 + (p11 - p01) * tx;
                out[dst + c] = Math.round(top + (bottom - top) * ty);
            }
        }
    }
    return { rgba: out, w: dw, h: dh };
}

// ── Thumbnail cache ───────────────────────────────────────────────────────────

interface ThumbEntry { pngPath: string; mtime: number; }
const thumbCache = new Map<string, ThumbEntry>();

function log(message: string): void {
    output.appendLine(`[inline-icons] ${message}`);
    console.log(`[inline-icons] ${message}`);
}

function getThumbnailUri(fsPath: string): vscode.Uri | undefined {
    const ext = path.extname(fsPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext.slice(1))) return undefined;

    let mtime = 0;
    try { mtime = fs.statSync(fsPath).mtimeMs; } catch { return undefined; }

    const cached = thumbCache.get(fsPath);
    if (cached && cached.mtime === mtime) {
        log(`thumb cache hit: ${path.basename(fsPath)}`);
        return vscode.Uri.file(cached.pngPath);
    }

    // PNG/JPG can be served directly — VSCode can render them natively
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        thumbCache.set(fsPath, { pngPath: fsPath, mtime });
        return vscode.Uri.file(fsPath);
    }

    try {
        const bytes = new Uint8Array(fs.readFileSync(fsPath));
        const decoded = decodeRasterPreview(bytes, ext);

        fs.mkdirSync(THUMB_DIR, { recursive: true });
        const key = crypto.createHash('sha1').update(fsPath).digest('hex');
        const pngPath = path.join(THUMB_DIR, key + '.png');
        if (decoded.mode === 'jpeg') {
            writeJpegPreviewPngSync(decoded.jpegBase64, THUMB_DIM, pngPath);
        } else {
            const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
            const scaled = scaleDown(rgba, decoded.width, decoded.height, THUMB_DIM);
            const png = encodePng(scaled.w, scaled.h, scaled.rgba);
            fs.writeFileSync(pngPath, png);
        }

        thumbCache.set(fsPath, { pngPath, mtime });
        log(`thumb generated: ${path.basename(fsPath)} -> ${pngPath}`);
        return vscode.Uri.file(pngPath);
    } catch (error) {
        log(`thumb failed: ${fsPath} :: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

// ── Decoration manager ────────────────────────────────────────────────────────

// Maps fsPath → active DecorationType so we can dispose old ones
const activeTypes = new Map<string, vscode.TextEditorDecorationType>();

// Single shared type for paths that don't resolve to a local file
let fallbackType: vscode.TextEditorDecorationType | undefined;
function getFallbackType(): vscode.TextEditorDecorationType {
    if (!fallbackType) {
        fallbackType = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '\u{1F5BC}', // 🖼 framed picture
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                width: ICON_CSS,
                margin: `0 4px 2px 0`,
                fontStyle: 'normal',
            },
        });
    }
    return fallbackType;
}

function makeDecorationType(iconUri: vscode.Uri): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
        before: {
            contentIconPath: iconUri,
            width: ICON_CSS,
            height: ICON_CSS,
            margin: `0 4px 2px 0`,
        },
    });
}

function makeDecorationOptions(ranges: vscode.Range[], hoverMessage?: vscode.MarkdownString): vscode.DecorationOptions[] {
    return ranges.map((range) => ({ range, hoverMessage }));
}

function intersectsVisibleRange(range: vscode.Range, visibleRanges: readonly vscode.Range[]): boolean {
    return visibleRanges.some((visible) => visible.intersection(range) !== undefined);
}

interface CollectedRanges {
    /** fsPath → ranges where we have a local file */
    resolved: Map<string, vscode.Range[]>;
    /** assetPath → ranges for paths not found on disk (candidates for CASC extraction) */
    pending: Map<string, vscode.Range[]>;
}

function collectImageRanges(
    document: vscode.TextDocument,
    roots: string[],
    index?: AssetIndex,
): CollectedRanges {
    const text = document.getText();
    const resolved = new Map<string, vscode.Range[]>();
    const pending = new Map<string, vscode.Range[]>();

    const addTo = (map: Map<string, vscode.Range[]>, key: string, start: number, len: number) => {
        const range = new vscode.Range(document.positionAt(start), document.positionAt(start + len));
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(range);
    };

    // 1. Raw string literals
    STRING_IMAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_IMAGE_RE.exec(text)) !== null) {
        const assetPath = m[1];
        const fsPath = resolveImagePath(assetPath, roots);
        if (fsPath) {
            addTo(resolved, fsPath, m.index, m[0].length);
        } else {
            addTo(pending, assetPath, m.index, m[0].length);
        }
    }

    // 2. ClassName.member  (e.g. Icons.bTNHeal)
    if (index) {
        MEMBER_ACCESS_RE.lastIndex = 0;
        while ((m = MEMBER_ACCESS_RE.exec(text)) !== null) {
            const key = `${m[1]}.${m[2]}`;
            const assetPath = index.get(key);
            if (!assetPath) continue;
            const fsPath = resolveImagePath(assetPath, roots);
            if (fsPath) {
                addTo(resolved, fsPath, m.index, m[0].length);
            } else {
                addTo(pending, assetPath, m.index, m[0].length);
            }
        }
    }

    return { resolved, pending };
}

// Track CASC extractions in progress so we don't fire duplicates
const extracting = new Set<string>();
const decorationVersions = new Map<string, number>();
const pendingThumbJobs = new Set<string>();
const thumbQueue: Array<() => Promise<void>> = [];
let runningThumbJobs = 0;
const cascQueue: Array<() => Promise<void>> = [];
let runningCascJobs = 0;
const updateTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleThumbJob(job: () => Promise<void>): void {
    thumbQueue.push(job);
    runThumbQueue();
}

function runThumbQueue(): void {
    while (runningThumbJobs < MAX_CONCURRENT_THUMB_JOBS && thumbQueue.length > 0) {
        const next = thumbQueue.shift();
        if (!next) return;
        runningThumbJobs += 1;
        void next().finally(() => {
            runningThumbJobs -= 1;
            runThumbQueue();
        });
    }
}

function scheduleCascJob(job: () => Promise<void>): void {
    cascQueue.push(job);
    runCascQueue();
}

function runCascQueue(): void {
    while (runningCascJobs < MAX_CONCURRENT_CASC_JOBS && cascQueue.length > 0) {
        const next = cascQueue.shift();
        if (!next) return;
        runningCascJobs += 1;
        void next().finally(() => {
            runningCascJobs -= 1;
            runCascQueue();
        });
    }
}

async function updateDecorations(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const docKey = document.uri.toString();
    const version = (decorationVersions.get(docKey) ?? 0) + 1;
    decorationVersions.set(docKey, version);
    const roots = candidateRoots(document.uri.fsPath);
    const text = document.getText();
    const useAssetIndex = shouldUseAssetIndex(text);
    const index = useAssetIndex ? getAssetIndex() : undefined;
    if (useAssetIndex) log(`asset index enabled for ${path.basename(document.uri.fsPath)}`);

    const { resolved, pending } = collectImageRanges(document, roots, index);
    log(`scan ${path.basename(document.uri.fsPath)}: resolved=${resolved.size} pending=${pending.size} version=${version}`);

    // Dispose types for paths no longer needed
    const wanted = new Set(resolved.keys());
    for (const [fp, type] of activeTypes) {
        if (!wanted.has(fp)) {
            editor.setDecorations(type, []);
            type.dispose();
            activeTypes.delete(fp);
        }
    }

    // Show fallback glyph only for paths that are still pending.
    const allPendingRanges = [...pending.values()].flat();
    editor.setDecorations(getFallbackType(), allPendingRanges);

    // Apply thumbnail decorations for already-cached paths and queue the rest.
    for (const [fsPath, ranges] of resolved) {
        const hoverMessage = getImageHoverMarkdown(fsPath);
        const visibleRanges = ranges.filter((range) => intersectsVisibleRange(range, editor.visibleRanges));
        const cached = thumbCache.get(fsPath);
        let mtime = 0;
        try {
            mtime = fs.statSync(fsPath).mtimeMs;
        } catch (error) {
            log(`stat failed: ${fsPath} :: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        if (cached && cached.mtime === mtime) {
            let type = activeTypes.get(fsPath);
            if (!type) {
                type = makeDecorationType(vscode.Uri.file(cached.pngPath));
                activeTypes.set(fsPath, type);
            }
            editor.setDecorations(type, makeDecorationOptions(ranges, hoverMessage));
            continue;
        }

        if (visibleRanges.length > 0) {
            const iconUri = getThumbnailUri(fsPath);
            if (iconUri) {
                let type = activeTypes.get(fsPath);
                if (type) {
                    type.dispose();
                }
                type = makeDecorationType(iconUri);
                activeTypes.set(fsPath, type);
                editor.setDecorations(type, makeDecorationOptions(ranges, hoverMessage));
                log(`applied visible thumb immediately: ${fsPath} ranges=${ranges.length}`);
            }
            continue;
        }

        if (pendingThumbJobs.has(fsPath)) continue;
        pendingThumbJobs.add(fsPath);
        log(`queue thumb: ${fsPath}`);
        scheduleThumbJob(async () => {
            try {
                const iconUri = getThumbnailUri(fsPath);
                if (!iconUri) return;

                const active = vscode.window.activeTextEditor;
                const latestVersion = decorationVersions.get(docKey);
                if (!active || active.document !== document || latestVersion !== version) {
                    log(`skip stale thumb apply: ${fsPath}`);
                    return;
                }

                const latestText = document.getText();
                const latestNeedsAssetIndex = shouldUseAssetIndex(latestText);
                const currentRanges = collectImageRanges(
                    document,
                    candidateRoots(document.uri.fsPath),
                    latestNeedsAssetIndex ? getAssetIndex() : undefined,
                ).resolved.get(fsPath);
                if (!currentRanges || currentRanges.length === 0) {
                    log(`skip thumb apply, path no longer visible: ${fsPath}`);
                    return;
                }

                let type = activeTypes.get(fsPath);
                if (type) {
                    type.dispose();
                }
                type = makeDecorationType(iconUri);
                activeTypes.set(fsPath, type);
                active.setDecorations(type, makeDecorationOptions(currentRanges, getImageHoverMarkdown(fsPath)));
                log(`applied thumb: ${fsPath} ranges=${currentRanges.length}`);
            } finally {
                pendingThumbJobs.delete(fsPath);
            }
        });
    }

    // Fire off CASC extraction for pending asset paths (deduplicated, non-blocking)
    for (const [assetPath, ranges] of pending) {
        if (!ranges.some((range) => intersectsVisibleRange(range, editor.visibleRanges))) continue;
        if (extracting.has(assetPath)) continue;
        extracting.add(assetPath);
        log(`queue casc extract: ${assetPath}`);
        scheduleCascJob(async () => {
            try {
                log(`start casc extract: ${assetPath}`);
                const cachedPath = await ensureCascCached(assetPath);
                if (!cachedPath) {
                    log(`casc unresolved: ${assetPath}`);
                    return;
                }
                log(`casc resolved: ${assetPath} -> ${cachedPath}`);
                const active = vscode.window.activeTextEditor;
                if (active && active.document === document) void updateDecorations(active);
            } catch (error) {
                log(`casc error: ${assetPath} :: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                extracting.delete(assetPath);
            }
        });
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerInlineImageDecorations(_context: vscode.ExtensionContext): vscode.Disposable {
    const LANGS = ['wurst', 'jass', 'wc3-fdf'];

    const update = (editor: vscode.TextEditor | undefined) => {
        if (!editor) return;
        const lang = editor.document.languageId;
        const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
        if (!LANGS.includes(lang) && ext !== '.j') return;
        const key = editor.document.uri.toString();
        const existing = updateTimers.get(key);
        if (existing) clearTimeout(existing);
        updateTimers.set(key, setTimeout(() => {
            updateTimers.delete(key);
            void updateDecorations(editor);
        }, UPDATE_DEBOUNCE_MS));
    };

    const subs = [
        vscode.window.onDidChangeActiveTextEditor(update),
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => update(event.textEditor)),
        vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) update(editor);
        }),
        // Invalidate asset index when .wurst files change
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.fileName.endsWith('.wurst')) { assetIndex = null; update(vscode.window.activeTextEditor); }
        }),
        // Dispose all active types when extension deactivates
        new vscode.Disposable(() => {
            for (const timer of updateTimers.values()) clearTimeout(timer);
            updateTimers.clear();
            for (const t of activeTypes.values()) t.dispose();
            activeTypes.clear();
            fallbackType?.dispose();
            fallbackType = undefined;
            output.dispose();
        }),
    ];

    // Decorate the already-open editor immediately
    update(vscode.window.activeTextEditor);

    return vscode.Disposable.from(...subs);
}
