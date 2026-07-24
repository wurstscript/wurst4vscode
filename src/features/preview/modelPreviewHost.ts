'use strict';

/**
 * Host-side helpers for embedding the War3 model viewer (`dist/webview/mdxViewer.js`)
 * inside other webviews (e.g. the object editor's inline model-preview square).
 *
 * Resolves a model and its textures through the shared extension-agnostic asset
 * resolver (local roots + CASC) and pushes them to the webview using a message
 * protocol the consuming inline script maps onto `War3Viewer.loadModel` /
 * `onTexture` / `onTextureImageData`.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getCandidateRoots, resolveAssetPathWithCasc, assetPathVariants, fastByteHash, scaleDown } from '../imageAssetSupport';
import { getModelThumbCacheDir } from './cascStorage';
import { decodeToRgba } from './imageDecoders';

function extOf(p: string): string {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dot = p.lastIndexOf('.');
    return dot > slash ? p.slice(dot + 1).toLowerCase() : '';
}

async function readCachedThumb(cacheKey: string): Promise<{ uri: string; cachePath: string; bytes: number; buf: Buffer } | undefined> {
    const cachePath = path.join(getModelThumbCacheDir(), `${cacheKey}.webp`);
    try {
        const buf = await fs.promises.readFile(cachePath);
        return { uri: `data:image/webp;base64,${buf.toString('base64')}`, cachePath, bytes: buf.length, buf };
    } catch {
        return undefined;
    }
}

function statThumbKey(resolvedPath: string, stat: fs.Stats): string {
    const identity = `${resolvedPath.toLowerCase()}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
    return `v8s-${fastByteHash(Buffer.from(identity, 'utf8'))}`;
}

function thumbLog(message: string): void {
    console.log(`[wurst-model-thumb] ${message}`);
}

type ThumbnailDiagnostic = {
    startedAt: number;
    model?: string;
    modelBytes?: number;
    resolveMs?: number;
    textureMs?: number;
    textureCount?: number;
    textureSent?: number;
    textureCacheHits?: number;
    textureFailures?: number;
    worker?: Record<string, unknown>;
};

const thumbnailDiagnostics = new Map<string, ThumbnailDiagnostic>();
let diagnosticWrite = Promise.resolve();
let diagnosticFileInitialized = false;

export function getModelThumbnailDiagnosticsPath(): string {
    return path.join(getModelThumbCacheDir(), 'thumbnail-diagnostics.jsonl');
}

function appendThumbnailDiagnostic(entry: Record<string, unknown>): void {
    const diagnosticsPath = getModelThumbnailDiagnosticsPath();
    diagnosticWrite = diagnosticWrite.then(async () => {
        await fs.promises.mkdir(path.dirname(diagnosticsPath), { recursive: true });
        if (!diagnosticFileInitialized) {
            diagnosticFileInitialized = true;
            try {
                const stat = await fs.promises.stat(diagnosticsPath);
                if (stat.size > 1_000_000) await fs.promises.truncate(diagnosticsPath, 0);
            } catch {
                // First diagnostic entry.
            }
            console.log(`[wurst-model-thumb] diagnostics=${diagnosticsPath}`);
        }
        await fs.promises.appendFile(diagnosticsPath, `${JSON.stringify(entry)}\n`, 'utf8');
    }).catch((error) => {
        console.error(`[wurst-model-thumb] diagnostic write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

function finishThumbnailDiagnostic(key: string, outcome: string, extra: Record<string, unknown> = {}): void {
    const diagnostic = thumbnailDiagnostics.get(key);
    if (!diagnostic) return;
    thumbnailDiagnostics.delete(key);
    appendThumbnailDiagnostic({
        at: new Date().toISOString(),
        key,
        model: diagnostic.model,
        outcome,
        totalMs: Date.now() - diagnostic.startedAt,
        modelBytes: diagnostic.modelBytes,
        resolveMs: diagnostic.resolveMs,
        textureMs: diagnostic.textureMs,
        textureCount: diagnostic.textureCount,
        textureSent: diagnostic.textureSent,
        textureCacheHits: diagnostic.textureCacheHits,
        textureFailures: diagnostic.textureFailures,
        worker: diagnostic.worker,
        ...extra,
    });
}

export function recordModelThumbnailProfile(
    key: string,
    phase: string,
    elapsedMs: number | undefined,
    detail: string | undefined,
): void {
    const diagnostic = thumbnailDiagnostics.get(key);
    if (!diagnostic || !phase.startsWith('worker-')) return;
    let metrics: Record<string, unknown> = {};
    if (detail) {
        try { metrics = JSON.parse(detail) as Record<string, unknown>; } catch {}
    }
    diagnostic.worker = { ...(diagnostic.worker ?? {}), [phase.slice('worker-'.length)]: metrics };
    if (phase === 'worker-rendered') {
        finishThumbnailDiagnostic(key, 'rendered', { workerElapsedMs: elapsedMs });
    } else if (phase === 'worker-failed' || phase === 'worker-error') {
        finishThumbnailDiagnostic(key, 'failed', { phase, workerElapsedMs: elapsedMs });
    }
}

function modelThumbCacheDisabled(): boolean {
    return process.env.WURST_MODEL_THUMB_DISABLE_CACHE === '1';
}

type TexturePayload =
    | { blpBase64: string }
    | { ddsBase64: string }
    | { textureBytes: Uint8Array; textureExt: 'blp' | 'dds' }
    | { rgbaBase64: string; width: number; height: number };

const texturePayloadCache = new Map<string, TexturePayload>();
const textureMissingCache = new Set<string>();
const MAX_TEXTURE_PAYLOAD_CACHE = 512;
const MAX_TEXTURE_PAYLOAD_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_TEXTURE_MISSING_CACHE = 2048;
const TEXTURE_RESOLVE_CONCURRENCY = 6;
const MODEL_THUMB_TEXTURE_MAX_DIMENSION = 128;
let texturePayloadCacheBytes = 0;

function texturePayloadKey(resolvedPath: string, stat: fs.Stats, variant: string): string {
    return `${variant}\0${resolvedPath.toLowerCase()}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
}

function texturePayloadSize(payload: TexturePayload): number {
    if ('rgbaBase64' in payload) return payload.rgbaBase64.length;
    if ('ddsBase64' in payload) return payload.ddsBase64.length;
    if ('textureBytes' in payload) return payload.textureBytes.byteLength;
    return payload.blpBase64.length;
}

function rememberTexturePayload(key: string, payload: TexturePayload): void {
    const payloadBytes = texturePayloadSize(payload);
    const previous = texturePayloadCache.get(key);
    if (previous) {
        texturePayloadCacheBytes -= texturePayloadSize(previous);
        texturePayloadCache.delete(key);
    }
    texturePayloadCache.set(key, payload);
    texturePayloadCacheBytes += payloadBytes;
    while (texturePayloadCache.size > MAX_TEXTURE_PAYLOAD_CACHE || texturePayloadCacheBytes > MAX_TEXTURE_PAYLOAD_CACHE_BYTES) {
        const firstKey = texturePayloadCache.keys().next().value;
        if (!firstKey) break;
        const first = texturePayloadCache.get(firstKey);
        if (first) texturePayloadCacheBytes -= texturePayloadSize(first);
        texturePayloadCache.delete(firstKey);
    }
}

function rememberMissingTexture(key: string): void {
    if (textureMissingCache.has(key)) {
        textureMissingCache.delete(key);
    }
    textureMissingCache.add(key);
    while (textureMissingCache.size > MAX_TEXTURE_MISSING_CACHE) {
        const firstKey = textureMissingCache.values().next().value;
        if (!firstKey) break;
        textureMissingCache.delete(firstKey);
    }
}

export function markModelThumbnailBad(key: string, cacheKey?: string, aliasKey?: string, reason?: string): void {
    const reasonSuffix = reason ? ` reason=${reason}` : '';
    const cacheKeySuffix = cacheKey ? ` key=${cacheKey}` : '';
    const aliasKeySuffix = aliasKey && aliasKey !== cacheKey ? ` aliasKey=${aliasKey}` : '';
    thumbLog(`${key} render-failed${reasonSuffix}${cacheKeySuffix}${aliasKeySuffix}`);
    finishThumbnailDiagnostic(key, 'failed', { reason });
}

function textureMissingKey(texPath: string, roots: readonly string[]): string {
    const normalizedPath = texPath.replace(/[\\/]+/g, '\\').toLowerCase();
    const normalizedRoots = roots.map((root) => root.replace(/[\\/]+/g, '\\').toLowerCase()).join('|');
    return `${normalizedPath}\0${normalizedRoots}`;
}

function assetLabel(assetPath: string): string {
    const slash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
    return slash >= 0 ? assetPath.slice(slash + 1) : assetPath;
}

async function forEachLimited<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await worker(item);
        }
    });
    await Promise.all(workers);
}

function getCompressedDdsFormat(bytes: Buffer): string | undefined {
    if (bytes.length < 128 || bytes.readUInt32LE(0) !== 0x20534444) return undefined;
    const pfFlags = bytes.readUInt32LE(80);
    if ((pfFlags & 0x4) === 0) return undefined;
    const fourCc = bytes.toString('ascii', 84, 88).toUpperCase();
    return fourCc === 'DXT1' || fourCc === 'DXT3' || fourCc === 'DXT5' ? fourCc : undefined;
}

function getDdsDimensions(bytes: Buffer): { width: number; height: number } | undefined {
    if (bytes.length < 128 || bytes.readUInt32LE(0) !== 0x20534444) return undefined;
    return { height: bytes.readUInt32LE(12), width: bytes.readUInt32LE(16) };
}

function compactDdsForThumbnail(bytes: Buffer): Buffer {
    const format = getCompressedDdsFormat(bytes);
    const dimensions = getDdsDimensions(bytes);
    if (!format || !dimensions || Math.max(dimensions.width, dimensions.height) <= MODEL_THUMB_TEXTURE_MAX_DIMENSION) {
        return bytes;
    }
    const blockBytes = format === 'DXT1' ? 8 : 16;
    const mipCount = Math.max(1, bytes.readUInt32LE(28) || 1);
    let width = dimensions.width;
    let height = dimensions.height;
    let offset = 128;
    let level = 0;
    while (level + 1 < mipCount && Math.max(width, height) > MODEL_THUMB_TEXTURE_MAX_DIMENSION) {
        offset += Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes;
        width = Math.max(1, width >> 1);
        height = Math.max(1, height >> 1);
        level++;
    }
    const mipLengths: number[] = [];
    let levelWidth = width;
    let levelHeight = height;
    for (let index = level; index < mipCount; index++) {
        mipLengths.push(Math.max(1, Math.ceil(levelWidth / 4)) * Math.max(1, Math.ceil(levelHeight / 4)) * blockBytes);
        levelWidth = Math.max(1, levelWidth >> 1);
        levelHeight = Math.max(1, levelHeight >> 1);
    }
    const payloadBytes = Math.min(bytes.length - offset, mipLengths.reduce((sum, length) => sum + length, 0));
    if (payloadBytes <= 0) return bytes;
    const compact = Buffer.allocUnsafe(128 + payloadBytes);
    bytes.copy(compact, 0, 0, 128);
    bytes.copy(compact, 128, offset, offset + payloadBytes);
    compact.writeUInt32LE(height, 12);
    compact.writeUInt32LE(width, 16);
    compact.writeUInt32LE(mipLengths[0], 20);
    compact.writeUInt32LE(mipLengths.length, 28);
    return compact;
}

function compactBlpForThumbnail(bytes: Buffer): Buffer {
    if (bytes.length < 160 || bytes.toString('ascii', 0, 4) !== 'BLP1') return bytes;
    const content = bytes.readUInt32LE(4);
    const width = bytes.readUInt32LE(12);
    const height = bytes.readUInt32LE(16);
    let level = 0;
    while (
        level < 15 &&
        Math.max(Math.max(1, width >> level), Math.max(1, height >> level)) > MODEL_THUMB_TEXTURE_MAX_DIMENSION &&
        bytes.readUInt32LE(92 + (level + 1) * 4) > 0
    ) level++;
    if (level === 0) return bytes;
    const mipOffset = bytes.readUInt32LE(28 + level * 4);
    const mipSize = bytes.readUInt32LE(92 + level * 4);
    const jpegHeaderSize = content === 0 ? bytes.readUInt32LE(156) : 0;
    const prefixLength = content === 0 ? 160 + jpegHeaderSize : 156 + 1024;
    if (!mipOffset || !mipSize || prefixLength > bytes.length || mipOffset + mipSize > bytes.length) return bytes;
    const compact = Buffer.allocUnsafe(prefixLength + mipSize);
    bytes.copy(compact, 0, 0, prefixLength);
    bytes.copy(compact, prefixLength, mipOffset, mipOffset + mipSize);
    compact.writeUInt32LE(Math.max(1, width >> level), 12);
    compact.writeUInt32LE(Math.max(1, height >> level), 16);
    for (let index = 0; index < 16; index++) {
        compact.writeUInt32LE(0, 28 + index * 4);
        compact.writeUInt32LE(0, 92 + index * 4);
    }
    compact.writeUInt32LE(prefixLength, 28);
    compact.writeUInt32LE(mipSize, 92);
    return compact;
}

function buildTexturePayload(bytes: Buffer, ext: string, thumbnail: boolean): { payload?: TexturePayload; decodedDds: boolean } {
    // Keep the renderer's proven BLP decoder in the loop. Decoding every BLP through the
    // generic host-side preview decoder caused some paletted/JPEG-content textures to become
    // black before they ever reached WebGL. The compressed source is also cheaper to transfer
    // than full RGBA; the thumbnail viewer downsizes the decoded ImageData before upload.
    if (ext === 'blp') {
        return { payload: { blpBase64: bytes.toString('base64') }, decodedDds: false };
    }
    // Compressed DDS can be uploaded directly and is substantially smaller than expanded RGBA.
    if (ext === 'dds' && getCompressedDdsFormat(bytes)) {
        return { payload: { ddsBase64: bytes.toString('base64') }, decodedDds: false };
    }
    if (thumbnail) {
        const dec = decodeToRgba(new Uint8Array(bytes), `.${ext}`);
        const scaled = scaleDown(dec.rgba, dec.width, dec.height, MODEL_THUMB_TEXTURE_MAX_DIMENSION);
        return {
            payload: {
                rgbaBase64: Buffer.from(scaled.rgba).toString('base64'),
                width: scaled.w,
                height: scaled.h,
            },
            decodedDds: ext === 'dds',
        };
    }
    try {
        const dec = decodeToRgba(new Uint8Array(bytes), `.${ext}`);
        return {
            payload: {
                rgbaBase64: Buffer.from(dec.rgba).toString('base64'),
                width: dec.width,
                height: dec.height,
            },
            decodedDds: ext === 'dds',
        };
    } catch {
        return { decodedDds: false };
    }
}

/** Resolve a model path and push its bytes to the webview for `War3Viewer.loadModel`. */
export async function postModelToWebview(modelPath: string, documentUri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    const roots = await getCandidateRoots(documentUri.fsPath);
    const resolved = await resolveAssetPathWithCasc(modelPath, roots, 'model');
    if (!resolved) {
        const tried = assetPathVariants(modelPath, 'model');
        console.log(`[wurst-model-preview] not found: ${modelPath} (tried: ${tried.join(', ')})`);
        await webview.postMessage({ type: 'mdxModelMissing', path: modelPath, tried });
        return;
    }
    console.log(`[wurst-model-preview] resolved ${modelPath} -> ${resolved}`);
    if (!isModelFile(resolved)) {
        await webview.postMessage({ type: 'mdxModelMissing', path: modelPath });
        return;
    }
    try {
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved)));
        const format = extOf(resolved) === 'mdl' ? 'mdl' : 'mdx';
        const fileName = resolved.slice(Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\')) + 1);
        await webview.postMessage({ type: 'mdxModel', mdxBase64: bytes.toString('base64'), format, fileName, path: modelPath });
    } catch {
        await webview.postMessage({ type: 'mdxModelMissing', path: modelPath });
    }
}

/**
 * Resolve a model and either post a cached webp thumbnail immediately or send
 * the model bytes to the webview so it can render one frame and post it back.
 */
export async function requestModelThumbnail(
    modelPath: string,
    key: string,
    documentUri: vscode.Uri,
    webview: vscode.Webview,
    useModelUri = false,
): Promise<void> {
    const t0 = Date.now();
    thumbnailDiagnostics.set(key, { startedAt: t0, model: modelPath });
    thumbLog(`${key} request model="${modelPath}"`);
    try {
        const roots = await getCandidateRoots(documentUri.fsPath);
        const tRoots = Date.now();
        const resolved = await resolveAssetPathWithCasc(modelPath, roots, 'model');
        const tResolved = Date.now();
        if (!resolved) {
            thumbLog(`${key} miss model="${modelPath}" roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms`);
            await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath, reason: 'not-found' });
            finishThumbnailDiagnostic(key, 'missing', { reason: 'not-found' });
            return;
        }
        if (!isModelFile(resolved)) {
            thumbLog(`${key} rejected non-model model="${modelPath}" resolved="${resolved}"`);
            await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath, reason: 'not-model' });
            finishThumbnailDiagnostic(key, 'missing', { reason: 'not-model' });
            return;
        }

        const tStatStart = Date.now();
        const stat = await fs.promises.stat(resolved);
        const diagnostic = thumbnailDiagnostics.get(key);
        if (diagnostic) {
            diagnostic.resolveMs = Date.now() - t0;
            diagnostic.modelBytes = stat.size;
        }
        const aliasKey = statThumbKey(resolved, stat);
        const statCached = modelThumbCacheDisabled() ? undefined : await readCachedThumb(aliasKey);
        const tStatCache = Date.now();
        if (statCached) {
            thumbLog(`${key} cache-hit-stat aliasKey=${aliasKey} path="${statCached.cachePath}" bytes=${statCached.bytes} roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms stat/cacheRead=${tStatCache - tStatStart}ms total=${tStatCache - t0}ms`);
            await webview.postMessage({ type: 'modelThumbLoaded', key, uri: statCached.uri, cacheKey: aliasKey });
            finishThumbnailDiagnostic(key, 'cache-hit', { cacheBytes: statCached.bytes });
            return;
        }

        const tPrep = Date.now();
        const format = extOf(resolved) === 'mdl' ? 'mdl' : 'mdx';
        const fileName = resolved.slice(Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\')) + 1);
        if (useModelUri) {
            const modelUri = webview.asWebviewUri(vscode.Uri.file(resolved)).toString();
            thumbLog(`${key} cache-miss key=${aliasKey} model="${modelPath}" resolved="${resolved}" roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms stat/cacheRead=${tStatCache - tStatStart}ms prep=${tPrep - tStatCache}ms source=uri bytes=${stat.size}`);
            await webview.postMessage({
                type: 'modelThumbRender',
                key,
                path: modelPath,
                cacheKey: aliasKey,
                aliasKey,
                modelUri,
                format,
                fileName,
            });
            return;
        }
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved)));
        const tRead = Date.now();
        const cacheKey = aliasKey;
        thumbLog(`${key} cache-miss key=${cacheKey} model="${modelPath}" resolved="${resolved}" roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms stat/cacheRead=${tStatCache - tStatStart}ms prep=${tPrep - tStatCache}ms read=${tRead - tPrep}ms bytes=${stat.size}`);
        await webview.postMessage({
            type: 'modelThumbRender',
            key,
            path: modelPath,
            cacheKey,
            aliasKey,
            mdxBase64: bytes.toString('base64'),
            format,
            fileName,
        });
    } catch (err) {
        thumbLog(`${key} error model="${modelPath}" total=${Date.now() - t0}ms error=${err instanceof Error ? err.message : String(err)}`);
        await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath, reason: 'error' });
        finishThumbnailDiagnostic(key, 'missing', { reason: 'error', error: err instanceof Error ? err.message : String(err) });
    }
}

function isModelFile(filePath: string): boolean {
    const ext = extOf(filePath);
    return ext === 'mdx' || ext === 'mdl';
}

/** Persist a webview-rendered webp thumbnail and echo it back as a data URL. */
export async function cacheModelThumbnail(key: string, cacheKey: string, webpBase64: string, webview: vscode.Webview, aliasKey?: string): Promise<void> {
    const validKey = (value: string | undefined) => !value || /^v(?:2|3s|4s|5s|6s|7s|8s)-[a-f0-9-]+$/i.test(value);
    if (!validKey(cacheKey) || !validKey(aliasKey) || !/^[A-Za-z0-9+/=]+$/.test(webpBase64) || webpBase64.length > 1_000_000) {
        thumbLog(`${key} cache-write rejected key=${cacheKey || '(empty)'} base64Chars=${webpBase64?.length ?? 0}`);
        await webview.postMessage({ type: 'modelThumbMissing', key });
        return;
    }
    const t0 = Date.now();
    try {
        const bytes = Buffer.from(webpBase64, 'base64');
        if (bytes.length < 12 || bytes.slice(0, 4).toString('ascii') !== 'RIFF' || bytes.slice(8, 12).toString('ascii') !== 'WEBP') {
            thumbLog(`${key} cache-write rejected-non-webp key=${cacheKey} bytes=${bytes.length}`);
            await webview.postMessage({ type: 'modelThumbMissing', key });
            return;
        }
        if (modelThumbCacheDisabled()) {
            const aliasKeySuffix = aliasKey ? ` aliasKey=${aliasKey}` : '';
            thumbLog(`${key} cache-write-disabled key=${cacheKey}${aliasKeySuffix} bytes=${bytes.length} decode=${Date.now() - t0}ms total=${Date.now() - t0}ms`);
            await webview.postMessage({ type: 'modelThumbLoaded', key, uri: `data:image/webp;base64,${bytes.toString('base64')}`, cacheKey });
            return;
        }
        const cachePath = path.join(getModelThumbCacheDir(), `${cacheKey}.webp`);
        const tDecode = Date.now();
        await fs.promises.mkdir(getModelThumbCacheDir(), { recursive: true });
        const tMkdir = Date.now();
        await fs.promises.writeFile(cachePath, bytes);
        if (aliasKey && aliasKey !== cacheKey) {
            try { await fs.promises.writeFile(path.join(getModelThumbCacheDir(), `${aliasKey}.webp`), bytes); } catch {}
        }
        const tWrite = Date.now();
        const aliasKeySuffix = aliasKey ? ` aliasKey=${aliasKey}` : '';
        thumbLog(`${key} cache-write key=${cacheKey}${aliasKeySuffix} path="${cachePath}" bytes=${bytes.length} decode=${tDecode - t0}ms mkdir=${tMkdir - tDecode}ms write=${tWrite - tMkdir}ms total=${tWrite - t0}ms`);
        await webview.postMessage({ type: 'modelThumbLoaded', key, uri: `data:image/webp;base64,${bytes.toString('base64')}`, cacheKey });
    } catch (err) {
        thumbLog(`${key} cache-write error key=${cacheKey} total=${Date.now() - t0}ms error=${err instanceof Error ? err.message : String(err)}`);
        await webview.postMessage({ type: 'modelThumbMissing', key });
    }
}

function buildWorkerTexturePayload(bytes: Buffer, ext: string): TexturePayload | undefined {
    const exactBytes = (source: Buffer) =>
        new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
    if (ext === 'blp') return { textureBytes: exactBytes(compactBlpForThumbnail(bytes)), textureExt: 'blp' };
    if (ext !== 'dds' || !getCompressedDdsFormat(bytes)) return undefined;
    return { textureBytes: exactBytes(compactDdsForThumbnail(bytes)), textureExt: 'dds' };
}

/** Resolve model textures and push them to the webview for `War3Viewer.onTexture` / `onTextureImageData`. */
export async function postTexturesToWebview(
    texPaths: string[],
    documentUri: vscode.Uri,
    webview: vscode.Webview,
    thumbKey?: string,
    useBinaryTexturePayload = false,
): Promise<void> {
    const totalStart = Date.now();
    const post = (message: Record<string, unknown>) => webview.postMessage(thumbKey ? { ...message, thumbKey } : message);
    const uniqueTexPaths = [...new Set(texPaths)];
    const stats = {
        payloadCache: 0,
        sent: 0,
        missing: 0,
        missingCache: 0,
        unsupported: 0,
        decodedDds: 0,
        errors: 0,
        slow: [] as string[],
    };
    let roots: string[];
    try {
        roots = await getCandidateRoots(documentUri.fsPath);
    } catch (err) {
        stats.errors = uniqueTexPaths.length;
        await forEachLimited(uniqueTexPaths, TEXTURE_RESOLVE_CONCURRENCY, async (texPath) => {
            await post({ type: 'mdxTexture', path: texPath, error: true });
        });
        if (thumbKey) {
            await post({ type: 'modelThumbTexturesComplete', paths: uniqueTexPaths, error: true });
            thumbLog(`${thumbKey} textures roots-error=${err instanceof Error ? err.message : String(err)} total=${Date.now() - totalStart}ms`);
        }
        return;
    }

    try {
        await forEachLimited(uniqueTexPaths, TEXTURE_RESOLVE_CONCURRENCY, async (texPath) => {
        const t0 = Date.now();
        const missKey = textureMissingKey(texPath, roots);
        try {
            if (textureMissingCache.has(missKey)) {
                stats.missingCache++;
                await post({ type: 'mdxTexture', path: texPath, missing: true });
                return;
            }
            const resolved = await resolveAssetPathWithCasc(texPath, roots, 'texture');
            if (!resolved) {
                rememberMissingTexture(missKey);
                stats.missing++;
                await post({ type: 'mdxTexture', path: texPath, missing: true });
                return;
            }
            textureMissingCache.delete(missKey);
            const stat = await fs.promises.stat(resolved);
            const ext = extOf(resolved);
            const cacheKey = texturePayloadKey(
                resolved,
                stat,
                thumbKey ? `thumb-${MODEL_THUMB_TEXTURE_MAX_DIMENSION}` : 'full',
            );
            const cachedPayload = texturePayloadCache.get(cacheKey);
            if (cachedPayload) {
                texturePayloadCache.delete(cacheKey);
                texturePayloadCache.set(cacheKey, cachedPayload);
                stats.payloadCache++;
                stats.sent++;
                await post({ type: 'mdxTexture', path: texPath, ...cachedPayload });
                return;
            }
            const bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved)));
            const workerPayload = useBinaryTexturePayload ? buildWorkerTexturePayload(bytes, ext) : undefined;
            const built = workerPayload
                ? { payload: workerPayload, decodedDds: false }
                : buildTexturePayload(bytes, ext, !!thumbKey);
            if (!built.payload) {
                stats.unsupported++;
                await post({ type: 'mdxTexture', path: texPath, unsupported: true });
                return;
            }
            rememberTexturePayload(cacheKey, built.payload);
            if (built.decodedDds) stats.decodedDds++;
            stats.sent++;
            await post({ type: 'mdxTexture', path: texPath, ...built.payload });
        } catch {
            rememberMissingTexture(missKey);
            stats.errors++;
            await post({ type: 'mdxTexture', path: texPath, error: true });
        } finally {
            const elapsed = Date.now() - t0;
            if (elapsed >= 120 && stats.slow.length < 4) {
                stats.slow.push(`${assetLabel(texPath)}:${elapsed}ms`);
            }
        }
        });
    } finally {
        if (thumbKey) {
            await post({ type: 'modelThumbTexturesComplete', paths: uniqueTexPaths });
        }
    }
    if (thumbKey) {
        const diagnostic = thumbnailDiagnostics.get(thumbKey);
        if (diagnostic) {
            diagnostic.textureMs = Date.now() - totalStart;
            diagnostic.textureCount = uniqueTexPaths.length;
            diagnostic.textureSent = stats.sent;
            diagnostic.textureCacheHits = stats.payloadCache;
            diagnostic.textureFailures = stats.missing + stats.missingCache + stats.unsupported + stats.errors;
        }
        const slow = stats.slow.length ? ` slow=${stats.slow.join(',')}` : '';
        thumbLog(`${thumbKey} textures unique=${uniqueTexPaths.length}/${texPaths.length} sent=${stats.sent} cache=${stats.payloadCache} ddsRgba=${stats.decodedDds} miss=${stats.missing} missCache=${stats.missingCache} unsupported=${stats.unsupported} errors=${stats.errors} total=${Date.now() - totalStart}ms${slow}`);
    }
}
