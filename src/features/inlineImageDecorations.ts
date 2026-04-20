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
import * as crypto from 'crypto';
import { decodeRasterPreview, decodeToRgba, ensureCascAssetCached, ensureCascCached } from './blpPreview';
import {
    getCandidateRoots,
    getTempPreviewDir,
    resolveAssetPath,
    encodePng,
    scaleDown,
} from './imageAssetSupport';
import { AssetIndex, getAssetIndex, invalidateAssetIndex } from '../utils/assetIndex';

// ── Config ────────────────────────────────────────────────────────────────────

const THUMB_DIM = 16;          // thumbnail size in px
const ICON_CSS  = '12px';      // rendered size in editor
const THUMB_DIR  = getTempPreviewDir('wurst_inline_thumbs');
const MAX_CONCURRENT_THUMB_JOBS = 2;
const MAX_CONCURRENT_CASC_JOBS = 8;
const UPDATE_DEBOUNCE_MS = 120;

// Matches "some\\path\\file.blp" style strings
const STRING_IMAGE_RE  = /"([^"\r\n]+\.(blp|dds|tga|png|jpg|jpeg))"/gi;
// Matches "some\\path\\file.mdx" style strings (models)
const STRING_MODEL_RE  = /"([^"\r\n]+\.(mdx|mdl))"/gi;
// Matches ClassName.memberName  e.g. Icons.bTNHeal
const MEMBER_ACCESS_RE = /\b([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\b/g;

const output = vscode.window.createOutputChannel('Wurst Inline Icons');
let isDisposed = false;


function stripStringLiterals(text: string): string {
    return text.replace(/"([^"\\]|\\.)*"/g, '""');
}

function shouldUseAssetIndex(text: string): boolean {
    MEMBER_ACCESS_RE.lastIndex = 0;
    return MEMBER_ACCESS_RE.test(stripStringLiterals(text));
}

// ── Path resolution ───────────────────────────────────────────────────────────

async function candidateRoots(docFsPath: string): Promise<string[]> {
    return getCandidateRoots(docFsPath);
}

async function resolveImagePath(assetPath: string, roots: string[]): Promise<string | undefined> {
    return resolveAssetPath(assetPath, roots);
}

// ── Thumbnail cache ───────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['blp', 'dds', 'tga', 'png', 'jpg', 'jpeg']);

interface ThumbEntry { pngPath: string; mtime: number; }
const thumbCache = new Map<string, ThumbEntry>();

async function getFreshPreviewPath(basePath: string, sourceMtime: number): Promise<string | undefined> {
    for (const ext of ['.png', '.jpg']) {
        const candidate = basePath + ext;
        if (await isFreshThumbFile(candidate, sourceMtime)) {
            return candidate;
        }
    }
    return undefined;
}

let logEpoch = 0;
function log(message: string): void {
    if (isDisposed) return;
    if (logEpoch === 0) logEpoch = Date.now();
    const ms = Date.now() - logEpoch;
    const ts = `+${ms}ms`;
    try {
        output.appendLine(`[inline-icons] ${ts} ${message}`);
    } catch {
        return;
    }
    console.log(`[inline-icons] ${ts} ${message}`);
}

function safeSetDecorations(
    editor: vscode.TextEditor,
    decorationType: vscode.TextEditorDecorationType,
    decorations: vscode.Range[] | vscode.DecorationOptions[],
): void {
    if (isDisposed) return;
    try {
        editor.setDecorations(decorationType, decorations);
    } catch {
        // Ignore teardown races while the extension host/editor is closing.
    }
}

async function isFreshThumbFile(thumbPath: string, sourceMtime: number): Promise<boolean> {
    try {
        return (await fs.promises.stat(thumbPath)).mtimeMs >= sourceMtime;
    } catch {
        return false;
    }
}

async function getCachedThumbnailUri(fsPath: string): Promise<vscode.Uri | undefined> {
    const ext = path.extname(fsPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext.slice(1))) return undefined;

    let mtime = 0;
    try { mtime = (await fs.promises.stat(fsPath)).mtimeMs; } catch { return undefined; }

    const cached = thumbCache.get(fsPath);
    if (cached && cached.mtime === mtime && await isFreshThumbFile(cached.pngPath, mtime)) {
        log(`thumb cache hit: ${path.basename(fsPath)}`);
        return vscode.Uri.file(cached.pngPath);
    }

    // PNG/JPG can be served directly — VSCode can render them natively
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        thumbCache.set(fsPath, { pngPath: fsPath, mtime });
        return vscode.Uri.file(fsPath);
    }

    try {
        await fs.promises.mkdir(THUMB_DIR, { recursive: true });
        const key = crypto.createHash('sha1').update(fsPath).digest('hex');
        const previewPath = await getFreshPreviewPath(path.join(THUMB_DIR, key), mtime);
        if (previewPath) {
            thumbCache.set(fsPath, { pngPath: previewPath, mtime });
            log(`thumb disk cache hit: ${path.basename(fsPath)}`);
            return vscode.Uri.file(previewPath);
        }
    } catch {
        return undefined;
    }

    return undefined;
}

async function getThumbnailUri(fsPath: string): Promise<vscode.Uri | undefined> {
    const cachedUri = await getCachedThumbnailUri(fsPath);
    if (cachedUri) {
        return cachedUri;
    }

    const ext = path.extname(fsPath).toLowerCase();
    if (!IMAGE_EXTS.has(ext.slice(1))) return undefined;

    let mtime = 0;
    try { mtime = (await fs.promises.stat(fsPath)).mtimeMs; } catch { return undefined; }

    try {
        await fs.promises.mkdir(THUMB_DIR, { recursive: true });
        const key = crypto.createHash('sha1').update(fsPath).digest('hex');
        const basePath = path.join(THUMB_DIR, key);

        const bytes = new Uint8Array(await fs.promises.readFile(fsPath));
        const { width, height, rgba } = decodeToRgba(bytes, ext);
        const previewPath = `${basePath}.png`;
        const scaled = scaleDown(Buffer.from(rgba), width, height, THUMB_DIM);
        const png = encodePng(scaled.w, scaled.h, scaled.rgba);
        await fs.promises.writeFile(previewPath, png);

        thumbCache.set(fsPath, { pngPath: previewPath, mtime });
        log(`thumb generated: ${path.basename(fsPath)} -> ${previewPath}`);
        return vscode.Uri.file(previewPath);
    } catch (error) {
        log(`thumb failed: ${fsPath} :: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

// ── Decoration manager ────────────────────────────────────────────────────────

// Maps fsPath → active DecorationType so we can dispose old ones
const activeTypes = new Map<string, vscode.TextEditorDecorationType>();
const missingRangesByPath = new Map<string, vscode.Range[]>();

// Single shared type for all paths not yet rendered (CASC pending + thumb loading)
let loadingType: vscode.TextEditorDecorationType | undefined;
function getLoadingType(): vscode.TextEditorDecorationType {
    if (!loadingType) {
        loadingType = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '◌',
                color: new vscode.ThemeColor('editorCodeLens.foreground'),
                width: ICON_CSS,
                margin: `0 4px 2px 0`,
                fontStyle: 'normal',
            },
        });
    }
    return loadingType;
}

let missingType: vscode.TextEditorDecorationType | undefined;
function getMissingType(): vscode.TextEditorDecorationType {
    if (!missingType) {
        missingType = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '×',
                color: new vscode.ThemeColor('editorError.foreground'),
                width: ICON_CSS,
                margin: `0 4px 2px 0`,
                fontStyle: 'normal',
            },
        });
    }
    return missingType;
}

let mdxFoundType: vscode.TextEditorDecorationType | undefined;
function getMdxFoundType(): vscode.TextEditorDecorationType {
    if (!mdxFoundType) {
        mdxFoundType = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '✓',
                color: new vscode.ThemeColor('charts.green'),
                width: ICON_CSS,
                margin: `0 4px 2px 0`,
                fontStyle: 'normal',
            },
        });
    }
    return mdxFoundType;
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

interface CollectedRanges {
    /** fsPath → ranges where we have a local file */
    resolved: Map<string, vscode.Range[]>;
    /** assetPath → ranges for paths not found on disk (candidates for CASC extraction) */
    pending: Map<string, vscode.Range[]>;
    /** fsPath → ranges for model files (.mdx/.mdl) found locally */
    mdxResolved: Map<string, vscode.Range[]>;
    /** assetPath → ranges for model files not found locally (candidates for CASC lookup) */
    mdxPending: Map<string, vscode.Range[]>;
}

function getScanRanges(editor: vscode.TextEditor): vscode.Range[] {
    const lineCount = editor.document.lineCount;
    const seen = new Set<string>();
    const scanRanges: vscode.Range[] = [];

    for (const visible of editor.visibleRanges) {
        const startLine = Math.max(0, visible.start.line - 20);
        const endLine = Math.min(lineCount - 1, visible.end.line + 20);
        const key = `${startLine}:${endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scanRanges.push(new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length));
    }

    if (scanRanges.length === 0 && lineCount > 0) {
        scanRanges.push(new vscode.Range(0, 0, Math.min(lineCount - 1, 200), editor.document.lineAt(Math.min(lineCount - 1, 200)).text.length));
    }

    return scanRanges;
}

async function collectImageRanges(
    document: vscode.TextDocument,
    roots: string[],
    scanRanges: readonly vscode.Range[],
    index?: AssetIndex,
): Promise<CollectedRanges> {
    const resolved = new Map<string, vscode.Range[]>();
    const pending = new Map<string, vscode.Range[]>();
    const mdxResolved = new Map<string, vscode.Range[]>();
    const mdxPending = new Map<string, vscode.Range[]>();
    const matches: Array<{ assetPath: string; start: number; len: number }> = [];
    const mdxMatches: Array<{ assetPath: string; start: number; len: number }> = [];

    const addTo = (map: Map<string, vscode.Range[]>, key: string, start: number, len: number) => {
        const range = new vscode.Range(document.positionAt(start), document.positionAt(start + len));
        let arr = map.get(key);
        if (!arr) { arr = []; map.set(key, arr); }
        arr.push(range);
    };

    for (const scanRange of scanRanges) {
        const text = document.getText(scanRange);
        const baseOffset = document.offsetAt(scanRange.start);

        // 1. Raw image string literals
        STRING_IMAGE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_IMAGE_RE.exec(text)) !== null) {
            matches.push({ assetPath: m[1], start: baseOffset + m.index, len: m[0].length });
        }

        // 2. Raw model string literals (.mdx / .mdl)
        STRING_MODEL_RE.lastIndex = 0;
        while ((m = STRING_MODEL_RE.exec(text)) !== null) {
            mdxMatches.push({ assetPath: m[1], start: baseOffset + m.index, len: m[0].length });
        }

        // 3. ClassName.member  (e.g. Icons.bTNHeal)
        if (index) {
            MEMBER_ACCESS_RE.lastIndex = 0;
            while ((m = MEMBER_ACCESS_RE.exec(text)) !== null) {
                const key = `${m[1]}.${m[2]}`;
                const assetPath = index.get(key);
                if (!assetPath) continue;
                matches.push({ assetPath, start: baseOffset + m.index, len: m[0].length });
            }
        }
    }

    const uniqueAssetPaths = Array.from(new Set(matches.map((match) => match.assetPath)));
    const resolvedPaths = new Map<string, string | undefined>(
        await Promise.all(uniqueAssetPaths.map(async (assetPath): Promise<[string, string | undefined]> => [assetPath, await resolveImagePath(assetPath, roots)]))
    );

    for (const match of matches) {
        const fsPath = resolvedPaths.get(match.assetPath);
        if (fsPath) {
            addTo(resolved, fsPath, match.start, match.len);
        } else {
            addTo(pending, match.assetPath, match.start, match.len);
        }
    }

    const uniqueMdxPaths = Array.from(new Set(mdxMatches.map((m) => m.assetPath)));
    const resolvedMdxPaths = new Map<string, string | undefined>(
        await Promise.all(uniqueMdxPaths.map(async (assetPath): Promise<[string, string | undefined]> => [assetPath, await resolveImagePath(assetPath, roots)]))
    );

    for (const match of mdxMatches) {
        const fsPath = resolvedMdxPaths.get(match.assetPath);
        if (fsPath) {
            addTo(mdxResolved, fsPath, match.start, match.len);
        } else {
            addTo(mdxPending, match.assetPath, match.start, match.len);
        }
    }

    return { resolved, pending, mdxResolved, mdxPending };
}

// Track CASC extractions in progress so we don't fire duplicates
const extracting = new Set<string>();
const unresolvedAssets = new Set<string>();
const mdxFoundRangesByPath = new Map<string, vscode.Range[]>();
const decorationVersions = new Map<string, number>();
const pendingThumbJobs = new Set<string>();
// Maps fsPath/assetPath → the ranges currently showing the ◌ glyph for that path.
// Cleared per-path when a thumb is applied, so the glyph doesn't linger.
const loadingRangesByPath = new Map<string, vscode.Range[]>();
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

function setLoadingRanges(key: string, ranges: vscode.Range[]): void {
    if (ranges.length > 0) {
        loadingRangesByPath.set(key, ranges);
    } else {
        loadingRangesByPath.delete(key);
    }
}

function clearLoadingRanges(editor: vscode.TextEditor, key: string): void {
    if (!loadingRangesByPath.delete(key)) return;
    safeSetDecorations(editor, getLoadingType(), [...loadingRangesByPath.values()].flat());
}

function setMissingRanges(key: string, ranges: vscode.Range[]): void {
    if (ranges.length > 0) {
        missingRangesByPath.set(key, ranges);
    } else {
        missingRangesByPath.delete(key);
    }
}

function clearMissingRanges(editor: vscode.TextEditor, key: string): void {
    if (!missingRangesByPath.delete(key)) return;
    safeSetDecorations(editor, getMissingType(), [...missingRangesByPath.values()].flat());
}

async function updateDecorations(editor: vscode.TextEditor): Promise<void> {
    if (isDisposed) return;
    const document = editor.document;
    const docKey = document.uri.toString();
    const version = (decorationVersions.get(docKey) ?? 0) + 1;
    decorationVersions.set(docKey, version);
    const roots = await candidateRoots(document.uri.fsPath);
    const scanRanges = getScanRanges(editor);
    const text = document.getText();
    const useAssetIndex = shouldUseAssetIndex(text);
    const index = useAssetIndex ? getAssetIndex() : undefined;
    if (useAssetIndex) log(`asset index enabled for ${path.basename(document.uri.fsPath)}`);

    const { resolved, pending, mdxResolved, mdxPending } = await collectImageRanges(document, roots, scanRanges, index);
    log(`scan ${path.basename(document.uri.fsPath)}: ranges=${scanRanges.length} resolved=${resolved.size} pending=${pending.size} mdxResolved=${mdxResolved.size} mdxPending=${mdxPending.size} version=${version}`);

    // Dispose types for paths no longer needed
    const wanted = new Set(resolved.keys());
    for (const [fp, type] of activeTypes) {
        if (!wanted.has(fp)) {
            safeSetDecorations(editor, type, []);
            type.dispose();
            activeTypes.delete(fp);
        }
    }

    loadingRangesByPath.clear();
    missingRangesByPath.clear();
    mdxFoundRangesByPath.clear();

    // Apply thumbnail decorations for already-cached paths and queue the rest.
    for (const [fsPath, ranges] of resolved) {
        const iconUri = await getCachedThumbnailUri(fsPath);
        if (iconUri) {
            setLoadingRanges(fsPath, []);
            setMissingRanges(fsPath, []);
            let type = activeTypes.get(fsPath);
            if (!type) {
                type = makeDecorationType(iconUri);
                activeTypes.set(fsPath, type);
            }
            safeSetDecorations(editor, type, makeDecorationOptions(ranges));
            continue;
        }

        setLoadingRanges(fsPath, ranges);
        if (pendingThumbJobs.has(fsPath)) continue;
        pendingThumbJobs.add(fsPath);
        const thumbQueuedAt = Date.now();
        log(`queue thumb: ${fsPath}`);
        scheduleThumbJob(async () => {
            const thumbStartedAt = Date.now();
            const thumbQueueWait = thumbStartedAt - thumbQueuedAt;
            try {
                const iconUri = await getThumbnailUri(fsPath);
                const thumbElapsed = Date.now() - thumbStartedAt;
                if (!iconUri) {
                    log(`thumb failed: ${path.basename(fsPath)} (queue ${thumbQueueWait}ms, gen ${thumbElapsed}ms)`);
                    return;
                }
                log(`thumb ready: ${path.basename(fsPath)} (queue ${thumbQueueWait}ms, gen ${thumbElapsed}ms)`);

                const active = vscode.window.activeTextEditor;
                const latestVersion = decorationVersions.get(docKey);
                if (!active || active.document !== document || latestVersion !== version) {
                    log(`skip stale thumb apply: ${fsPath}`);
                    return;
                }

                let type = activeTypes.get(fsPath);
                if (type) {
                    type.dispose();
                }
                type = makeDecorationType(iconUri);
                activeTypes.set(fsPath, type);
                safeSetDecorations(active, type, makeDecorationOptions(ranges));
                clearLoadingRanges(active, fsPath);
                log(`applied thumb: ${fsPath} ranges=${ranges.length}`);
            } finally {
                pendingThumbJobs.delete(fsPath);
            }
        });
    }

    for (const [assetPath, ranges] of pending) {
        setLoadingRanges(assetPath, ranges);
        if (unresolvedAssets.has(assetPath)) {
            setLoadingRanges(assetPath, []);
            setMissingRanges(assetPath, ranges);
        }
    }

    // ── MDX / model path decorations ──────────────────────────────────────────

    // Locally-found model files → populate found-ranges map
    for (const [fsPath, ranges] of mdxResolved) {
        mdxFoundRangesByPath.set(fsPath, ranges);
    }
    // Already-known-unresolved MDX paths → × ; others → ◌ (loading)
    for (const [assetPath, ranges] of mdxPending) {
        if (unresolvedAssets.has(assetPath)) {
            setMissingRanges(assetPath, ranges);
        } else {
            setLoadingRanges(assetPath, ranges);
        }
    }
    safeSetDecorations(editor, getMdxFoundType(), [...mdxFoundRangesByPath.values()].flat());
    safeSetDecorations(editor, getLoadingType(), [...loadingRangesByPath.values()].flat());
    safeSetDecorations(editor, getMissingType(), [...missingRangesByPath.values()].flat());

    // Fire off CASC lookup for pending model paths (deduplicated, non-blocking)
    for (const [assetPath, ranges] of mdxPending) {
        if (unresolvedAssets.has(assetPath)) continue;
        if (extracting.has(assetPath)) continue;
        extracting.add(assetPath);
        log(`queue casc model check: ${assetPath}`);
        scheduleCascJob(async () => {
            try {
                const startedAt = Date.now();
                const cachedPath = await ensureCascAssetCached(assetPath);
                const elapsed = Date.now() - startedAt;
                const active = vscode.window.activeTextEditor;
                if (!active || active.document !== document) return;
                if (!cachedPath) {
                    unresolvedAssets.add(assetPath);
                    clearLoadingRanges(active, assetPath);
                    setMissingRanges(assetPath, ranges);
                    safeSetDecorations(active, getMissingType(), [...missingRangesByPath.values()].flat());
                    log(`casc model unresolved: ${assetPath} (${elapsed}ms)`);
                    return;
                }
                log(`casc model resolved: ${assetPath} (${elapsed}ms)`);
                mdxFoundRangesByPath.set(assetPath, ranges);
                clearLoadingRanges(active, assetPath);
                clearMissingRanges(active, assetPath);
                safeSetDecorations(active, getMdxFoundType(), [...mdxFoundRangesByPath.values()].flat());
            } catch (error) {
                log(`casc model error: ${assetPath} :: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                extracting.delete(assetPath);
            }
        });
    }

    // Fire off CASC extraction for pending asset paths (deduplicated, non-blocking)
    for (const [assetPath] of pending) {
        if (unresolvedAssets.has(assetPath)) continue;
        if (extracting.has(assetPath)) continue;
        extracting.add(assetPath);
        const queuedAt = Date.now();
        log(`queue casc extract: ${assetPath}`);
        scheduleCascJob(async () => {
            try {
                const startedAt = Date.now();
                const queueWait = startedAt - queuedAt;
                log(`start casc extract: ${assetPath} (queued ${queueWait}ms)`);
                const cachedPath = await ensureCascCached(assetPath);
                const elapsed = Date.now() - startedAt;
                if (!cachedPath) {
                    unresolvedAssets.add(assetPath);
                    const active = vscode.window.activeTextEditor;
                    if (active && active.document === document) {
                        const missingRanges = pending.get(assetPath) ?? [];
                        clearLoadingRanges(active, assetPath);
                        setMissingRanges(assetPath, missingRanges);
                        safeSetDecorations(active, getMissingType(), [...missingRangesByPath.values()].flat());
                    }
                    log(`casc unresolved: ${assetPath} (${elapsed}ms)`);
                    return;
                }
                log(`casc resolved: ${assetPath} -> ${cachedPath} (${elapsed}ms)`);
                const active = vscode.window.activeTextEditor;
                if (!active || active.document !== document) return;
                // Directly queue a thumb job for the resolved path instead of
                // re-scanning the full document (which would iterate 2000+ pending paths).
                const pendingRanges = pending.get(assetPath);
                if (pendingRanges && pendingRanges.length > 0) {
                    const thumbQueuedAt2 = Date.now();
                    scheduleThumbJob(async () => {
                        const thumbStartedAt2 = Date.now();
                        const iconUri = await getThumbnailUri(cachedPath);
                        const thumbElapsed2 = Date.now() - thumbStartedAt2;
                        if (!iconUri) {
                            log(`thumb failed for casc-resolved: ${path.basename(cachedPath)} (gen ${thumbElapsed2}ms)`);
                            return;
                        }
                        log(`thumb ready (casc): ${path.basename(cachedPath)} (queue ${thumbStartedAt2 - thumbQueuedAt2}ms, gen ${thumbElapsed2}ms)`);
                        const currentActive = vscode.window.activeTextEditor;
                        if (!currentActive || currentActive.document !== document) return;
                        // Use the ranges captured at scan time — no re-scan needed.
                        let type = activeTypes.get(cachedPath);
                        if (type) type.dispose();
                        type = makeDecorationType(iconUri);
                        activeTypes.set(cachedPath, type);
                        safeSetDecorations(currentActive, type, makeDecorationOptions(pendingRanges));
                        clearLoadingRanges(currentActive, assetPath);
                        clearMissingRanges(currentActive, assetPath);
                        log(`applied thumb (casc): ${cachedPath} ranges=${pendingRanges.length}`);
                    });
                }
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
            void updateDecorations(editor).catch(() => {
                // Ignore races from editor/extension shutdown.
            });
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
            if (doc.fileName.endsWith('.wurst')) { invalidateAssetIndex(); update(vscode.window.activeTextEditor); }
        }),
        // Dispose all active types when extension deactivates
        new vscode.Disposable(() => {
            isDisposed = true;
            for (const timer of updateTimers.values()) clearTimeout(timer);
            updateTimers.clear();
            for (const t of activeTypes.values()) t.dispose();
            activeTypes.clear();
            unresolvedAssets.clear();
            loadingRangesByPath.clear();
            missingRangesByPath.clear();
            mdxFoundRangesByPath.clear();
            loadingType?.dispose();
            loadingType = undefined;
            missingType?.dispose();
            missingType = undefined;
            mdxFoundType?.dispose();
            mdxFoundType = undefined;
            output.dispose();
        }),
    ];

    // Decorate the already-open editor immediately
    update(vscode.window.activeTextEditor);

    return vscode.Disposable.from(...subs);
}
