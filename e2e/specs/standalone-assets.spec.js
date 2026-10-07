'use strict';

const path = require('path');
const fs = require('fs');
const { test, expect, root } = require('../fixtures');
const { createTsLoader } = require('../harness/tsLoader');
const { createVscodeMock, fileUri } = require('../harness/vscodeMock');

test('standalone browser opens assets without an editor, workspace or replacement target', async ({ page, server }) => {
    const vscode = createVscodeMock();
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
        'src/features/imageAssetSupport.ts': { getCandidateRoots: async () => [], gatherImportedAssets: async () => { throw new Error('No document to scan'); } },
        'src/features/preview/modelPreviewHost.ts': { handleModelThumbMessage: async () => true },
    } });
    await load('src/features/assetLinks.ts').openAssetBrowser({ extensionUri: fileUri(root) });
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
