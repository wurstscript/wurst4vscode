'use strict';

const { test, expect } = require('../fixtures');
const { createTsLoader } = require('../harness/tsLoader');
const { createVscodeMock } = require('../harness/vscodeMock');
const { fileUri } = require('../harness/vscodeMock');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMDX, generateMDX, generateMDL } = require('war3-model');
const { serializeObjMod } = require('casc-ts/formats');

const cleanups = [];
test.afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function sceneFiles(animated = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-map-models-'));
    fs.mkdirSync(path.join(dir, 'models'));
    fs.mkdirSync(path.join(dir, 'textures'));
    fs.writeFileSync(path.join(dir, 'war3map.w3e'), 'fixture anchor');
    const bytes = fs.readFileSync(path.join(__dirname, '../../wc3data/melon.mdx'));
    const model = parseMDX(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const extent = Math.max(...model.Geosets.map(geoset => Math.max(...geoset.Vertices.map(Math.abs))));
    for (const geoset of model.Geosets) for (let i = 0; i < geoset.Vertices.length; i++) geoset.Vertices[i] *= 128 / extent;
    for (const texture of model.Textures) { texture.Image = 'textures\\shared.tga'; texture.ReplaceableId = 0; }
    model.Info.BoundsRadius = 256;
    if (animated) {
        model.Sequences = ['Death', 'Stand'].map((Name, index) => ({ ...model.Info, Name,
            Interval: new Uint32Array([index * 2000, index * 2000 + 1200]),
            NonLooping: index === 0, MoveSpeed: 0, Rarity: 0,
        }));
        const frames = [0, 1200, 2000, 2600, 3200], values = [0, 0, 1, 0, 1];
        model.GeosetAnims = model.Geosets.map((_, GeosetId) => ({ GeosetId, Flags: 0,
            Color: new Float32Array([1, 1, 1]), Alpha: { LineType: 0, GlobalSeqId: null, VectorSize: 1,
                Frames: new Int32Array(frames), Values: new Float32Array(values),
                Keys: frames.map((Frame, i) => ({ Frame, Vector: new Float32Array([values[i]]) })),
            },
        }));
    }
    fs.writeFileSync(path.join(dir, 'models/shared.mdx'), Buffer.from(generateMDX(model)));
    fs.writeFileSync(path.join(dir, 'models/other.mdl'), generateMDL(model));
    const tga = Buffer.alloc(18 + 4 * 4 * 4);
    tga[2] = 2; tga.writeUInt16LE(4, 12); tga.writeUInt16LE(4, 14); tga[16] = 32; tga[17] = 0x28;
    for (let i = 18; i < tga.length; i += 4) { tga[i] = 80; tga[i + 1] = 240; tga[i + 2] = 20; tga[i + 3] = 255; }
    fs.writeFileSync(path.join(dir, 'textures/shared.tga'), tga);
    return dir;
}

async function openMap(page, server, count = 4, options = {}) {
    const dir = options.models ? sceneFiles(options.animated) : undefined;
    let disposed = false, releaseTextures, releaseModels;
    const textureGate = options.holdTextures ? new Promise(resolve => { releaseTextures = resolve; }) : Promise.resolve();
    const modelGate = options.holdUnitModel ? new Promise(resolve => { releaseModels = resolve; }) : Promise.resolve();
    cleanups.push(() => { disposed = true; releaseTextures?.(); releaseModels?.(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
    const load = createTsLoader({
        mocks: { vscode: createVscodeMock({ workspaceFolders: dir ? [{ uri: fileUri(dir), name: 'fixture', index: 0 }] : [] }) },
        augment: { 'src/features/mapPreview.ts': `export const __e2e = { mapObjectCatalog, markerModel, async buildHtml(terrain, markers, scriptUri) {
            const catalog = new Map(markers.map(m => [m.typeId.toLowerCase(), { name: m.label, modelPath: m.modelPath }]));
            const units = markers.filter(m => m.kind !== 'doodad').map((m, editorId) => ({ ...m, typeId: m.typeId,
                ownerIndex: m.owner, editorId, scaleX: m.scale?.[0], scaleY: m.scale?.[1], scaleZ: m.scale?.[2] }));
            const scene = { terrain, materials: await buildTerrainMaterials(terrain), catalog,
                doodads: markers.filter(m => m.kind === 'doodad').map(m => ({ ...m, id: m.typeId })),
                types: new Map(markers.map(m => [m.typeId, { name: m.label, kind: m.typeId === 'ratf' ? 'item' : 'unit' }])),
                owners: { players: 12, neutralHostile: 12, neutralPassive: 15 } };
            return buildMapEditorHtml({ units, file: {}, fileName: 'Terrain fixture', isDirty: false }, scene, scriptUri);
        } };` },
    });
    const { buildHtml } = load('src/features/mapPreview.ts').__e2e;
    const side = 17, size = side * side;
    const terrain = {
        version: 11, tileset: 'L', customTileset: false,
        width: side, height: side, centerX: -1024, centerY: -1024,
        groundTiles: ['Ldrt'], cliffTiles: [], min: 0, max: 0,
        heights: new Int16Array(size), water: new Int16Array(size),
        ground: new Uint8Array(size), cliff: new Uint8Array(size), layer: new Uint8Array(size),
        flags: new Uint8Array(size), detail: new Uint8Array(size), waterMask: new Uint8Array(size),
    };
    const markers = [
        { kind: 'unit', typeId: 'hfoo', label: 'Footman', x: 0, y: 0, z: 0, owner: 0 },
        { kind: 'unit', typeId: 'ratf', label: 'Item <test>', x: 640, y: 384, z: 0, owner: 15 },
        { kind: 'doodad', typeId: 'LTlt', label: 'Tree', x: -640, y: -384, z: 0 },
        { kind: 'start', typeId: 'sloc', label: 'Start Location', x: 640, y: -640, z: 0, owner: 1 },
    ];
    for (let i = markers.length; i < count; i++) {
        markers.push({ kind: 'doodad', typeId: 'LTlt', label: `Tree ${i}`, x: -512, y: i, z: 0 });
    }
    if (options.models) {
        markers[0].modelPath = 'models\\shared.mdx';
        markers[1].modelPath = 'models\\shared.mdx'; markers[1].scale = [2, 2, 2]; markers[1].angle = 0.9;
        markers[2].modelPath = 'models\\other.mdl';
        if (options.buried) for (const marker of markers) { marker.x = 0; marker.y = 0; marker.z = -512; }
        if (count > 4) { markers[4].modelPath = 'models\\missing.mdx'; markers[4].label = 'Missing asset'; }
    }
    const html = await buildHtml(terrain, markers, `${server.origin}/dist/webview/mapPreviewWebview.js`);
    const pageErrors = [], consoleErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const requests = [];
    const host = load('src/features/preview/modelPreviewHost.ts');
    const webview = { postMessage: async message => {
        if (!disposed) await page.evaluate(message => window.postMessage(message, '*'), JSON.parse(JSON.stringify(message)));
        return true;
    } };
    await page.exposeFunction('__mapToHost', async message => {
        requests.push(message);
        if (!dir || disposed) return;
        if (message.type === 'loadMapModel') {
            if (message.path.endsWith('shared.mdx')) await modelGate;
            if (!disposed) await host.postModelToWebview(message.path, fileUri(path.join(dir, 'war3map.w3e')), webview);
        }
        else if (message.type === 'loadMapTextures') {
            await textureGate;
            if (!disposed) await host.postTexturesToWebview(message.paths, fileUri(path.join(dir, 'war3map.w3e')), webview, message.path, true, 256);
        }
    });
    await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ postMessage(message) { void window.__mapToHost(message).catch(console.error); } });
        window.sceneLatencies = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(url, options) {
                super(url, options);
                if (options?.name !== 'wurst-map-scene') return;
                const pending = new Map(), post = this.postMessage.bind(this);
                this.postMessage = (message, ...transfer) => {
                    if (message.type === 'view') pending.set(message.state.revision, performance.now());
                    post(message, ...transfer);
                };
                this.addEventListener('message', ({ data }) => {
                    if (data.type !== 'sceneFrame' || !pending.has(data.revision)) return;
                    window.sceneLatencies.push(performance.now() - pending.get(data.revision));
                    for (const revision of pending.keys()) if (revision <= data.revision) pending.delete(revision);
                });
            }
        };
    });
    await page.goto(server.publish(html));
    // VS Code injects these theme variables when mounting a real webview.
    await page.evaluate(() => {
        const theme = {
            '--vscode-editor-background': '#1e1e1e', '--vscode-editor-foreground': '#d4d4d4',
            '--vscode-font-family': 'Segoe UI, sans-serif', '--vscode-font-size': '13px',
            '--vscode-sideBar-background': '#252526', '--vscode-descriptionForeground': '#aaaaaa',
            '--vscode-input-background': '#3c3c3c', '--vscode-input-foreground': '#cccccc',
            '--vscode-button-background': '#0e639c', '--vscode-button-foreground': '#ffffff',
            '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-list-activeSelectionBackground': '#094771',
        };
        for (const [key, value] of Object.entries(theme)) document.documentElement.style.setProperty(key, value);
    });
    await expect(page.locator('#mp-count')).toHaveText(`${count} / ${count} placements`);
    await expect(page.locator('#mp-canvas')).toHaveAttribute('data-ready', 'true');
    return { html, pageErrors, consoleErrors, requests, releaseTextures, releaseModels, dir, internals: load('src/features/mapPreview.ts').__e2e };
}

async function greenPixels(page) {
    const png = await page.locator('#mp-canvas').screenshot();
    return page.evaluate(async base64 => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let green = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 1] > 150 && pixels[i] < 110 && pixels[i + 2] < 160) green++;
        return green;
    }, png.toString('base64'));
}

async function expectFrozen(page) {
    const frozen = await greenPixels(page), samples = [], started = Date.now();
    await expect.poll(async () => {
        samples.push(await greenPixels(page));
        return Date.now() - started;
    }, { intervals: [100], timeout: 3000 }).toBeGreaterThan(800);
    expect(samples.every(value => value === frozen)).toBe(true);
}

test('searches rawcodes and names, filters owners and categories, and preserves selection details', async ({ page, server }, testInfo) => {
    const { html, pageErrors, consoleErrors } = await openMap(page, server);
    expect(html).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    await expect(page.locator('.mp-object')).toHaveCount(4);
    await page.locator('#mp-placement-search').fill('HFOO');
    await expect(page.locator('.mp-object')).toHaveCount(1);
    await page.locator('.mp-object').click();
    await expect(page.locator('#mp-details')).toContainText('Footman');
    await expect(page.locator('#mp-details')).toContainText('x 0, y 0, z 0');
    await expect(page.locator('.mp-object')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#mp-placement-search').fill('item');
    await expect(page.locator('.mp-object')).toHaveCount(1);
    await expect(page.locator('.mp-object')).toContainText('Item <test>');
    await expect(page.locator('#mp-details')).toContainText('Selection hidden by filters');
    await expect(page.locator('#mp-selection-ring')).toBeHidden();
    await page.locator('#mp-placement-search').fill('');
    await page.locator('#mp-placement-owner').selectOption('15');
    await expect(page.locator('.mp-object')).toHaveCount(1);
    await expect(page.locator('.mp-object')).toContainText('ratf');
    await page.locator('#t-units').uncheck();
    await page.locator('#t-items').uncheck();
    await expect(page.locator('#mp-objects')).toHaveText('No matching placements.');
    await page.locator('#mp-placement-owner').selectOption('all');
    await expect(page.locator('.mp-object')).toHaveCount(2);
    await page.locator('#t-units').check();
    await page.locator('#t-items').check();
    await expect(page.locator('.mp-object[aria-pressed="true"]')).toContainText('Footman');
    await page.screenshot({ path: testInfo.outputPath('map-view.png') });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test('focuses selection, picks markers without treating an orbit as a click, and isolates placements', async ({ page, server }) => {
    const { pageErrors, consoleErrors } = await openMap(page, server);
    await page.locator('.mp-object').filter({ hasText: 'Footman' }).click();
    await page.locator('#mp-focus').click();
    const canvas = await page.locator('#mp-canvas').boundingBox();
    const ring = await page.locator('#mp-selection-ring').boundingBox();
    expect(Math.abs(ring.x + ring.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(1);
    expect(Math.abs(ring.y + ring.height / 2 - (canvas.y + canvas.height / 2))).toBeLessThan(1);
    await page.locator('#mp-isolate').check();
    await expect(page.locator('#mp-count')).toHaveText('1 / 4 placements');
    await page.locator('#mp-clear').click();
    await expect(page.locator('.mp-object')).toHaveCount(4);
    await page.locator('#mp-xray').check();
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await expect(page.locator('#mp-details')).toContainText('Footman');
    await page.locator('#mp-canvas').press('Escape');
    await expect(page.locator('#mp-focus')).toBeDisabled();
    await page.mouse.move(canvas.x + 40, canvas.y + 40);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 120, canvas.y + 60, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('#mp-focus')).toBeDisabled();
    await page.locator('.mp-object').filter({ hasText: 'Tree' }).click();
    await page.locator('#mp-canvas').focus();
    await page.locator('#mp-canvas').press('f');
    await expect(page.locator('#mp-selection-ring')).toBeVisible();
    await page.locator('#mp-top').click();
    await page.locator('#mp-exag').fill('3');
    await expect(page.locator('#mp-selection-ring')).toBeVisible();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test('bounds list rendering on large maps and keeps the canvas usable in a narrow panel', async ({ page, server }, testInfo) => {
    await openMap(page, server, 245);
    await expect(page.locator('.mp-object')).toHaveCount(100);
    await page.locator('#mp-more').click();
    await expect(page.locator('.mp-object')).toHaveCount(200);
    await page.locator('#mp-more').click();
    await expect(page.locator('.mp-object')).toHaveCount(245);
    await expect(page.locator('#mp-more')).toBeHidden();
    await page.locator('#mp-placement-search').fill('Tree 244');
    await expect(page.locator('.mp-object')).toHaveCount(1);
    await page.setViewportSize({ width: 600, height: 700 });
    const canvas = await page.locator('#mp-canvas').boundingBox();
    expect(canvas.width).toBeGreaterThan(250);
    expect(canvas.height).toBeGreaterThan(250);
    await expect(page.locator('#mp-focus')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('map-view-narrow.png') });
});

test('draws real MDX and MDL placements with shared assets, filters and placement scale', async ({ page, server }, testInfo) => {
    const result = await openMap(page, server, 4, { models: true });
    await expect(page.locator('#mp-model-status')).toHaveText('2/2 models');
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(2);
    expect(result.requests.filter(m => m.type === 'loadMapTextures')).toHaveLength(1);
    const before = Number(await page.locator('#mp-canvas').getAttribute('data-frame'));
    await page.locator('#mp-placement-search').fill('Tree');
    await page.locator('.mp-object').click(); await page.locator('#mp-focus').click();
    await expect.poll(async () => Number(await page.locator('#mp-canvas').getAttribute('data-frame'))).toBeGreaterThan(before + 1);
    await expect.poll(() => greenPixels(page)).toBeGreaterThan(150);
    await page.locator('#mp-placement-search').fill('Footman');
    await page.locator('.mp-object').click(); await page.locator('#mp-focus').click();
    await expect.poll(() => greenPixels(page)).toBeGreaterThan(150);
    const normal = await greenPixels(page);
    await page.locator('#mp-models').uncheck();
    await expect.poll(() => greenPixels(page)).toBeLessThan(60);
    await page.locator('#mp-models').check();
    await page.locator('#mp-placement-search').fill('Item');
    await page.locator('.mp-object').click(); await page.locator('#mp-focus').click();
    await expect.poll(() => greenPixels(page)).toBeGreaterThan(normal * 2);
    await page.screenshot({ path: testInfo.outputPath('placed-models.png') });
    expect(result.pageErrors).toEqual([]); expect(result.consoleErrors).toEqual([]);
});

test('keeps camera rendering responsive while texture loading is deferred and settles missing models', async ({ page, server }) => {
    const result = await openMap(page, server, 5, { models: true, holdTextures: true });
    await expect.poll(() => result.requests.filter(m => m.type === 'loadMapTextures').length).toBe(1);
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(1);
    await page.evaluate(() => {
        window.frameTimes = []; let previous = performance.now();
        const tick = now => { window.frameTimes.push(now - previous); previous = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    const before = Number(await page.locator('#mp-canvas').getAttribute('data-frame'));
    await page.locator('.mp-object').filter({ hasText: 'Footman' }).click();
    await page.locator('#mp-focus').click();
    const bounds = await page.locator('#mp-canvas').boundingBox();
    await page.mouse.move(bounds.x + 100, bounds.y + 100); await page.mouse.down();
    await page.mouse.move(bounds.x + 230, bounds.y + 130, { steps: 12 }); await page.mouse.up();
    await expect.poll(async () => Number(await page.locator('#mp-canvas').getAttribute('data-frame'))).toBeGreaterThan(before + 3);
    expect(await page.evaluate(() => Math.max(...window.frameTimes))).toBeLessThan(150);
    result.releaseTextures();
    await expect(page.locator('#mp-model-status')).toHaveText('2/3 models · 1 unavailable');
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(3);
    expect(result.pageErrors).toEqual([]); expect(result.consoleErrors).toEqual([]);
});

test('animates Stand on units, items and MDL doodads, with pause and hidden-page suspension', async ({ page, server }) => {
    const result = await openMap(page, server, 4, { models: true, animated: true });
    await expect(page.locator('#mp-model-status')).toHaveText('2/2 models');
    for (const name of ['Footman', 'Item', 'Tree']) {
        await page.locator('#mp-placement-search').fill(name);
        await page.locator('.mp-object').click(); await page.locator('#mp-focus').click();
        await expect.poll(() => greenPixels(page), { intervals: [100], timeout: 5000 }).toBeGreaterThan(150);
        await expect.poll(() => greenPixels(page), { intervals: [100], timeout: 5000 }).toBeLessThan(60);
    }
    const beforePause = Number(await page.locator('#mp-canvas').getAttribute('data-frame'));
    await page.locator('#mp-animate').uncheck();
    await expect.poll(async () => Number(await page.locator('#mp-canvas').getAttribute('data-frame'))).toBeGreaterThan(beforePause);
    await expectFrozen(page);
    await page.locator('#mp-animate').check();
    await expect.poll(() => greenPixels(page), { intervals: [100], timeout: 5000 }).toBeGreaterThan(150);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectFrozen(page);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => greenPixels(page), { intervals: [100], timeout: 5000 }).toBeLessThan(60);
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(2);
    expect(result.pageErrors).toEqual([]); expect(result.consoleErrors).toEqual([]);
});

test('keeps animation and camera input responsive while the next model loads', async ({ page, server }) => {
    const result = await openMap(page, server, 4, { models: true, animated: true, holdUnitModel: true });
    await expect(page.locator('#mp-model-status')).toHaveText('1/2 models');
    await expect.poll(() => result.requests.filter(m => m.type === 'loadMapModel').length).toBe(2);
    await page.locator('#mp-placement-search').fill('Tree');
    await page.locator('.mp-object').click(); await page.locator('#mp-focus').click();
    await page.locator('#mp-placement-search').fill('');
    await expect.poll(() => greenPixels(page), { intervals: [100] }).toBeGreaterThan(150);
    await expect.poll(() => greenPixels(page), { intervals: [100] }).toBeLessThan(60);
    await page.evaluate(() => {
        window.frameTimes = []; window.sceneLatencies = []; let previous = performance.now();
        const tick = now => { window.frameTimes.push(now - previous); previous = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    });
    const before = Number(await page.locator('#mp-canvas').getAttribute('data-frame'));
    const bounds = await page.locator('#mp-canvas').boundingBox();
    await page.mouse.move(bounds.x + 100, bounds.y + 100); await page.mouse.down();
    result.releaseModels();
    await page.mouse.move(bounds.x + 230, bounds.y + 130, { steps: 20 }); await page.mouse.up();
    await expect.poll(async () => Number(await page.locator('#mp-canvas').getAttribute('data-frame'))).toBeGreaterThan(before + 3);
    await expect(page.locator('#mp-model-status')).toHaveText('2/2 models');
    await expect.poll(() => greenPixels(page), { intervals: [100] }).toBeGreaterThan(150);
    expect(await page.evaluate(() => Math.max(...window.frameTimes))).toBeLessThan(150);
    expect(await page.evaluate(() => window.sceneLatencies.length)).toBeGreaterThan(3);
    expect(await page.evaluate(() => Math.max(...window.sceneLatencies))).toBeLessThan(150);
    expect(result.pageErrors).toEqual([]); expect(result.consoleErrors).toEqual([]);
});

test('removing the last references drops queued models and undo loads them on demand', async ({ page, server }) => {
    const result = await openMap(page, server, 4, { models: true, holdTextures: true });
    await expect.poll(() => result.requests.filter(m => m.type === 'loadMapTextures').length).toBe(1);
    await page.evaluate(() => {
        window.savedPlacements = window.__wurstMapEditorDebug.state().placements;
        window.postMessage({ type: 'placementsChanged', placements: window.savedPlacements.filter(p => p.kind === 'start'), isDirty: true, select: -1 }, '*');
    });
    await expect(page.locator('#mp-model-status')).toHaveText('0/1 models');
    result.releaseTextures();
    await expect(page.locator('#mp-model-status')).toHaveText('1/1 models');
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(1);
    await page.evaluate(() => window.postMessage({ type: 'placementsChanged', placements: window.savedPlacements, isDirty: false, select: -1 }, '*'));
    await expect(page.locator('#mp-model-status')).toHaveText('2/2 models');
    expect(result.requests.filter(m => m.type === 'loadMapModel')).toHaveLength(2);
    expect(result.pageErrors).toEqual([]); expect(result.consoleErrors).toEqual([]);
});

test('models share terrain depth and become visible when the covering terrain is hidden', async ({ page, server }) => {
    await openMap(page, server, 4, { models: true, buried: true });
    await expect(page.locator('#mp-model-status')).toHaveText('2/2 models');
    await expect.poll(() => greenPixels(page)).toBeLessThan(60);
    await page.locator('#t-terrain').uncheck();
    await expect.poll(() => greenPixels(page)).toBeGreaterThan(150);
});

test('map and skin model overrides inherit stock data and preserve placement transforms', async ({ page, server }) => {
    const { dir, internals } = await openMap(page, server, 4, { models: true });
    const file = mods => serializeObjMod({ version: 2, ext: '.w3u', extended: false, origObjs: [],
        customObjs: [{ baseId: 'hfoo', newId: 'H001', mods: mods.map(([fieldId, value]) => ({ fieldId,
            value, varType: typeof value === 'number' ? 'real' : 'string', endToken: 'H001' })) }] });
    fs.writeFileSync(path.join(dir, 'war3map.w3u'), file([['umdl', 'models\\shared.mdx'], ['usca', 1.5]]));
    fs.writeFileSync(path.join(dir, 'war3mapSkin.w3u'), file([['umdl', 'models\\other.mdl']]));
    const catalog = await internals.mapObjectCatalog(dir);
    const custom = catalog.get('h001');
    expect(custom.modelPath).toBe('models\\other.mdl');
    expect(custom.name).toBe(catalog.get('hfoo').name);
    const marker = internals.markerModel(custom, { scaleX: 2, scaleY: 1, scaleZ: 3, angle: 0.8 }, false);
    expect(marker.scale).toEqual([3, 1.5, 4.5]); expect(marker.angle).toBeCloseTo(0.8);
    expect(internals.markerModel(custom, { variation: 2 }, true)).toMatchObject({
        modelPath: 'models\\other2.mdl', modelFallback: 'models\\other.mdl',
    });
    const posted = [];
    const load = createTsLoader({ mocks: { vscode: createVscodeMock({ workspaceFolders: [{ uri: fileUri(dir), name: 'fixture', index: 0 }] }) } });
    await load('src/features/preview/modelPreviewHost.ts').postModelToWebview('models\\shared0.mdx', fileUri(path.join(dir, 'war3map.w3e')),
        { postMessage: message => { posted.push(message); return Promise.resolve(true); } }, ['models\\shared.mdx']);
    expect(posted[0]).toMatchObject({ type: 'mdxModel', path: 'models\\shared0.mdx', format: 'mdx' });
});
