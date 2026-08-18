'use strict';

/**
 * Field table: filters, the technical view, and the full edit round-trip — webview edit -> host
 * document edit -> undo/redo -> save -> bytes on disk that re-parse to the edited value.
 *
 * Assertions deliberately key off field *ids* and values that come from the fixture file, never off
 * game-data labels: labels resolve through WorldEditStrings in CASC, so they differ between a machine
 * with Warcraft III installed and CI, while ids and overrides are identical everywhere.
 */

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');

const { parseObjMod } = repoRequire('casc-ts/formats');

/** Selects a custom object by rawcode and waits for its field rows to land. */
async function selectObject(page, rawcode) {
    await page.fill('#search', rawcode);
    await page.locator('#tree .object-row', { has: page.locator('.object-id', { hasText: rawcode }) }).first().click();
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);
}

/** The row for a given field id, found via technical mode's id column. */
function rowForField(page, fieldId) {
    return page.locator('#details tbody tr', { has: page.locator(`td.id:text-is("${fieldId}")`) });
}

test('technical mode swaps in the id/type columns and back', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await expect(page.locator('#details thead th')).toHaveText(['Field', 'Value']);

    await page.check('#technical-toggle');
    await expect(page.locator('#details thead th')).toHaveText(['Field', 'Label', 'Group', 'Type', 'Value']);
    await expect(page.locator('#details tbody td.id').first()).toHaveText(/^[a-zA-Z0-9]{4}$/);

    await page.uncheck('#technical-toggle');
    await expect(page.locator('#details thead th')).toHaveText(['Field', 'Value']);
});

test('"modified only" narrows the table to overridden rows', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');

    const total = await page.locator('#details tbody tr:not(.category-row)').count();
    const overridden = await page.locator('#details tbody tr.overridden').count();
    expect(overridden).toBeGreaterThan(0);
    expect(overridden).toBeLessThan(total);

    await page.check('#hide-unmodified-toggle');
    const visible = page.locator('#details tbody tr:not(.category-row):not(.hidden)');
    await expect(visible).toHaveCount(overridden);
    for (const cls of await visible.evaluateAll((rows) => rows.map((r) => r.className))) {
        expect(cls).toContain('overridden');
    }
});

test('"hide empty" removes rows whose value is blank or WC3\'s "-" placeholder', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');

    const emptyRows = page.locator('#details tbody tr[data-empty="1"]');
    expect(await emptyRows.count()).toBeGreaterThan(0);

    await page.check('#hide-empty-toggle');
    await expect(page.locator('#details tbody tr[data-empty="1"]:not(.hidden)')).toHaveCount(0);
    await expect(page.locator('#details tbody tr[data-empty="0"]:not(.hidden)')).not.toHaveCount(0);
});

test('field search filters rows and reports how many matched', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    const before = await page.locator('#details tbody tr:not(.category-row):not(.hidden)').count();
    await page.fill('#field-search', 'ugol');

    // The field search is fuzzy (same scorer as the object search), so it narrows rather than
    // pinpoints — the contract is that it shrinks the table, keeps the exact match, and says how many.
    await expect(page.locator('#field-match')).toHaveText(/^\d+ match(es)?$/);
    const visible = page.locator('#details tbody tr:not(.category-row):not(.hidden)');
    const after = await visible.count();
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    await expect(visible.locator('td.id:text-is("ugol")')).toHaveCount(1);

    await page.fill('#field-search', '');
    await expect(page.locator('#details tbody tr:not(.category-row):not(.hidden)')).toHaveCount(before);
});

test('the category filter hides a whole category and shows a count badge', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');

    await page.click('#cat-filter-btn');
    await expect(page.locator('#cat-filter-pop')).toBeVisible();
    const firstCat = page.locator('#cat-filter-pop input[type="checkbox"]').first();
    const catKey = await firstCat.getAttribute('data-cat');
    await firstCat.uncheck();

    await expect(page.locator(`#details tbody tr[data-cat="${catKey}"]:not(.hidden)`)).toHaveCount(0);
    await expect(page.locator('#cat-filter-btn')).toContainText('1');

    await page.click('#cat-filter-none');
    await expect(page.locator('#details tbody tr:not(.category-row):not(.hidden)')).toHaveCount(0);
    await page.click('#cat-filter-all');
    await expect(page.locator('#details tbody tr:not(.category-row):not(.hidden)')).not.toHaveCount(0);
});

test('editing an int field posts the edit, marks the document dirty, and survives undo/redo', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    const goldRow = rowForField(page, 'ugol');
    await expect(goldRow).toHaveCount(1);
    await goldRow.locator('.cell-edit').click();

    const input = goldRow.locator('input.num-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('25');
    await input.fill('137');
    await input.blur();

    await expect.poll(() => host.isDirty, { message: 'the host document should be dirty' }).toBe(true);
    await expect(page.locator('#editable-badge')).toHaveText('● unsaved');
    expect(host.editLabels).toEqual(['Edit ugol']);
    await expect(goldRow.locator('.cell-edit-val')).toContainText('137');

    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
    await expect(goldRow.locator('.cell-edit-val')).toContainText('25');

    host.redo();
    await expect.poll(() => host.isDirty).toBe(true);
    await expect(goldRow.locator('.cell-edit-val')).toContainText('137');
});

test('the number steppers respect the field varType', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    // ua1c (Attack 1 cooldown) is an `unreal`, so it steps in 0.05 and clamps at zero rather than
    // going negative; ugol is an `int` and steps by whole numbers.
    const cooldown = rowForField(page, 'ua1c');
    await cooldown.locator('.cell-edit').click();
    const cooldownInput = cooldown.locator('input.num-input');
    await expect(cooldownInput).toHaveAttribute('data-num-step', '0.05');
    await cooldownInput.fill('0');
    await cooldown.locator('.num-step[data-dir="-1"]').click();
    await expect(cooldownInput).toHaveValue('0');

    const gold = rowForField(page, 'ugol');
    await gold.locator('.cell-edit').click();
    const goldInput = gold.locator('input.num-input');
    await expect(goldInput).toHaveAttribute('data-num-step', '1');
    await goldInput.fill('10');
    await gold.locator('.num-step[data-dir="1"]').click();
    await expect(goldInput).toHaveValue('11');
});

test('saving writes bytes that re-parse to the edited value', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    const goldRow = rowForField(page, 'ugol');
    await goldRow.locator('.cell-edit').click();
    await goldRow.locator('input.num-input').fill('4242');
    await goldRow.locator('input.num-input').blur();
    await expect.poll(() => host.isDirty).toBe(true);

    await host.save();
    expect(host.isDirty).toBe(false);

    const reparsed = parseObjMod(host.readFile(), '.w3u');
    const entry = reparsed.customObjs.find((obj) => obj.newId === 'h004');
    expect(entry, 'h004 should still exist after the save').toBeTruthy();
    const gold = entry.mods.find((mod) => mod.fieldId === 'ugol');
    expect(gold, 'the edited field should be written as an override').toBeTruthy();
    expect(String(gold.value)).toBe('4242');
});

test('Ctrl+S in the webview saves through the host', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    const row = rowForField(page, 'ufoo');
    await row.locator('.cell-edit').click();
    await row.locator('input.num-input').fill('9');
    // No blur: Ctrl+S has to commit the focused editor itself (commitActiveEditor) before saving,
    // otherwise the in-progress edit is silently dropped.
    await page.keyboard.press('Control+s');

    await expect.poll(() => host.isDirty, { message: 'Ctrl+S should have saved' }).toBe(false);
    const entry = parseObjMod(host.readFile(), '.w3u').customObjs.find((obj) => obj.newId === 'h004');
    expect(String(entry.mods.find((mod) => mod.fieldId === 'ufoo').value)).toBe('9');
});

test('a rawcode reference chip inside a field jumps to that object', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');

    // ubui (Structures Built) is a rawcode list; every id the file also defines becomes a jump chip.
    const chip = rowForField(page, 'ubui').locator('.resolved-chip[data-jump]').first();
    await expect(chip).toBeVisible();
    const target = await chip.getAttribute('data-jump');
    await chip.click();

    await expect(page.locator(`#tree .object-row[data-key="${target}"]`)).toHaveClass(/active/);
});

test('field-table state (technical, filters) is restored after a reload', async ({ openObjMod }) => {
    const { page, host, gotoHtml } = await openObjMod();
    await selectObject(page, 'h004');
    await page.check('#technical-toggle');
    await page.check('#hide-unmodified-toggle');
    await page.fill('#field-search', 'ugol');
    const filtered = await page.locator('#details tbody tr:not(.category-row):not(.hidden)').count();

    await gotoHtml(await host.rerender());

    await expect(page.locator('#technical-toggle')).toBeChecked();
    await expect(page.locator('#hide-unmodified-toggle')).toBeChecked();
    await expect(page.locator('#field-search')).toHaveValue('ugol');
    await expect(page.locator('#details tbody tr:not(.category-row):not(.hidden)')).toHaveCount(filtered);
});
