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
import { getCandidateRoots, resolveAssetPathWithCasc, assetPathVariants, fastByteHash } from '../imageAssetSupport';
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
    return `v4s-${fastByteHash(Buffer.from(`${resolvedPath.toLowerCase()}\0${stat.size}\0${Math.round(stat.mtimeMs)}`, 'utf8'))}`;
}

function thumbLog(message: string): void {
    console.log(`[wurst-model-thumb] ${message}`);
}

type TexturePayload =
    | { blpBase64: string }
    | { ddsBase64: string }
    | { rgbaBase64: string; width: number; height: number };

const texturePayloadCache = new Map<string, TexturePayload>();
const MAX_TEXTURE_PAYLOAD_CACHE = 512;

function texturePayloadKey(resolvedPath: string, stat: fs.Stats): string {
    return `${resolvedPath.toLowerCase()}\0${stat.size}\0${Math.round(stat.mtimeMs)}`;
}

function rememberTexturePayload(key: string, payload: TexturePayload): void {
    if (texturePayloadCache.has(key)) {
        texturePayloadCache.delete(key);
    }
    texturePayloadCache.set(key, payload);
    while (texturePayloadCache.size > MAX_TEXTURE_PAYLOAD_CACHE) {
        const firstKey = texturePayloadCache.keys().next().value;
        if (!firstKey) break;
        texturePayloadCache.delete(firstKey);
    }
}

function getCompressedDdsFormat(bytes: Buffer): string | undefined {
    if (bytes.length < 128 || bytes.readUInt32LE(0) !== 0x20534444) return undefined;
    const pfFlags = bytes.readUInt32LE(80);
    if ((pfFlags & 0x4) === 0) return undefined;
    const fourCc = bytes.toString('ascii', 84, 88).toUpperCase();
    return fourCc === 'DXT1' || fourCc === 'DXT3' || fourCc === 'DXT5' ? fourCc : undefined;
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
export async function requestModelThumbnail(modelPath: string, key: string, documentUri: vscode.Uri, webview: vscode.Webview): Promise<void> {
    const t0 = Date.now();
    thumbLog(`${key} request model="${modelPath}"`);
    const roots = await getCandidateRoots(documentUri.fsPath);
    const tRoots = Date.now();
    const resolved = await resolveAssetPathWithCasc(modelPath, roots, 'model');
    const tResolved = Date.now();
    if (!resolved) {
        thumbLog(`${key} miss model="${modelPath}" roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms`);
        await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath });
        return;
    }
    if (!isModelFile(resolved)) {
        thumbLog(`${key} rejected non-model model="${modelPath}" resolved="${resolved}"`);
        await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath });
        return;
    }

    try {
        const tStatStart = Date.now();
        const stat = await fs.promises.stat(resolved);
        const aliasKey = statThumbKey(resolved, stat);
        const statCached = await readCachedThumb(aliasKey);
        const tStatCache = Date.now();
        if (statCached) {
            thumbLog(`${key} cache-hit-stat aliasKey=${aliasKey} path="${statCached.cachePath}" bytes=${statCached.bytes} roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms stat/cacheRead=${tStatCache - tStatStart}ms total=${tStatCache - t0}ms`);
            await webview.postMessage({ type: 'modelThumbLoaded', key, uri: statCached.uri, cacheKey: aliasKey });
            return;
        }

        const cacheKey = aliasKey;
        const format = extOf(resolved) === 'mdl' ? 'mdl' : 'mdx';
        const fileName = resolved.slice(Math.max(resolved.lastIndexOf('/'), resolved.lastIndexOf('\\')) + 1);
        const tPrep = Date.now();
        thumbLog(`${key} cache-miss key=${cacheKey} model="${modelPath}" resolved="${resolved}" roots=${tRoots - t0}ms resolve=${tResolved - tRoots}ms stat/cacheRead=${tStatCache - tStatStart}ms prep=${tPrep - tStatCache}ms bytes=${stat.size}`);
        await webview.postMessage({
            type: 'modelThumbRender',
            key,
            path: modelPath,
            cacheKey,
            aliasKey,
            modelUri: webview.asWebviewUri(vscode.Uri.file(resolved)).toString(),
            format,
            fileName,
        });
    } catch {
        thumbLog(`${key} error model="${modelPath}" total=${Date.now() - t0}ms`);
        await webview.postMessage({ type: 'modelThumbMissing', key, path: modelPath });
    }
}

function isModelFile(filePath: string): boolean {
    const ext = extOf(filePath);
    return ext === 'mdx' || ext === 'mdl';
}

/** Persist a webview-rendered webp thumbnail and echo it back as a data URL. */
export async function cacheModelThumbnail(key: string, cacheKey: string, webpBase64: string, webview: vscode.Webview, aliasKey?: string): Promise<void> {
    const validKey = (value: string | undefined) => !value || /^v(?:2|3s|4s)-[a-f0-9-]+$/i.test(value);
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
        const cachePath = path.join(getModelThumbCacheDir(), `${cacheKey}.webp`);
        const tDecode = Date.now();
        await fs.promises.mkdir(getModelThumbCacheDir(), { recursive: true });
        const tMkdir = Date.now();
        await fs.promises.writeFile(cachePath, bytes);
        if (aliasKey && aliasKey !== cacheKey) {
            try { await fs.promises.writeFile(path.join(getModelThumbCacheDir(), `${aliasKey}.webp`), bytes); } catch {}
        }
        const tWrite = Date.now();
        thumbLog(`${key} cache-write key=${cacheKey}${aliasKey ? ` aliasKey=${aliasKey}` : ''} path="${cachePath}" bytes=${bytes.length} decode=${tDecode - t0}ms mkdir=${tMkdir - tDecode}ms write=${tWrite - tMkdir}ms total=${tWrite - t0}ms`);
        await webview.postMessage({ type: 'modelThumbLoaded', key, uri: `data:image/webp;base64,${bytes.toString('base64')}`, cacheKey });
    } catch (err) {
        thumbLog(`${key} cache-write error key=${cacheKey} total=${Date.now() - t0}ms error=${err instanceof Error ? err.message : String(err)}`);
        await webview.postMessage({ type: 'modelThumbMissing', key });
    }
}

/** Resolve model textures and push them to the webview for `War3Viewer.onTexture` / `onTextureImageData`. */
export async function postTexturesToWebview(texPaths: string[], documentUri: vscode.Uri, webview: vscode.Webview, thumbKey?: string): Promise<void> {
    const totalStart = Date.now();
    const roots = await getCandidateRoots(documentUri.fsPath);
    const post = (message: Record<string, unknown>) => webview.postMessage(thumbKey ? { ...message, thumbKey } : message);
    const uniqueTexPaths = [...new Set(texPaths)];
    await Promise.all(uniqueTexPaths.map(async (texPath) => {
        const t0 = Date.now();
        try {
            const resolved = await resolveAssetPathWithCasc(texPath, roots, 'texture');
            const tResolved = Date.now();
            if (!resolved) {
                if (thumbKey) thumbLog(`${thumbKey} texture-miss path="${texPath}" resolve=${tResolved - t0}ms`);
                await post({ type: 'mdxTexture', path: texPath });
                return;
            }
            const stat = await fs.promises.stat(resolved);
            const cacheKey = texturePayloadKey(resolved, stat);
            const cachedPayload = texturePayloadCache.get(cacheKey);
            if (cachedPayload) {
                texturePayloadCache.delete(cacheKey);
                texturePayloadCache.set(cacheKey, cachedPayload);
                await post({ type: 'mdxTexture', path: texPath, ...cachedPayload });
                if (thumbKey) thumbLog(`${thumbKey} texture-cache path="${texPath}" resolved="${resolved}" resolve=${tResolved - t0}ms post=${Date.now() - tResolved}ms total=${Date.now() - t0}ms`);
                return;
            }
            const bytes = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved)));
            const tRead = Date.now();
            const ext = extOf(resolved);
            if (ext === 'blp') {
                // Send the raw BLP; war3-model's decoder handles team-color / jpeg-content BLPs.
                const payload: TexturePayload = { blpBase64: bytes.toString('base64') };
                rememberTexturePayload(cacheKey, payload);
                await post({ type: 'mdxTexture', path: texPath, ...payload });
                if (thumbKey) thumbLog(`${thumbKey} texture path="${texPath}" resolved="${resolved}" resolve=${tResolved - t0}ms read=${tRead - tResolved}ms post=${Date.now() - tRead}ms total=${Date.now() - t0}ms bytes=${bytes.length}`);
            } else if (ext === 'dds') {
                if (getCompressedDdsFormat(bytes)) {
                    const payload: TexturePayload = { ddsBase64: bytes.toString('base64') };
                    rememberTexturePayload(cacheKey, payload);
                    await post({ type: 'mdxTexture', path: texPath, ...payload });
                    if (thumbKey) thumbLog(`${thumbKey} texture-dds path="${texPath}" resolved="${resolved}" resolve=${tResolved - t0}ms read=${tRead - tResolved}ms post=${Date.now() - tRead}ms total=${Date.now() - t0}ms bytes=${bytes.length}`);
                } else {
                    if (thumbKey) thumbLog(`${thumbKey} texture-dds-unsupported path="${texPath}" resolved="${resolved}" resolve=${tResolved - t0}ms read=${tRead - tResolved}ms total=${Date.now() - t0}ms bytes=${bytes.length}`);
                    await post({ type: 'mdxTexture', path: texPath });
                }
            } else {
                const dec = decodeToRgba(new Uint8Array(bytes), `.${ext}`);
                const tDecode = Date.now();
                const payload: TexturePayload = {
                    rgbaBase64: Buffer.from(dec.rgba).toString('base64'),
                    width: dec.width,
                    height: dec.height,
                };
                rememberTexturePayload(cacheKey, payload);
                await post({ type: 'mdxTexture', path: texPath, ...payload });
                if (thumbKey) thumbLog(`${thumbKey} texture path="${texPath}" resolved="${resolved}" resolve=${tResolved - t0}ms read=${tRead - tResolved}ms decode=${tDecode - tRead}ms post=${Date.now() - tDecode}ms total=${Date.now() - t0}ms bytes=${bytes.length} size=${dec.width}x${dec.height}`);
            }
        } catch {
            if (thumbKey) thumbLog(`${thumbKey} texture-error path="${texPath}" total=${Date.now() - t0}ms`);
            await post({ type: 'mdxTexture', path: texPath });
        }
    }));
    if (thumbKey) thumbLog(`${thumbKey} textures total count=${texPaths.length} unique=${uniqueTexPaths.length} total=${Date.now() - totalStart}ms`);
}
