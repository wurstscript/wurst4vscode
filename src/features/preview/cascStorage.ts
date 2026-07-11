'use strict';

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CascStorage, closeAllSegments } from 'casc-ts';

const WURST_HOME = path.join(os.homedir(), '.wurst');

let defaultWarcraftPathsCache: string[] | null = null;
let cascDataRootCache: string | null | undefined;
let loggedCascRootMessage = '';
const cascTextureMissCache = new Set<string>();
const cascAssetMissCache = new Set<string>();
const MAX_CASC_MISS_CACHE = 4096;

// ---------------------------------------------------------------------------
// Diagnostics: everything about "where did we look for the WC3 install and
// what did we find" goes here, visible via "Wurst: Show WC3 Data Log" — the
// per-call `log` callbacks passed around this file are often console-only (or
// no-ops), which left multi-drive/custom-install-path detection failures with
// no way for a user to see what was actually tried.
// ---------------------------------------------------------------------------
let cascOutputChannel: vscode.OutputChannel | undefined;

export function getCascOutputChannel(): vscode.OutputChannel {
    if (!cascOutputChannel) cascOutputChannel = vscode.window.createOutputChannel('Wurst: WC3 Data');
    return cascOutputChannel;
}

function channelLog(message: string): void {
    const iso = new Date().toISOString();
    getCascOutputChannel().appendLine(`[${iso.slice(11, 23)}] ${message}`);
}

function normalizeWindowsDriveRoot(value: string | undefined): string | null {
    if (!value) return null;
    const match = /^([a-zA-Z]):/.exec(value);
    return match ? `${match[1].toUpperCase()}:\\` : null;
}

function getWindowsDriveRoots(): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    const add = (driveRoot: string | null) => {
        if (!driveRoot || seen.has(driveRoot)) return;
        seen.add(driveRoot);
        try {
            if (fs.existsSync(driveRoot)) roots.push(driveRoot);
        } catch {}
    };

    add(normalizeWindowsDriveRoot(process.env.SystemDrive));
    add(normalizeWindowsDriveRoot(os.homedir()));
    add(normalizeWindowsDriveRoot(process.cwd()));

    for (let code = 67; code <= 90; code++) {
        add(`${String.fromCharCode(code)}:\\`);
    }

    return roots;
}

/**
 * Warcraft III's installer (both the classic installer and Battle.net) has always registered its
 * install location here, regardless of which drive or folder the user picked — the fixed relative
 * paths below only cover the *default* locations, so a custom install (a second/third drive, a
 * Steam-library-style folder, a renamed directory) is invisible to them. `reg.exe` ships with every
 * Windows install, so this needs no new dependency.
 */
function getWindowsRegistryInstallPaths(): string[] {
    const keys = [
        'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\Warcraft III',
        'HKLM\\SOFTWARE\\Blizzard Entertainment\\Warcraft III',
        'HKCU\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\Warcraft III',
        'HKCU\\SOFTWARE\\Blizzard Entertainment\\Warcraft III',
    ];
    const found: string[] = [];
    for (const key of keys) {
        try {
            const out = child_process.execFileSync('reg', ['query', key, '/v', 'InstallPath'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 5000,
            });
            const match = /InstallPath\s+REG_SZ\s+(.+)/i.exec(out);
            const installPath = match?.[1]?.trim();
            if (installPath) {
                channelLog(`registry: ${key} -> ${installPath}`);
                found.push(installPath);
            }
        } catch {
            // Key doesn't exist (not installed, or installed by something that doesn't write it) —
            // not an error, just try the next candidate.
        }
    }
    return found;
}

function getWindowsWarcraftPaths(): string[] {
    const relativeCandidates = [
        path.join('Program Files (x86)', 'Warcraft III'),
        path.join('Program Files', 'Warcraft III'),
        path.join('Games', 'Warcraft III'),
        'Warcraft III',
    ];
    const paths: string[] = [...getWindowsRegistryInstallPaths()];
    for (const driveRoot of getWindowsDriveRoots()) {
        for (const rel of relativeCandidates) {
            paths.push(path.join(driveRoot, rel));
        }
    }
    return paths;
}

function getDefaultWarcraftPaths(): string[] {
    if (defaultWarcraftPathsCache) {
        return defaultWarcraftPathsCache;
    }

    let candidates: string[];
    if (process.platform === 'win32') {
        candidates = getWindowsWarcraftPaths();
    } else if (process.platform === 'darwin') {
        candidates = [
            '/Applications/Warcraft III',
            '/Application/Warcraft III',
        ];
    } else if (process.platform === 'linux') {
        const winePrefix = process.env.WINEPREFIX || path.join(os.homedir(), '.wine');
        candidates = [
            path.join(winePrefix, 'drive_c', 'Program Files (x86)', 'Warcraft III'),
            path.join(winePrefix, 'drive_c', 'Program Files', 'Warcraft III'),
            path.join(os.homedir(), 'Games', 'Warcraft III'),
        ];
    } else {
        candidates = [];
    }

    defaultWarcraftPathsCache = candidates;
    return candidates;
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

export const getGameAssetCacheDir = getCascCacheDir;

export function getModelThumbCacheDir(): string {
    return path.join(WURST_HOME, 'model_thumbs');
}

function getCacheDir(): string {
    return getCascCacheDir();
}

export function normalizeCascAssetPath(assetPath: string): string {
    return assetPath.replace(/\\\\/g, '\\').replace(/\//g, '\\').toLowerCase();
}

export const normalizeGameAssetPath = normalizeCascAssetPath;

function getCachedAssetPath(cacheDir: string, normalizedAssetPath: string): string {
    // CASC namespace paths contain ':' (e.g. "_hd.w3mod:replaceabletextures\..."), which is illegal
    // in Windows directory names → mkdir ENOENT. Map ':' to a safe char for the on-disk cache only.
    return path.join(cacheDir, ...normalizedAssetPath.replace(/:/g, '$').split('\\'));
}

function rememberMiss(cache: Set<string>, key: string): void {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.add(key);
    while (cache.size > MAX_CASC_MISS_CACHE) {
        const firstKey = cache.values().next().value;
        if (!firstKey) break;
        cache.delete(firstKey);
    }
}

function logCascRootOnce(message: string, log: (msg: string) => void): void {
    if (message === loggedCascRootMessage) {
        return;
    }
    loggedCascRootMessage = message;
    log(message);
    channelLog(message);
}

function getDisabledButtonFallbackPath(assetPath: string): string | null {
    const normalized = normalizeCascAssetPath(assetPath);
    const prefix = 'replaceabletextures\\commandbuttonsdisabled\\disbtn';
    if (!normalized.startsWith(prefix)) {
        return null;
    }
    return 'replaceabletextures\\commandbuttons\\disbtn' + normalized.slice(prefix.length);
}

function textureBasePath(assetPath: string): string {
    return normalizeCascAssetPath(assetPath).replace(/\.[^\\.]+$/, '');
}

function getCascDataRoot(log: (msg: string) => void): string | null {
    if (cascDataRootCache !== undefined) {
        return cascDataRootCache;
    }
    const wc3path = vscode.workspace.getConfiguration('wurst').get<string>('wc3path', '');
    if (wc3path) {
        const dataRoot = findCascDataRoot(wc3path);
        if (dataRoot) {
            if (dataRoot !== wc3path) logCascRootOnce(`CASC root: ${dataRoot} (from ${wc3path})`, log);
            cascDataRootCache = dataRoot;
            return dataRoot;
        }
        log(`CASC wurst.wc3path "${wc3path}" has no WC3 CASC root — falling back to default paths`);
        channelLog(`wurst.wc3path "${wc3path}" has no WC3 CASC root (looked for Data/ + .build.info|.build.db) — falling back to default paths`);
    }
    const defaultPaths = getDefaultWarcraftPaths();
    for (const p of defaultPaths) {
        const dataRoot = findCascDataRoot(p);
        if (dataRoot) {
            logCascRootOnce(`CASC root: ${dataRoot}`, log);
            cascDataRootCache = dataRoot;
            return dataRoot;
        }
    }
    logCascRootOnce(`CASC skip: no WC3 install found (${defaultPaths.length} default paths checked)`, log);
    channelLog(`Checked paths:\n${defaultPaths.map((p) => `  - ${p}`).join('\n')}`);
    channelLog('If Warcraft III is installed somewhere else, set the "wurst.wc3path" setting to its folder.');
    cascDataRootCache = null;
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
            channelLog(`opening storage at: ${wc3Root}`);
            cascStorageInstance = await CascStorage.openAsync(wc3Root, log);
            log(`CASC storage opened (${cascStorageInstance.fileCount} files)`);
            channelLog(`storage opened (${cascStorageInstance.fileCount} files)`);
            return cascStorageInstance;
        } catch (e) {
            log(`CASC open failed: ${String(e)}`);
            channelLog(`storage open failed: ${String(e)}`);
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
    cascDataRootCache = undefined;
    loggedCascRootMessage = '';
    cascTextureMissCache.clear();
    cascAssetMissCache.clear();
}

/** Read one file directly from the in-process CascStorage. No child process, no disk cache write. */
async function cascReadDirect(wc3Root: string, cascPath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const storage = await getCascStorageInstance(wc3Root, log);
    if (!storage) return null;
    try {
        const buf = await storage.readFileAsync(cascPath);
        if (!buf || buf.length === 0) return null;
        return buf;
    } catch {
        return null;
    }
}

/** Look up a texture. Checks disk cache first; if missing, extracts in-process and caches to disk. */
export async function findCascTexture(texPath: string, log: (msg: string) => void): Promise<{ buf: Buffer; ext: 'dds' | 'blp' | 'tga' } | null> {
    const cacheDir = getCacheDir();
    // CASC paths are lowercase with backslash separators
    const basePath = textureBasePath(texPath);
    const ddsPath = `${basePath}.dds`;
    const blpPath = `${basePath}.blp`;
    const tgaPath = `${basePath}.tga`;
    const fallbackNormalized = getDisabledButtonFallbackPath(texPath);
    const fallbackBasePath = fallbackNormalized ? textureBasePath(fallbackNormalized) : null;
    const fallbackDdsPath = fallbackBasePath ? `${fallbackBasePath}.dds` : null;
    const fallbackBlpPath = fallbackBasePath ? `${fallbackBasePath}.blp` : null;
    const fallbackTgaPath = fallbackBasePath ? `${fallbackBasePath}.tga` : null;
    const missKey = `${basePath}\0${fallbackBasePath ?? ''}`;

    // Check disk cache
    const cacheCandidates: Array<[string, 'dds' | 'blp' | 'tga']> = [[ddsPath, 'dds'], [blpPath, 'blp'], [tgaPath, 'tga']];
    if (fallbackDdsPath) cacheCandidates.push([fallbackDdsPath, 'dds']);
    if (fallbackBlpPath) cacheCandidates.push([fallbackBlpPath, 'blp']);
    if (fallbackTgaPath) cacheCandidates.push([fallbackTgaPath, 'tga']);
    for (const [rel, ext] of cacheCandidates) {
        const cachePath = getCachedAssetPath(cacheDir, rel);
        try {
            const buf = await fs.promises.readFile(cachePath);
            return { buf, ext };
        } catch {}
    }

    if (cascTextureMissCache.has(missKey)) {
        return null;
    }

    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return null;

    const candidates: Array<[string, 'dds' | 'blp' | 'tga']> = [
        [`war3.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:_hd.w3mod:${ddsPath}`, 'dds'],
        [`war3.w3mod:${blpPath}`, 'blp'],
        [`war3.w3mod:${tgaPath}`, 'tga'],
        [`war3.w3mod:_hd.w3mod:${tgaPath}`, 'tga'],
    ];
    if (fallbackDdsPath) {
        candidates.push([`war3.w3mod:${fallbackDdsPath}`, 'dds']);
        candidates.push([`war3.w3mod:_hd.w3mod:${fallbackDdsPath}`, 'dds']);
    }
    if (fallbackBlpPath) candidates.push([`war3.w3mod:${fallbackBlpPath}`, 'blp']);
    if (fallbackTgaPath) candidates.push([`war3.w3mod:${fallbackTgaPath}`, 'tga']);

    for (const [cascPath, ext] of candidates) {
        const rel = ext === 'dds' ? ddsPath : ext === 'tga' ? tgaPath : blpPath;
        const cachePath = getCachedAssetPath(cacheDir, rel);
        const buf = await cascReadDirect(wc3Root, cascPath, log);
        if (buf) {
            log(`CASC extracted: ${cascPath} (${buf.length} bytes) → ${cachePath}`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return { buf, ext };
        }
    }

    // Last resort: texture path drifted — find by basename (try both .dds and .blp endings).
    const storage = await getCascStorageInstance(wc3Root, log);
    if (storage) {
        const baseNoExt = basePath.split('\\').pop() ?? '';
        for (const ext of ['dds', 'blp', 'tga'] as const) {
            const found = await storage.findPathByBasenameAsync(`${baseNoExt}.${ext}`);
            if (!found) continue;
            const buf = await cascReadDirect(wc3Root, found, log);
            if (!buf) continue;
            const rel = ext === 'dds' ? ddsPath : ext === 'tga' ? tgaPath : blpPath;
            const cachePath = getCachedAssetPath(cacheDir, rel);
            log(`CASC basename-resolved texture: ${baseNoExt}.${ext} → ${found} (${buf.length} bytes)`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return { buf, ext };
        }
    }
    rememberMiss(cascTextureMissCache, missKey);
    return null;
}

export const findGameTexture = findCascTexture;

export async function findCascAsset(assetPath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const cacheDir = getCacheDir();
    const normalized = normalizeCascAssetPath(assetPath);
    const cachePath = getCachedAssetPath(cacheDir, normalized);
    try {
        const cached = await fs.promises.readFile(cachePath);
        return cached;
    } catch {}

    if (cascAssetMissCache.has(normalized)) {
        return null;
    }

    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return null;

    const candidates = [
        `war3.w3mod:${normalized}`,
        `war3.w3mod:_hd.w3mod:${normalized}`,
        `war3.w3mod:enus.w3mod:${normalized}`,
        `war3.w3mod:enus.w3mod:_hd.w3mod:${normalized}`,
        `war3.w3mod:_locales\\enus.w3mod:${normalized}`,
        `war3.w3mod:_locales\\enus.w3mod:_hd.w3mod:${normalized}`,
        `war3.w3mod:dede.w3mod:${normalized}`,
        `war3.w3mod:dede.w3mod:_hd.w3mod:${normalized}`,
        `war3.w3mod:_locales\\dede.w3mod:${normalized}`,
        `war3.w3mod:_locales\\dede.w3mod:_hd.w3mod:${normalized}`,
        `war3.w3mod:frfr.w3mod:${normalized}`,
        `war3.w3mod:_locales\\frfr.w3mod:${normalized}`,
        `war3.w3mod:eses.w3mod:${normalized}`,
        `war3.w3mod:_locales\\eses.w3mod:${normalized}`,
        `war3.w3mod:ruru.w3mod:${normalized}`,
        `war3.w3mod:_locales\\ruru.w3mod:${normalized}`,
        `war3.w3mod:kokr.w3mod:${normalized}`,
        `war3.w3mod:_locales\\kokr.w3mod:${normalized}`,
        `war3.w3mod:zhcn.w3mod:${normalized}`,
        `war3.w3mod:_locales\\zhcn.w3mod:${normalized}`,
        `war3.w3mod:zhtw.w3mod:${normalized}`,
        `war3.w3mod:_locales\\zhtw.w3mod:${normalized}`,
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

    // Last resort: the referenced path drifted from where the file actually lives in CASC
    // (common with skin-file model/texture paths). Find it by basename instead.
    const basename = normalized.split('\\').pop() ?? '';
    if (basename) {
        const storage = await getCascStorageInstance(wc3Root, log);
        const found = storage ? await storage.findPathByBasenameAsync(basename) : null;
        if (found) {
            const buf = await cascReadDirect(wc3Root, found, log);
            if (buf) {
                log(`CASC basename-resolved: ${basename} → ${found} (${buf.length} bytes)`);
                await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
                await fs.promises.writeFile(cachePath, buf);
                return buf;
            }
        }
    }

    rememberMiss(cascAssetMissCache, normalized);
    return null;
}

export const findGameAsset = findCascAsset;

export async function listGameAssetPaths(
    predicate: (assetPath: string) => boolean,
    log: (msg: string) => void = defaultCascLog,
): Promise<string[]> {
    const wc3Root = getCascDataRoot(log);
    if (!wc3Root) return [];
    const storage = await getCascStorageInstance(wc3Root, log);
    if (!storage) return [];

    // Expand the main containers before listing; CascStorage discovers sub-TVFS contents lazily.
    try { await storage.findPathByBasenameAsync('__wurst_no_such_asset__'); } catch {}

    const out: string[] = [];
    const seen = new Set<string>();
    for (const cascPath of storage.listFiles()) {
        const assetPath = stripCascContainerPrefix(cascPath);
        if (!assetPath || !predicate(assetPath)) continue;
        const normalized = normalizeCascAssetPath(assetPath);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(assetPath.replace(/\//g, '\\'));
    }
    return out.sort((a, b) => a.localeCompare(b));
}

function stripCascContainerPrefix(cascPath: string): string | undefined {
    const normalized = cascPath.replace(/\//g, '\\');
    const parts = normalized.split(':');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/\.w3mod$/i.test(parts[i])) {
            return parts.slice(i + 1).join(':').replace(/^\\+/, '');
        }
    }
    return normalized.replace(/^\\+/, '');
}

function defaultCascLog(message: string): void {
    if (process.env.WURST_CASC_DEBUG === '1') {
        console.log(`[wurst-casc] ${message}`);
    }
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
 * Returns the absolute path to the cached file (DDS/BLP/TGA), or undefined if
 * the path cannot be resolved (no wc3path configured, file not in CASC, etc.).
 */
export async function ensureCascCached(assetPath: string): Promise<string | undefined> {
    const result = await findCascTexture(assetPath, defaultCascLog);
    if (!result) return undefined;
    const cacheDir = getCacheDir();
    const rel = `${textureBasePath(assetPath)}.${result.ext}`;
    return getCachedAssetPath(cacheDir, rel);
}

export const ensureGameTextureCached = ensureCascCached;

export async function ensureCascAssetCached(assetPath: string): Promise<string | undefined> {
    const result = await findCascAsset(assetPath, defaultCascLog);
    if (!result) return undefined;
    return getCachedAssetPath(getCacheDir(), normalizeCascAssetPath(assetPath));
}

export const ensureGameAssetCached = ensureCascAssetCached;

export function registerCascDiagnosticsCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('wurst.showWc3DataLog', () => {
        // Touch it once so the log has *something* in it even before any preview has loaded.
        getCascDataRoot(defaultCascLog);
        getCascOutputChannel().show();
    });
}
