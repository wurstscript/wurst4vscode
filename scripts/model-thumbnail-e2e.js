'use strict';

/**
 * Local-only thumbnail benchmark/e2e harness.
 *
 * This launches a real Chromium/Edge instance, loads dist/webview/mdxViewer.js,
 * reuses one warm War3Viewer instance, renders deterministic still thumbnails,
 * and checks blankness, darkness, optional snapshots, and logs per-thumbnail latency.
 *
 * Enable explicitly:
 *   $env:WURST_MODEL_E2E='1'; npm run test:e2e:models:local
 *
 * Useful knobs:
 *   WURST_MODEL_BENCH_MODELS      semicolon-separated .mdx/.mdl paths
 *   WURST_MODEL_TEXTURE_ROOTS     semicolon-separated texture roots
 *   WURST_MODEL_SNAPSHOT_FILE     default %TEMP%/wurst-model-thumbnail.snapshots.json
 *   WURST_MODEL_UPDATE_SNAPSHOTS  set to 1 to write/update snapshots
 *   CHROME_PATH                   explicit browser executable
 */

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enabled = process.env.WURST_MODEL_E2E === '1' || process.env.WURST_LOCAL_E2E === '1';

if (!enabled) {
    console.log('local model thumbnail e2e skipped (set WURST_MODEL_E2E=1 to enable)');
    process.exit(0);
}

if (typeof WebSocket !== 'function') {
    throw new Error('This harness needs Node with global WebSocket support (Node 22+ here is fine).');
}

const perModelTimeoutMs = Number(process.env.WURST_MODEL_E2E_MODEL_TIMEOUT_MS || 15000);
const browserEvalTimeoutMs = Number(process.env.WURST_MODEL_E2E_BROWSER_TIMEOUT_MS || Math.max(30000, perModelTimeoutMs * 2));
const snapshotFile = process.env.WURST_MODEL_SNAPSHOT_FILE ||
    path.join(os.tmpdir(), 'wurst-model-thumbnail.snapshots.json');
const updateSnapshots = process.env.WURST_MODEL_UPDATE_SNAPSHOTS === '1';

function benchLog(message) {
    console.log(`[model-e2e] ${message}`);
}

function splitEnvPaths(value) {
    return String(value || '').split(';').map((part) => part.trim()).filter(Boolean);
}

function defaultModelPaths() {
    const base = path.join(root, 'node_modules', 'war3-model');
    return [
        // Self-contained custom fixture: model + main custom BLP live together.
        // Broader stock-game fixtures can be supplied via WURST_MODEL_BENCH_MODELS
        // once WURST_MODEL_TEXTURE_ROOTS points at extracted/CASC-cached game data.
        'BrutalLord.MDX',
    ].map((name) => path.join(base, name)).filter((file) => fs.existsSync(file));
}

function normalizeAsset(value) {
    return String(value || '').replace(/\0/g, '').replace(/\//g, '\\').toLowerCase();
}

function browserCandidates() {
    const env = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [];
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
        return [
            ...env,
            path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ...programFiles.flatMap((dir) => [
                path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ]),
        ];
    }
    if (process.platform === 'darwin') {
        return [
            ...env,
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
    }
    return [...env, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
}

function findBrowser() {
    for (const candidate of browserCandidates()) {
        if (!candidate) continue;
        if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
        return candidate;
    }
    throw new Error('No Chromium/Edge executable found. Set CHROME_PATH.');
}

function readFileBase64(filePath) {
    return fs.readFileSync(filePath).toString('base64');
}

function addTexture(textureMap, key, payload) {
    if (!key) return;
    const normalized = normalizeAsset(key);
    if (!textureMap[normalized]) textureMap[normalized] = payload;
    const base = path.basename(normalized);
    if (base && !textureMap[base]) textureMap[base] = payload;
}

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
        const payload = { kind: ext.slice(1), base64: readFileBase64(full) };
        addTexture(textureMap, entry.name, payload);
        addTexture(textureMap, path.relative(rootDir, full), payload);
        addTexture(textureMap, full, payload);
    }
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
        modelBase64: readFileBase64(file),
        textures: textureMap,
    }));
}

function startStaticServer() {
    const server = http.createServer((req, res) => {
        const rawUrl = new URL(req.url || '/', 'http://127.0.0.1');
        if (rawUrl.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>model thumb e2e</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#ddd;font-family:sans-serif}
#viewport{width:96px;height:96px;position:relative}
#canvas{width:96px;height:96px;display:block}
#gizmo{width:1px;height:1px;position:absolute;left:-100px;top:-100px}
</style></head>
<body>
<div id="viewport"><canvas id="canvas"></canvas><canvas id="gizmo" width="1" height="1"></canvas></div>
<script src="/dist/webview/mdxViewer.js"></script>
</body></html>`);
            return;
        }
        const filePath = path.resolve(root, rawUrl.pathname.replace(/^\/+/, '').replace(/\//g, path.sep));
        if (!filePath.startsWith(root) || !fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': filePath.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

async function waitForDevtoolsPort(userDataDir) {
    const file = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        try {
            const [port] = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            if (port) return Number(port);
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error('Timed out waiting for browser DevToolsActivePort.');
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.nextId = 1;
        this.pending = new Map();
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (!msg.id) return;
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else pending.resolve(msg.result);
        };
        await new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    close() {
        try { this.ws.close(); } catch {}
    }
}

async function waitForExpression(client, expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await client.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
        });
        if (result.result?.value) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${expression}`);
}

function browserBenchExpression(fixtures) {
    return `(${async function runModelBench(fixturesArg, timeoutMsArg) {
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
                hash: imageData.width + 'x' + imageData.height + '-' + h1.toString(16).padStart(8, '0') + '-' + h2.toString(16).padStart(8, '0'),
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

        async function withTimeout(label, promise, timeoutMs) {
            let timer = 0;
            try {
                return await Promise.race([
                    promise,
                    new Promise((_, reject) => {
                        timer = window.setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
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
            const loaded = new Promise((resolve, reject) => {
                loadedResolve = resolve;
                loadedReject = reject;
            });
            try {
                window.War3Viewer.loadModel(b64ToArrayBuffer(fixture.modelBase64), fixture.fileName, fixture.format, { autoplay: false });
            } catch (err) {
                loadedReject(err);
            }
            let info;
            try {
                info = await withTimeout(
                    fixture.name + ' loadModel',
                    new Promise((resolve, reject) => {
                        loaded.then(resolve, reject);
                        const check = () => {
                            if (!waitingForLoad) return;
                            if (errors.length) reject(new Error(fixture.name + ': ' + errors.join('; ')));
                            else requestAnimationFrame(check);
                        };
                        requestAnimationFrame(check);
                    }),
                    timeoutMsArg
                );
            } finally {
                waitingForLoad = false;
                loadedResolve = null;
            }
            const tLoaded = performance.now();
            if (errors.length) throw new Error(fixture.name + ': ' + errors.join('; '));

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
            const imageData = window.War3Viewer.readPixelsImageData();
            const metrics = metricsForImage(imageData);
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
        if (fixturesArg.length) {
            results.push(await runOne(fixturesArg[0], true));
        }
        for (const fixture of fixturesArg) {
            results.push(await runOne(fixture, false));
        }
        return results;
    }})(${JSON.stringify(fixtures)}, ${JSON.stringify(perModelTimeoutMs)})`;
}

function readSnapshots() {
    try { return JSON.parse(fs.readFileSync(snapshotFile, 'utf8')); } catch { return {}; }
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
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2) + '\n');
}

async function main() {
    const modelPaths = splitEnvPaths(process.env.WURST_MODEL_BENCH_MODELS);
    const models = (modelPaths.length ? modelPaths : defaultModelPaths()).map((file) => path.resolve(file));
    assert.ok(models.length, 'No model fixtures found. Set WURST_MODEL_BENCH_MODELS.');
    assert.ok(fs.existsSync(path.join(root, 'dist', 'webview', 'mdxViewer.js')), 'Missing dist/webview/mdxViewer.js. Run npm run package-web first.');

    benchLog(`fixtures=${models.length} textureScanMs=${process.env.WURST_MODEL_TEXTURE_SCAN_MS || 5000}`);
    const fixtures = buildFixtures(models);
    benchLog(`textures indexed=${Object.keys(fixtures[0]?.textures || {}).length}`);
    const server = await startStaticServer();
    const serverPort = server.address().port;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-model-e2e-'));
    benchLog(`browser=${findBrowser()}`);
    const browser = childProcess.spawn(findBrowser(), [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--enable-webgl',
        '--remote-debugging-port=0',
        `--user-data-dir=${userDataDir}`,
        `http://127.0.0.1:${serverPort}/`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let client;
    try {
        const devtoolsPort = await waitForDevtoolsPort(userDataDir);
        const pages = await requestJson(`http://127.0.0.1:${devtoolsPort}/json/list`);
        const page = pages.find((entry) => entry.type === 'page') || pages[0];
        if (!page?.webSocketDebuggerUrl) throw new Error('No page websocket from browser.');
        client = new CdpClient(page.webSocketDebuggerUrl);
        await client.connect();
        await client.send('Runtime.enable');
        await waitForExpression(client, '!!window.War3Viewer');
        benchLog(`browser bench start timeout=${browserEvalTimeoutMs}ms`);
        const evalResult = await client.send('Runtime.evaluate', {
            expression: browserBenchExpression(fixtures),
            awaitPromise: true,
            returnByValue: true,
            timeout: browserEvalTimeoutMs,
        });
        if (evalResult.exceptionDetails) {
            throw new Error(evalResult.exceptionDetails.text || 'browser benchmark failed');
        }
        const results = evalResult.result.value;
        if (updateSnapshots) writeSnapshots(results);
        const snapshots = readSnapshots();
        const failures = [];
        for (const result of results.filter((entry) => !entry.warmup)) {
            if (result.visiblePixels < 24) failures.push(`${result.name}: blank render (${result.visiblePixels} visible pixels, ${result.alphaPixels} alpha pixels)`);
            if (result.avgLuma < 3 && result.maxLuma < 16) failures.push(`${result.name}: too dark avg=${result.avgLuma.toFixed(1)} max=${result.maxLuma.toFixed(1)}`);
            const snapshot = snapshots[result.name];
            if (snapshot && snapshot.snapshotHash !== result.snapshotHash) {
                failures.push(`${result.name}: snapshot changed ${snapshot.snapshotHash} -> ${result.snapshotHash}`);
            }
        }
        for (const result of results) {
            const tag = result.warmup ? 'warmup' : 'bench ';
            console.log(`${tag} ${result.name}: total=${result.totalMs.toFixed(1)}ms load=${result.loadMs.toFixed(1)}ms textures=${result.textureMs.toFixed(1)}ms render=${result.renderMs.toFixed(1)}ms visible=${result.visiblePixels} alpha=${result.alphaPixels} geosets=${result.geosets} tex=${result.loadedTextures}/${result.requestedTextures} hash=${result.snapshotHash}${result.missingTextures.length ? ` missing=${result.missingTextures.join(',')}` : ''}`);
        }
        if (!Object.keys(snapshots).length && !updateSnapshots) {
            console.log(`no snapshot baseline at ${snapshotFile}; set WURST_MODEL_UPDATE_SNAPSHOTS=1 to create one`);
        }
        assert.equal(failures.length, 0, failures.join('\n'));
        const maxObserved = Math.max(...results.filter((entry) => !entry.warmup).map((entry) => entry.totalMs));
        console.log(`local model thumbnail e2e passed (${results.length - 1} benchmark fixture${results.length === 2 ? '' : 's'}, max observed ${maxObserved.toFixed(1)}ms)`);
    } finally {
        client?.close();
        browser.kill();
        server.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
