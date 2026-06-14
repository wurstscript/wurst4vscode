'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    decodeBlp,
    decodeTga,
    parseDoo,
    parseObjMod,
    parseWct,
    parseWtg,
    parseWpm,
    parseW3i,
    serializeW3i,
} = require('casc-ts/formats');

const root = path.resolve(__dirname, '..');
const cascTestdata = path.resolve(root, '..', 'casc-ts', 'testdata');
const wc3libsResources = path.resolve(root, '..', 'wc3libs', 'src', 'test', 'resources');

function read(relPath) {
    return fs.readFileSync(path.resolve(root, relPath));
}

function readExternal(base, relPath) {
    return fs.readFileSync(path.resolve(base, relPath));
}

function assertNoError(parsed, label) {
    assert.ok(!parsed.error, `${label}: ${parsed.error}`);
}

function assertRaster(decoded, label) {
    assert.equal(decoded.kind, 'raster', `${label}: expected raster result`);
    assert.ok(decoded.width > 0, `${label}: expected positive width`);
    assert.ok(decoded.height > 0, `${label}: expected positive height`);
    if (decoded.mode === 'rgba') {
        const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
        assert.equal(rgba.length, decoded.width * decoded.height * 4, `${label}: RGBA byte count mismatch`);
    } else {
        assert.ok(Buffer.from(decoded.jpegBase64, 'base64').length > 0, `${label}: empty JPEG payload`);
    }
}

function testImages() {
    const images = [
        ['casc-ts war3mapMap.blp', () => decodeBlp(readExternal(cascTestdata, 'war3mapMap.blp'))],
        ['wc3libs test.blp', () => decodeBlp(readExternal(wc3libsResources, 'images/test.blp'))],
        ['wc3libs transparent_example.blp', () => decodeBlp(readExternal(wc3libsResources, 'images/transparent_example.blp'))],
        ['wc3libs no_alpha.blp', () => decodeBlp(readExternal(wc3libsResources, 'images/no_alpha.blp'))],
        ['wc3libs fake_alpha.blp', () => decodeBlp(readExternal(wc3libsResources, 'images/fake_alpha.blp'))],
        ['wc3libs test.tga', () => decodeTga(readExternal(wc3libsResources, 'images/test.tga'))],
    ];

    for (const [label, decode] of images) {
        assertRaster(decode(), label);
    }
}

function testWpm() {
    for (const [label, data] of [
        ['casc-ts war3map.wpm', readExternal(cascTestdata, 'war3map.wpm')],
        ['wc3libs WPM/war3map.wpm', readExternal(wc3libsResources, 'wc3data/WPM/war3map.wpm')],
    ]) {
        const parsed = parseWpm(data);
        assertNoError(parsed, label);
        assert.ok(parsed.width > 0 && parsed.height > 0, `${label}: expected dimensions`);
        assert.equal(parsed.data.length, parsed.width * parsed.height, `${label}: cell count mismatch`);
    }
}

function testDoo() {
    for (const [label, fileName, data] of [
        ['casc-ts war3map.doo', 'war3map.doo', readExternal(cascTestdata, 'war3map.doo')],
        ['casc-ts war3mapUnits.doo', 'war3mapUnits.doo', readExternal(cascTestdata, 'war3mapUnits.doo')],
        ['wc3libs DOO/war3map.doo', 'war3map.doo', readExternal(wc3libsResources, 'wc3data/DOO/war3map.doo')],
        ['wc3libs DOO_UNITS/war3mapUnits.doo', 'war3mapUnits.doo', readExternal(wc3libsResources, 'wc3data/DOO_UNITS/war3mapUnits.doo')],
    ]) {
        const parsed = parseDoo(data, fileName);
        assertNoError(parsed, label);
        assert.ok(parsed.kind === 'doodads' || parsed.kind === 'units', `${label}: unknown DOO kind`);
    }
}

function testObjectMods() {
    const files = [
        'war3map.w3u',
        'war3map.w3t',
        'war3map.w3a',
        'war3map.w3b',
        'war3map.w3d',
        'war3map.w3h',
        'war3map.w3q',
        'war3mapSkin.w3u',
        'war3mapSkin.w3t',
        'war3mapSkin.w3a',
        'war3mapSkin.w3b',
        'war3mapSkin.w3d',
        'war3mapSkin.w3h',
        'war3mapSkin.w3q',
    ];

    for (const file of files) {
        const ext = path.extname(file);
        const parsed = parseObjMod(readExternal(cascTestdata, file), ext);
        assertNoError(parsed, `casc-ts ${file}`);
        assert.ok(parsed.version >= 1, `casc-ts ${file}: expected version`);
    }

    for (const ext of ['W3U', 'W3T', 'W3A', 'W3B', 'W3D', 'W3H', 'W3Q']) {
        const rel = `wc3data/${ext}/war3map.${ext.toLowerCase()}`;
        const parsed = parseObjMod(readExternal(wc3libsResources, rel), `.${ext.toLowerCase()}`);
        assertNoError(parsed, `wc3libs ${rel}`);
        assert.ok(parsed.version >= 1, `wc3libs ${rel}: expected version`);
    }
}

function testTriggers() {
    for (const [label, data] of [
        ['casc-ts war3map.wct', readExternal(cascTestdata, 'war3map.wct')],
        ['wc3libs WCT/war3map.wct', readExternal(wc3libsResources, 'wc3data/WCT/war3map.wct')],
    ]) {
        const parsed = parseWct(data);
        assertNoError(parsed, label);
        assert.ok(Array.isArray(parsed.trigs), `${label}: expected trigger array`);
    }

    for (const [label, data] of [
        ['casc-ts war3map.wtg', readExternal(cascTestdata, 'war3map.wtg')],
        ['wc3libs WTG/war3map.wtg', readExternal(wc3libsResources, 'wc3data/WTG/war3map.wtg')],
    ]) {
        const parsed = parseWtg(data);
        assertNoError(parsed, label);
        assert.ok(parsed.trigCount >= parsed.trigs.length, `${label}: trigger count mismatch`);
    }
}

function testW3i() {
    // Parse-prefix + opaque-tail must round-trip byte-exact across w3i versions, and
    // editing a prefix string must preserve the opaque tail (players/forces/lists).
    for (const [label, data] of [
        ['casc-ts war3map.w3i', readExternal(cascTestdata, 'war3map.w3i')],
        ['wc3libs W3I/war3map.w3i', readExternal(wc3libsResources, 'wc3data/W3I/war3map.w3i')],
        ['wc3libs W3I/war3map_default.w3i', readExternal(wc3libsResources, 'wc3data/W3I/war3map_default.w3i')],
        ['wc3libs W3I/war3map_latest_lua.w3i', readExternal(wc3libsResources, 'wc3data/W3I/war3map_latest_lua.w3i')],
    ]) {
        const parsed = parseW3i(data);
        assertNoError(parsed, label);
        assert.ok(parsed.version >= 1, `${label}: expected version`);
        assert.ok(serializeW3i(parsed).equals(data), `${label}: serialize ∘ parse not byte-exact`);

        const edited = parseW3i(data);
        edited.name = 'Smoke Test Name';
        const reparsed = parseW3i(serializeW3i(edited));
        assertNoError(reparsed, `${label} (edited)`);
        assert.equal(reparsed.name, 'Smoke Test Name', `${label}: edited name not persisted`);
        assert.ok(reparsed.tail.equals(parsed.tail), `${label}: opaque tail changed after edit`);
    }
}

function main() {
    assert.ok(fs.existsSync(cascTestdata), `Missing casc-ts testdata at ${cascTestdata}`);
    assert.ok(fs.existsSync(wc3libsResources), `Missing wc3libs resources at ${wc3libsResources}`);

    testImages();
    testWpm();
    testDoo();
    testObjectMods();
    testTriggers();
    testW3i();

    console.log('WC3 preview smoke fixtures passed');
}

main();
