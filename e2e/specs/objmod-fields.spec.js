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
const fs = require('fs');
const path = require('path');

const { parseObjMod, serializeObjMod } = repoRequire('casc-ts/formats');

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

test('creating a custom object requires a base, accepts an optional rawcode, and round-trips through undo/save', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await expect(page.locator('#add-object')).toBeVisible();
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-overlay')).toBeVisible();

    // The selector is populated from stock game data; its placeholder is followed by real base objects.
    expect(await page.locator('#add-object-base option').count()).toBeGreaterThan(1);
    await page.locator('#add-object-base').selectOption({ index: 1 });
    await page.locator('#add-object-id').fill('h004');
    await page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit());
    await expect(page.locator('#add-object-error')).toHaveText('That rawcode is already in use.');
    expect(host.isDirty).toBe(false);

    await page.locator('#add-object-id').fill('Z901');
    await Promise.all([
        page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit()),
        page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit()),
    ]);

    await expect.poll(() => host.isDirty).toBe(true);
    expect(host.editLabels).toEqual(['Create Z901']);
    await expect(page.locator('#tree .object-row', { hasText: 'Z901' })).toHaveCount(1);

    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
    await expect(page.locator('#tree .object-row', { hasText: 'Z901' })).toHaveCount(0);

    host.redo();
    await expect(page.locator('#tree .object-row', { hasText: 'Z901' })).toHaveCount(1);
    await host.save();
    const created = parseObjMod(host.readFile(), '.w3u').customObjs.find((obj) => obj.newId === 'Z901');
    expect(created, 'created custom object should be serialized').toBeTruthy();
    expect(created.mods).toEqual([]);
});

test('creating an object without a rawcode generates, reverts, and saves a collision-free id', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    const initialObjectCount = await page.locator('#tree .object-row').count();
    await page.locator('#add-object').click();

    // The native required constraint must stop an empty-base submission before it reaches the host.
    await page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit());
    expect(host.isDirty).toBe(false);
    await expect(page.locator('#add-object-overlay')).toBeVisible();

    await page.locator('#add-object-base').selectOption({ index: 1 });
    await expect(page.locator('#add-object-generated')).toHaveText(/^[\x20-\x7e]{4}$/);
    const previewedId = (await page.locator('#add-object-generated').textContent()).trim();
    await page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit());
    await expect.poll(() => host.isDirty).toBe(true);
    await expect(page.locator('#tree .object-row')).toHaveCount(initialObjectCount + 1);
    const generatedId = (await page.locator('#tree .object-row.active .object-id').textContent()).trim();
    expect(generatedId).toBe(previewedId);
    expect(generatedId).toMatch(/^[A-Za-z0-9]{4}$/);

    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
    await expect(page.locator('#tree .object-row')).toHaveCount(initialObjectCount);

    host.redo();
    await expect(page.locator('#tree .object-row')).toHaveCount(initialObjectCount + 1);
    await host.save();
    const created = parseObjMod(host.readFile(), '.w3u').customObjs.find((obj) => obj.newId === generatedId);
    expect(created, 'generated id should be persisted as a custom object').toBeTruthy();
});

test('base picker searches friendly names and rawcodes', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await page.locator('#add-object').click();
    const base = await page.locator('#add-object-base option').evaluateAll((options) => {
        const namedOptions = options.map((candidate) => {
            const display = candidate.textContent?.trim() || '';
            const rawcodeSuffix = ` (${candidate.value})`;
            return { candidate, name: display.endsWith(rawcodeSuffix) ? display.slice(0, -rawcodeSuffix.length).trim() : display };
        });
        const named = namedOptions.find(({ candidate, name }) => candidate.value && name.toLowerCase() !== candidate.value.toLowerCase());
        if (!named) throw new Error('Expected a named base object');
        return {
            rawcode: named.candidate.value,
            name: named.name,
        };
    });

    await page.locator('#add-object-base-search').fill(base.rawcode);
    await expect(page.locator(`#add-object-base option[value="${base.rawcode}"]`)).toHaveCount(1);
    await expect(page.locator('#add-object-base-status')).toContainText('matching base object');

    await page.locator('#add-object-base-search').fill(base.name);
    await expect(page.locator(`#add-object-base option[value="${base.rawcode}"]`)).toHaveCount(1);
});

test('base picker prioritizes human-readable prefix matches and shows the base race', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await page.locator('#add-object').click();
    await page.locator('#add-object-base-search').fill('guard');
    await expect(page.locator('#add-object-base option').nth(1)).toHaveAttribute('value', 'hgtw');
    await expect(page.locator('#add-object-base option[value="hgtw"]')).toHaveText(/Guard Tower.*Human.*hgtw/);
});

test('generated rawcodes reserve custom rawcodes from every object-data sibling in the map', async ({ openObjMod }) => {
    const reserved = Array.from({ length: 36 }, (_, index) => `h0${index.toString(36).toUpperCase().padStart(2, '0')}`);
    const { page, host } = await openObjMod({
        setupFixture: (dir) => fs.writeFileSync(path.join(dir, 'war3map.w3a'), serializeObjMod({
            version: 3,
            ext: '.w3a',
            extended: true,
            origObjs: [],
            customObjs: reserved.map((newId) => ({ baseId: 'Amls', newId, mods: [] })),
        })),
    });
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-base option[value="hpea"]')).toHaveCount(1);
    await page.locator('#add-object-base').selectOption('hpea');
    await expect(page.locator('#add-object-generated')).toHaveText(/^[\x20-\x7e]{4}$/);
    const previewedId = (await page.locator('#add-object-generated').textContent()).trim();
    expect(reserved).not.toContain(previewedId);

    await page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit());
    await expect.poll(() => host.isDirty).toBe(true);
    await expect(page.locator('#tree .object-row', { has: page.locator('.object-id', { hasText: previewedId }) })).toHaveCount(1);
    await host.save();
    expect(parseObjMod(host.readFile(), '.w3u').customObjs.some((object) => object.newId === previewedId)).toBe(true);
});

test('copy and paste duplicate the selected object with independent serialized mods', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await selectObject(page, 'h004');
    await page.fill('#search', '');
    await expect(page.locator('#tree .object-row', { has: page.locator('.object-id', { hasText: 'h004' }) })).toHaveCount(1);
    const initialCount = await page.locator('#tree .object-row').count();
    await page.locator('#copy-object').click();
    await expect(page.locator('#paste-object')).toBeEnabled();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await expect.poll(() => host.isDirty).toBe(true);
    await expect(page.locator('#tree .object-row')).toHaveCount(initialCount + 1);
    expect(host.editLabels).toEqual(['Duplicate ' + (await page.locator('#tree .object-row.active .object-id').textContent()).trim()]);

    const createdId = (await page.locator('#tree .object-row.active .object-id').textContent()).trim();
    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
    await expect(page.locator('#tree .object-row')).toHaveCount(initialCount);
    host.redo();
    await expect.poll(() => host.isDirty).toBe(true);
    await expect(page.locator('#tree .object-row')).toHaveCount(initialCount + 1);
    await host.save();
    const parsed = parseObjMod(host.readFile(), '.w3u');
    const source = parsed.customObjs.find((obj) => obj.newId === 'h004');
    const duplicate = parsed.customObjs.find((obj) => obj.newId === createdId);
    expect(duplicate.baseId).toBe(source.baseId);
    expect(duplicate.mods).toEqual(source.mods);
    expect(duplicate.mods).not.toBe(source.mods);
});

test('Save As preserves an object created while editing the skin sibling', async ({ openObjMod }) => {
    const { page, host } = await openObjMod({
        fileName: 'war3mapSkin.w3u',
        setupFixture: (dir) => fs.copyFileSync(path.join(dir, 'war3map.w3u'), path.join(dir, 'war3mapSkin.w3u')),
    });
    await page.locator('#add-object').click();
    await page.locator('#add-object-base').selectOption({ index: 1 });
    await page.locator('#add-object-id').fill('Z902');
    await page.locator('#add-object-dialog').evaluate((form) => form.requestSubmit());
    await expect.poll(() => host.isDirty).toBe(true);

    await host.saveAs('copiedSkin.w3u');
    const copied = parseObjMod(host.readFile('copiedSkin.w3u'), '.w3u');
    expect(copied.customObjs.find((obj) => obj.newId === 'Z902'), 'Save As should include the new object').toBeTruthy();
});

test('ability editors exclude buff-only bases', async ({ openObjMod }) => {
    const { page } = await openObjMod({
        fileName: 'war3map.w3a',
        setupFixture: (dir) => fs.writeFileSync(path.join(dir, 'war3map.w3a'), serializeObjMod({
            version: 3, ext: '.w3a', extended: true, origObjs: [], customObjs: [],
        })),
    });
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-base option[value="Amls"]')).toHaveCount(1);
    await expect(page.locator('#add-object-base option[value="Bmlc"]')).toHaveCount(0);
});

test('buff editors exclude ability-only bases', async ({ openObjMod }) => {
    const { page } = await openObjMod({
        fileName: 'war3map.w3h',
        setupFixture: (dir) => fs.writeFileSync(path.join(dir, 'war3map.w3h'), serializeObjMod({
            version: 3, ext: '.w3h', extended: false, origObjs: [], customObjs: [],
        })),
    });
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-base option[value="Bmlc"]')).toHaveCount(1);
    await expect(page.locator('#add-object-base option[value="Amls"]')).toHaveCount(0);
});

test('unit editors exclude dependency and ability records from base choices', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-base option[value="hpea"]')).toHaveCount(1);
    await expect(page.locator('#add-object-base option[value="Aimp"]')).toHaveCount(0);
    await expect(page.locator('#add-object-base option[value="HERO"]')).toHaveCount(0);
});

test('upgrade editors exclude skin-only records from base choices', async ({ openObjMod }) => {
    const { page } = await openObjMod({
        fileName: 'war3map.w3q',
        setupFixture: (dir) => fs.writeFileSync(path.join(dir, 'war3map.w3q'), serializeObjMod({
            version: 3, ext: '.w3q', extended: false, origObjs: [], customObjs: [],
        })),
    });
    await page.locator('#add-object').click();
    await expect(page.locator('#add-object-base option[value="Rhme"]')).toHaveCount(1);
    await expect(page.locator('#add-object-base option[value="BP001"]')).toHaveCount(0);
});

test('a stale detail response cannot populate an object after its identity changes', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await expect(page.locator('#details .table-wrap tbody tr')).not.toHaveCount(0);
    const selectedKey = await page.evaluate(() => window.__wurstModelThumbDebug.state().selectedKey);

    await page.evaluate((key) => window.postMessage({
        type: 'objectDetailsLoaded',
        key,
        identity: 'Custom:stale-object',
        mods: [{ fieldId: 'zzzz', label: 'Stale field', category: 'data', type: 'int', value: 1 }],
    }, '*'), selectedKey);

    await expect.poll(() => page.evaluate(() => window.__wurstModelThumbDebug.detailsRows()
        .some((row) => row.fieldId === 'zzzz'))).toBe(false);
});

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
