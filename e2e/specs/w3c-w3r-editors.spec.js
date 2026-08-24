'use strict';

const { test, expect } = require('../fixtures');

test('camera editor exposes named fields and supports edit, undo, and save', async ({ openW3c }) => {
    const { page, host, pageErrors } = await openW3c();

    await expect(page.locator('#editorCount')).toHaveText('2');
    await expect(page.locator('[data-row="0"] [data-field="name"]')).toHaveValue('Resolved Overview');
    await expect(page.locator('[data-row="0"] [data-field="targetX"]')).toHaveValue('128');
    await expect(page.locator('[data-row="1"] [data-field="name"]')).toHaveValue('Boss Arena');
    expect(pageErrors).toEqual([]);

    await page.fill('[data-row="0"] [data-field="name"]', 'Edited Overview');
    await page.locator('[data-row="0"] [data-field="name"]').blur();
    await page.fill('[data-row="0"] [data-field="distance"]', '1900');
    await page.locator('[data-row="0"] [data-field="distance"]').blur();
    await expect.poll(() => host.doc.file.cameras[0].distance).toBe(1900);
    expect(host.isDirty).toBe(true);

    host.undo();
    expect(host.doc.file.cameras[0].distance).toBe(1650);
    host.undo();
    expect(host.doc.wtsEdits.has(3)).toBe(false);
    expect(host.isDirty).toBe(false);

    host.redo();
    host.redo();
    await host.save();
    const reparsed = host.internals.parseW3cFile(host.readFile());
    expect(reparsed.cameras[0]).toMatchObject({ name: 'TRIGSTR_003', distance: 1900 });
    expect(host.readText('war3map.wts')).toContain('Edited Overview');
});

test('camera editor can add and remove camera records', async ({ openW3c }) => {
    const { page, host } = await openW3c();

    await page.click('[data-add]');
    await expect.poll(() => host.doc.file.cameras.length).toBe(3);
    await expect(page.locator('[data-row="2"] [data-field="name"]')).toHaveValue('New Camera');
    await page.click('[data-row="2"] [data-remove]');
    await expect.poll(() => host.doc.file.cameras.length).toBe(2);
    expect(host.editLabels).toEqual(['Add camera', 'Remove camera']);
});

test('camera editor accepts fractional float32 values', async ({ openW3c }) => {
    const { page, host } = await openW3c();

    await page.fill('[data-row="0"] [data-field="targetX"]', '1e39');
    await page.locator('[data-row="0"] [data-field="targetX"]').blur();
    expect(host.doc.file.cameras[0].targetX).toBe(128);
    await page.fill('[data-row="0"] [data-field="targetX"]', '0.1');
    await page.locator('[data-row="0"] [data-field="targetX"]').blur();
    await expect(page.locator('[data-row="0"] [data-field="targetX"]')).toHaveValue(Math.fround(0.1).toString());
    await host.save();

    const reparsed = host.internals.parseW3cFile(host.readFile());
    expect(reparsed.cameras[0].targetX).toBe(Math.fround(0.1));
});

test('region editor exposes bounds, environment, color, and round-trips edits', async ({ openW3r }) => {
    const { page, host, pageErrors } = await openW3r();

    await expect(page.locator('#editorCount')).toHaveText('2');
    await expect(page.locator('[data-row="0"] [data-field="name"]')).toHaveValue('Resolved Spawn');
    await expect(page.locator('[data-row="0"] [data-field="minX"]')).toHaveValue('-128');
    await expect(page.locator('[data-row="0"] [data-field="weatherId"]')).toHaveValue('NULL');
    await expect(page.locator('[data-row="0"] [data-field="color"]')).toHaveValue('#c08040');
    expect(pageErrors).toEqual([]);

    await page.fill('[data-row="0"] [data-field="name"]', 'Edited Area');
    await page.locator('[data-row="0"] [data-field="name"]').blur();
    await page.fill('[data-row="0"] [data-field="maxY"]', '512');
    await page.locator('[data-row="0"] [data-field="maxY"]').blur();
    await page.fill('[data-row="0"] [data-field="weatherId"]', 'RAIN');
    await page.locator('[data-row="0"] [data-field="weatherId"]').blur();
    await page.fill('[data-row="0"] [data-field="color"]', '#abcdef');
    await page.locator('[data-row="0"] [data-field="color"]').blur();
    await expect.poll(() => host.doc.file.regions[0].maxY).toBe(512);
    expect(host.doc.file.regions[0]).toMatchObject({ name: 'TRIGSTR_004', weatherId: 'RAIN', red: 0xab, green: 0xcd, blue: 0xef });
    expect(host.doc.wtsEdits.get(4)).toBe('Edited Area');

    await host.save();
    const reparsed = host.internals.parseW3rFile(host.readFile());
    expect(reparsed.regions[0]).toMatchObject({ name: 'TRIGSTR_004', maxY: 512, weatherId: 'RAIN', red: 0xab, green: 0xcd, blue: 0xef });
    expect(host.readText('war3map.wts')).toContain('Edited Area');
});

test('region editor can add and remove region records', async ({ openW3r }) => {
    const { page, host } = await openW3r();

    await page.click('[data-add]');
    await expect.poll(() => host.doc.file.regions.length).toBe(3);
    await expect(page.locator('[data-row="2"] [data-field="name"]')).toHaveValue('New Region');
    await page.click('[data-row="2"] [data-remove]');
    await expect.poll(() => host.doc.file.regions.length).toBe(2);
    expect(host.editLabels).toEqual(['Add region', 'Remove region']);
});

test('region editor accepts fractional float32 bounds', async ({ openW3r }) => {
    const { page, host } = await openW3r();

    await page.fill('[data-row="0"] [data-field="minX"]', '1e39');
    await page.locator('[data-row="0"] [data-field="minX"]').blur();
    expect(host.doc.file.regions[0].minX).toBe(-128);
    await page.fill('[data-row="0"] [data-field="minX"]', '12.345');
    await page.locator('[data-row="0"] [data-field="minX"]').blur();
    await expect(page.locator('[data-row="0"] [data-field="minX"]')).toHaveValue(Math.fround(12.345).toString());
    await host.save();

    const reparsed = host.internals.parseW3rFile(host.readFile());
    expect(reparsed.regions[0].minX).toBe(Math.fround(12.345));
});
