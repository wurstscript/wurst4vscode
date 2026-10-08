'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { test, expect, root } = require('../fixtures');
const { createTsLoader } = require('../harness/tsLoader');
const { createVscodeMock, fileUri } = require('../harness/vscodeMock');
const { parseMDX, generateMDX } = require('war3-model');

for (const contextual of [false, true]) {
    test(`asset actions and reload restoration ${contextual ? 'preserve the code target' : 'work standalone'}`, async ({ page, server }) => {
        const vscode = createVscodeMock();
        const value = 'Units/Human/Footman/Footman.mdx';
        const original = 'old.mdx';
        let html, receive, copied, replacement;
        let disposed = false;
        const panel = { webview: {
            cspSource: server.origin,
            asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
            set html(value) { html = value; }, onDidReceiveMessage(handler) { receive = handler; },
        }, dispose() { disposed = true; } };
        vscode.window.createWebviewPanel = () => panel;
        vscode.env.clipboard.writeText = async text => { copied = text; };
        vscode.Range = class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } };
        vscode.WorkspaceEdit = class { replace(_uri, _range, text) { replacement = text; } };
        vscode.workspace.openTextDocument = async () => ({ getText: () => original });
        vscode.workspace.applyEdit = async () => true;
        vscode.window.showTextDocument = async () => {};
        const load = createTsLoader({ mocks: { vscode,
            'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({ models: [{ value, label: 'Footman' }], icons: [], sounds: [] }) },
            'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => ({ model: [], icon: [], sound: [] }) },
            'src/features/preview/modelPreviewHost.ts': { handleModelThumbMessage: async () => true },
        } });
        const host = load('src/features/assetLinks.ts');
        const context = { extensionUri: fileUri(root) };
        const targetUri = fileUri(path.join(root, 'test.wurst')).toString();
        if (contextual) await host.restoreAssetBrowser(context, panel, { browserContext: { documentUri: targetUri,
            target: { uri: targetUri, kind: 'model', currentValue: original, range: [0, 0, 0, original.length] } } });
        else await host.openAssetBrowser(context);
        expect(vscode.recorded.commands.filter(entry => entry.command === 'workbench.action.moveEditorToNewWindow')).toHaveLength(contextual ? 0 : 1);
        await page.exposeFunction('__assetAction', msg => receive(msg));
        await page.addInitScript(() => {
            window.acquireVsCodeApi = () => ({
                postMessage: msg => window.__assetAction(msg),
                getState: () => JSON.parse(sessionStorage.getItem('asset-state') || '{}'),
                setState: state => sessionStorage.setItem('asset-state', JSON.stringify(state)),
            });
        });
        await page.goto(server.publish(html));
        await expect(page.locator('.card-name')).toHaveText('Footman');
        expect(await page.locator('.card-path').count()).toBe(0);
        await page.getByRole('button', { name: 'Copy path', exact: true }).click();
        await expect.poll(() => copied).toBe(contextual ? 'Units\\\\Human\\\\Footman\\\\Footman.mdx' : 'Units\\Human\\Footman\\Footman.mdx');
        expect(replacement).toBeUndefined(); expect(disposed).toBe(false);
        await page.getByRole('button', { name: 'Open in viewer', exact: true }).click();
        await expect.poll(() => vscode.recorded.commands.filter(entry => entry.command === 'wurst.openAssetFromString').length).toBe(1);
        expect(vscode.recorded.commands.find(entry => entry.command === 'wurst.openAssetFromString').args[0]).toBe(value);
        expect(replacement).toBeUndefined(); expect(disposed).toBe(false);
        await page.locator('#search').fill('Foot');
        const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('asset-state')));
        expect(state.query).toBe('Foot');
        // Simulate the serializer repopulating the panel, then a webview reload using VS Code state.
        await host.restoreAssetBrowser(context, panel, state);
        expect(vscode.recorded.commands.filter(entry => entry.command === 'workbench.action.moveEditorToNewWindow')).toHaveLength(contextual ? 0 : 1);
        await page.goto(server.publish(html));
        await expect(page.locator('#search')).toHaveValue('Foot');
        await expect(page.locator('#tab-model')).toHaveClass(/active/);
        if (contextual) {
            await page.getByRole('button', { name: 'Use asset', exact: true }).click();
            await expect.poll(() => replacement).toBe('Units\\\\Human\\\\Footman\\\\Footman.mdx');
            await expect.poll(() => disposed).toBe(true);
        } else await expect(page.getByRole('button', { name: 'Use asset', exact: true })).toHaveCount(0);
    });
}

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
        const encoded = Uint8Array.from(atob(message.webpBase64), c => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([encoded], { type: 'image/webp' }));
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

test('restored viewport gets the first thumbnail request', async ({ page, server }) => {
    const vscode = createVscodeMock();
    let html;
    vscode.window.createWebviewPanel = () => ({ webview: {
        cspSource: server.origin,
        asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
        set html(value) { html = value; }, onDidReceiveMessage() {},
    } });
    const load = createTsLoader({ mocks: { vscode,
        'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({
            models: Array.from({ length: 120 }, (_, index) => ({ value: `model-${index}.mdx` })), icons: [], sounds: [],
        }) },
        'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => ({ model: [], icon: [], sound: [] }) },
    } });
    await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
    await page.addInitScript(() => {
        window.messages = [];
        window.acquireVsCodeApi = () => ({
            postMessage: message => window.messages.push(message),
            getState: () => ({ activeTab: 'model', scrollTop: 1000 }),
        });
    });
    await page.goto(server.publish(html));
    await expect.poll(() => page.evaluate(() => window.messages.filter(m => m.type === 'loadModelThumb').length)).toBe(1);
    const result = await page.evaluate(() => {
        const grid = document.querySelector('#grid');
        const viewport = grid.getBoundingClientRect();
        const visible = [...grid.querySelectorAll('.model-thumb')].find(el => {
            const rect = el.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        return { scrollTop: grid.scrollTop, visibleKey: visible.getAttribute('data-key'),
            requestKey: window.messages.find(m => m.type === 'loadModelThumb').key };
    });
    // The saved position may clamp to the grid's maximum scroll offset.
    expect(result.scrollTop).toBeGreaterThan(500);
    expect(result.requestKey).toBe(result.visibleKey);
    expect(result.requestKey).not.toContain('model-0.mdx');
});

test('scrolling defers old thumbnails and requests the current viewport first', async ({ page, server }) => {
    const vscode = createVscodeMock();
    let html;
    vscode.window.createWebviewPanel = () => ({ webview: {
        cspSource: server.origin,
        asWebviewUri: uri => ({ toString: () => server.origin + '/dist/webview/' + path.basename(uri.fsPath) }),
        set html(value) { html = value; }, onDidReceiveMessage() {},
    } });
    const load = createTsLoader({ mocks: { vscode,
        'src/features/objModPreview.ts': { loadObjValueCatalog: async () => ({
            models: Array.from({ length: 120 }, (_, index) => ({ value: `model-${index}.mdx` })), icons: [], sounds: [],
        }) },
        'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => ({ model: [], icon: [], sound: [] }) },
    } });
    await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
    await page.addInitScript(() => {
        window.messages = [];
        window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) });
    });
    await page.goto(server.publish(html));
    const requests = () => page.evaluate(() => window.messages.filter(m => m.type === 'loadModelThumb'));
    await expect.poll(async () => (await requests()).length).toBe(1);
    const first = (await requests())[0];
    await page.locator('#grid').evaluate(grid => { grid.scrollTop = grid.scrollHeight / 2; });
    // Let the offscreen host response arrive after the scroll. No texture/render work may start.
    await page.evaluate(key => window.postMessage({ type: 'modelThumbRender', key,
        cacheKey: 'unused', mdxBase64: 'AA==' }, '*'), first.key);
    await expect.poll(async () => (await requests()).length).toBe(2);
    const second = (await requests())[1];
    const firstVisibleKey = await page.evaluate(() => {
        const viewport = document.querySelector('#grid').getBoundingClientRect();
        return [...document.querySelectorAll('.model-thumb')].find(el => {
            const rect = el.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
        }).getAttribute('data-key');
    });
    expect(second.key).toBe(firstVisibleKey);
    expect(second.key).not.toBe(first.key);
    expect(await page.evaluate(() => window.messages.some(m => m.type === 'requestTextures' || m.type === 'modelThumbFailed'))).toBe(false);
    // A stale acknowledgement must not unlock the current request.
    await page.evaluate(key => window.postMessage({ type: 'modelThumbLoaded', key, uri: 'data:image/png;base64,AA==' }, '*'), first.key);
    await expect.poll(async () => (await requests()).length).toBe(2);
    const bytes = fs.readFileSync(path.join(root, 'wc3data/melon.mdx'));
    await page.evaluate(({ key, bytes }) => window.postMessage({ type: 'modelThumbRender', key,
        cacheKey: 'current', mdxBase64: bytes, format: 'mdx' }, '*'), { key: second.key, bytes: bytes.toString('base64') });
    await expect.poll(() => page.evaluate(() => window.messages.some(m => m.type === 'requestTextures' && m.thumbKey === window.messages.filter(m => m.type === 'loadModelThumb')[1].key))).toBe(true);
    // Scrolling away while the worker waits for textures cancels that render immediately.
    await page.locator('#grid').evaluate(grid => { grid.scrollTop = 0; });
    await expect.poll(async () => (await requests()).length).toBe(3);
    const third = (await requests())[2];
    expect(third.path).toBe('model-1.mdx');
    await page.evaluate(key => window.postMessage({ type: 'modelThumbMissing', key }, '*'), second.key);
    await expect.poll(async () => (await requests()).length).toBe(3);
    expect(await page.evaluate(() => window.messages.some(m => m.type === 'modelThumbFailed'))).toBe(false);
    await page.screenshot({ path: test.info().outputPath('visible-thumbnail-queue.png') });
});

for (const cacheVersion of ['v10s', 'v11s', 'v12s', 'v13s', 'v14s']) {
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
        await expect.poll(() => vscode.recorded.commands.filter(entry => entry.command === 'wurst.openAssetFromString').length).toBe(1);
        expect(vscode.recorded.commands.find(entry => entry.command === 'wurst.openAssetFromString').command).toBe('wurst.openAssetFromString');
        expect(vscode.recorded.commands.find(entry => entry.command === 'wurst.openAssetFromString').args[0]).toBe('Units\\Human\\Footman\\Footman.mdx');
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
        await expect.poll(() => vscode.recorded.commands.filter(entry => entry.command === 'wurst.openAssetFromString').length).toBe(1);
        expect(vscode.recorded.commands.find(entry => entry.command === 'wurst.openAssetFromString').args[1].toString()).toBe(expected.toString());
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
