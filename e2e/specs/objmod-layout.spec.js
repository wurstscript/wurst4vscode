'use strict';

/**
 * Layout contracts that only a real browser can check: the splitter's clamping and ARIA, the
 * side-by-side -> stacked fallback driven by the ResizeObserver, the two density scales, and the
 * settings-driven tooltip width.
 *
 * These assert on computed layout (bounding boxes, resolved CSS variables) rather than on markup, so
 * a CSS change that visually breaks the editor fails here even when the DOM is untouched.
 */

const { test, expect } = require('../fixtures');

const LIST_MIN_PX = 130;
const LIST_MAX_RATIO = 0.46;

const listWidth = (page) => page.locator('.object-list').evaluate((el) => el.getBoundingClientRect().width);
const editorWidth = (page) => page.locator('#object-editor').evaluate((el) => el.getBoundingClientRect().width);

test('the browse list sits beside the details pane at a normal width', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const list = await page.locator('.object-list').boundingBox();
    const details = await page.locator('#details').boundingBox();

    expect(details.x).toBeGreaterThanOrEqual(list.x + list.width - 1);
    await expect(page.locator('#object-editor')).not.toHaveClass(/narrow/);
    expect(list.width).toBeGreaterThan(LIST_MIN_PX);
});

test('the splitter resizes with the keyboard, clamps, and reports its range via ARIA', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const splitter = page.locator('#splitter');

    await splitter.focus();
    const before = await listWidth(page);
    await splitter.press('ArrowRight');
    await splitter.press('ArrowRight');
    await expect.poll(() => listWidth(page)).toBeGreaterThan(before);

    // Home/End must land exactly on the documented bounds, not merely near them.
    await splitter.press('Home');
    await expect.poll(() => listWidth(page)).toBeCloseTo(LIST_MIN_PX, 0);
    await expect(splitter).toHaveAttribute('aria-valuenow', String(LIST_MIN_PX));

    await splitter.press('End');
    const max = Math.round((await editorWidth(page)) * LIST_MAX_RATIO);
    await expect.poll(async () => Math.round(await listWidth(page))).toBeCloseTo(max, -1);
    await expect(splitter).toHaveAttribute('aria-valuemin', String(LIST_MIN_PX));
    await expect(splitter).toHaveAttribute('aria-valuemax', String(max));
});

test('a dragged splitter width is persisted and restored', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();
    const splitter = page.locator('#splitter');
    const box = await splitter.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const dragged = await listWidth(page);
    expect(dragged).toBeGreaterThan(LIST_MIN_PX);

    await gotoHtml(await host.rerender());
    await expect.poll(() => listWidth(page)).toBeCloseTo(dragged, 0);
});

test('a very narrow editor stacks the list above the details pane', async ({ openObjMod, page }) => {
    await openObjMod();
    // Below NARROW_LAYOUT_PX (440) the ResizeObserver flips the editor into its stacked fallback.
    await page.setViewportSize({ width: 400, height: 800 });

    await expect(page.locator('#object-editor')).toHaveClass(/narrow/);
    const list = await page.locator('.object-list').boundingBox();
    const details = await page.locator('#details').boundingBox();
    expect(details.y).toBeGreaterThanOrEqual(list.y + list.height - 1);

    // ...and widening again restores side-by-side, rather than sticking in the fallback.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#object-editor')).not.toHaveClass(/narrow/);
});

test('the density toggle switches the spacing scale and persists it', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();
    const toggle = page.locator('#density-toggle');
    const rowHeight = () => page.locator('#tree .object-row').first().evaluate((el) => el.getBoundingClientRect().height);

    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    const compact = await rowHeight();

    await toggle.click();
    await expect(page.locator('body')).toHaveClass(/density-cozy/);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(rowHeight, { message: 'cozy rows should be taller than compact ones' }).toBeGreaterThan(compact);

    await gotoHtml(await host.rerender());
    await expect(page.locator('body')).toHaveClass(/density-cozy/);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(page.locator('body')).not.toHaveClass(/density-cozy/);
    await expect.poll(rowHeight).toBeCloseTo(compact, 0);
});

test('wurst.objModTooltipWidth drives the tooltip box width and is clamped to its setting range', async ({ openObjMod }) => {
    const { page } = await openObjMod({ config: { 'wurst.objModTooltipWidth': 420 } });
    await expect(page.locator('#tree .object-row').first()).toBeVisible();

    const width = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--wc3-tip-width').trim());
    expect(width).toBe('420px');
});

test('an out-of-range tooltip width setting falls back to the allowed maximum', async ({ openObjMod }) => {
    const { page } = await openObjMod({ config: { 'wurst.objModTooltipWidth': 99999 } });
    await expect(page.locator('#tree .object-row').first()).toBeVisible();

    const width = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--wc3-tip-width').trim());
    expect(width).toBe('1200px');
});

test('the field table never forces the page into a horizontal scroll', async ({ openObjMod, page }) => {
    await openObjMod();
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);

    for (const width of [1280, 900, 640, 420]) {
        await page.setViewportSize({ width, height: 800 });
        const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `page should not scroll horizontally at ${width}px`).toBeLessThanOrEqual(1);
    }
});
