'use strict';

const { test, expect } = require('../fixtures');

test('camera editor exposes named fields and supports edit, undo, and save', async ({ openW3c }) => {
    const { page, host, pageErrors } = await openW3c();

    await expect(page.locator('#editorCount')).toHaveText('2');
    await expect(page.locator('[data-row="0"] [data-field="name"]')).toHaveValue('Overview');
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
    expect(host.doc.file.cameras[0].name).toBe('Overview');
    expect(host.isDirty).toBe(false);

    host.redo();
    host.redo();
    await host.save();
    const reparsed = host.internals.parseW3cFile(host.readFile());
    expect(reparsed.cameras[0]).toMatchObject({ name: 'Edited Overview', distance: 1900 });
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

    await page.fill('[data-row="0"] [data-field="targetX"]', '0.1');
    await page.locator('[data-row="0"] [data-field="targetX"]').blur();
    await host.save();

    const reparsed = host.internals.parseW3cFile(host.readFile());
    expect(reparsed.cameras[0].targetX).toBe(Math.fround(0.1));
});

test('region editor exposes bounds, environment, color, and round-trips edits', async ({ openW3r }) => {
    const { page, host, pageErrors } = await openW3r();

    await expect(page.locator('#editorCount')).toHaveText('2');
    await expect(page.locator('[data-row="0"] [data-field="name"]')).toHaveValue('Spawn Area');
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
    expect(host.doc.file.regions[0]).toMatchObject({ name: 'Edited Area', weatherId: 'RAIN', red: 0xab, green: 0xcd, blue: 0xef });

    await host.save();
    const reparsed = host.internals.parseW3rFile(host.readFile());
    expect(reparsed.regions[0]).toMatchObject({ name: 'Edited Area', maxY: 512, weatherId: 'RAIN', red: 0xab, green: 0xcd, blue: 0xef });
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

    await page.fill('[data-row="0"] [data-field="minX"]', '12.345');
    await page.locator('[data-row="0"] [data-field="minX"]').blur();
    await host.save();

    const reparsed = host.internals.parseW3rFile(host.readFile());
    expect(reparsed.regions[0].minX).toBe(Math.fround(12.345));
});
