'use strict';

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');
const fs = require('fs');
const path = require('path');
const { parseObjMod, serializeObjMod } = repoRequire('casc-ts/formats');

test('collapsed model fields offer one-click selection and a two-line thumbnail', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await page.fill('#search', 'h004');
    await page.locator('#tree .object-row', { has: page.locator('.object-id:text-is("h004")') }).first().click();
    await page.check('#technical-toggle');
    const row = page.locator('#details tbody tr', { has: page.locator('td.id:text-is("umdl")') });
    await expect(row.locator('.asset-model-preview')).toBeVisible();
    const size = await row.locator('.asset-model-preview').evaluate(el => {
        const box = el.getBoundingClientRect();
        const value = el.closest('.value-display').getBoundingClientRect();
        return { width: box.width, height: box.height, valueHeight: value.height };
    });
    expect(size.width).toBeGreaterThanOrEqual(36);
    expect(size.height).toBeGreaterThanOrEqual(size.valueHeight - 1);
    await row.getByRole('button', { name: 'Choose asset', exact: true }).click();
    await expect(page.locator('#ab-overlay')).toBeVisible();
    await expect(row.locator('.edit-raw')).toHaveCount(0);
    expect(host.isDirty).toBe(false);
    const value = 'Units\\Undead\\Acolyte\\Acolyte.mdx';
    await page.evaluate(value => window.postMessage({ type: 'assetCatalog', models: [{ value, label: 'Acolyte' }] }, '*'), value);
    await page.locator('.ab-card').filter({ hasText: 'Acolyte' }).getByRole('button', { name: 'Use asset', exact: true }).click();
    await expect.poll(() => host.isDirty).toBe(true);
    expect(host.editLabels).toEqual(['Edit umdl']);
    host.undo();
    await expect.poll(() => host.isDirty).toBe(false);
});

test('detail header refresh reuses a loaded tree icon without leaving a spinner', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    await expect(page.locator('.details-head')).toBeVisible();
    const object = await page.evaluate(() => {
        const key = document.querySelector('#tree .object-row.active').getAttribute('data-key');
        return { ...window.__OBJMOD_INITIAL__.objects.find(obj => obj.key === key), iconPath: 'test-header-icon.blp' };
    });
    await page.evaluate(object => window.postMessage({ type: 'objectUpdated', object }, '*'), object);
    await expect.poll(() => page.evaluate(() => window.__e2eOutbox.some(msg => msg.type === 'loadObjectIcon' && msg.iconPath === 'test-header-icon.blp'))).toBe(true);
    await page.evaluate(() => {
        const request = window.__e2eOutbox.find(msg => msg.type === 'loadObjectIcon' && msg.iconPath === 'test-header-icon.blp');
        window.postMessage({ type: 'objectIconLoaded', key: request.key, mode: 'rgba', width: 1, height: 1, rgbaBase64: '/wAA/w==' }, '*');
    });
    await expect(page.locator('.details-icon img')).toHaveCount(1);
    await page.evaluate(object => window.postMessage({ type: 'objectUpdated', object }, '*'), object);
    await expect(page.locator('.details-icon img')).toHaveCount(1);
    await expect(page.locator('.details-icon')).not.toHaveClass(/loading/);
});

test('asset fields keep one wrapper through repeated edits, undo, and redo', async ({ openObjMod }) => {
    const { page, host } = await openObjMod();
    await page.fill('#search', 'h004');
    await page.locator('#tree .object-row', { has: page.locator('.object-id:text-is("h004")') }).first().click();
    await page.check('#technical-toggle');
    const row = page.locator('#details tbody tr', { has: page.locator('td.id:text-is("umdl")') });
    for (let i = 0; i < 3; i++) {
        await row.locator('.cell-edit').click();
        await row.locator('.edit-raw').fill('Units\\Undead\\Acolyte\\Acolyte.mdx');
        await row.locator('.edit-raw').press('Enter');
        await expect(row.locator('.cell-edit')).toBeVisible();
        await expect(row.locator('.asset-cell')).toHaveCount(1);
        await expect(row.locator('[data-browse]')).toHaveCount(1);
        host.undo();
        await expect(row.locator('.asset-cell')).toHaveCount(1);
        host.redo();
        await expect(row.locator('.asset-cell')).toHaveCount(1);
    }
    await row.getByRole('button', { name: 'Choose asset', exact: true }).click();
    await expect(page.locator('#ab-overlay')).toBeVisible();
});

test('object actions have padding and gaps in both density modes', async ({ openObjMod }) => {
    const { page } = await openObjMod();
    for (const cozy of [false, true]) {
        if (cozy) await page.locator('#density-toggle').click();
        const spacing = await page.locator('.object-list-actions').evaluate(el => {
            const style = getComputedStyle(el);
            return { top: parseFloat(style.paddingTop), left: parseFloat(style.paddingLeft), bottom: parseFloat(style.paddingBottom), gap: parseFloat(style.gap) };
        });
        expect(spacing.top).toBeGreaterThanOrEqual(6);
        expect(spacing.left).toBeGreaterThanOrEqual(6);
        expect(spacing.bottom).toBeGreaterThanOrEqual(6);
        expect(spacing.gap).toBeGreaterThanOrEqual(4);
    }
});

for (const initialValue of ['', '-']) {
    test(`empty asset fields offer Browse for ${JSON.stringify(initialValue)}`, async ({ openObjMod }) => {
        const { page, host } = await openObjMod({
            setupFixture: dir => {
                const filePath = path.join(dir, 'war3map.w3u');
                const file = parseObjMod(fs.readFileSync(filePath), '.w3u');
                const object = file.customObjs.find(obj => obj.newId === 'h004');
                object.mods = object.mods.filter(mod => mod.fieldId !== 'umdl');
                object.mods.push({ fieldId: 'umdl', varType: 'string', value: initialValue, endToken: '\0\0\0\0' });
                fs.writeFileSync(filePath, serializeObjMod(file));
            },
        });
        await page.fill('#search', 'h004');
        await page.locator('#tree .object-row', { has: page.locator('.object-id:text-is("h004")') }).first().click();
        await page.check('#technical-toggle');
        const row = page.locator('#details tbody tr', { has: page.locator('td.id:text-is("umdl")') });
        await row.getByRole('button', { name: 'Choose asset', exact: true }).click();
        await expect(page.locator('#ab-overlay')).toBeVisible();
        const value = 'Units\\Undead\\Acolyte\\Acolyte.mdx';
        await page.evaluate(value => window.postMessage({ type: 'assetCatalog', models: [{ value, label: 'Acolyte' }] }, '*'), value);
        await page.locator('.ab-card').filter({ hasText: 'Acolyte' }).getByRole('button', { name: 'Use asset', exact: true }).click();
        await expect.poll(() => host.isDirty).toBe(true);
        await host.save();
        const object = parseObjMod(host.readFile(), '.w3u').customObjs.find(obj => obj.newId === 'h004');
        expect(object.mods.find(mod => mod.fieldId === 'umdl').value).toBe(value);
        host.undo();
        await expect(row.locator('[data-browse]')).toHaveCount(1);
        await expect(row.locator('.asset-model-preview')).toHaveCount(0);
    });
}
