'use strict';

/**
 * The readonly image/model preview (BLP/DDS/TGA/MDX). Its page loads two bundles — mdxViewer.js
 * and blpPreviewWebview.js — under a nonce, so these also prove the shipped CSP admits both.
 * Covers the raster path, the model path (headless Chromium's WebGL) with its texture round trip,
 * and the shared toolbar.
 */

const { test, expect } = require('../fixtures');

function pixel(page, x, y) {
    return page.evaluate(([px, py]) => {
        const canvas = document.getElementById('canvas2d');
        return Array.from(canvas.getContext('2d').getImageData(px, py, 1, 1).data);
    }, [x, y]);
}

test('renders a TGA with its dimensions and alpha under a nonce-only CSP', async ({ openBlpPreview }) => {
    const { page, host, pageErrors, consoleErrors } = await openBlpPreview();

    expect(host.html).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(host.html).not.toMatch(/<script nonce="[^"]+">/); // no inline script bodies left

    await expect(page.locator('#fileName')).toHaveText('swatch.tga');
    await expect(page.locator('#fileMeta')).toHaveText(/8 × 4/);
    await expect(page.locator('#loadingOverlay')).not.toHaveClass(/visible/);
    expect(await page.evaluate(() => typeof window.War3Viewer)).toBe('object');

    const size = await page.evaluate(() => {
        const canvas = document.getElementById('canvas2d');
        return [canvas.width, canvas.height];
    });
    expect(size).toEqual([8, 4]);
    expect(await pixel(page, 0, 0)).toEqual([255, 0, 0, 255]);
    expect((await pixel(page, 7, 0))[3]).toBe(0);

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test('a model loads and every texture it requests is answered by the host', async ({ openBlpPreview }) => {
    const { page, host, pageErrors, consoleErrors } = await openBlpPreview({ copyFrom: 'wc3data/melon.mdx' });

    await expect(page.locator('#fileMeta')).toHaveText(/geosets: \d+ · textures: \d+/);
    await expect(page.locator('#sidebar')).toHaveClass(/visible/);
    await expect(page.locator('#zoomLabel')).toHaveText('3D');
    await expect(page.locator('#resetCamBtn')).toBeVisible();
    await expect(page.locator('#fitBtn')).toBeHidden();

    // requestTextures goes webview → handleModelThumbMessage → one mdxTexture reply per path.
    // Whether a texture resolves depends on local game data, so only the round trip is asserted.
    const requested = await page.locator('.tex-item').evaluateAll((items) => items.map((item) => item.dataset.path));
    expect(requested.length).toBeGreaterThan(0);
    await expect.poll(() => requested.filter((texPath) => !host.posted.some((m) => m.type === 'mdxTexture' && m.path === texPath)))
        .toEqual([]);
    for (const texPath of requested) {
        const reply = host.posted.find((m) => m.type === 'mdxTexture' && m.path === texPath);
        const item = page.locator(`.tex-item[data-path="${texPath.replace(/\\/g, '\\\\')}"]`);
        if (reply.resolvedFsPath) await expect(item.locator('a')).toHaveText(texPath.split(/[\\/]/).pop());
        else await expect(item).toHaveClass(/missing/);
    }

    await page.click('#renderModeBtn');
    await expect(page.locator('#renderModeBtn')).toHaveText('Wire');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
});

test('toolbar zooms, fits and toggles alpha; model-only controls stay hidden', async ({ openBlpPreview }) => {
    const { page } = await openBlpPreview();
    await expect(page.locator('#fileMeta')).toHaveText(/8 × 4/);

    await expect(page.locator('#resetCamBtn')).toBeHidden();
    await expect(page.locator('#renderModeBtn')).toBeHidden();
    await expect(page.locator('#zoomLabel')).toHaveText('100%');

    await page.click('#zoomInBtn');
    await expect(page.locator('#zoomLabel')).toHaveText('120%');
    await page.click('#fitBtn');
    // An 8×4 swatch fitted to the viewport is enlarged far past 100%.
    expect(parseInt(await page.locator('#zoomLabel').textContent(), 10)).toBeGreaterThan(1000);

    await expect(page.locator('#alphaBtn')).toHaveClass(/active/);
    await page.click('#alphaBtn');
    await expect(page.locator('#viewport')).toHaveClass(/alpha-off/);
    await expect(page.locator('#alphaBtn')).not.toHaveClass(/active/);
});
