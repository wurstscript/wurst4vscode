'use strict';

/**
 * The editable .w3i map-info editor.
 *
 * The important contract here is the parse-prefix + opaque-tail model: only the leading string and
 * scalar fields are editable, everything after them (players, forces, lists) must come back out of a
 * save byte-for-byte. TRIGSTR-backed strings edit war3map.wts; inline strings edit the w3i itself.
 */

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');

const { parseW3i } = repoRequire('casc-ts/formats');

test('renders the map info, resolving TRIGSTR strings through war3map.wts', async ({ openW3i }) => {
    const { page, pageErrors } = await openW3i();

    await expect(page.locator('[data-field="name"]')).toHaveValue('E2E Map Name');
    await expect(page.locator('[data-field="author"]')).toHaveValue('Wurst E2E');
    await expect(page.locator('[data-select="tileset"]')).toHaveValue('L');

    // The pill is what tells the user this field lives in war3map.wts rather than in the w3i.
    const namePill = page.locator('label', { has: page.locator('[data-field="name"]') }).locator('.source-pill');
    await expect(namePill).toHaveText('TRIGSTR_001');
    await expect(page.locator('label', { has: page.locator('[data-field="author"]') }).locator('.source-pill')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
});

test('shows the display-only players and forces parsed out of the opaque tail', async ({ openW3i }) => {
    const { page } = await openW3i();
    const dialog = page.locator('.dialog');
    await expect(dialog).toContainText('Player 1 (Human)');
    await expect(dialog).toContainText('Player 2 (Computer)');
    await expect(dialog).toContainText('Force 1');
});

test('editing an inline string marks the document dirty and writes it into the w3i bytes', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    await expect(page.locator('#dirtyBadge')).toBeHidden();

    await page.fill('[data-field="author"]', 'Edited Author');
    await page.locator('[data-field="author"]').blur();

    await expect.poll(() => host.isDirty).toBe(true);
    await expect(page.locator('#dirtyBadge')).toBeVisible();
    expect(host.editLabels).toEqual(['Edit author']);

    await host.save();
    expect(host.isDirty).toBe(false);
    expect(parseW3i(host.readFile()).author).toBe('Edited Author');
});

test('editing a TRIGSTR-backed string writes war3map.wts, not the w3i bytes', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    const before = host.readFile();

    await page.fill('[data-field="name"]', 'Renamed By E2E');
    await page.locator('[data-field="name"]').blur();
    await expect.poll(() => host.isDirty).toBe(true);
    await host.save();

    // The w3i still holds the TRIGSTR reference; only the string table changed.
    const after = parseW3i(host.readFile());
    expect(after.name).toBe('TRIGSTR_001');
    expect(host.readText('war3map.wts')).toContain('Renamed By E2E');
    expect(Buffer.compare(before, host.readFile())).toBe(0);
});

test('a save preserves the opaque tail byte-for-byte', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    const tailBefore = parseW3i(host.readFile()).tail;

    await page.fill('[data-field="author"]', 'Tail Check');
    await page.locator('[data-field="author"]').blur();
    await expect.poll(() => host.isDirty).toBe(true);
    await host.save();

    const after = parseW3i(host.readFile());
    expect(Buffer.compare(after.tail, tailBefore), 'the opaque tail must round-trip unchanged').toBe(0);
    expect(after.players.map((p) => p.name)).toEqual(['Player 1 (Human)', 'Player 2 (Computer)']);
    expect(after.forces.map((f) => f.name)).toEqual(['Force 1']);
});

test('a flag checkbox toggles the right bit and undo restores it', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    const flagsBefore = host.doc.file.flags;

    const checkbox = page.locator('[data-flag]').first();
    const bit = Number(await checkbox.getAttribute('data-flag'));
    const wasOn = await checkbox.isChecked();
    await checkbox.setChecked(!wasOn);

    await expect.poll(() => host.doc.file.flags).toBe(wasOn ? flagsBefore & ~bit : flagsBefore | bit);
    expect(host.isDirty).toBe(true);

    host.undo();
    expect(host.doc.file.flags).toBe(flagsBefore);
    expect(host.isDirty).toBe(false);
});

test('changing the tileset select edits the scalar field', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    await page.selectOption('[data-select="tileset"]', 'N');

    await expect.poll(() => host.doc.file.tileset).toBe('N');
    await host.save();
    expect(parseW3i(host.readFile()).tileset).toBe('N');
});

test('re-entering the same value is not treated as an edit', async ({ openW3i }) => {
    const { page, host } = await openW3i();

    await page.fill('[data-field="author"]', 'Wurst E2E');
    await page.locator('[data-field="author"]').blur();
    await page.selectOption('[data-select="tileset"]', 'L');

    // A real edit right after proves the no-op ones were already delivered and ignored, rather than
    // merely still in flight — nothing changed, so the document must still be clean at that point.
    await page.fill('[data-field="author"]', 'Definitely Changed');
    await page.locator('[data-field="author"]').blur();
    await expect.poll(() => host.editLabels.length).toBe(1);
    host.undo();

    // Nothing else should have been recorded: otherwise every click-through of the form would leave
    // a spurious "unsaved" state and empty undo entries behind it.
    expect(host.editLabels).toEqual(['Edit author']);
    expect(host.isDirty).toBe(false);
    await expect(page.locator('#dirtyBadge')).toBeHidden();
});

test('the custom loading-screen model offers an "Open model" action', async ({ openW3i }) => {
    const { page, host } = await openW3i();
    const button = page.locator('[data-open-asset]');
    await expect(button).toHaveAttribute('data-open-asset', 'war3mapImported\\LoadingScreen.mdx');

    await button.click();
    // The host answers by trying to open the asset; with nothing to resolve it reports back rather
    // than failing silently.
    await expect
        .poll(() => host.vscodeMock.recorded.warnings.length + host.vscodeMock.recorded.info.length +
            host.vscodeMock.recorded.errors.length + host.vscodeMock.recorded.commands.length)
        .toBeGreaterThan(0);
});
