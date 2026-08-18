'use strict';

/**
 * The editable .wpm pathing-map editor.
 *
 * Painting happens on a canvas driven by real pointer events, so the assertions cross-check two
 * independent things after each gesture: the bytes the host now holds, and the pixel actually drawn
 * under the cursor. Either alone could pass while the editor is visibly broken.
 */

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');

const { parseWpm } = repoRequire('casc-ts/formats');

const NO_WALK = 0x02;
const NO_BUILD = 0x08;

/** Reads back the on-screen colour at a viewport-relative point, as rgb triplet. */
function pixelAt(page, x, y) {
    return page.evaluate(([px, py]) => {
        const canvas = document.getElementById('wpmCanvas');
        const rect = canvas.getBoundingClientRect();
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(
            Math.round((px - rect.left) * (canvas.width / rect.width)),
            Math.round((py - rect.top) * (canvas.height / rect.height)),
            1, 1,
        ).data;
        return [data[0], data[1], data[2]];
    }, [x, y]);
}

/** Clicks at the centre of the viewport with the given tool selected. */
async function paintAtViewportCentre(page, tool) {
    await page.click(`[data-tool="${tool}"]`);
    const box = await page.locator('#viewport').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    return { x, y };
}

test('renders the pathing grid with its dimensions and the blocked block from the fixture', async ({ openWpm }) => {
    const { page, host, pageErrors } = await openWpm();

    await expect(page.locator('header .meta')).toHaveText(/16 × 16/);
    await expect(page.locator('#wpmCanvas')).toBeVisible();
    expect(host.doc.file.width).toBe(16);
    expect(Array.from(host.doc.file.data).filter((v) => v === NO_WALK)).toHaveLength(16);
    expect(pageErrors).toEqual([]);
});

test('the dirty badge stays hidden until something is painted', async ({ openWpm }) => {
    const { page } = await openWpm();
    await expect(page.locator('#dirtyBadge')).toBeHidden();

    await page.click('[data-tool="paint"]');
    await expect(page.locator('#dirtyBadge')).toBeHidden();
});

test('painting a cell edits the document and repaints that pixel', async ({ openWpm }) => {
    const { page, host } = await openWpm();
    await page.click('#btnZoomFit');
    const before = Buffer.from(host.doc.file.data);
    const centre = await page.locator('#viewport').boundingBox();
    const blank = await pixelAt(page, centre.x + centre.width / 2, centre.y + centre.height / 2);

    const { x, y } = await paintAtViewportCentre(page, 'paint');

    await expect.poll(() => host.isDirty, { message: 'painting should dirty the document' }).toBe(true);
    await expect(page.locator('#dirtyBadge')).toBeVisible();

    const changed = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== host.doc.file.data[i]) changed.push(i);
    expect(changed, 'a single click should edit exactly one cell').toHaveLength(1);
    // The default brush is No Walk + No Build (see the checked boxes in buildWpmHtml).
    expect(host.doc.file.data[changed[0]]).toBe(NO_WALK | NO_BUILD);
    expect(host.editLabels).toEqual(['Paint 1 pathing cell']);

    // No Walk drives the red channel and No Build the blue one (see cellRgb in wpmPreview.ts); the
    // green channel is left to whatever the grid/background blend produces, so it isn't asserted.
    await expect.poll(() => pixelAt(page, x, y)).not.toEqual(blank);
    const [r, , b] = await pixelAt(page, x, y);
    expect([r, b]).toEqual([255, 255]);
});

test('undo and redo restore the painted cell in both the document and the canvas', async ({ openWpm }) => {
    const { page, host } = await openWpm();
    await page.click('#btnZoomFit');
    const before = Buffer.from(host.doc.file.data);
    const { x, y } = await paintAtViewportCentre(page, 'paint');
    await expect.poll(() => host.isDirty).toBe(true);
    const painted = await pixelAt(page, x, y);

    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
    expect(Buffer.compare(Buffer.from(host.doc.file.data), before)).toBe(0);
    await expect.poll(() => pixelAt(page, x, y)).not.toEqual(painted);
    await expect(page.locator('#dirtyBadge')).toBeHidden();

    host.redo();
    await expect.poll(() => host.isDirty).toBe(true);
    await expect.poll(() => pixelAt(page, x, y)).toEqual(painted);
});

test('a drag paints a line of cells as one undo step', async ({ openWpm }) => {
    const { page, host } = await openWpm();
    await page.click('#btnZoomFit');
    await page.click('[data-tool="paint"]');
    const box = await page.locator('#viewport').boundingBox();
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => host.editLabels.length).toBe(1);
    expect(host.editLabels[0]).toMatch(/^Paint \d+ pathing cells$/);
    const painted = Number(/Paint (\d+)/.exec(host.editLabels[0])[1]);
    expect(painted).toBeGreaterThan(1);

    // One drag is one undo step, however many cells it touched.
    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
});

test('the erase tool clears flags instead of painting them', async ({ openWpm }) => {
    const { page, host } = await openWpm();
    await page.click('#btnZoomFit');
    const centre = await page.locator('#viewport').boundingBox();
    const blank = await pixelAt(page, centre.x + centre.width / 2, centre.y + centre.height / 2);

    // Paint first so there is definitely something under the cursor to erase.
    const before = Buffer.from(host.doc.file.data);
    await paintAtViewportCentre(page, 'paint');
    await expect.poll(() => host.isDirty).toBe(true);
    const paintedIndex = Array.from(host.doc.file.data).findIndex((v, i) => v !== before[i]);
    expect(paintedIndex).toBeGreaterThanOrEqual(0);

    const { x, y } = await paintAtViewportCentre(page, 'erase');

    await expect.poll(() => host.editLabels.length).toBe(2);
    expect(host.editLabels[1]).toBe('Erase 1 pathing cell');
    expect(host.doc.file.data[paintedIndex]).toBe(0);
    await expect.poll(() => pixelAt(page, x, y)).toEqual(blank);
});

test('Alt+click picks up the brush flags from the cell under the cursor', async ({ openWpm }) => {
    const { page } = await openWpm();
    await page.click('#btnZoomFit');
    await paintAtViewportCentre(page, 'paint');

    await expect(page.locator('#brushValue')).toHaveText('0x0A');
    // Clear the brush, then pick it back up off the cell we just painted.
    await page.uncheck('[data-brush-bit="2"]');
    await page.uncheck('[data-brush-bit="8"]');
    await expect(page.locator('#brushValue')).toHaveText('0x00');

    const box = await page.locator('#viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Alt');

    await expect(page.locator('#brushValue')).toHaveText('0x0A');
    await expect(page.locator('[data-tool="paint"]')).toHaveClass(/active/);
});

test('saving writes bytes that re-parse to the painted map', async ({ openWpm }) => {
    const { page, host } = await openWpm();
    await page.click('#btnZoomFit');
    await paintAtViewportCentre(page, 'paint');
    await expect.poll(() => host.isDirty).toBe(true);

    await host.save();
    expect(host.isDirty).toBe(false);

    const reparsed = parseWpm(host.readFile());
    expect(reparsed.error).toBeUndefined();
    expect(reparsed.width).toBe(16);
    expect(reparsed.height).toBe(16);
    expect(Buffer.compare(reparsed.data, Buffer.from(host.doc.file.data))).toBe(0);
});

test('the zoom controls change the rendered scale', async ({ openWpm }) => {
    const { page } = await openWpm();
    await page.click('#btnZoomFit');
    const fitted = await page.locator('#zoomLabel').textContent();

    await page.click('#btnZoomIn');
    await expect(page.locator('#zoomLabel')).not.toHaveText(fitted);
    await page.click('#btnZoomFit');
    await expect(page.locator('#zoomLabel')).toHaveText(fitted);
});
