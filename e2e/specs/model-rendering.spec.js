'use strict';

const fs = require('fs');
const path = require('path');
const { parseMDX, generateMDX } = require('war3-model');
const { test, expect } = require('../fixtures');

// A static, real WC3 model with deliberately wrong authored extents exercises posed framing.
function modelBytes(hiddenStand = false, transparentLastPass = false) {
    const bytes = fs.readFileSync(path.join(__dirname, '../../wc3data/melon.mdx'));
    const model = parseMDX(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    model.Info.MinimumExtent.fill(-100000);
    model.Info.MaximumExtent.fill(100000);
    model.Info.BoundsRadius = 100000;
    if (transparentLastPass) {
        for (const material of model.Materials) {
            material.Layers[0].FilterMode = 0;
            material.Layers[0].Shading = 16;
            material.Layers.push({ ...material.Layers[0], FilterMode: 2, Alpha: 0.25 });
        }
    }
    if (hiddenStand) {
        model.Sequences = ['Stand', 'Visible'].map((Name, index) => ({
            ...model.Info, Name, Interval: new Uint32Array([index * 1000, index * 1000 + 500]),
            NonLooping: false, MoveSpeed: 0, Rarity: 0,
        }));
        model.GeosetAnims = model.Geosets.map((_, GeosetId) => ({
            GeosetId, Color: new Float32Array([1, 1, 1]), Flags: 0,
            Alpha: { LineType: 0, GlobalSeqId: null, VectorSize: 1, Frames: new Int32Array([0, 1000]), Values: new Float32Array([0, 1]),
                Keys: [0, 1000].map((Frame, index) => ({ Frame, Vector: new Float32Array([index]) })) },
        }));
    }
    return Buffer.from(generateMDX(model)).toString('base64');
}

async function startWorker(page, server) {
    await page.goto(server.publish('<!doctype html><body></body>'));
    await page.evaluate(async () => {
        const bundle = await (await fetch('/dist/webview/mdxThumbnailWorker.js')).text();
        const url = URL.createObjectURL(new Blob([bundle], { type: 'text/javascript' }));
        window.workerMessages = [];
        window.thumbWorker = new Worker(url);
        window.thumbWorker.onmessage = event => window.workerMessages.push(event.data);
    });
    await expect.poll(() => page.evaluate(() => window.workerMessages.some(m => m.type === 'ready'))).toBe(true);
}

async function render(page, key, namespace, hiddenStand = false) {
    await page.evaluate(({ bytes, key, namespace }) => {
        const buffer = Uint8Array.from(atob(bytes), c => c.charCodeAt(0)).buffer;
        window.thumbWorker.postMessage({ type: 'render', job: {
            key, cacheKey: key, textureNamespace: namespace, format: 'mdx', buffer,
        } }, [buffer]);
    }, { bytes: modelBytes(hiddenStand), key, namespace });
}

async function requests(page, key) {
    await expect.poll(() => page.evaluate(key => window.workerMessages.some(m => m.type === 'requestTextures' && m.key === key), key)).toBe(true);
    return page.evaluate(key => window.workerMessages.find(m => m.type === 'requestTextures' && m.key === key).paths, key);
}

async function supply(page, key, paths) {
    await page.evaluate(({ key, paths }) => {
        for (const path of paths) window.thumbWorker.postMessage({ type: 'texture', thumbKey: key,
            path, width: 1, height: 1, rgbaBase64: btoa(String.fromCharCode(80, 220, 90, 255)) });
        window.thumbWorker.postMessage({ type: 'texturesComplete', thumbKey: key });
    }, { key, paths });
}

async function rendered(page, key) {
    await expect.poll(() => page.evaluate(key => window.workerMessages.some(m => m.type === 'rendered' && m.key === key), key)).toBe(true);
    return page.evaluate(key => window.workerMessages.find(m => m.type === 'rendered' && m.key === key), key);
}

test('thumbnail worker waits for textures, frames actual geometry, and isolates warm caches', async ({ page, server }) => {
    await startWorker(page, server);
    await render(page, 'cold', 'map-a');
    const paths = await requests(page, 'cold');
    // Rendering must remain pending until texture replies arrive, irrespective of elapsed frames.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.workerMessages.some(m => m.type === 'rendered'))).toBe(false);
    await supply(page, 'cold', paths);
    const result = await rendered(page, 'cold');
    expect(result.textureFailures).toBe(0);
    const image = await page.evaluate(async base64 => {
        const bitmap = await createImageBitmap(await (await fetch('data:image/webp;base64,' + base64)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let pixels = 0;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 12) pixels++;
        return { width: canvas.width, height: canvas.height, pixels };
    }, result.webpBase64);
    expect(image.width).toBe(96); expect(image.height).toBe(96);
    expect(image.pixels).toBeGreaterThan(100);

    await render(page, 'warm', 'map-a');
    await rendered(page, 'warm');
    expect(await page.evaluate(() => window.workerMessages.some(m => m.type === 'requestTextures' && m.key === 'warm'))).toBe(false);
    await render(page, 'other-map', 'map-b');
    expect(await requests(page, 'other-map')).toEqual(paths);
    await supply(page, 'other-map', paths);
    await rendered(page, 'other-map');
});

test('cancelled texture waits cannot complete a later job; terminal missing replies settle', async ({ page, server }) => {
    await startWorker(page, server);
    await render(page, 'cancelled', 'map-a');
    const paths = await requests(page, 'cancelled');
    await page.evaluate(() => window.thumbWorker.postMessage({ type: 'cancel', key: 'cancelled' }));
    await render(page, 'next', 'map-b');
    await requests(page, 'next');
    await supply(page, 'cancelled', paths);
    await page.evaluate(() => window.thumbWorker.postMessage({ type: 'texturesComplete', thumbKey: 'next' }));
    const result = await rendered(page, 'next');
    expect(result.textureFailures).toBe(paths.length);
    expect(await page.evaluate(() => window.workerMessages.some(m => m.key === 'cancelled' && (m.type === 'rendered' || m.type === 'failed')))).toBe(false);
});

test('invisible preferred sequence falls back to a visible sequence without reloading textures', async ({ page, server }) => {
    await startWorker(page, server);
    await render(page, 'hidden-stand', 'map-a', true);
    await supply(page, 'hidden-stand', await requests(page, 'hidden-stand'));
    await rendered(page, 'hidden-stand');
    const messages = await page.evaluate(() => window.workerMessages);
    expect(messages.filter(m => m.type === 'requestTextures')).toHaveLength(1);
    expect(messages.find(m => m.type === 'profile' && m.phase === 'rendered').frame).toBeGreaterThanOrEqual(1000);
});

test('frozen preview exposes first textured GPU draw and asynchronous still capture', async ({ page, server }) => {
    await page.goto(server.publish('<!doctype html><div id="viewport"><canvas id="model" style="width:256px;height:256px"></canvas></div><canvas id="gizmo"></canvas><script src="/dist/webview/mdxViewer.js"></script>'));
    await page.evaluate(bytes => {
        window.viewerMessages = []; window.ready = false; window.viewerErrors = [];
        const v = window.War3Viewer;
        v.init({ canvas3d: document.querySelector('#model'), gizmo: document.querySelector('#gizmo'), viewport: document.querySelector('#viewport'),
            vscodeApi: { postMessage: m => window.viewerMessages.push(m) },
            callbacks: { onModelLoaded() {}, onFrameUpdate() {}, onDebug() {}, onError: e => window.viewerErrors.push(e) } });
        v.loadModel(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)).buffer, 'melon.mdx', 'mdx', { freezeAnimation: true, maxTextureDimension: 128 });
        window.readyPromise = v.whenRendered().then(() => { window.ready = true; });
    }, modelBytes());
    expect(await page.evaluate(() => window.ready)).toBe(false);
    const result = await page.evaluate(async () => {
        const v = window.War3Viewer;
        for (const path of window.viewerMessages.find(m => m.type === 'requestTextures').paths) {
            v.onTextureImageData(path, new ImageData(new Uint8ClampedArray([80, 220, 90, 255]), 1, 1));
        }
        await window.readyPromise; await v.renderStillFrameAsync();
        const frame = v.readPixelsImageData();
        return { ready: window.ready, pixels: Array.from(frame.data).filter((value, index) => index % 4 === 3 && value > 12).length,
            errors: window.viewerErrors };
    });
    expect(result.ready).toBe(true); expect(result.pixels).toBeGreaterThan(100); expect(result.errors).toEqual([]);
});

test('transparent final passes do not retain depth between preview frames', async ({ page, server }) => {
    await page.goto(server.publish('<!doctype html><div id="viewport"><canvas id="model" style="width:256px;height:256px"></canvas></div><canvas id="gizmo"></canvas><script src="/dist/webview/mdxViewer.js"></script>'));
    const counts = await page.evaluate(async bytes => {
        const viewer = window.War3Viewer;
        const messages = [];
        viewer.init({ canvas3d: document.querySelector('#model'), gizmo: document.querySelector('#gizmo'), viewport: document.querySelector('#viewport'),
            vscodeApi: { postMessage: message => messages.push(message) },
            callbacks: { onModelLoaded() {}, onFrameUpdate() {}, onDebug() {}, onError() {} } });
        viewer.loadModel(Uint8Array.from(atob(bytes), value => value.charCodeAt(0)).buffer, 'depth-regression.mdx', 'mdx', { freezeAnimation: true });
        for (const path of messages.find(message => message.type === 'requestTextures').paths) {
            viewer.onTextureImageData(path, new ImageData(new Uint8ClampedArray([80, 220, 90, 255]), 1, 1));
        }
        await viewer.whenRendered();
        const coverage = [];
        for (let frame = 0; frame < 20; frame++) {
            viewer.renderStillFrame();
            coverage.push(viewer.readPixelsImageData().data.filter((value, index) => index % 4 === 3 && value > 12).length);
        }
        return coverage;
    }, modelBytes(false, true));
    expect(counts[0]).toBeGreaterThan(100);
    for (const count of counts) expect(count).toBe(counts[0]);
});
