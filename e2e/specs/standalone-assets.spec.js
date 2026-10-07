'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, root } = require('../fixtures');
const { createTsLoader } = require('../harness/tsLoader');
const { createVscodeMock, fileUri } = require('../harness/vscodeMock');
const { parseMDX, generateMDX } = require('war3-model');

test('standalone browser uses the thumbnail service, waits for textures and frames posed geometry', async ({ page, server }) => {
    const bytes = fs.readFileSync(path.join(root, 'wc3data/melon.mdx'));
    const model = parseMDX(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    model.Info.MinimumExtent.fill(-100000);
    model.Info.MaximumExtent.fill(100000);
    model.Info.BoundsRadius = 100000;
    const modelBase64 = Buffer.from(generateMDX(model)).toString('base64');
    const vscode = createVscodeMock();
    let html;
    vscode.window.createWebviewPanel = () => ({ webview: {
        cspSource: server.origin,
        asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
        set html(value) { html = value; },
        onDidReceiveMessage() {},
    } });
    const load = createTsLoader({ mocks: {
        vscode,
        'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({ models: [{ value: 'test.mdx' }], icons: [], sounds: [] }) },
        'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => ({ model: [], icon: [], sound: [] }) },
    } });
    await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
    await page.addInitScript(() => {
        window.messages = [];
        window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) });
        window.War3Viewer = new Proxy({}, { get() { throw new Error('Thumbnails must not use the live viewer'); } });
    });
    await page.goto(server.publish(html));
    const thumb = page.locator('.model-thumb');
    await expect.poll(() => page.evaluate(() => window.messages.some(m => m.type === 'loadModelThumb'))).toBe(true);
    const key = await thumb.getAttribute('data-key');
    await page.evaluate(msg => window.postMessage(msg, '*'), {
        type: 'modelThumbRender', key, cacheKey: 'v12s-abc', mdxBase64: modelBase64, format: 'mdx', textureNamespace: 'standalone-test',
    });
    await expect.poll(() => page.evaluate(() => window.messages.some(m => m.type === 'requestTextures'))).toBe(true);
    expect(await page.evaluate(() => window.messages.some(m => m.type === 'modelThumbRendered'))).toBe(false);
    await expect(thumb).toHaveClass(/pending/);
    const paths = await page.evaluate(() => window.messages.find(m => m.type === 'requestTextures').paths);
    await page.evaluate(({ key, paths }) => {
        for (const path of paths) window.postMessage({ type: 'mdxTexture', thumbKey: key, path,
            width: 1, height: 1, rgbaBase64: btoa(String.fromCharCode(80, 220, 90, 255)) }, '*');
        window.postMessage({ type: 'modelThumbTexturesComplete', thumbKey: key }, '*');
    }, { key, paths });
    await expect.poll(() => page.evaluate(() => window.messages.some(m => m.type === 'modelThumbRendered'))).toBe(true);
    await expect(thumb).toHaveClass(/loaded/);
    const result = await page.evaluate(async () => {
        const message = window.messages.find(m => m.type === 'modelThumbRendered');
        const bitmap = await createImageBitmap(await (await fetch('data:image/webp;base64,' + message.webpBase64)).blob());
        const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const rgba = ctx.getImageData(0, 0, 96, 96).data;
        let minX = 96, minY = 96, maxX = -1, maxY = -1;
        for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) if (rgba[(y * 96 + x) * 4 + 3] > 12) {
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        return { span: Math.max(maxX - minX + 1, maxY - minY + 1), cacheKey: message.cacheKey };
    });
    expect(result.span).toBeGreaterThan(80);
    expect(result.cacheKey).toBe('v12s-abc');
});

for (const cacheVersion of ['v10s', 'v11s', 'v12s']) {
    test(`rendered model thumbnails stay loaded after saving ${cacheVersion}`, async ({ page, server }) => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-thumb-cache-'));
        try {
            const vscode = createVscodeMock();
            let html;
            vscode.window.createWebviewPanel = () => ({ webview: {
                cspSource: server.origin,
                asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
                set html(value) { html = value; },
                onDidReceiveMessage() {},
            } });
            const load = createTsLoader({ mocks: {
                vscode,
                'src/features/preview/cascStorage.ts': { getModelThumbCacheDir: () => cacheDir, getGameAssetCacheDir: () => cacheDir },
                'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({ models: [{ value: 'test.mdx', label: 'Test model' }], icons: [], sounds: [] }) },
                'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => ({ model: [], icon: [], sound: [] }) },
            } });
            await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
            await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
            await page.goto(server.publish(html));
            const thumb = page.locator('.model-thumb');
            const key = await thumb.getAttribute('data-key');
            const uri = await page.evaluate(() => document.createElement('canvas').toDataURL('image/webp'));
            await page.evaluate(msg => window.postMessage(msg, '*'), { type: 'modelThumbLoaded', key, uri });
            await expect(thumb).toHaveClass(/loaded/);
            const messages = [];
            await load('src/features/preview/modelPreviewHost.ts').cacheModelThumbnail(key, 'v2-abc', uri.split(',')[1], {
                postMessage: async msg => {
                    messages.push(msg);
                    await page.evaluate(message => window.postMessage(message, '*'), msg);
                    return true;
                },
            }, `${cacheVersion}-def`);
            expect(messages.map(msg => msg.type)).toEqual(['modelThumbLoaded']);
            expect(fs.readFileSync(path.join(cacheDir, 'v2-abc.webp'))).toEqual(fs.readFileSync(path.join(cacheDir, `${cacheVersion}-def.webp`)));
            await expect(thumb).toHaveClass(/loaded/);
            await expect(thumb).not.toHaveClass(/missing/);
            expect(await thumb.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
            await expect(thumb.locator('img')).toBeVisible();
        } finally {
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
});
}

for (const editor of ['none', 'untitled', 'workspace']) {
    test(`standalone browser opens assets with ${editor} context without a replacement target`, async ({ page, server }) => {
        const vscode = createVscodeMock({ workspaceFolders: editor === 'workspace' ? [{ uri: fileUri(root) }] : [] });
        if (editor !== 'none') vscode.window.activeTextEditor = { document: { uri: { scheme: 'untitled', fsPath: '/Untitled-1' } } };
        let scanned;
        let receive;
        let html;
        let disposed = false;
        vscode.window.createWebviewPanel = () => ({
            webview: {
                cspSource: server.origin,
                asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
                set html(value) { html = value; },
                onDidReceiveMessage(handler) { receive = handler; },
            },
            dispose() { disposed = true; },
        });
        const load = createTsLoader({ mocks: {
            vscode,
            'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({
                models: [{ value: 'Units\\Human\\Footman\\Footman.mdx', label: 'Footman' }], icons: [], sounds: [],
            }) },
            'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async fsPath => {
                if (editor !== 'workspace') throw new Error('No document to scan');
                scanned = fsPath;
                return { model: [], icon: [], sound: [] };
            } },
            'src/features/preview/modelPreviewHost.ts': { handleModelThumbMessage: async () => true },
        } });
        await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
        if (editor === 'workspace') expect(path.dirname(scanned)).toBe(root);
        await page.exposeFunction('__assetMessage', message => receive(message));
        await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.__assetMessage(message) }); });
        await page.goto(server.publish(html));
        await expect(page.locator('.meta')).toHaveText('Click an asset to open its preview.');
        await expect(page.locator('#tab-model')).toHaveClass(/active/);
        await page.locator('.card').click();
        await expect.poll(() => vscode.recorded.commands.length).toBe(1);
        expect(vscode.recorded.commands[0].command).toBe('wurst.openAssetFromString');
        expect(vscode.recorded.commands[0].args[0]).toBe('Units\\Human\\Footman\\Footman.mdx');
        expect(disposed).toBe(false);
    });
}

for (const source of ['editor', 'workspace', 'model']) {
    test(`standalone browser preserves remote ${source} asset roots and source URI`, async ({ page, server }) => {
        const remoteRoot = fileUri(root, 'vscode-remote', 'ssh-remote+fixture');
        const remoteDocument = fileUri(path.join(root, 'models', 'preview.mdx'), 'vscode-remote', remoteRoot.authority);
        const vscode = createVscodeMock({ workspaceFolders: [{ uri: remoteRoot }] });
        vscode.window.activeTextEditor = { document: { uri: source === 'editor' ? remoteDocument : { scheme: 'untitled', fsPath: '/Untitled-1' } } };
        let scanned;
        let candidatePath;
        let receive;
        let html;
        vscode.window.createWebviewPanel = () => ({ webview: {
            cspSource: server.origin,
            asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
            set html(value) { html = value; },
            onDidReceiveMessage(handler) { receive = handler; },
        } });
        const load = createTsLoader({ mocks: {
            vscode,
            'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({ models: [], icons: [], sounds: [] }) },
            'src/features/imageAssetSupport.ts': {
                getCandidateRoots: async fsPath => { candidatePath = fsPath; return []; },
                gatherImportedAssets: async fsPath => {
                    scanned = fsPath;
                    return { model: [{ value: 'imports\\remote.mdx', label: 'Remote import' }], icon: [], sound: [] };
                },
            },
            'src/features/preview/modelPreviewHost.ts': { handleModelThumbMessage: async () => true },
        } });
        await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) }, source === 'model' ? remoteDocument : undefined);
        const expected = source === 'workspace' ? vscode.Uri.joinPath(remoteRoot, 'asset-browser') : remoteDocument;
        expect(scanned).toBe(expected.fsPath);
        expect(candidatePath).toBe(expected.fsPath);
        await page.exposeFunction('__assetMessage', message => receive(message));
        await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.__assetMessage(message) }); });
        await page.goto(server.publish(html));
        await expect(page.locator('.card')).toContainText('Remote import');
        await page.locator('.card').click();
        await expect.poll(() => vscode.recorded.commands.length).toBe(1);
        expect(vscode.recorded.commands[0].args[1].toString()).toBe(expected.toString());
    });
}

test('model preview exposes the asset browser with its source URI', async ({ openBlpPreview }) => {
    const { page, host } = await openBlpPreview();
    await expect(page.locator('#fileMeta')).toHaveText(/8 × 4/);
    const { fileUri } = require('../harness/vscodeMock');
    // The host's real provider handles the message; capture commands through the harness mock.
    await page.evaluate(mdxBase64 => window.postMessage({ type: 'mdx', fileName: 'melon.mdx', format: 'mdx', mdxBase64 }, '*'), fs.readFileSync(path.join(root, 'wc3data/melon.mdx')).toString('base64'));
    await expect(page.locator('#browseAssetsBtn')).toBeVisible();
    await page.locator('#browseAssetsBtn').click();
    await expect.poll(() => host.recorded.commands.some(entry => entry.command === 'wurst.openAssetBrowser')).toBe(true);
    expect(host.recorded.commands.find(entry => entry.command === 'wurst.openAssetBrowser').args[0].toString()).toBe(fileUri(host.doc.uri.fsPath).toString());
});
