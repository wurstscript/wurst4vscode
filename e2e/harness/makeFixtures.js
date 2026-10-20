'use strict';

/**
 * Generates the binary map-data fixtures the e2e specs open.
 *
 * They are built here rather than checked in so the bytes stay readable/reviewable as code, and so a
 * casc-ts format change surfaces as a generator failure instead of a stale blob that quietly parses
 * into something else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { repoRequire } = require('./tsLoader');

const { serializeW3i, serializeWpm, serializeDoo, serializeObjMod, BinWriter } = repoRequire('casc-ts/formats');

const W3I_VERSION = 31; // Reforged-era; exercises the v28 game-version block and the v31 tail skips.

/** A tail the display-only player/force parser can read, so the rendered editor has real rows. */
function buildW3iTail() {
    const w = new BinWriter(512);
    w.writeI32(0);            // fog type
    w.writeF32(3000); w.writeF32(5000); w.writeF32(0.5); // fog start/end/density
    w.writeI32(0);            // fog color
    w.writeI32(0);            // global weather id
    w.writeString('Default'); // sound environment
    w.writeU8('L'.charCodeAt(0)); // light environment tileset
    w.writeI32(0);            // water color
    w.writeI32(0);            // script language (v28+)
    w.writeI32(0); w.writeI32(0); // supported graphics modes + game data version (v31+)

    w.writeI32(2); // players
    const player = (num, type, race, name) => {
        w.writeI32(num); w.writeI32(type); w.writeI32(race); w.writeI32(0);
        w.writeString(name);
        w.writeF32(0); w.writeF32(0);   // start x/y
        w.writeI32(0); w.writeI32(0);   // ally low/high priority
        w.writeI32(0); w.writeI32(0);   // enemy low/high priority (v31+)
    };
    player(0, 1, 1, 'Player 1 (Human)');
    player(1, 2, 2, 'Player 2 (Computer)');

    w.writeI32(1); // forces
    w.writeI32(0); w.writeU32(0xffffffff); w.writeString('Force 1');
    return w.toBuffer();
}

function buildW3i() {
    return serializeW3i({
        version: W3I_VERSION,
        saves: 1,
        editorVersion: 6072,
        gameVersionRaw: (() => {
            const b = Buffer.alloc(16);
            b.writeUInt32LE(1, 0); b.writeUInt32LE(36, 4); b.writeUInt32LE(1, 8); b.writeUInt32LE(20363, 12);
            return b;
        })(),
        // Mixed on purpose: `name` is a wts-backed TRIGSTR (editing it must route to war3map.wts),
        // `author` is an inline string (editing it must rewrite the w3i bytes).
        name: 'TRIGSTR_001',
        author: 'Wurst E2E',
        description: 'TRIGSTR_002',
        recommendedPlayers: '2',
        cameraBounds: Buffer.alloc(32),
        margins: Buffer.alloc(16),
        width: 64,
        height: 64,
        flags: 0x0001 | 0x0400,
        tileset: 'L',
        loadingBackground: -1,
        loadingModel: 'war3mapImported\\LoadingScreen.mdx',
        loadingText: 'Loading text',
        loadingTitle: 'Loading title',
        loadingSubtitle: 'Loading subtitle',
        gameDataSet: 0,
        prologuePath: '',
        prologueText: 'Prologue text',
        prologueTitle: 'Prologue title',
        prologueSubtitle: 'Prologue subtitle',
        tail: buildW3iTail(),
    });
}

const WTS = `STRING 1
{
E2E Map Name
}

STRING 2
{
E2E map description spanning
two lines.
}

STRING 3
{
Resolved Overview
}

STRING 4
{
Resolved Spawn
}

STRING 5
{
Resolved Region Sound
}
`;

/** 16x16 pathing map with a recognisable block of blocked cells to assert paint/erase against. */
function buildWpm() {
    const width = 16;
    const height = 16;
    const data = Buffer.alloc(width * height, 0);
    for (let y = 4; y < 8; y++) {
        for (let x = 4; x < 8; x++) data[y * width + x] = 0x02; // walkability blocked
    }
    data[7 * width + 9] = 0xd0; // unfloatable + unamphibious + no-peon-harvest: picker must preserve every bit
    return serializeWpm({ version: 0, width, height, data, tail: Buffer.alloc(0) });
}

function buildMmp() {
    const w = new BinWriter(8 + 4 * 16);
    w.writeI32(0); // version
    w.writeI32(4); // icon count
    const icon = (type, x, y, blue, green, red, alpha = 0xff) => {
        w.writeI32(type); w.writeI32(x); w.writeI32(y);
        w.writeU8(blue); w.writeU8(green); w.writeU8(red); w.writeU8(alpha);
    };
    icon(0, -1024, 512, 0xff, 0xff, 0xff); // default gold mine color
    icon(1, 256, -768, 0x40, 0x80, 0xc0);
    icon(2, 1024, 2048, 0xff, 0xff, 0xff, 0x80);
    icon(77, 0, 0, 0x10, 0x20, 0x30);
    return w.toBuffer();
}

function buildW3c() {
    const w = new BinWriter(256);
    w.writeI32(0); w.writeI32(2);
    const camera = (name, values) => {
        for (const value of values) w.writeF32(value);
        w.writeString(name);
    };
    camera('TRIGSTR_003', [128, 256, 32, 90, 304, 1650, 0, 70, 5000, 0]);
    camera('Boss Arena', [-512, 1024, 64, 180, 280, 2200, 3, 75, 6000, 1]);
    return w.toBuffer();
}

function buildW3r() {
    const w = new BinWriter(256);
    w.writeI32(5); w.writeI32(2);
    const region = (name, minX, maxX, minY, maxY, index, weather, sound, blue, green, red, endToken = 0) => {
        w.writeF32(minX); w.writeF32(maxX); w.writeF32(minY); w.writeF32(maxY);
        w.writeString(name); w.writeI32(index); w.writeId(weather); w.writeString(sound);
        w.writeU8(blue); w.writeU8(green); w.writeU8(red); w.writeU8(endToken);
    };
    region('TRIGSTR_004', -128, 256, -64, 384, 3, 'NULL', 'TRIGSTR_005', 0x40, 0x80, 0xc0);
    region('Boss Room', 512, 1024, 768, 1280, 7, 'SNOW', '', 0x10, 0x20, 0x30, 1);
    return w.toBuffer();
}

/**
 * A 16x16-tile map for the placement editor: flat ground at z 0 with a raised plateau (cliff layer 3,
 * z 128) over tilepoints 10..14, which is map x/y 256..768. Nothing about it needs game data.
 */
const PLACEMENT_MAP = { width: 17, height: 17, centerX: -1024, centerY: -1024, plateau: [10, 14], plateauZ: 128 };

function buildW3e() {
    const { width, height, centerX, centerY, plateau } = PLACEMENT_MAP;
    const w = new BinWriter(64 + width * height * 7);
    w.writeId('W3E!');
    w.writeI32(11);
    w.writeU8('L'.charCodeAt(0)); // tileset
    w.writeI32(0);                // no custom tileset
    w.writeI32(2); w.writeId('Ldrt'); w.writeId('Lgrs');
    w.writeI32(1); w.writeId('CLdi');
    w.writeI32(width); w.writeI32(height);
    w.writeF32(centerX); w.writeF32(centerY);
    const u16 = (value) => { w.writeU8(value & 0xff); w.writeU8(value >> 8); };
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            const raised = i >= plateau[0] && i <= plateau[1] && j >= plateau[0] && j <= plateau[1];
            u16(0x2000);              // ground height: zero
            u16(0x2000);              // water level, no boundary flag
            w.writeU8(raised ? 0x10 : 0x00); // ground texture in the high nibble, no flags
            w.writeU8(0);             // texture details
            w.writeU8(raised ? 3 : 2); // cliff texture 0, layer 2 is ground level
        }
    }
    return w.toBuffer();
}

/** A unit record with the values World Editor writes, so untouched records exercise every field. */
function placedUnit(overrides) {
    return {
        typeId: 'hfoo', variation: 0, x: 0, y: 0, z: 0, angle: Math.fround(Math.PI * 1.5),
        scaleX: 1, scaleY: 1, scaleZ: 1, skinId: overrides.typeId || 'hfoo', flags: 2, ownerIndex: 0, unknownA: 0, unknownB: 0,
        lifePerc: -1, manaPerc: -1, itemTablePtr: -1, drops: [], resourcesAmount: 12500,
        targetAcquisition: -1, heroLevel: 1, heroStr: 0, heroAgi: 0, heroInt: 0,
        invItems: [], abilities: [], randType: 'any', randLevel: 1, randClass: 0,
        customColor: -1, waygateTargetRectIndex: -1, editorId: 0,
        ...overrides,
    };
}

/** Index order matters to the specs: 0 start location, 1 footman, 2 hero, 3 item, 4 custom unit. */
function buildPlacementUnits() {
    return serializeDoo({
        kind: 'units', version: 8, subVersion: 11, units: [
            placedUnit({ typeId: 'sloc', x: -768, y: -768, flags: 3, resourcesAmount: 0, targetAcquisition: 0, heroLevel: 0, editorId: 0 }),
            placedUnit({ typeId: 'hfoo', x: -512, y: -512, editorId: 1 }),
            placedUnit({
                typeId: 'Hpal', x: -256, y: -512, ownerIndex: 1, heroLevel: 3, heroStr: 25, editorId: 2,
                drops: [{ items: [{ itemId: 'ratc', chance: 100 }] }],
                invItems: [{ slot: 0, itemId: 'ratc' }],
                abilities: [{ abilityId: 'AHhb', autoCast: false, level: 1 }],
            }),
            placedUnit({ typeId: 'ratc', x: 0, y: -512, ownerIndex: 27, editorId: 3 }),
            placedUnit({ typeId: 'h000', x: -512, y: 0, ownerIndex: 24, editorId: 4 }),
        ],
    });
}

function buildPlacementDoodads() {
    return serializeDoo({
        kind: 'doodads', version: 8, subVersion: 11, specialVersion: 0, specialDoodads: [], doodads: [{
            typeId: 'LTlt', variation: 0, x: -640, y: 384, z: 0, angle: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
            skinId: 'LTlt', flags: 2, lifePerc: 100, itemTablePtr: -1, drops: [], editorId: 5,
        }],
    });
}

/** One custom unit with an inline name, one custom item named through war3map.wts. */
function buildCustomObjects(ext, baseId, newId, name) {
    return serializeObjMod({
        version: 2, ext, extended: false, origObjs: [],
        customObjs: [{ baseId, newId, mods: [{ fieldId: 'unam', varType: 'string', value: name, endToken: '\0\0\0\0' }] }],
    });
}

/** Writes a fresh temp dir holding the placement-editor map and returns its path. */
function makePlacementMapFixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-e2e-placement-'));
    fs.writeFileSync(path.join(dir, 'war3map.w3e'), buildW3e());
    fs.writeFileSync(path.join(dir, 'war3mapUnits.doo'), buildPlacementUnits());
    fs.writeFileSync(path.join(dir, 'war3map.doo'), buildPlacementDoodads());
    fs.writeFileSync(path.join(dir, 'war3map.w3i'), buildW3i());
    fs.writeFileSync(path.join(dir, 'war3map.w3u'), buildCustomObjects('.w3u', 'hfoo', 'h000', 'E2E Captain'));
    fs.writeFileSync(path.join(dir, 'war3map.w3t'), buildCustomObjects('.w3t', 'ratc', 'I000', 'TRIGSTR_007'));
    fs.writeFileSync(path.join(dir, 'war3map.wts'), 'STRING 7\n{\nE2E Relic\n}\n', 'utf8');
    return dir;
}

/** Writes a fresh temp dir containing the editable map-data fixtures and returns its path. */
function makeMapFixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-e2e-map-'));
    fs.writeFileSync(path.join(dir, 'war3map.w3i'), buildW3i());
    fs.writeFileSync(path.join(dir, 'war3map.wts'), WTS, 'utf8');
    fs.writeFileSync(path.join(dir, 'war3map.wpm'), buildWpm());
    fs.writeFileSync(path.join(dir, 'war3map.mmp'), buildMmp());
    fs.writeFileSync(path.join(dir, 'war3map.w3c'), buildW3c());
    fs.writeFileSync(path.join(dir, 'war3map.w3r'), buildW3r());
    fs.writeFileSync(path.join(dir, 'wurst.build'), 'projectName = wurst-e2e\n');
    return dir;
}

module.exports = {
    makeMapFixtureDir, makePlacementMapFixtureDir, buildW3i, buildWpm, buildMmp, buildW3c, buildW3r, WTS, W3I_VERSION, PLACEMENT_MAP,
};
