'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The map terrain and placement editor on war3mapUnits.doo.
 *
 * Markers live in a WebGL scene behind an orbit camera, so the specs ask the page where a map
 * position lands on screen (`__wurstMapEditorDebug`) and drive real mouse events there. Each edit is
 * checked in the host document, and the save tests re-parse the bytes on disk.
 */

const { test, expect } = require('../fixtures');
const { repoRequire } = require('../harness/tsLoader');
const { makePlacementMapFixtureDir, PLACEMENT_MAP } = require('../harness/makeFixtures');

const { parseDoo, serializeDoo } = repoRequire('casc-ts/formats');

// Fixture order, see buildPlacementUnits in makeFixtures.js.
const START = 0;
const FOOTMAN = 1;
const HERO = 2;
const ITEM = 3;
const CUSTOM = 4;
/** Map positions inside the raised plateau and on the flat ground around it. */
const ON_PLATEAU = { x: 512, y: 512 };
const ON_GROUND = { x: -768, y: 256 };

async function openEditor(openMapPlacement, options) {
    const opened = await openMapPlacement(options);
    await opened.page.waitForFunction(() => !!window.__wurstMapEditorDebug);
    await expect(opened.page.locator('#mp-selection .mp-empty')).toBeVisible();
    return opened;
}

async function screenPoint(page, kind, x, y) {
    const point = await page.evaluate(([fn, mx, my]) => window.__wurstMapEditorDebug[fn](mx, my), [kind, x, y]);
    expect(point, `map position ${x},${y} should be on screen`).toBeTruthy();
    return point;
}

async function clickPlacement(page, host, index) {
    const unit = host.doc.file.units[index];
    const p = await screenPoint(page, 'markerScreenPosition', unit.x, unit.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.mp-sel-id')).toContainText(unit.typeId);
}

async function dragPlacementTo(page, host, index, target) {
    const unit = host.doc.file.units[index];
    const from = await screenPoint(page, 'markerScreenPosition', unit.x, unit.y);
    const to = await screenPoint(page, 'groundScreenPosition', target.x, target.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
}

async function clickGround(page, target) {
    const p = await screenPoint(page, 'groundScreenPosition', target.x, target.y);
    await page.mouse.click(p.x, p.y);
}

async function pickType(page, kind, rawcode) {
    await page.locator(`.mp-kinds [data-kind="${kind}"]`).click();
    await page.locator('#mp-search').fill(rawcode);
    const row = page.locator(`.mp-type[data-type="${rawcode}"]`);
    await row.click();
    await expect(page.locator('#mp-mode')).toBeVisible();
    return row;
}

const diskUnits = (host) => parseDoo(host.readFile(), 'war3mapUnits.doo').units;

test('renders the terrain and every placement from the fixture', async ({ openMapPlacement }) => {
    const { page, host, pageErrors } = await openEditor(openMapPlacement);

    await expect(page.locator('.mp-meta')).toContainText('16x16 tiles');
    await expect(page.locator('#mp-err')).toBeHidden();
    await expect(page.locator('#mp-dirty')).toBeHidden();
    const state = await page.evaluate(() => window.__wurstMapEditorDebug.state());
    expect(state.placements.map((p) => [p.id, p.kind])).toEqual([
        ['sloc', 'start'], ['hfoo', 'unit'], ['Hpal', 'unit'], ['ratc', 'item'], ['h000', 'unit'],
    ]);
    expect(host.doc.file.readOnlyReason).toBeUndefined();
    expect(pageErrors).toEqual([]);
});

test('clicking a marker selects it and shows rawcode, name, owner and position', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);

    await clickPlacement(page, host, FOOTMAN);
    await expect(page.locator('#mp-sel-owner')).toHaveValue('0');
    await expect(page.locator('#mp-sel-x')).toHaveText('-512');
    await expect(page.locator('#mp-sel-y')).toHaveText('-512');
    await expect(page.locator('#mp-sel-z')).toHaveText('0');

    // Custom units are named from the map's own .w3u, owners resolved against the 24-player layout.
    await clickPlacement(page, host, CUSTOM);
    await expect(page.locator('.mp-sel-name')).toHaveText('E2E Captain');
    await expect(page.locator('#mp-sel-owner')).toHaveValue('24');
    await expect(page.locator('#mp-sel-owner option:checked')).toHaveText('Neutral Hostile');

    // Items have no owner choice in World Editor.
    await clickPlacement(page, host, ITEM);
    await expect(page.locator('#mp-sel-owner')).toHaveCount(0);
    await expect(page.locator('.mp-props')).toContainText('Neutral Passive');

    // Clicking empty terrain clears the selection.
    await clickGround(page, ON_PLATEAU);
    await expect(page.locator('#mp-selection .mp-empty')).toBeVisible();
    expect(host.editLabels).toEqual([]);
});

test('dragging a unit onto the plateau moves it and snaps z to the terrain', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    await clickPlacement(page, host, FOOTMAN);

    await dragPlacementTo(page, host, FOOTMAN, ON_PLATEAU);

    await expect.poll(() => host.editLabels.length).toBe(1);
    expect(host.editLabels[0]).toMatch(/^Move /);
    const moved = host.doc.file.units[FOOTMAN];
    expect(Math.abs(moved.x - ON_PLATEAU.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(moved.y - ON_PLATEAU.y)).toBeLessThanOrEqual(3);
    expect(moved.z).toBe(PLACEMENT_MAP.plateauZ);
    await expect(page.locator('#mp-dirty')).toBeVisible();
    await expect(page.locator('#mp-sel-z')).toHaveText(String(PLACEMENT_MAP.plateauZ));
    const movedTo = { x: moved.x, y: moved.y };

    host.undo();
    expect(host.doc.file.units[FOOTMAN]).toMatchObject({ x: -512, y: -512, z: 0 });
    await expect(page.locator('#mp-sel-x')).toHaveText('-512');
    await expect(page.locator('#mp-dirty')).toBeHidden();

    host.redo();
    expect(host.doc.file.units[FOOTMAN]).toMatchObject({ ...movedTo, z: PLACEMENT_MAP.plateauZ });
    await expect(page.locator('#mp-dirty')).toBeVisible();
});

test('Delete removes the selected unit and undo restores it in place', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    const hero = structuredClone(host.doc.file.units[HERO]);
    await clickPlacement(page, host, HERO);

    await page.keyboard.press('Delete');

    await expect.poll(() => host.doc.file.units.length).toBe(4);
    expect(host.doc.file.units.map((u) => u.typeId)).toEqual(['sloc', 'hfoo', 'ratc', 'h000']);
    expect(host.editLabels[0]).toMatch(/^Delete /);
    await expect(page.locator('#mp-selection .mp-empty')).toBeVisible();

    host.undo();
    expect(host.doc.file.units[HERO]).toEqual(hero);
    await expect(page.locator('.mp-sel-id')).toContainText('Hpal');
});

test('a repeated Delete or a message for an outdated list removes nothing else', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    await clickPlacement(page, host, HERO);

    // A held key repeats faster than the state round trip; only the selected unit may go.
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await expect.poll(() => host.doc.file.units.length).toBe(4);
    expect(host.editLabels).toHaveLength(1);

    // Index 2 is now the item; a message still carrying the hero's creation number must not touch it.
    host.receive({ type: 'delete', index: HERO, editorId: 2 });
    host.receive({ type: 'move', index: HERO, editorId: 2, x: ON_PLATEAU.x, y: ON_PLATEAU.y });
    expect(host.editLabels).toHaveLength(1);
    expect(host.doc.file.units[HERO]).toMatchObject({ typeId: 'ratc', x: 0, y: -512 });
});

test('places a custom unit from the picker for the chosen owner', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    await page.locator('#mp-owner').selectOption('2');

    const row = await pickType(page, 'unit', 'h000');
    await expect(row).toContainText('E2E Captain');
    await expect(row).toContainText('custom');
    await clickGround(page, ON_PLATEAU);

    await expect.poll(() => host.doc.file.units.length).toBe(6);
    const placed = host.doc.file.units[5];
    expect(placed).toMatchObject({
        typeId: 'h000', skinId: 'h000', ownerIndex: 2, z: PLACEMENT_MAP.plateauZ, editorId: 5,
        angle: Math.fround(Math.PI * 1.5), flags: 2, lifePerc: -1, resourcesAmount: 12500, heroLevel: 1,
        randType: 'any', randLevel: 1, customColor: -1,
    });
    expect(host.editLabels).toEqual(['Place E2E Captain']);
    await expect(page.locator('.mp-sel-name')).toHaveText('E2E Captain');

    // Place mode stays on for repeated placement until Escape.
    await page.keyboard.press('Escape');
    await expect(page.locator('#mp-mode')).toBeHidden();

    host.undo();
    expect(host.doc.file.units).toHaveLength(5);
    await expect(page.locator('#mp-selection .mp-empty')).toBeVisible();
});

test('places items as Neutral Passive and names custom items through war3map.wts', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);

    const row = await pickType(page, 'item', 'I000');
    await expect(row).toContainText('E2E Relic');
    await expect(page.locator('#mp-owner')).toBeDisabled();
    await clickGround(page, ON_GROUND);

    await expect.poll(() => host.doc.file.units.length).toBe(6);
    expect(host.doc.file.units[5]).toMatchObject({ typeId: 'I000', ownerIndex: 27, z: 0 });
});

test('changing the owner of the selected unit is one undoable edit', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    await clickPlacement(page, host, FOOTMAN);

    await page.locator('#mp-sel-owner').selectOption('3');

    await expect.poll(() => host.doc.file.units[FOOTMAN].ownerIndex).toBe(3);
    expect(host.editLabels[0]).toMatch(/^Change owner of /);
    host.undo();
    expect(host.doc.file.units[FOOTMAN].ownerIndex).toBe(0);
    await expect(page.locator('#mp-sel-owner')).toHaveValue('0');
});

test('start locations can be selected but not moved or deleted', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    await clickPlacement(page, host, START);
    await expect(page.locator('#mp-delete')).toBeDisabled();

    await page.keyboard.press('Delete');
    await dragPlacementTo(page, host, START, ON_PLATEAU);

    expect(host.editLabels).toEqual([]);
    expect(host.doc.file.units[START]).toMatchObject({ x: -768, y: -768 });
});

test('saves move, place and delete edits to disk and keeps untouched records byte-exact', async ({ openMapPlacement }) => {
    const { page, host } = await openEditor(openMapPlacement);
    const original = diskUnits(host);

    await clickPlacement(page, host, FOOTMAN);
    await dragPlacementTo(page, host, FOOTMAN, ON_PLATEAU);
    await expect.poll(() => host.editLabels.length).toBe(1);
    await clickPlacement(page, host, HERO);
    await page.keyboard.press('Delete');
    await expect.poll(() => host.editLabels.length).toBe(2);
    await pickType(page, 'unit', 'hfoo');
    await clickGround(page, ON_GROUND);
    await expect.poll(() => host.editLabels.length).toBe(3);

    await host.save();

    expect(host.isDirty).toBe(false);
    await expect(page.locator('#mp-dirty')).toBeHidden();
    const bytes = host.readFile();
    const saved = parseDoo(bytes, 'war3mapUnits.doo');
    expect(saved.error).toBeUndefined();
    expect(serializeDoo(saved).equals(bytes)).toBe(true);
    expect(saved.units.map((u) => u.typeId)).toEqual(['sloc', 'hfoo', 'ratc', 'h000', 'hfoo']);
    expect(saved.units[0]).toEqual(original[START]);
    expect(saved.units[1]).toEqual({ ...original[FOOTMAN], x: host.doc.file.units[1].x, y: host.doc.file.units[1].y, z: PLACEMENT_MAP.plateauZ });
    expect(saved.units[2]).toEqual(original[ITEM]);
    expect(saved.units[3]).toEqual(original[CUSTOM]);
    expect(saved.units[4]).toMatchObject({ typeId: 'hfoo', skinId: 'hfoo', ownerIndex: 0, z: 0, editorId: 5 });
});

test('saving without edits leaves the file untouched', async ({ openMapPlacement }) => {
    const { host } = await openEditor(openMapPlacement);
    const before = host.readFile();
    await host.save();
    expect(host.readFile().equals(before)).toBe(true);
});

test('a unit file that does not re-serialize byte-for-byte opens read-only', async ({ openMapPlacement }) => {
    const fixtureDir = makePlacementMapFixtureDir();
    try {
        // A signalling-NaN scale comes back quieted from a float round-trip: exactly the silent
        // byte change the editor must refuse to save.
        const unitsPath = path.join(fixtureDir, 'war3mapUnits.doo');
        const parsed = parseDoo(fs.readFileSync(unitsPath), 'war3mapUnits.doo');
        parsed.units[FOOTMAN].scaleZ = 1.25;
        const bytes = serializeDoo(parsed);
        bytes.set([0x01, 0x00, 0x80, 0x7f], bytes.indexOf(Buffer.from([0x00, 0x00, 0xa0, 0x3f])));
        fs.writeFileSync(unitsPath, bytes);

        const { page, host } = await openEditor(openMapPlacement, { fixtureDir });
        await expect(page.locator('.mp-readonly')).toContainText('read-only');
        await clickPlacement(page, host, FOOTMAN);
        await expect(page.locator('#mp-delete')).toBeDisabled();
        await page.keyboard.press('Delete');
        await dragPlacementTo(page, host, FOOTMAN, ON_PLATEAU);
        host.receive({ type: 'delete', index: FOOTMAN, editorId: host.doc.file.units[FOOTMAN].editorId });

        expect(host.editLabels).toEqual([]);
        await expect(host.provider.saveCustomDocumentAs(host.doc, host.doc.uri)).rejects.toThrow(/read-only/);
        expect(fs.readFileSync(unitsPath).equals(bytes)).toBe(true);
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
