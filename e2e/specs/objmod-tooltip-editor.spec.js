'use strict';

/**
 * The in-place WC3 tooltip editor: the rich/raw editing box, its floating toolbar, and the colour
 * palette (presets, colours already used in the text, and the saved custom colours that round-trip
 * through the host's globalState).
 */

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');

const { parseObjMod } = repoRequire('casc-ts/formats');

const CUSTOM_COLORS_KEY = 'wurst.objModCustomColors.v1';

async function selectObject(page, rawcode) {
    await page.fill('#search', rawcode);
    await page.locator('#tree .object-row', { has: page.locator('.object-id', { hasText: rawcode }) }).first().click();
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);
}

/**
 * Opens a colour-capable field's in-place editor and returns its parts. Picks a field that already
 * has text: an empty contenteditable box has no layout height, which makes visibility assertions
 * meaningless and hides real regressions behind "element not visible".
 */
async function openTooltipEditor(page, rawcode = 'h004') {
    await selectObject(page, rawcode);
    const collapsed = page.locator('#details .tt-collapsed[data-mi]')
        .filter({ hasNot: page.locator('.tt-empty') })
        .first();
    await expect(collapsed).toBeVisible();
    await collapsed.click();
    const body = page.locator('.tt-collapsed-body[contenteditable="true"]');
    await expect(body).toBeVisible();
    return { collapsed, body, toolbar: page.locator('.tt-float-toolbar') };
}

test('clicking a tooltip field opens an in-place editor with a floating toolbar', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const { collapsed, body, toolbar } = await openTooltipEditor(page);

    await expect(collapsed).toHaveClass(/tt-editing/);
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('.tt-raw-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(body).toHaveAttribute('contenteditable', 'true');

    // The toolbar floats over the page but must stay beside the box it is editing, not off-screen.
    const boxRect = await page.locator('.tt-collapsed-box').first().boundingBox();
    const toolbarRect = await toolbar.boundingBox();
    expect(toolbarRect.x + toolbarRect.width).toBeGreaterThan(0);
    expect(toolbarRect.y).toBeLessThan(boxRect.y + boxRect.height + 200);
});

test('the Raw toggle swaps to a textarea holding the WC3 source and back', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const { body, toolbar } = await openTooltipEditor(page);

    await body.click();
    await page.keyboard.type('Hello');
    await toolbar.locator('.tt-raw-toggle').click();

    const raw = page.locator('textarea.tt-collapsed-raw');
    await expect(raw).toBeVisible();
    await expect(body).toBeHidden();
    await expect(toolbar.locator('.tt-raw-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await raw.inputValue()).toContain('Hello');

    await toolbar.locator('.tt-raw-toggle').click();
    await expect(body).toBeVisible();
    await expect(raw).toBeHidden();
    await expect(body).toContainText('Hello');
});

test('typing colour codes in raw mode updates the "used colours" swatches live', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);

    const used = toolbar.locator('.tt-used-colors');
    await toolbar.locator('.tt-raw-toggle').click();
    const raw = page.locator('textarea.tt-collapsed-raw');

    await raw.fill('|cff00ff00Green|r and |cffff0000Red|r');
    await expect(used.locator('.tt-used-sw')).toHaveCount(2);
    await expect(used.locator('.tt-used-sw').nth(0)).toHaveAttribute('data-color', '00ff00');
    await expect(used.locator('.tt-used-sw').nth(1)).toHaveAttribute('data-color', 'ff0000');

    // Adding a third colour has to show up without reopening the editor — the whole point of the
    // live refresh (the group used to reflect only the value from when editing started).
    await raw.fill('|cff00ff00Green|r |cffff0000Red|r |cff0000ffBlue|r');
    await expect(used.locator('.tt-used-sw')).toHaveCount(3);

    // ...and removing them again has to empty *and* hide the group, not leave a stray divider.
    await raw.fill('no colours here');
    await expect(used.locator('.tt-used-sw')).toHaveCount(0);
    await expect(used).toBeHidden();
});

test('an escaped "||" is not mistaken for a colour code', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-raw-toggle').click();

    await page.locator('textarea.tt-collapsed-raw').fill('||cffabcdefnot a colour |cff123456yes|r');
    const used = toolbar.locator('.tt-used-colors');
    await expect(used.locator('.tt-used-sw')).toHaveCount(1);
    await expect(used.locator('.tt-used-sw')).toHaveAttribute('data-color', '123456');
});

test('a used-colour swatch re-applies that colour to the selection', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-raw-toggle').click();
    const raw = page.locator('textarea.tt-collapsed-raw');

    await raw.fill('|cff00ff00Green|r plain');
    await expect(toolbar.locator('.tt-used-sw')).toHaveCount(1);
    // Select the word "plain" so the swatch has something to wrap.
    await raw.evaluate((el) => { el.focus(); el.setSelectionRange(el.value.length - 5, el.value.length); });
    await toolbar.locator('.tt-used-sw').first().click();

    await expect.poll(() => raw.inputValue()).toContain('|cff00ff00plain|r');
    await expect.poll(() => host.editLabels.length).toBeGreaterThan(0);
});

test('a preset swatch wraps the selection and the popover closes', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-raw-toggle').click();
    const raw = page.locator('textarea.tt-collapsed-raw');
    await raw.fill('Colour me');
    await raw.evaluate((el) => { el.focus(); el.setSelectionRange(0, 6); });

    await toolbar.locator('.tt-color-sq').click();
    const pop = toolbar.locator('.tt-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.tt-palette-label').first()).toHaveText('Presets');
    await expect(pop.locator('.tt-swatches .tt-sw')).not.toHaveCount(0);

    await pop.locator('.tt-sw[data-color="ff0303"]').click();
    await expect(pop).toBeHidden();
    await expect.poll(() => raw.inputValue()).toContain('|cffff0303Colour|r');
});

test('the Saved palette is hidden until a custom colour is picked, then persists to the host', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-raw-toggle').click();
    await page.locator('textarea.tt-collapsed-raw').fill('Custom');

    await toolbar.locator('.tt-color-sq').click();
    const pop = toolbar.locator('.tt-pop');
    await expect(pop.locator('.tt-custom-colors')).toBeHidden();

    // The native colour input only emits `change` on commit, which Playwright cannot click through
    // in the OS picker — set the value and fire the event the browser would.
    await pop.locator('input.tt-color').evaluate((el) => {
        el.value = '#123456';
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expect
        .poll(() => host.globalState.get(CUSTOM_COLORS_KEY), { message: 'the host should persist the picked colour' })
        .toEqual(['123456']);
});

test('saved custom colours come back in the palette after a reload', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod({
        globalState: { [CUSTOM_COLORS_KEY]: ['123456', 'abcdef'] },
    });

    await gotoHtml(host.html);
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-color-sq').click();

    const custom = toolbar.locator('.tt-pop .tt-custom-colors');
    await expect(custom).toBeVisible();
    await expect(custom.locator('.tt-palette-label')).toHaveText('Saved');
    await expect(custom.locator('.tt-custom-sw')).toHaveCount(2);
    await expect(custom.locator('.tt-custom-sw').nth(0)).toHaveAttribute('data-color', '123456');
});

test('the saved-palette spacing follows the density scale', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod({
        globalState: { [CUSTOM_COLORS_KEY]: ['123456'] },
    });
    await gotoHtml(host.html);

    // Clicking the density toggle is a click outside the editor, which closes it and takes the
    // floating toolbar with it — so each density is measured on a freshly opened palette.
    const measurePalette = async () => {
        const { toolbar } = await openTooltipEditor(page);
        await toolbar.locator('.tt-color-sq').click();
        const spacing = await toolbar.locator('.tt-pop .tt-custom-colors').evaluate((el) => {
            const style = getComputedStyle(el);
            return { gap: parseFloat(style.rowGap), pad: parseFloat(style.paddingTop) };
        });
        await page.keyboard.press('Escape');
        return spacing;
    };

    const compact = await measurePalette();
    await page.click('#density-toggle');
    await expect(page.locator('body')).toHaveClass(/density-cozy/);

    // Hard-coded px here would leave this corner of the toolbar on the compact scale while the rest
    // of the editor switched — the whole point of the :root / body.density-cozy variable pair.
    const cozy = await measurePalette();
    expect(cozy.gap).toBeGreaterThan(compact.gap);
    expect(cozy.pad).toBeGreaterThan(compact.pad);
});

test('a preset colour is never duplicated into the saved palette', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod({
        // ffcc00 is the "Gold" preset; only the non-preset colour should be kept.
        globalState: { [CUSTOM_COLORS_KEY]: ['ffcc00', '654321'] },
    });
    await gotoHtml(host.html);
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-color-sq').click();

    const custom = toolbar.locator('.tt-pop .tt-custom-colors');
    await expect(custom.locator('.tt-custom-sw')).toHaveCount(1);
    await expect(custom.locator('.tt-custom-sw')).toHaveAttribute('data-color', '654321');
});

test('Escape reverts an in-place edit and leaves the document clean', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    const { collapsed, body } = await openTooltipEditor(page);
    const mi = await collapsed.getAttribute('data-mi');
    const before = (await body.textContent()).trim();
    expect(before).not.toBe('');

    await body.click();
    await page.keyboard.type('scratch that');
    await page.keyboard.press('Escape');

    await expect(page.locator('.tt-collapsed-body[contenteditable="true"]')).toHaveCount(0);
    await expect(page.locator(`#details .tt-collapsed[data-mi="${mi}"] .tt-collapsed-body`)).toHaveText(before);
    expect(host.isDirty).toBe(false);
});

test('an edited tooltip is written back as WC3 colour markup on save', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    const { toolbar } = await openTooltipEditor(page);
    await toolbar.locator('.tt-raw-toggle').click();
    await page.locator('textarea.tt-collapsed-raw').fill('|cffffcc00E2E Tooltip|r');

    await expect.poll(() => host.isDirty, { message: 'editing should dirty the document' }).toBe(true);
    await host.save();

    const written = parseObjMod(host.readFile(), '.w3u');
    const values = written.customObjs
        .flatMap((entry) => entry.mods)
        .map((mod) => String(mod.value));
    expect(values).toContain('|cffffcc00E2E Tooltip|r');
});
