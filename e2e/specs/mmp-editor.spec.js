'use strict';

/** The editable .mmp minimap/lobby-preview icon list. */

const { test, expect } = require('../fixtures');

test('renders icon types, coordinates, colors, and the default-color state', async ({ openMmp }) => {
    const { page, host, pageErrors } = await openMmp();

    await expect(page.locator('#mmpCount')).toHaveText('4');
    await expect(page.locator('[data-row="0"] [data-field="type"]')).toHaveValue('0');
    await expect(page.locator('[data-row="0"] [data-field="x"]')).toHaveValue('-1024');
    await expect(page.locator('[data-row="0"] [data-default-color]')).toBeChecked();
    await expect(page.locator('[data-row="0"] [data-field="color"]')).toBeDisabled();
    await expect(page.locator('.mmp-footer-hint')).toContainText('no custom tint');
    await expect(page.locator('[data-row="1"] .type-label')).toHaveText('Neutral Building / House');
    await expect(page.locator('[data-row="3"] .type-label')).toHaveText('Unknown / custom (77)');
    await expect(page.locator('[data-row="3"] [data-field="type"]')).toHaveValue('77');
    expect(host.doc.file.icons[1].red).toBe(0xc0);
    expect(pageErrors).toEqual([]);
});

test('removing an icon is undoable and redoable', async ({ openMmp }) => {
    const { page, host } = await openMmp();

    await page.click('[data-row="1"] [data-remove]');
    await expect.poll(() => host.doc.file.icons.length).toBe(3);
    await expect(page.locator('#mmpCount')).toHaveText('3');
    expect(host.editLabels).toEqual(['Remove minimap icon']);
    expect(host.isDirty).toBe(true);

    host.undo();
    await expect.poll(() => host.doc.file.icons.length).toBe(4);
    await expect(page.locator('#mmpCount')).toHaveText('4');
    expect(host.isDirty).toBe(false);

    host.redo();
    await expect.poll(() => host.doc.file.icons.length).toBe(3);
    await expect(page.locator('#mmpCount')).toHaveText('3');
});

test('editing coordinates, type, and color fields updates the icon', async ({ openMmp }) => {
    const { page, host } = await openMmp();

    await page.selectOption('[data-row="0"] [data-field="type"]', '2');
    await page.fill('[data-row="0"] [data-field="x"]', '1234');
    await page.locator('[data-row="0"] [data-field="x"]').blur();
    await page.uncheck('[data-row="0"] [data-default-color]');
    await page.fill('[data-row="0"] [data-field="color"]', '#123456');
    await page.locator('[data-row="0"] [data-field="color"]').blur();
    await page.fill('[data-row="0"] [data-field="alpha"]', '96');
    await page.locator('[data-row="0"] [data-field="alpha"]').blur();

    await expect.poll(() => host.doc.file.icons[0].type).toBe(2);
    expect(host.doc.file.icons[0]).toMatchObject({ x: 1234, red: 0x12, green: 0x34, blue: 0x56, alpha: 96 });
    await expect(page.locator('[data-row="0"] .type-label')).toHaveText('Player Start');
    expect(host.editLabels).toEqual(['Edit icon type', 'Edit icon x', 'Edit icon color', 'Edit icon alpha']);
});

test('adding an icon and saving round-trips the edited list', async ({ openMmp }) => {
    const { page, host } = await openMmp();

    await page.click('[data-add]');
    await expect.poll(() => host.doc.file.icons.length).toBe(5);
    await page.selectOption('[data-row="4"] [data-field="type"]', '2');
    await page.locator('[data-row="4"] [data-field="type"]').blur();
    await page.fill('[data-row="4"] [data-field="x"]', '900');
    await page.locator('[data-row="4"] [data-field="x"]').blur();
    await page.fill('[data-row="4"] [data-field="y"]', '-450');
    await page.locator('[data-row="4"] [data-field="y"]').blur();
    await page.uncheck('[data-row="4"] [data-default-color]');
    await page.fill('[data-row="4"] [data-field="color"]', '#abcdef');
    await page.locator('[data-row="4"] [data-field="color"]').blur();

    await host.save();
    expect(host.isDirty).toBe(false);
    const reparsed = host.internals.parseMmpFile(host.readFile());
    expect(reparsed.error).toBeUndefined();
    expect(reparsed.icons).toHaveLength(5);
    expect(reparsed.icons[4]).toMatchObject({ type: 2, x: 900, y: -450, red: 0xab, green: 0xcd, blue: 0xef, alpha: 0xff });
});
