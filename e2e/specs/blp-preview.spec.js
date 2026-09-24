'use strict';

/**
 * The readonly image/model preview (BLP/DDS/TGA/MDX). Its page loads two bundles — mdxViewer.js
 * and blpPreviewWebview.js — under a nonce, so these also prove the shipped CSP admits both.
 * Model rendering needs WebGL and real model data and stays in the local tier; the raster path
 * and the shared toolbar run here.
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
