'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CascStorage, closeAllSegments } from 'casc-ts';

const WURST_HOME = path.join(os.homedir(), '.wurst');

function getDefaultWarcraftPaths(): string[] {
    if (process.platform === 'win32') {
        return [
            'C:\\Program Files (x86)\\Warcraft III',
            'C:\\Program Files\\Warcraft III',
            'D:\\Program Files (x86)\\Warcraft III',
            'D:\\Program Files\\Warcraft III',
        ];
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Warcraft III',
            '/Application/Warcraft III',
        ];
    }
    if (process.platform === 'linux') {
        const winePrefix = process.env.WINEPREFIX || path.join(os.homedir(), '.wine');
        return [
            path.join(winePrefix, 'drive_c', 'Program Files (x86)', 'Warcraft III'),
            path.join(winePrefix, 'drive_c', 'Program Files', 'Warcraft III'),
            path.join(os.homedir(), 'Games', 'Warcraft III'),
        ];
    }
    return [];
}

/** Walk up from `startPath` until we find a WC3 CASC root (has Data/ AND .build.info or .build.db). */
function findCascDataRoot(startPath: string): string | null {
    let dir = startPath;
    for (let i = 0; i < 5; i++) {
        if (fs.existsSync(path.join(dir, 'Data')) &&
            (fs.existsSync(path.join(dir, '.build.info')) || fs.existsSync(path.join(dir, '.build.db')))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

export function getCascCacheDir(): string {
    return path.join(WURST_HOME, 'casc_cache');
}

function getCacheDir(): string {
    return getCascCacheDir();
}

export function normalizeCascAssetPath(assetPath: string): string {
    return assetPath.replace(/\\\\/g, '\\').replace(/\//g, '\\').toLowerCase();
}

function getCachedAssetPath(cacheDir: string, normalizedAssetPath: string): string {
    return path.join(cacheDir, ...normalizedAssetPath.split('\\'));
}

function getDisabledButtonFallbackPath(assetPath: string): string | null {
    const normalized = normalizeCascAssetPath(assetPath);
    const prefix = 'replaceabletextures\\commandbuttonsdisabled\\disbtn';
    if (!normalized.startsWith(prefix)) {
        return null;
    }
    return 'replaceabletextures\\commandbuttons\\disbtn' + normalized.slice(prefix.length);
}

function getCascDataRoot(log: (msg: string) => void): string | null {
    const wc3path = vscode.workspace.getConfiguration('wurst').get<string>('wc3path', '');
    if (wc3path) {
        const dataRoot = findCascDataRoot(wc3path);
        if (dataRoot) {
            if (dataRoot !== wc3path) log(`CASC resolved data root: ${dataRoot} (from ${wc3path})`);
            return dataRoot;
        }
        log(`CASC wurst.wc3path "${wc3path}" has no WC3 CASC root — falling back to default paths`);
    }
    for (const p of getDefaultWarcraftPaths()) {
        const dataRoot = findCascDataRoot(p);
        if (dataRoot) { log(`CASC using default path: ${dataRoot}`); return dataRoot; }
    }
    log(`CASC skip: no WC3 install found (checked wurst.wc3path and default paths)`);
    return null;
}

// ---------------------------------------------------------------------------
// In-process CASC singleton — open once, reuse for all extractions.
// This eliminates the per-file child-process spawn + repeated index loading.
// ---------------------------------------------------------------------------

let cascStorageInstance: CascStorage | null = null;
let cascStorageRoot: string | null = null;
let cascStorageOpening: Promise<CascStorage | null> | null = null;

async function getCascStorageInstance(wc3Root: string, log: (msg: string) => void): Promise<CascStorage | null> {
    if (cascStorageInstance && cascStorageRoot === wc3Root) {
        return cascStorageInstance;
    }
    if (cascStorageOpening && cascStorageRoot === wc3Root) {
        return cascStorageOpening;
    }
    // Root changed or first open — (re-)initialise
    cascStorageInstance = null;
    cascStorageRoot = wc3Root;
    cascStorageOpening = (async () => {
        try {
            log(`CASC opening storage at: ${wc3Root}`);
            cascStorageInstance = await CascStorage.openAsync(wc3Root, log);
            log(`CASC storage opened (${cascStorageInstance.fileCount} files)`);
            return cascStorageInstance;
        } catch (e) {
            log(`CASC open failed: ${String(e)}`);
            cascStorageRoot = null;
            return null;
        } finally {
            cascStorageOpening = null;
        }
    })();
    return cascStorageOpening;
}

/** Reset the singleton (e.g. when wc3path setting changes). */
export function resetCascStorage(): void {
    closeAllSegments();
    cascStorageInstance = null;
    cascStorageRoot = null;
    cascStorageOpening = null;
}

/** Read one file directly from the in-process CascStorage. No child process, no disk cache write. */
async function cascReadDirect(wc3Root: string, cascPath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const storage = await getCascStorageInstance(wc3Root, log);
    if (!storage) return null;
    try {
        const t = Date.now();
        const buf = await storage.readFileAsync(cascPath);
        if (!buf || buf.length === 0) { log(`CASC empty: ${cascPath}`); return null; }
        log(`CASC read: ${cascPath} (${buf.length} bytes, ${Date.now() - t}ms)`);
        return buf;
    } catch (e) {
        log(`CASC miss: ${cascPath} — ${String(e)}`);
        return null;
    }
}

/** Look up a texture. Checks disk cache first; if missing, extracts in-process and caches to disk. */
export async function findCascTexture(texPath: string, log: (msg: string) => void): Promise<{ buf: Buffer; ext: 'dds' | 'blp' } | null> {
    const cacheDir = getCacheDir();
    // CASC paths are lowercase with backslash separators
    const normalized = normalizeCascAssetPath(texPath);
    const ddsPath = normalized.replace(/\.blp$/, '.dds');
    const fallbackNormalized = getDisabledButtonFallbackPath(texPath);
    const fallbackDdsPath = fallbackNormalized?.replace(/\.blp$/, '.dds') ?? null;

    // Check disk cache
    const cacheCandidates: Array<[string, 'dds' | 'blp']> = [[ddsPath, 'dds'], [normalized, 'blp']];
    if (fallbackDdsPath) cacheCandidates.push([fallbackDdsPath, 'dds']);
    if (fallbackNormalized) cacheCandidates.push([fallbackNormalized, 'blp']);
    for (const [rel, ext] of cacheCandidates) {
        const cachePath = getCachedAssetPath(cacheDir, rel);
        try {
            const buf = await fs.promises.readFile(cachePath);
            log(`CASC cache hit: ${rel}`);
            return { buf, ext };
        } catch {}
    }

    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return null;

    const candidates: Array<[string, 'dds' | 'blp']> = [
        [`war3.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:_hd.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:${normalized}`, 'blp'],
    ];
    if (fallbackDdsPath) {
        candidates.push([`war3.w3mod:${fallbackDdsPath}`, 'dds']);
        candidates.push([`war3.w3mod:_hd.w3mod:${fallbackDdsPath}`, 'dds']);
    }
    if (fallbackNormalized) {
        candidates.push([`war3.w3mod:${fallbackNormalized}`, 'blp']);
    }

    for (const [cascPath, ext] of candidates) {
        const rel = ext === 'dds' ? ddsPath : normalized;
        const cachePath = getCachedAssetPath(cacheDir, rel);
        const buf = await cascReadDirect(wc3Root, cascPath, log);
        if (buf) {
            log(`CASC extracted: ${cascPath} (${buf.length} bytes) → ${cachePath}`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return { buf, ext };
        }
    }
    return null;
}

export async function findCascAsset(assetPath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const cacheDir = getCacheDir();
    const normalized = normalizeCascAssetPath(assetPath);
    const cachePath = getCachedAssetPath(cacheDir, normalized);
    try {
        const cached = await fs.promises.readFile(cachePath);
        log(`CASC cache hit: ${normalized}`);
        return cached;
    } catch {}

    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return null;

    const candidates = [
        `war3.w3mod:${normalized}`,
        `war3.w3mod:_hd.w3mod:${normalized}`,
    ];

    for (const cascPath of candidates) {
        const buf = await cascReadDirect(wc3Root, cascPath, log);
        if (buf) {
            log(`CASC extracted: ${cascPath} (${buf.length} bytes) → ${cachePath}`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return buf;
        }
    }

    return null;
}

/** Try to read a texture file from the local filesystem relative to the MDX file.
 *  Returns the buffer and the actual path found (may differ in extension). */
export function findLocalTexture(texPath: string, mdxFsPath: string): { buf: Buffer; foundPath: string } | null {
    const normalized = texPath.replace(/\\/g, '/');
    // When the model references a .blp, also try the Reforged .dds equivalent.
    const alternates = [normalized];
    if (normalized.toLowerCase().endsWith('.blp')) {
        alternates.push(normalized.slice(0, -4) + '.dds');
    }
    const mdxDir = path.dirname(mdxFsPath);

    let dir = mdxDir;
    for (let i = 0; i < 4; i++) {
        for (const alt of alternates) {
            const candidate = path.join(dir, alt);
            if (fs.existsSync(candidate)) {
                return { buf: fs.readFileSync(candidate), foundPath: candidate };
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Ensures a texture asset is present in the CASC disk cache, extracting from
 * the WC3 game files if needed.
 *
 * Returns the absolute path to the cached file (DDS or BLP), or undefined if
 * the path cannot be resolved (no wc3path configured, file not in CASC, etc.).
 */
export async function ensureCascCached(assetPath: string): Promise<string | undefined> {
    const log = (msg: string) => console.log(`[wurst-casc] ${msg}`);
    const result = await findCascTexture(assetPath, log);
    if (!result) return undefined;
    const cacheDir = getCacheDir();
    const normalized = normalizeCascAssetPath(assetPath);
    const rel = result.ext === 'dds' ? normalized.replace(/\.blp$/, '.dds') : normalized;
    return getCachedAssetPath(cacheDir, rel);
}

export async function ensureCascAssetCached(assetPath: string): Promise<string | undefined> {
    const log = (msg: string) => console.log(`[wurst-casc] ${msg}`);
    log(`ensureCascAssetCached: ${assetPath}`);
    const result = await findCascAsset(assetPath, log);
    if (!result) { log(`ensureCascAssetCached: failed for ${assetPath}`); return undefined; }
    return getCachedAssetPath(getCacheDir(), normalizeCascAssetPath(assetPath));
}
