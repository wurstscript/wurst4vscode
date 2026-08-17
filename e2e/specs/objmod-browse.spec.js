'use strict';

/**
 * Browse list: rendering, search, selection, and the state that has to survive a webview reload.
 */

const { test, expect } = require('../fixtures');

/** Rows only exist for expanded branches, so "all objects" means expanding everything first. */
async function expandAll(page) {
    for (let i = 0; i < 6; i++) {
        const collapsed = page.locator('#tree [aria-expanded="false"]');
        const count = await collapsed.count();
        if (!count) break;
        for (let n = 0; n < count; n++) await collapsed.nth(0).click();
    }
}

test('renders a grouped tree and selects the first object with its field rows', async ({ openObjMod }) => {
    const { page, host, pageErrors } = await openObjMod();

    await expect(page.locator('#tree .object-row').first()).toBeVisible();
    await expect(page.locator('.md-meta')).toContainText('123 objects');

    // The first object is selected on open and its fields are requested from the host, not shipped
    // in the initial payload — that laziness is the whole point of the details protocol.
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);
    expect(host.posted.some((m) => m.type === 'objectDetailsLoaded')).toBe(true);
    expect(pageErrors).toEqual([]);
});

test('search filters the tree, reports a match count, and the clear button restores it', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await expandAll(page);
    const allRows = await page.locator('#tree .object-row').count();
    expect(allRows).toBe(123);

    await page.fill('#search', 'peasant');
    await expect(page.locator('#search-match')).toHaveText(/^\d+ of 123$/);
    const matched = Number((await page.locator('#search-match').textContent()).split(' ')[0]);
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThan(allRows);
    for (const name of await page.locator('#tree .object-row .object-name').allTextContents()) {
        expect(name.toLowerCase()).toContain('peasant');
    }

    await page.click('#search-clear');
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.locator('#search-match')).toHaveText('');
    await expandAll(page);
    expect(await page.locator('#tree .object-row').count()).toBe(allRows);
});

test('search finds an object by its rawcode', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await expandAll(page);
    const allRows = await page.locator('#tree .object-row').count();

    // The matcher is fuzzy (see matchScore in objectTree.ts), so a rawcode query narrows rather than
    // pinpoints — what matters is that the exact object survives the filter and the list shrinks.
    await page.fill('#search', 'h004');
    await expandAll(page);
    const matched = await page.locator('#tree .object-row').count();
    expect(matched).toBeLessThan(allRows);
    await expect(page.locator('#tree .object-row .object-id', { hasText: 'h004' }).first()).toBeVisible();
});

test('a query that excludes the selected object moves the selection into the results', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await page.fill('#search', 'peasant');
    await expect(page.locator('#tree .object-row.active')).toHaveCount(1);
    const activeName = await page.locator('#tree .object-row.active .object-name').textContent();
    expect(activeName.toLowerCase()).toContain('peasant');
});

test('clicking an object switches the details panel and tells the host the new selection', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await page.fill('#search', 'militia');
    const row = page.locator('#tree .object-row').first();
    const label = await row.locator('.object-name').textContent();
    await row.click();

    await expect(page.locator('#details .details-title')).toContainText(label.trim());
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);

    // The host persists selection by stable rawcode identity, not by array index (see
    // rememberSelection/objModSelectionPathKey) — that is what survives Git reordering the file.
    await expect
        .poll(() => host.doc.selectedIdentity, { message: 'host should have stored the selection identity' })
        .toBeTruthy();
});

test('selection, search text and density survive a webview reload', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();

    await page.fill('#search', 'militia');
    await page.locator('#tree .object-row').first().click();
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);
    await page.click('#density-toggle');
    await expect(page.locator('body')).toHaveClass(/density-cozy/);
    const selectedBefore = await page.locator('#tree .object-row.active .object-id').textContent();

    // Same thing the host's own external-change auto-reload does: rebuild the HTML and re-navigate.
    await gotoHtml(await host.rerender());

    await expect(page.locator('#search')).toHaveValue('militia');
    await expect(page.locator('body')).toHaveClass(/density-cozy/);
    await expect(page.locator('#tree .object-row.active .object-id')).toHaveText(selectedBefore);
});

test('collapsing a tree branch persists across a reload', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();

    const heading = page.locator('#tree [aria-expanded="true"]').first();
    const nodeKey = await heading.getAttribute('data-node');
    await heading.click();
    await expect(page.locator(`#tree [data-node="${nodeKey}"]`)).toHaveAttribute('aria-expanded', 'false');

    await gotoHtml(await host.rerender());
    await expect(page.locator(`#tree [data-node="${nodeKey}"]`)).toHaveAttribute('aria-expanded', 'false');
});

test('tree scroll position is restored on reload', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();
    await expandAll(page);

    await page.locator('#tree').evaluate((el) => { el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(() => page.locator('#tree').evaluate((el) => el.scrollTop)).toBeGreaterThan(300);

    await gotoHtml(await host.rerender());
    await expect
        .poll(() => page.locator('#tree').evaluate((el) => el.scrollTop), { message: 'tree scroll should be restored' })
        .toBeGreaterThan(300);
});
