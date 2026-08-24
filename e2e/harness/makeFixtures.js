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

const { serializeW3i, serializeWpm, BinWriter } = repoRequire('casc-ts/formats');

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
`;

/** 16x16 pathing map with a recognisable block of blocked cells to assert paint/erase against. */
function buildWpm() {
    const width = 16;
    const height = 16;
    const data = Buffer.alloc(width * height, 0);
    for (let y = 4; y < 8; y++) {
        for (let x = 4; x < 8; x++) data[y * width + x] = 0x02; // walkability blocked
    }
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
    camera('Overview', [128, 256, 32, 90, 304, 1650, 0, 70, 5000, 0]);
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
    region('Spawn Area', -128, 256, -64, 384, 3, 'NULL', 'Sound\\Environment\\GrasslandDay', 0x40, 0x80, 0xc0);
    region('Boss Room', 512, 1024, 768, 1280, 7, 'SNOW', '', 0x10, 0x20, 0x30, 1);
    return w.toBuffer();
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

module.exports = { makeMapFixtureDir, buildW3i, buildWpm, buildMmp, buildW3c, buildW3r, WTS, W3I_VERSION };
