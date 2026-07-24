import { decodeBLP, getBLPImageData, ModelRenderer, parseMDL, parseMDX } from 'war3-model';

const scope: any = self;
const RENDER_SIZE = 128;
const OUTPUT_SIZE = 96;
const MAX_TEXTURE_DIMENSION = 128;
const MAX_TEXTURE_CACHE_ENTRIES = 256;
const MAX_TEXTURE_CACHE_BYTES = 32 * 1024 * 1024;

type ParsedModel = ReturnType<typeof parseMDX>;
type TextureEntry = {
    imageData: ImageData | null;
    texture?: WebGLTexture;
    bytes: number;
};

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let renderer: ModelRenderer | null = null;
let activeJob: any = null;
let activeStartedAt = 0;
let pendingTextures = new Set<string>();
let activeTextureKeys = new Set<string>();
let textureBatchComplete = false;
let textureFailures = 0;
const textureCache = new Map<string, TextureEntry>();
let textureCacheBytes = 0;

function now(): number {
    return performance.now();
}

function post(message: Record<string, unknown>, transfer?: Transferable[]): void {
    scope.postMessage(message, transfer || []);
}

function profile(phase: string, detail: Record<string, unknown> = {}): void {
    if (!activeJob) return;
    post({
        type: 'profile',
        key: activeJob.key,
        phase,
        elapsedMs: Math.round(now() - activeStartedAt),
        ...detail,
    });
}

function normalizePath(value: string): string {
    return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function ensureSequence(model: ParsedModel): void {
    if (model.Sequences.length) return;
    model.Sequences.push({
        Name: 'Static',
        Interval: new Uint32Array([0, 0]),
        NonLooping: true,
        MinimumExtent: model.Info.MinimumExtent,
        MaximumExtent: model.Info.MaximumExtent,
        BoundsRadius: model.Info.BoundsRadius,
        MoveSpeed: 0,
        Rarity: 0,
    });
}

function environmentTextureIds(model: ParsedModel): Set<number> {
    const ids = new Set<number>();
    for (const material of model.Materials) {
        if (model.Version >= 1100) {
            for (const layer of material.Layers) {
                if (layer.ShaderTypeId === 1 && typeof layer.ReflectionsTextureID === 'number') {
                    ids.add(layer.ReflectionsTextureID);
                }
            }
        } else if (model.Version >= 1000 && material.Shader === 'Shader_HD_DefaultUnit') {
            const id = material.Layers[5]?.TextureID;
            if (typeof id === 'number') ids.add(id);
        }
    }
    return ids;
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

function downscale(imageData: ImageData): ImageData {
    if (Math.max(imageData.width, imageData.height) <= MAX_TEXTURE_DIMENSION) return imageData;
    const scale = MAX_TEXTURE_DIMENSION / Math.max(imageData.width, imageData.height);
    const width = Math.max(1, Math.round(imageData.width * scale));
    const height = Math.max(1, Math.round(imageData.height * scale));
    const source = new OffscreenCanvas(imageData.width, imageData.height);
    source.getContext('2d')!.putImageData(imageData, 0, 0);
    const target = new OffscreenCanvas(width, height);
    const context = target.getContext('2d')!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
}

function base64Bytes(encoded: string): Uint8Array<ArrayBuffer> {
    const binary = atob(encoded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
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

function rememberTexture(path: string, imageData: ImageData | null): void {
    if (!renderer || !gl) return;
    const key = normalizePath(path);
    const texture = renderer.getTexture(path);
    const previous = textureCache.get(key);
    textureCacheBytes -= previous?.bytes || 0;
    textureCache.delete(key);
    const entry = { imageData, texture, bytes: imageData?.data.byteLength || 0 };
    textureCache.set(key, entry);
    textureCacheBytes += entry.bytes;
    trimTextureCache();
}

function trimTextureCache(): void {
    if (!gl) return;
    while (textureCache.size > MAX_TEXTURE_CACHE_ENTRIES || textureCacheBytes > MAX_TEXTURE_CACHE_BYTES) {
        const first = [...textureCache.keys()].find(key => !activeTextureKeys.has(key));
        if (!first) break;
        const removed = textureCache.get(first);
        if (removed?.texture) gl.deleteTexture(removed.texture);
        textureCacheBytes -= removed?.bytes || 0;
        textureCache.delete(first);
    }
}

function adoptCachedTexture(path: string): boolean {
    if (!renderer) return false;
    const key = normalizePath(path);
    const entry = textureCache.get(key);
    if (!entry) return false;
    textureCache.delete(key);
    textureCache.set(key, entry);
    if (entry.texture && renderer.adoptTexture(path, entry.texture)) return true;
    if (entry.imageData) {
        renderer.setTextureImageData(path, [entry.imageData]);
        entry.texture = renderer.getTexture(path);
        return true;
    }
    return false;
}

function applyBlpTexture(path: string, buffer: ArrayBuffer): boolean {
    if (!renderer) return false;
    const decoded = getBLPImageData(decodeBLP(buffer), 0);
    const rgba = new Uint8ClampedArray(new ArrayBuffer(decoded.data.byteLength));
    rgba.set(decoded.data);
    const image = downscale(new ImageData(rgba, decoded.width, decoded.height));
    renderer.setTextureImageData(path, [image]);
    rememberTexture(path, image);
    return true;
}

function applyDdsTexture(path: string, buffer: ArrayBuffer): boolean {
    if (!renderer || !gl) return false;
    const info = parseDdsInfo(buffer);
    const extension = gl.getExtension('WEBGL_compressed_texture_s3tc') ||
        gl.getExtension('MOZ_WEBGL_compressed_texture_s3tc') ||
        gl.getExtension('WEBKIT_WEBGL_compressed_texture_s3tc');
    if (!extension) return false;
    const format = info.format === 'dxt1'
        ? extension.COMPRESSED_RGB_S3TC_DXT1_EXT
        : info.format === 'dxt3'
            ? extension.COMPRESSED_RGBA_S3TC_DXT3_EXT
            : extension.COMPRESSED_RGBA_S3TC_DXT5_EXT;
    renderer.setTextureCompressedImage(path, format, buffer, info);
    rememberTexture(path, null);
    return true;
}

async function applyTexture(message: any, expectedJobKey: string): Promise<boolean> {
    if (!renderer || !gl || activeJob?.key !== expectedJobKey) return false;
    try {
        if (message.textureBytes) {
            const buffer = message.textureBytes instanceof ArrayBuffer
                ? message.textureBytes
                : message.textureBytes.buffer;
            if (message.textureExt === 'blp') return applyBlpTexture(message.path, buffer);
            if (message.textureExt === 'dds') return applyDdsTexture(message.path, buffer);
            return false;
        }
        if (message.blpBase64) {
            const bytes = base64Bytes(message.blpBase64);
            return applyBlpTexture(message.path, bytes.buffer);
        }
        if (message.rgbaBase64 && message.width && message.height) {
            const bytes = base64Bytes(message.rgbaBase64);
            const image = downscale(new ImageData(new Uint8ClampedArray(bytes.buffer), message.width, message.height));
            renderer.setTextureImageData(message.path, [image]);
            rememberTexture(message.path, image);
            return true;
        }
        if (message.ddsBase64) {
            const bytes = base64Bytes(message.ddsBase64);
            return applyDdsTexture(message.path, bytes.buffer);
        }
    } catch (error) {
        profile('texture-error', { path: message.path, error: error instanceof Error ? error.message : String(error) });
    }
    return false;
}

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, (2 * far * near) * nf, 0,
    ]);
}

function lookAt(ex: number, ey: number, ez: number, tx: number, ty: number, tz: number): Float32Array {
    let z0 = ex - tx, z1 = ey - ty, z2 = ez - tz;
    let length = Math.hypot(z0, z1, z2) || 1;
    z0 /= length; z1 /= length; z2 /= length;
    let x0 = -z1, x1 = z0, x2 = 0;
    length = Math.hypot(x0, x1, x2) || 1;
    x0 /= length; x1 /= length; x2 /= length;
    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;
    return new Float32Array([
        x0, y0, z0, 0,
        x1, y1, z1, 0,
        x2, y2, z2, 0,
        -(x0 * ex + x1 * ey + x2 * ez),
        -(y0 * ex + y1 * ey + y2 * ez),
        -(z0 * ex + z1 * ey + z2 * ez),
        1,
    ]);
}

function cameraQuaternion(forwardX: number, forwardY: number, forwardZ: number): Float32Array {
    const x0 = -forwardX, x1 = -forwardY, x2 = -forwardZ;
    let y0 = forwardY, y1 = -forwardX, y2 = 0;
    const length = Math.hypot(y0, y1, y2) || 1;
    y0 /= length; y1 /= length; y2 /= length;
    const m00 = x0, m01 = y0, m02 = 0;
    const m10 = x1, m11 = y1, m12 = 0;
    const m20 = x2, m21 = y2, m22 = 1;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return new Float32Array([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
    }
    return new Float32Array([0, 0, 0, 1]);
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

async function renderThumbnail(): Promise<void> {
    if (!activeJob || !renderer || !gl || !canvas) return;
    const job = activeJob;
    const width = canvas.width;
    const height = canvas.height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const model = job.model as ParsedModel;
    const min = model.Info.MinimumExtent;
    const max = model.Info.MaximumExtent;
    const centerX = min[0] <= 0 && max[0] >= 0 ? 0 : (min[0] + max[0]) / 2;
    const centerY = min[1] <= 0 && max[1] >= 0 ? 0 : (min[1] + max[1]) / 2;
    const centerZ = min[2] + (max[2] - min[2]) * 0.64;
    const radius = model.Info.BoundsRadius > 0
        ? model.Info.BoundsRadius
        : Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 100;
    const distance = Math.max(1, radius * 2.65);
    const pitch = 0.85;
    const ex = centerX + distance * Math.cos(pitch);
    const ey = centerY;
    const ez = centerZ + distance * Math.sin(pitch);
    const forwardLength = Math.hypot(centerX - ex, centerY - ey, centerZ - ez) || 1;
    const forwardX = (centerX - ex) / forwardLength;
    const forwardY = (centerY - ey) / forwardLength;
    const forwardZ = (centerZ - ez) / forwardLength;
    renderer.setCamera(
        new Float32Array([ex, ey, ez]) as any,
        cameraQuaternion(forwardX, forwardY, forwardZ) as any,
    );
    // Studio/front lighting is the appropriate no-environment fallback for an asset thumbnail.
    renderer.setLightPosition(new Float32Array([ex, ey, ez]) as any);
    renderer.setLightColor(new Float32Array([1.8, 1.8, 1.8]) as any);
    const view = lookAt(ex, ey, ez, centerX, centerY, centerZ);
    const projection = perspective(50 * Math.PI / 180, 1, 1, 100000);
    const primarySequence = pickStandSequence(model);
    const sequenceOrder = [
        primarySequence,
        ...model.Sequences.map((_, index) => index).filter(index => index !== primarySequence),
    ];
    const candidates: Array<{ sequence: number; frame: number }> = [];
    const seenCandidates = new Set<string>();
    const addCandidate = (sequence: number, fraction: number) => {
        const interval = model.Sequences[sequence]?.Interval;
        if (!interval) return;
        const frameNumber = Math.round(interval[0] + Math.max(0, interval[1] - interval[0]) * fraction);
        const key = `${sequence}:${frameNumber}`;
        if (seenCandidates.has(key)) return;
        seenCandidates.add(key);
        candidates.push({ sequence, frame: frameNumber });
    };
    // Visibility tracks can hide every geoset at one otherwise valid Stand frame. Probe other
    // deterministic frozen frames before deciding that a successfully loaded model is unrenderable.
    for (const fraction of [0.2, 0, 0.5, 0.8]) addCandidate(primarySequence, fraction);
    for (const sequence of sequenceOrder.slice(1, 9)) {
        addCandidate(sequence, 0);
        addCandidate(sequence, 0.5);
    }

    let frame: ImageData | undefined;
    let bounds: ReturnType<typeof visibleBounds> | undefined;
    let sampledFrames = 0;
    for (const candidate of candidates) {
        renderer.setSequence(candidate.sequence);
        renderer.setFrame(candidate.frame);
        renderer.update(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        renderer.render(
            view as any,
            projection as any,
            { wireframe: false, useEnvironmentMap: false },
        );
        gl.finish();

        const raw = new Uint8ClampedArray(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const flipped = new Uint8ClampedArray(raw.length);
        const row = width * 4;
        for (let y = 0; y < height; y++) {
            flipped.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
        }
        frame = new ImageData(flipped, width, height);
        bounds = visibleBounds(frame);
        sampledFrames++;
        if (bounds.pixels >= 4) break;
    }
    if (!frame || !bounds || bounds.pixels < 4) throw new Error(`empty-frame-after-${sampledFrames}-samples`);
    const padding = Math.ceil(Math.max(bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1) * 0.16);
    const minX = Math.max(0, bounds.minX - padding);
    const minY = Math.max(0, bounds.minY - padding);
    const maxX = Math.min(width - 1, bounds.maxX + padding);
    const maxY = Math.min(height - 1, bounds.maxY + padding);
    const cropWidth = maxX - minX + 1;
    const cropHeight = maxY - minY + 1;
    const source = new OffscreenCanvas(width, height);
    source.getContext('2d')!.putImageData(frame, 0, 0);
    const output = new OffscreenCanvas(OUTPUT_SIZE, OUTPUT_SIZE);
    const outputContext = output.getContext('2d')!;
    outputContext.imageSmoothingEnabled = true;
    outputContext.imageSmoothingQuality = 'high';
    const scale = Math.min(OUTPUT_SIZE / cropWidth, OUTPUT_SIZE / cropHeight);
    const drawWidth = Math.max(1, Math.round(cropWidth * scale));
    const drawHeight = Math.max(1, Math.round(cropHeight * scale));
    outputContext.drawImage(
        source,
        minX, minY, cropWidth, cropHeight,
        Math.round((OUTPUT_SIZE - drawWidth) / 2),
        Math.round((OUTPUT_SIZE - drawHeight) / 2),
        drawWidth, drawHeight,
    );
    const blob = await output.convertToBlob({ type: 'image/webp', quality: 0.88 });
    const webp = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < webp.length; offset += 0x8000) {
        binary += String.fromCharCode(...webp.subarray(offset, offset + 0x8000));
    }
    profile('rendered', {
        avgLuma: Math.round(bounds.luma),
        visiblePixels: bounds.pixels,
        sampledFrames,
        webpBytes: webp.byteLength,
        textureFailures,
        textureCacheEntries: textureCache.size,
        textureCacheMb: Math.round(textureCacheBytes / 104857.6) / 10,
    });
    post({
        type: 'rendered',
        key: job.key,
        cacheKey: job.cacheKey,
        aliasKey: job.aliasKey,
        webpBase64: btoa(binary),
        avgLuma: Math.round(bounds.luma),
        textureFailures,
    });
    activeJob = null;
    activeTextureKeys.clear();
    trimTextureCache();
}

function maybeRender(): void {
    if (!activeJob || !textureBatchComplete || pendingTextures.size) return;
    textureBatchComplete = false;
    profile('textures-ready', { failures: textureFailures });
    void renderThumbnail().catch((error) => {
        const job = activeJob;
        if (!job) return;
        post({ type: 'failed', key: job.key, reason: error instanceof Error ? error.message : String(error) });
        activeJob = null;
        activeTextureKeys.clear();
        trimTextureCache();
    });
}

function beginJob(message: any): void {
    activeStartedAt = now();
    activeJob = message.job;
    pendingTextures = new Set();
    textureBatchComplete = false;
    textureFailures = 0;
    const parseStartedAt = now();
    const model = activeJob.format === 'mdl'
        ? parseMDL(new TextDecoder().decode(activeJob.buffer))
        : parseMDX(activeJob.buffer);
    ensureSequence(model);
    activeJob.model = model;
    profile('parsed', {
        ms: Math.round(now() - parseStartedAt),
        modelBytes: activeJob.buffer.byteLength,
        version: model.Version,
        isHD: model.Geosets.some(geoset => !!geoset.SkinWeights?.length),
        geosets: model.Geosets.length,
        textures: model.Textures.length,
    });

    if (!canvas) canvas = new OffscreenCanvas(RENDER_SIZE, RENDER_SIZE);
    if (!gl) gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true }) as WebGL2RenderingContext;
    if (!gl) throw new Error('worker-webgl2-unavailable');
    if (renderer) renderer.destroy();
    const initStartedAt = now();
    renderer = new ModelRenderer(model);
    renderer.setEnvironmentMapProcessingEnabled(false);
    renderer.initGL(gl);
    const sequenceIndex = pickStandSequence(model);
    renderer.setSequence(sequenceIndex);
    const sequence = model.Sequences[sequenceIndex];
    renderer.setFrame(Math.round(sequence.Interval[0] + Math.max(0, sequence.Interval[1] - sequence.Interval[0]) * 0.2));
    renderer.update(0);

    const environmentIds = environmentTextureIds(model);
    const paths: string[] = [];
    let reused = 0;
    const renderPaths = model.Textures.flatMap((texture, index) =>
        texture.ReplaceableId || !texture.Image || environmentIds.has(index) ? [] : [texture.Image]
    );
    activeTextureKeys = new Set(renderPaths.map(normalizePath));
    renderPaths.forEach(path => {
        if (adoptCachedTexture(path)) reused++;
        else paths.push(path);
    });
    const uniquePaths = [...new Set(paths)];
    pendingTextures = new Set(uniquePaths);
    profile('renderer-ready', {
        ms: Math.round(now() - initStartedAt),
        requested: uniquePaths.length,
        reused,
        skippedEnvironment: environmentIds.size,
    });
    if (uniquePaths.length) {
        post({ type: 'requestTextures', key: activeJob.key, paths: uniquePaths });
    } else {
        textureBatchComplete = true;
        maybeRender();
    }
}

scope.onmessage = (event: MessageEvent) => {
    const message: any = event.data || {};
    try {
        if (message.type === 'render') {
            beginJob(message);
        } else if (message.type === 'texture') {
            if (!activeJob || message.thumbKey !== activeJob.key || !pendingTextures.has(message.path)) return;
            const jobKey = activeJob.key;
            if (message.missing || message.unsupported || message.error) {
                textureFailures++;
                pendingTextures.delete(message.path);
                maybeRender();
                return;
            }
            void applyTexture(message, jobKey).then((loaded) => {
                if (!activeJob || activeJob.key !== jobKey || !pendingTextures.has(message.path)) return;
                if (!loaded) textureFailures++;
                pendingTextures.delete(message.path);
                maybeRender();
            }).catch((error) => {
                if (!activeJob || activeJob.key !== jobKey || !pendingTextures.has(message.path)) return;
                textureFailures++;
                pendingTextures.delete(message.path);
                profile('texture-error', { path: message.path, error: error instanceof Error ? error.message : String(error) });
                maybeRender();
            });
        } else if (message.type === 'texturesComplete') {
            if (!activeJob || message.thumbKey !== activeJob.key) return;
            textureBatchComplete = true;
            profile('texture-batch-complete', { inFlight: pendingTextures.size, failures: textureFailures });
            maybeRender();
        } else if (message.type === 'cancel' && activeJob?.key === message.key) {
            activeJob = null;
            pendingTextures.clear();
            activeTextureKeys.clear();
            trimTextureCache();
        }
    } catch (error) {
        const key = activeJob?.key || message.job?.key || message.key || '';
        post({ type: 'failed', key, reason: error instanceof Error ? error.message : String(error) });
        activeJob = null;
        pendingTextures.clear();
        activeTextureKeys.clear();
        trimTextureCache();
    }
};

post({ type: 'ready' });
