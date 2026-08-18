'use strict';

/**
 * Node-side pieces of the MDX model-thumbnail benchmark: locating model fixtures, indexing the
 * textures they reference, and the snapshot baseline.
 *
 * The in-page half (`runModelBench`) is a plain function so Playwright can hand it straight to
 * `page.evaluate` — the previous harness had to stringify it into a CDP `Runtime.evaluate`
 * expression, which is why it was wrapped in template-literal escaping.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { root } = require('./tsLoader');

const SNAPSHOT_FILE = process.env.WURST_MODEL_SNAPSHOT_FILE ||
    path.join(os.tmpdir(), 'wurst-model-thumbnail.snapshots.json');

function splitEnvPaths(value) {
    return String(value || '').split(';').map((part) => part.trim()).filter(Boolean);
}

/** Self-contained fixture shipped with war3-model; broader stock-game models come from env. */
function defaultModelPaths() {
    const base = path.join(root, 'node_modules', 'war3-model');
    return ['BrutalLord.MDX'].map((name) => path.join(base, name)).filter((file) => fs.existsSync(file));
}

function normalizeAsset(value) {
    return String(value || '').replace(/\0/g, '').replace(/\//g, '\\').toLowerCase();
}

function addTexture(textureMap, key, payload) {
    if (!key) return;
    const normalized = normalizeAsset(key);
    if (!textureMap[normalized]) textureMap[normalized] = payload;
    const base = path.basename(normalized);
    if (base && !textureMap[base]) textureMap[base] = payload;
}

/** Indexes textures under a root, bounded by count/dir/depth/time budgets so a huge game
 *  directory can be pointed at without the scan becoming the slowest part of the run. */
function walkTextures(rootDir, textureMap, budget, depth = 0) {
    if (budget.count <= 0 || budget.dirs <= 0 || Date.now() > budget.deadline || depth > budget.maxDepth) return;
    budget.dirs--;
    let entries;
    try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (budget.count <= 0 || budget.dirs <= 0 || Date.now() > budget.deadline) return;
        const full = path.join(rootDir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || ['node_modules', 'dist', 'out', '.git'].includes(entry.name.toLowerCase())) continue;
            walkTextures(full, textureMap, budget, depth + 1);
            continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.blp', '.dds', '.tga'].includes(ext)) continue;
        budget.count--;
        const payload = { kind: ext.slice(1), base64: fs.readFileSync(full).toString('base64') };
        addTexture(textureMap, entry.name, payload);
        addTexture(textureMap, path.relative(rootDir, full), payload);
        addTexture(textureMap, full, payload);
    }
}

function resolveModelPaths() {
    const fromEnv = splitEnvPaths(process.env.WURST_MODEL_BENCH_MODELS);
    return (fromEnv.length ? fromEnv : defaultModelPaths()).map((file) => path.resolve(file));
}

function buildFixtures(modelPaths) {
    const textureMap = {};
    const textureRoots = new Set([
        path.join(root, 'node_modules', 'war3-model'),
        ...modelPaths.map((file) => path.dirname(file)),
        ...splitEnvPaths(process.env.WURST_MODEL_TEXTURE_ROOTS),
    ]);
    const budget = {
        count: Number(process.env.WURST_MODEL_TEXTURE_BUDGET || 4000),
        dirs: Number(process.env.WURST_MODEL_TEXTURE_DIR_BUDGET || 1500),
        maxDepth: Number(process.env.WURST_MODEL_TEXTURE_MAX_DEPTH || 8),
        deadline: Date.now() + Number(process.env.WURST_MODEL_TEXTURE_SCAN_MS || 5000),
    };
    for (const textureRoot of textureRoots) walkTextures(textureRoot, textureMap, budget);

    return modelPaths.map((file) => ({
        name: path.basename(file),
        fileName: path.basename(file),
        format: path.extname(file).toLowerCase() === '.mdl' ? 'mdl' : 'mdx',
        modelBase64: fs.readFileSync(file).toString('base64'),
        textures: textureMap,
    }));
}

/** The page the viewer bundle is loaded into — a 96x96 canvas, matching the real thumbnail size. */
const BENCH_PAGE_HTML = `<title>model thumbnail bench</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#ddd;font-family:sans-serif}
#viewport{width:96px;height:96px;position:relative}
#canvas{width:96px;height:96px;display:block}
#gizmo{width:1px;height:1px;position:absolute;left:-100px;top:-100px}
</style>
<div id="viewport"><canvas id="canvas"></canvas><canvas id="gizmo" width="1" height="1"></canvas></div>
<script src="/dist/webview/mdxViewer.js"></script>`;

/**
 * Runs in the browser: loads each model into one warm War3Viewer, feeds it the textures it asks
 * for, renders a deterministic still frame, and reports pixel metrics plus timings.
 * The first fixture is run twice; the first pass is flagged as warm-up and excluded from assertions.
 */
async function runModelBench({ fixtures, timeoutMs }) {
    const b64ToArrayBuffer = (b64) => {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.buffer;
    };
    const normalize = (value) => String(value || '').replace(/\0/g, '').replace(/\//g, '\\').toLowerCase();
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    const metricsForImage = (imageData) => {
        const px = imageData.data;
        let alphaPixels = 0;
        let visiblePixels = 0;
        let lumaSum = 0;
        let maxLuma = 0;
        let h1 = 0x811c9dc5;
        let h2 = 0x27d4eb2d;
        for (let i = 0; i < px.length; i += 4) {
            const a = px[i + 3];
            const rgbVisible = px[i] + px[i + 1] + px[i + 2] > 24;
            if (a > 12) alphaPixels++;
            if (a > 12 || rgbVisible) {
                const luma = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
                visiblePixels++;
                lumaSum += luma;
                if (luma > maxLuma) maxLuma = luma;
            }
            h1 = Math.imul(h1 ^ px[i], 0x01000193) >>> 0;
            h1 = Math.imul(h1 ^ px[i + 1], 0x01000193) >>> 0;
            h1 = Math.imul(h1 ^ px[i + 2], 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ a, 0x85ebca6b) >>> 0;
        }
        return {
            alphaPixels,
            visiblePixels,
            avgLuma: visiblePixels ? lumaSum / visiblePixels : 0,
            maxLuma,
            hash: `${imageData.width}x${imageData.height}-${h1.toString(16).padStart(8, '0')}-${h2.toString(16).padStart(8, '0')}`,
        };
    };

    const canvas = document.getElementById('canvas');
    const gizmo = document.getElementById('gizmo');
    const viewport = document.getElementById('viewport');
    canvas.width = 96;
    canvas.height = 96;
    const messages = [];
    let loadedResolve = null;
    let errors = [];
    window.War3Viewer.init({
        canvas3d: canvas,
        gizmo,
        viewport,
        vscodeApi: { postMessage(message) { messages.push(message); } },
        callbacks: {
            onModelLoaded(info) { if (loadedResolve) loadedResolve(info); },
            onFrameUpdate() {},
            onDebug() {},
            onError(message) { errors.push(message); },
        },
    });

    async function withTimeout(label, promise, ms) {
        let timer = 0;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
                }),
            ]);
        } finally {
            if (timer) window.clearTimeout(timer);
        }
    }

    async function runOne(fixture, warmup) {
        messages.length = 0;
        errors = [];
        const t0 = performance.now();
        let loadedReject = null;
        let waitingForLoad = true;
        const loaded = new Promise((resolve, reject) => { loadedResolve = resolve; loadedReject = reject; });
        try {
            window.War3Viewer.loadModel(b64ToArrayBuffer(fixture.modelBase64), fixture.fileName, fixture.format, { autoplay: false });
        } catch (err) {
            loadedReject(err);
        }
        let info;
        try {
            info = await withTimeout(`${fixture.name} loadModel`, new Promise((resolve, reject) => {
                loaded.then(resolve, reject);
                const check = () => {
                    if (!waitingForLoad) return;
                    if (errors.length) reject(new Error(`${fixture.name}: ${errors.join('; ')}`));
                    else requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
            }), timeoutMs);
        } finally {
            waitingForLoad = false;
            loadedResolve = null;
        }
        const tLoaded = performance.now();
        if (errors.length) throw new Error(`${fixture.name}: ${errors.join('; ')}`);

        const requests = messages.filter((message) => message && message.type === 'requestTextures');
        const loadedTextures = [];
        const missingTextures = [];
        for (const request of requests) {
            for (const texPath of request.paths || []) {
                const key = normalize(texPath);
                const base = key.split('\\').pop();
                const payload = fixture.textures[key] || fixture.textures[base];
                if (!payload) {
                    missingTextures.push(texPath);
                    window.War3Viewer.onTexture(texPath, null);
                } else if (payload.kind === 'dds') {
                    loadedTextures.push(texPath);
                    window.War3Viewer.onTextureDds(texPath, b64ToArrayBuffer(payload.base64));
                } else {
                    loadedTextures.push(texPath);
                    window.War3Viewer.onTexture(texPath, b64ToArrayBuffer(payload.base64));
                }
            }
        }
        const tTextures = performance.now();

        // A fixed frame ~20% into the Stand animation keeps the snapshot hash deterministic.
        const standIndex = Math.max(0, info.sequences.findIndex((seq) => /stand/i.test(seq.name || '')));
        if (info.sequences.length) {
            const seq = info.sequences[standIndex] || info.sequences[0];
            window.War3Viewer.setSequence(standIndex);
            window.War3Viewer.setFrame(Math.round(seq.start + Math.max(0, seq.end - seq.start) * 0.2));
        }
        window.War3Viewer.resetCamera();
        window.War3Viewer.zoomOut();
        window.War3Viewer.zoomOut();
        window.War3Viewer.setAutoplay(false);
        await nextFrame();
        await nextFrame();
        window.War3Viewer.renderStillFrame();
        const metrics = metricsForImage(window.War3Viewer.readPixelsImageData());
        const tDone = performance.now();
        return {
            name: fixture.name,
            warmup,
            geosets: info.geosetCount,
            textures: info.textureCount,
            requestedTextures: requests.reduce((sum, request) => sum + ((request.paths || []).length), 0),
            loadedTextures: loadedTextures.length,
            missingTextures,
            loadMs: tLoaded - t0,
            textureMs: tTextures - tLoaded,
            renderMs: tDone - tTextures,
            totalMs: tDone - t0,
            alphaPixels: metrics.alphaPixels,
            visiblePixels: metrics.visiblePixels,
            avgLuma: metrics.avgLuma,
            maxLuma: metrics.maxLuma,
            snapshotHash: metrics.hash,
            webpBytes: Math.round((canvas.toDataURL('image/webp', 0.58).length - 'data:image/webp;base64,'.length) * 0.75),
        };
    }

    const results = [];
    if (fixtures.length) results.push(await runOne(fixtures[0], true));
    for (const fixture of fixtures) results.push(await runOne(fixture, false));
    return results;
}

function readSnapshots() {
    try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { return {}; }
}

function writeSnapshots(results) {
    const snapshots = {};
    for (const result of results.filter((entry) => !entry.warmup)) {
        snapshots[result.name] = {
            snapshotHash: result.snapshotHash,
            alphaPixels: result.alphaPixels,
            visiblePixels: result.visiblePixels,
            avgLuma: Number(result.avgLuma.toFixed(2)),
            maxLuma: Number(result.maxLuma.toFixed(2)),
        };
    }
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshots, null, 2)}\n`);
}

module.exports = {
    BENCH_PAGE_HTML,
    SNAPSHOT_FILE,
    buildFixtures,
    resolveModelPaths,
    runModelBench,
    readSnapshots,
    writeSnapshots,
};
