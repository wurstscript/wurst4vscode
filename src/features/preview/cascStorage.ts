'use strict';

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CascStorage, MpqStorage, closeAllSegments } from 'casc-ts';
import { appendDiagnostic, formatDiagnosticError } from '../diagnostics';

const WURST_HOME = path.join(os.homedir(), '.wurst');

let defaultWarcraftPathsCache: string[] | null = null;
let gameDataRootCache: GameDataRoot | null | undefined;
let loggedCascRootMessage = '';
const cascTextureMissCache = new Set<string>();
const cascAssetMissCache = new Set<string>();
const MAX_CASC_MISS_CACHE = 4096;

type GameStorageKind = 'casc' | 'mpq';

interface GameDataRoot {
    kind: GameStorageKind;
    root: string;
}

interface GameStorage {
    readonly kind: GameStorageKind;
    readonly fileCount: number;
    readFileAsync(filePath: string): Promise<Buffer>;
    hasFileAsync(filePath: string): Promise<boolean>;
    listFiles(): Promise<string[]>;
    findPathByBasenameAsync(basename: string): Promise<string | null>;
    close(): Promise<void>;
}

class CascGameStorage implements GameStorage {
    readonly kind = 'casc' as const;

    constructor(private readonly storage: CascStorage) {}

    get fileCount(): number { return this.storage.fileCount; }
    readFileAsync(filePath: string): Promise<Buffer> {
        return this.storage.readFileAsync(normalizeCascAssetPath(filePath).replace(/\\/g, '/'));
    }
    hasFileAsync(filePath: string): Promise<boolean> {
        return this.storage.hasFileAsync(normalizeCascAssetPath(filePath).replace(/\\/g, '/'));
    }
    listFiles(): Promise<string[]> {
        return Promise.resolve(this.storage.listFiles().map(normalizeGameAssetSeparators));
    }
    findPathByBasenameAsync(basename: string): Promise<string | null> {
        return this.storage.findPathByBasenameAsync(normalizeCascAssetPath(basename).replace(/\\/g, '/'));
    }
    async close(): Promise<void> { await closeAllSegments(); }
}

class MpqGameStorage implements GameStorage {
    readonly kind = 'mpq' as const;
    private constructor(private readonly archives: Array<{ name: string; storage: MpqStorage }>) {}

    static async openAsync(root: string, log: (message: string) => void): Promise<MpqGameStorage> {
        const entries = await fs.promises.readdir(root, { withFileTypes: true });
        const files = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name]));
        const record = (message: string): void => {
            log(message);
            channelLog(message);
        };
        // Low priority first. The last archive containing a path wins, matching
        // the classic client: base RoC -> TFT -> locale -> patch overlay.
        const archiveNames = ['war3.mpq', 'war3local.mpq', 'war3x.mpq', 'war3xlocal.mpq', 'war3patch.mpq'];
        const archives: Array<{ name: string; storage: MpqStorage }> = [];
        for (const requestedName of archiveNames) {
            const actualName = files.get(requestedName);
            if (!actualName) continue;
            const archivePath = path.join(root, actualName);
            try {
                const storage = await MpqStorage.openAsync(archivePath, record);
                archives.push({ name: actualName, storage });
            } catch (error) {
                record(`MPQ open failed: ${archivePath}: ${formatDiagnosticError(error)}`);
            }
        }
        if (!archives.length) throw new Error(`No readable WC3 MPQ archives found in ${root}`);
        log(`MPQ game storage opened (${archives.length} archives, ${archives.map((archive) => archive.name).join(', ')})`);
        return new MpqGameStorage(archives);
    }

    get fileCount(): number { return this.archives.reduce((sum, archive) => sum + archive.storage.fileCount, 0); }

    async readFileAsync(filePath: string): Promise<Buffer> {
        const normalized = normalizeCascAssetPath(filePath);
        for (let i = this.archives.length - 1; i >= 0; i--) {
            const archive = this.archives[i];
            if (await archive.storage.hasFileAsync(normalized)) {
                try {
                    return await archive.storage.readFileAsync(normalized);
                } catch (error) {
                    const detail = formatDiagnosticError(error);
                    const wrapped = new Error(`MPQ ${archive.name} failed to read ${normalized}: ${detail}`);
                    if (wrapped.stack && detail.includes('\n')) {
                        wrapped.stack += `\nCaused by:\n${detail}`;
                    }
                    throw wrapped;
                }
            }
        }
        throw new Error(`File not found in WC3 MPQ storage: ${filePath}`);
    }

    async hasFileAsync(filePath: string): Promise<boolean> {
        const normalized = normalizeCascAssetPath(filePath);
        for (let i = this.archives.length - 1; i >= 0; i--) {
            if (await this.archives[i].storage.hasFileAsync(normalized)) return true;
        }
        return false;
    }

    async listFiles(): Promise<string[]> {
        const paths = new Set<string>();
        for (const archive of this.archives) {
            for (const filePath of await archive.storage.listFilesAsync()) paths.add(normalizeGameAssetSeparators(filePath));
        }
        return [...paths];
    }

    async findPathByBasenameAsync(basename: string): Promise<string | null> {
        const needle = normalizeCascAssetPath(basename);
        for (let i = this.archives.length - 1; i >= 0; i--) {
            const paths = await this.archives[i].storage.listFilesAsync();
            const match = paths.find((filePath) => {
                const normalized = normalizeCascAssetPath(filePath);
                return normalized.endsWith(`\\${needle}`) || normalized === needle;
            });
            if (match) return match;
        }
        return null;
    }

    async close(): Promise<void> {
        await Promise.all(this.archives.map((archive) => archive.storage.close()));
    }
}

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
    const line = `[${iso.slice(11, 23)}] ${message}`;
    appendDiagnostic('WC3 data', line);
    getCascOutputChannel().appendLine(line);
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

function hasLegacyMpqArchive(dir: string): boolean {
    try {
        return fs.readdirSync(dir).some((entry) => /^(war3|war3x|war3patch|war3local|war3xlocal)\.mpq$/i.test(entry));
    } catch {
        return false;
    }
}

function findMpqDataRoot(startPath: string): string | null {
    let dir = startPath;
    for (let i = 0; i < 5; i++) {
        if (hasLegacyMpqArchive(dir)) return dir;
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
    return normalizeGameAssetSeparators(assetPath).toLowerCase();
}

/** Normalize separators without changing display casing. Used for catalog paths and lookups. */
export function normalizeGameAssetSeparators(assetPath: string): string {
    return assetPath
        .replace(/\0/g, '')
        .replace(/^\uFEFF/, '')
        .replace(/[\\/]+/g, '\\')
        .replace(/^\\/, '')
        .replace(/\\$/, '');
}

export const normalizeGameAssetPath = normalizeCascAssetPath;

function getCachedAssetPath(cacheDir: string, normalizedAssetPath: string): string {
    // CASC namespace paths contain ':' (e.g. "_hd.w3mod:replaceabletextures\..."), which is illegal
    // in Windows directory names → mkdir ENOENT. Map ':' to a safe char for the on-disk cache only.
    return path.join(cacheDir, ...normalizedAssetPath.replace(/:/g, '$').split('\\'));
}

function getSourceCachePath(kind: GameStorageKind, normalizedAssetPath: string): string {
    return getCachedAssetPath(path.join(getCacheDir(), kind), normalizedAssetPath);
}

export async function findCachedGameAsset(assetPath: string): Promise<string | undefined> {
    const normalized = normalizeCascAssetPath(assetPath);
    const candidates = [
        gameDataRootCache?.kind ? getSourceCachePath(gameDataRootCache.kind, normalized) : '',
        // Preserve assets extracted by older extension versions when CASC is active.
        gameDataRootCache?.kind === 'casc' ? getCachedAssetPath(getCacheDir(), normalized) : '',
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            await fs.promises.access(candidate, fs.constants.F_OK);
            return candidate;
        } catch {}
    }
    return undefined;
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

function getGameDataRoot(log: (msg: string) => void): GameDataRoot | null {
    if (gameDataRootCache !== undefined) {
        return gameDataRootCache;
    }
    const wc3path = vscode.workspace.getConfiguration('wurst').get<string>('wc3path', '');
    if (wc3path) {
        const dataRoot = findCascDataRoot(wc3path);
        if (dataRoot) {
            if (dataRoot !== wc3path) logCascRootOnce(`CASC root: ${dataRoot} (from ${wc3path})`, log);
            gameDataRootCache = { kind: 'casc', root: dataRoot };
            return gameDataRootCache;
        }
        const mpqRoot = findMpqDataRoot(wc3path);
        if (mpqRoot) {
            logCascRootOnce(`Legacy MPQ root: ${mpqRoot} (from ${wc3path})`, log);
            gameDataRootCache = { kind: 'mpq', root: mpqRoot };
            return gameDataRootCache;
        }
        log(`CASC wurst.wc3path "${wc3path}" has no WC3 CASC root — falling back to default paths`);
        channelLog(`wurst.wc3path "${wc3path}" has no WC3 CASC root (looked for Data/ + .build.info|.build.db) — falling back to default paths`);
    }
    const defaultPaths = getDefaultWarcraftPaths();
    for (const p of defaultPaths) {
        const dataRoot = findCascDataRoot(p);
        if (dataRoot) {
            logCascRootOnce(`CASC root: ${dataRoot}`, log);
            gameDataRootCache = { kind: 'casc', root: dataRoot };
            return gameDataRootCache;
        }
        const mpqRoot = findMpqDataRoot(p);
        if (mpqRoot) {
            logCascRootOnce(`Legacy MPQ root: ${mpqRoot}`, log);
            gameDataRootCache = { kind: 'mpq', root: mpqRoot };
            return gameDataRootCache;
        }
    }
    logCascRootOnce(`CASC skip: no WC3 install found (${defaultPaths.length} default paths checked)`, log);
    channelLog('Checked paths:\n' + defaultPaths.map((p) => '  - ' + p).join('\n'));
    channelLog('If Warcraft III is installed somewhere else, set the "wurst.wc3path" setting to its folder.');
    gameDataRootCache = null;
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
            const detail = formatDiagnosticError(e);
            log(`CASC open failed: ${detail}`);
            channelLog(`storage open failed: ${detail}`);
            cascStorageRoot = null;
            return null;
        } finally {
            cascStorageOpening = null;
        }
    })();
    return cascStorageOpening;
}

let mpqStorageInstance: MpqGameStorage | null = null;
let mpqStorageRoot: string | null = null;
let mpqStorageOpening: Promise<MpqGameStorage | null> | null = null;

async function getGameStorageInstance(root: GameDataRoot, log: (msg: string) => void): Promise<GameStorage | null> {
    if (root.kind === 'casc') {
        const storage = await getCascStorageInstance(root.root, log);
        return storage ? new CascGameStorage(storage) : null;
    }
    if (mpqStorageInstance && mpqStorageRoot === root.root) return mpqStorageInstance;
    if (mpqStorageOpening && mpqStorageRoot === root.root) return mpqStorageOpening;
    mpqStorageInstance = null;
    mpqStorageRoot = root.root;
    mpqStorageOpening = (async () => {
        try {
            mpqStorageInstance = await MpqGameStorage.openAsync(root.root, log);
            return mpqStorageInstance;
        } catch (error) {
            const detail = formatDiagnosticError(error);
            log(`MPQ game storage open failed: ${detail}`);
            channelLog(`game storage open failed: ${detail}`);
            mpqStorageRoot = null;
            return null;
        } finally {
            mpqStorageOpening = null;
        }
    })();
    return mpqStorageOpening;
}

/** Reset the singleton (e.g. when wc3path setting changes). */
export function resetCascStorage(): void {
    void mpqStorageInstance?.close();
    closeAllSegments();
    cascStorageInstance = null;
    cascStorageRoot = null;
    cascStorageOpening = null;
    mpqStorageInstance = null;
    mpqStorageRoot = null;
    mpqStorageOpening = null;
    gameDataRootCache = undefined;
    loggedCascRootMessage = '';
    cascTextureMissCache.clear();
    cascAssetMissCache.clear();
}

/** Read one file from the active game storage. No disk cache write. */
async function gameReadDirect(root: GameDataRoot, gamePath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const storage = await getGameStorageInstance(root, log);
    if (!storage) return null;
    try {
        if (!await storage.hasFileAsync(gamePath)) return null;
    } catch (error) {
        const detail = formatDiagnosticError(error);
        const message = `${root.kind.toUpperCase()} lookup failed: ${gamePath}: ${detail}`;
        log(message);
        channelLog(message);
        return null;
    }
    try {
        const buf = await storage.readFileAsync(gamePath);
        if (!buf || buf.length === 0) return null;
        return buf;
    } catch (error) {
        const detail = formatDiagnosticError(error);
        const message = `${root.kind.toUpperCase()} read failed: ${gamePath}: ${detail}`;
        log(message);
        channelLog(message);
        return null;
    }
}

type TextureExt = 'dds' | 'blp' | 'tga';

/** Look up a texture. Checks disk cache first; if missing, extracts in-process and caches to disk. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
export async function findCascTexture(texPath: string, log: (msg: string) => void): Promise<{ buf: Buffer; ext: TextureExt } | null> {
    const cacheDir = getCacheDir();
    const gameRoot = getGameDataRoot(log);
    const cacheKind = gameRoot?.kind ?? 'casc';
    // CASC paths are lowercase with backslash separators
    const basePath = textureBasePath(texPath);
    const ddsPath = `${basePath}.dds`;
    const blpPath = `${basePath}.blp`;
    const tgaPath = `${basePath}.tga`;
    const pathForExt = (ext: TextureExt): string => {
        if (ext === 'dds') return ddsPath;
        if (ext === 'tga') return tgaPath;
        return blpPath;
    };
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
        const cachePaths = [getSourceCachePath(cacheKind, rel)];
        if (cacheKind === 'casc') cachePaths.push(getCachedAssetPath(cacheDir, rel));
        for (const cachePath of cachePaths) {
            try {
                const buf = await fs.promises.readFile(cachePath);
                return { buf, ext };
            } catch {}
        }
    }

    if (cascTextureMissCache.has(missKey)) {
        return null;
    }

    if (!gameRoot) return null;

    const candidates: Array<[string, 'dds' | 'blp' | 'tga']> = gameRoot!.kind === 'mpq'
        ? [[blpPath, 'blp'], [tgaPath, 'tga'], [ddsPath, 'dds']]
        : [
            [`war3.w3mod:${ddsPath}`, 'dds'],
            [`war3.w3mod:_hd.w3mod:${ddsPath}`, 'dds'],
            [`war3.w3mod:${blpPath}`, 'blp'],
            [`war3.w3mod:${tgaPath}`, 'tga'],
            [`war3.w3mod:_hd.w3mod:${tgaPath}`, 'tga'],
        ];
    if (fallbackDdsPath) {
        candidates.push([gameRoot!.kind === 'mpq' ? fallbackDdsPath : `war3.w3mod:${fallbackDdsPath}`, 'dds']);
        if (gameRoot!.kind === 'casc') candidates.push([`war3.w3mod:_hd.w3mod:${fallbackDdsPath}`, 'dds']);
    }
    if (fallbackBlpPath) candidates.push([gameRoot!.kind === 'mpq' ? fallbackBlpPath : `war3.w3mod:${fallbackBlpPath}`, 'blp']);
    if (fallbackTgaPath) candidates.push([gameRoot!.kind === 'mpq' ? fallbackTgaPath : `war3.w3mod:${fallbackTgaPath}`, 'tga']);

    for (const [gamePath, ext] of candidates) {
        const rel = pathForExt(ext);
        const cachePath = getSourceCachePath(gameRoot!.kind, rel);
        const buf = await gameReadDirect(gameRoot!, gamePath, log);
        if (buf) {
            log(`${gameRoot!.kind.toUpperCase()} extracted: ${gamePath} (${buf.length} bytes) -> ${cachePath}`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return { buf, ext };
        }
    }

    // Last resort: texture path drifted — find by basename (try both .dds and .blp endings).
    const storage = await getGameStorageInstance(gameRoot!, log);
    if (storage) {
        const baseNoExt = basePath.split('\\').pop() ?? '';
        for (const ext of ['dds', 'blp', 'tga'] as const) {
            const found = await storage.findPathByBasenameAsync(`${baseNoExt}.${ext}`);
            if (!found) continue;
            const buf = await gameReadDirect(gameRoot!, found, log);
            if (!buf) continue;
            const rel = pathForExt(ext);
            const cachePath = getSourceCachePath(gameRoot!.kind, rel);
            log(`${gameRoot!.kind.toUpperCase()} basename-resolved texture: ${baseNoExt}.${ext} -> ${found} (${buf.length} bytes)`);
            await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.promises.writeFile(cachePath, buf);
            return { buf, ext };
        }
    }
    rememberMiss(cascTextureMissCache, missKey);
    log(`${gameRoot!.kind.toUpperCase()} texture not found after ${candidates.length} candidates: ${texPath}`);
    return null;
}

export const findGameTexture = findCascTexture;

async function readCachedGameBuffer(assetPath: string, root: GameDataRoot | null): Promise<Buffer | null> {
    const normalized = normalizeCascAssetPath(assetPath);
    const cachePaths = [getSourceCachePath(root?.kind ?? 'casc', normalized)];
    if (root?.kind === 'casc') cachePaths.push(getCachedAssetPath(getCacheDir(), normalized));
    for (const cachePath of cachePaths) {
        try {
            return await fs.promises.readFile(cachePath);
        } catch {}
    }
    return null;
}

function gameAssetCandidates(root: GameDataRoot, normalized: string): string[] {
    if (root.kind === 'mpq') return [normalized];
    return [
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
}

async function writeGameCache(root: GameDataRoot, assetPath: string, data: Buffer): Promise<string> {
    const cachePath = getSourceCachePath(root.kind, assetPath);
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(cachePath, data);
    return cachePath;
}

export async function findCascAsset(assetPath: string, log: (msg: string) => void): Promise<Buffer | null> {
    const normalized = normalizeCascAssetPath(assetPath);
    const gameRoot = getGameDataRoot(log);
    const cached = await readCachedGameBuffer(normalized, gameRoot);
    if (cached) return cached;

    if (cascAssetMissCache.has(normalized)) {
        return null;
    }

    if (!gameRoot) return null;

    const candidates = gameAssetCandidates(gameRoot, normalized);
    for (const gamePath of candidates) {
        const buf = await gameReadDirect(gameRoot, gamePath, log);
        if (buf) {
            const cachePath = await writeGameCache(gameRoot, normalized, buf);
            log(`${gameRoot.kind.toUpperCase()} extracted: ${gamePath} (${buf.length} bytes) -> ${cachePath}`);
            return buf;
        }
    }

    // Last resort: the referenced path drifted from where the file actually lives in CASC
    // (common with skin-file model/texture paths). Find it by basename instead.
    const basename = normalized.split('\\').pop() ?? '';
    if (basename) {
        const storage = await getGameStorageInstance(gameRoot, log);
        const found = storage ? await storage.findPathByBasenameAsync(basename) : null;
        if (found) {
            const buf = await gameReadDirect(gameRoot, found, log);
            if (buf) {
                log(`${gameRoot.kind.toUpperCase()} basename-resolved: ${basename} -> ${found} (${buf.length} bytes)`);
                await writeGameCache(gameRoot, normalized, buf);
                return buf;
            }
        }
    }

    rememberMiss(cascAssetMissCache, normalized);
    log(`${gameRoot.kind.toUpperCase()} asset not found after ${candidates.length} candidates: ${assetPath}`);
    return null;
}

export const findGameAsset = findCascAsset;

export async function listGameAssetPaths(
    predicate: (assetPath: string) => boolean,
    log: (msg: string) => void = defaultCascLog,
): Promise<string[]> {
    const gameRoot = getGameDataRoot(log);
    if (!gameRoot) return [];
    const storage = await getGameStorageInstance(gameRoot, log);
    if (!storage) return [];

    // Expand the main containers before listing; CascStorage discovers sub-TVFS contents lazily.
    if (gameRoot.kind === 'casc') {
        try { await storage.findPathByBasenameAsync('__wurst_no_such_asset__'); } catch {}
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const cascPath of await storage.listFiles()) {
        const assetPath = stripCascContainerPrefix(cascPath);
        if (!assetPath || !predicate(assetPath)) continue;
        const normalized = normalizeCascAssetPath(assetPath);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalizeGameAssetSeparators(assetPath));
    }
    return out.sort((a, b) => a.localeCompare(b));
}

function stripCascContainerPrefix(cascPath: string): string | undefined {
    const normalized = normalizeGameAssetSeparators(cascPath);
    const parts = normalized.split(':');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/\.w3mod$/i.test(parts[i])) {
            return parts.slice(i + 1).join(':').replace(/^\\+/, '');
        }
    }
    return normalized.replace(/^\\+/, '');
}

function defaultCascLog(message: string): void {
    channelLog(message);
    if (process.env.WURST_CASC_DEBUG === '1') {
        console.log(`[wurst-casc] ${message}`);
    }
}

/** Shared logger for game-data consumers that do not have a feature-specific output channel. */
export function logGameData(message: string): void {
    defaultCascLog(message);
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
    const rel = `${textureBasePath(assetPath)}.${result.ext}`;
    const kind = getGameDataRoot(defaultCascLog)?.kind ?? 'casc';
    return getSourceCachePath(kind, rel);
}

export const ensureGameTextureCached = ensureCascCached;

export async function ensureCascAssetCached(assetPath: string): Promise<string | undefined> {
    const result = await findCascAsset(assetPath, defaultCascLog);
    if (!result) return undefined;
    const kind = getGameDataRoot(defaultCascLog)?.kind ?? 'casc';
    return getSourceCachePath(kind, normalizeCascAssetPath(assetPath));
}

export const ensureGameAssetCached = ensureCascAssetCached;

export function registerCascDiagnosticsCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('wurst.showWc3DataLog', () => {
        // Touch it once so the log has *something* in it even before any preview has loaded.
        getGameDataRoot(defaultCascLog);
        getCascOutputChannel().show();
    });
}
