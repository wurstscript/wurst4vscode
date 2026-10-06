import { ThumbnailSession, parseMDL, parseMDX } from 'war3-model';
import type { TextureSource } from 'war3-model';
import { normalizeAssetPath } from './assetPathUtils';
import { base64ToBytes } from './webviewUtils';

const scope: any = self;
const OUTPUT_SIZE = 96;
const MAX_TEXTURE_DIMENSION = 128;
const session = new ThumbnailSession({ maxCachedTextureBytes: 32 * 1024 * 1024 });
type ParsedModel = ReturnType<typeof parseMDX>;
type PendingTexture = { resolve: (source: TextureSource) => void; reject: (error: Error) => void };
type Job = {
    key: string;
    controller: AbortController;
    pending: Map<string, PendingTexture>;
    sources: Map<string, Promise<TextureSource>>;
    requests: string[];
    started: number;
};
let activeJob: Job | null = null;

function post(message: Record<string, unknown>): void { scope.postMessage(message); }
function profile(job: Job, phase: string, detail: Record<string, unknown> = {}): void {
    if (activeJob === job) post({ type: 'profile', key: job.key, phase,
        elapsedMs: Math.round(performance.now() - job.started), ...detail });
}
function pickStandSequence(model: ParsedModel): number {
    let pick = 0;
    let best = Number.POSITIVE_INFINITY;
    model.Sequences.forEach((sequence, index) => {
        const name = String(sequence.Name || '').replace(/\0/g, '').trim().toLowerCase();
        if (name.includes('stand') && name.length < best) {
            best = name.length;
            pick = index;
        }
    });
    return pick;
}

function parseDdsInfo(buffer: ArrayBuffer): any {
    const view = new DataView(buffer);
    if (view.byteLength < 128 || view.getUint32(0, true) !== 0x20534444) throw new Error('invalid DDS');
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const mipMapCount = Math.max(1, view.getUint32(28, true) || 1);
    const fourCc = String.fromCharCode(view.getUint8(84), view.getUint8(85), view.getUint8(86), view.getUint8(87)).toUpperCase();
    const blockBytes = fourCc === 'DXT1' ? 8 : (fourCc === 'DXT3' || fourCc === 'DXT5' ? 16 : 0);
    if (!blockBytes) throw new Error(`unsupported DDS ${fourCc}`);
    const images: any[] = [];
    let offset = 128;
    let levelWidth = width;
    let levelHeight = height;
    for (let level = 0; level < mipMapCount && offset < view.byteLength; level++) {
        const length = Math.max(1, Math.ceil(levelWidth / 4)) * Math.max(1, Math.ceil(levelHeight / 4)) * blockBytes;
        images.push({ offset, length, shape: { width: levelWidth, height: levelHeight } });
        offset += length;
        levelWidth = Math.max(1, levelWidth >> 1);
        levelHeight = Math.max(1, levelHeight >> 1);
    }
    return {
        shape: { width, height },
        images,
        format: fourCc === 'DXT1' ? 'dxt1' : fourCc === 'DXT3' ? 'dxt3' : 'dxt5',
        flags: view.getUint32(8, true),
    };
}

function visibleBounds(image: ImageData): { minX: number; minY: number; maxX: number; maxY: number; luma: number; pixels: number } {
    let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
    let luma = 0, pixels = 0;
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const offset = (y * image.width + x) * 4;
            const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2];
            let alpha = image.data[offset + 3];
            if (alpha <= 8) alpha = Math.max(r, g, b);
            if (alpha <= 12) continue;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            luma += r * 0.2126 + g * 0.7152 + b * 0.0722;
            pixels++;
        }
    }
    return { minX, minY, maxX, maxY, luma: pixels ? luma / pixels : 0, pixels };
}


function textureSource(message: any): TextureSource {
    const buffer: ArrayBuffer = message.textureBytes instanceof ArrayBuffer
        ? message.textureBytes
        : base64ToBytes(message.blpBase64 || message.ddsBase64 || message.rgbaBase64 || '').buffer;
    if (message.textureExt === 'blp' || message.blpBase64) return { type: 'blp', buffer };
    if (message.textureExt === 'dds' || message.ddsBase64) {
        const info = parseDdsInfo(buffer);
        return { type: 'dds', buffer, info,
            format: info.format === 'dxt1' ? 0x83F0 : info.format === 'dxt3' ? 0x83F2 : 0x83F3 };
    }
    if (message.rgbaBase64 && message.width && message.height) {
        return { type: 'imageData', imageData: [new ImageData(new Uint8ClampedArray(buffer), message.width, message.height)] };
    }
    throw new Error('unsupported texture payload');
}

function requestTexture(job: Job, path: string): Promise<TextureSource> {
    const key = normalizeAssetPath(path);
    const cached = job.sources.get(key);
    if (cached) return cached;
    const source = new Promise<TextureSource>((resolve, reject) => {
        job.pending.set(key, { resolve, reject });
        job.requests.push(path);
        // loadTextures asks for all cache misses together; preserve one host batch per job.
        if (job.requests.length === 1) queueMicrotask(() => {
            if (activeJob !== job || job.controller.signal.aborted) return;
            post({ type: 'requestTextures', key: job.key, paths: job.requests.splice(0) });
        });
    });
    job.sources.set(key, source);
    return source;
}

function cancel(job: Job): void {
    job.controller.abort();
    job.pending.forEach(pending => pending.reject(new Error('thumbnail cancelled')));
    job.pending.clear();
    if (activeJob === job) activeJob = null;
}

async function beginJob(message: any): Promise<void> {
    if (activeJob) cancel(activeJob);
    const input = message.job;
    const job: Job = { key: input.key, controller: new AbortController(), pending: new Map(), sources: new Map(), requests: [], started: performance.now() };
    activeJob = job;
    try {
        const model = input.format === 'mdl'
            ? parseMDL(new TextDecoder().decode(input.buffer)) : parseMDX(input.buffer);
        profile(job, 'parsed', { modelBytes: input.buffer.byteLength, geosets: model.Geosets.length, textures: model.Textures.length });
        const options = {
            width: OUTPUT_SIZE, height: OUTPUT_SIZE, supersampling: 2,
            maxTextureSize: MAX_TEXTURE_DIMENSION,
            textureNamespace: input.textureNamespace || input.cacheKey || input.key,
            sequence: pickStandSequence(model), frameOffsetMs: 1, findVisibleFrame: true,
            warmupMs: model.ParticleEmitters2.length || model.RibbonEmitters.length ? 500 : 0,
            allowMissingTextures: true, useEnvironmentMap: false,
            signal: job.controller.signal,
            loadTexture: (texture: ParsedModel['Textures'][number]) => requestTexture(job, texture.Image),
        };
        const output = new OffscreenCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
        const context = output.getContext('2d')!;
        let result: Awaited<ReturnType<ThumbnailSession['render']>> | undefined;
        let bounds = visibleBounds(context.getImageData(0, 0, OUTPUT_SIZE, OUTPUT_SIZE));
        let sampledFrames = 0;
        // Geometry bounds cannot detect wholly transparent texels. Keep the consumer's pixel
        // validation and try other poses/sequences before declaring a valid model invisible.
        const sequences = [...new Set([options.sequence, ...model.Sequences.slice(0, 8).map((_, index) => index)])];
        capture: for (const sequence of sequences) {
            const interval = model.Sequences[sequence]?.Interval;
            const duration = interval ? interval[1] - interval[0] : 0;
            for (const frameOffsetMs of new Set([1, duration * 0.2, duration * 0.5, duration * 0.8])) {
                try {
                    result = await session.render(model, { ...options, sequence, frameOffsetMs });
                } catch (error) {
                    if (activeJob !== job) return;
                    if (error instanceof Error && error.message.startsWith('The selected pose has no visible geometry')) continue;
                    throw error;
                }
                if (activeJob !== job) return;
                const bitmap = await createImageBitmap(result.blob);
                context.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
                try { context.drawImage(bitmap, 0, 0); } finally { bitmap.close(); }
                bounds = visibleBounds(context.getImageData(0, 0, OUTPUT_SIZE, OUTPUT_SIZE));
                sampledFrames++;
                if (bounds.pixels >= 4) break capture;
            }
        }
        if (!result || bounds.pixels < 4) throw new Error(`empty-frame-after-${sampledFrames}-samples`);
        const blob = await output.convertToBlob({ type: 'image/webp', quality: 0.88 });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (activeJob !== job) return;
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const stats = session.getCacheStats();
        profile(job, 'rendered', { avgLuma: Math.round(bounds.luma), visiblePixels: bounds.pixels,
            frame: result.frame, sampledFrames, textureFailures: result.missingTextures.length,
            textureCacheEntries: stats.textures, textureCacheMb: Math.round(stats.estimatedBytes / 104857.6) / 10 });
        post({ type: 'rendered', key: job.key, cacheKey: input.cacheKey, aliasKey: input.aliasKey,
            webpBase64: btoa(binary), avgLuma: Math.round(bounds.luma), textureFailures: result.missingTextures.length });
        activeJob = null;
    } catch (error) {
        if (activeJob !== job) return;
        post({ type: 'failed', key: job.key, reason: error instanceof Error ? error.message : String(error) });
        cancel(job);
    }
}

scope.onmessage = (event: MessageEvent) => {
    const message: any = event.data || {};
    if (message.type === 'render') { void beginJob(message); return; }
    const job = activeJob;
    if (!job) return;
    if (message.type === 'cancel' && job.key === message.key) { cancel(job); return; }
    if (message.thumbKey !== job.key) return;
    if (message.type === 'texture') {
        const path = normalizeAssetPath(message.path || '');
        const pending = job.pending.get(path);
        if (!pending) return;
        job.pending.delete(path);
        try {
            if (message.missing || message.unsupported || message.error) throw new Error('texture unavailable');
            pending.resolve(textureSource(message));
        } catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
    } else if (message.type === 'texturesComplete') {
        // A terminal host batch also settles paths for which no individual reply arrived.
        job.pending.forEach(pending => pending.reject(new Error('texture unavailable')));
        job.pending.clear();
        profile(job, 'texture-batch-complete');
    }
};
post({ type: 'ready' });
