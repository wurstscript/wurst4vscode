'use strict';

/**
 * Fixture-driven test for the extension-side raster pipeline.
 *
 * Transpiles the real TypeScript module in memory, then decodes every checked-in
 * WC3 texture and compares its RGBA output to a known-good snapshot. In
 * particular, this exercises Warcraft's 4-component JPEG-content BLPs.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'wc3data');
const sourcePath = path.join(root, 'src', 'features', 'preview', 'imageDecoders.ts');

const expected = {
    'BTNAncientOfHibernation.blp': ['64x64', '9a57544e6aaec2775b28ce2528a31d00f07de29597143d52b8933d5c47c65a82'],
    'BTNBallista.blp': ['64x64', '0b0418fe37bdeeafd9e8cbed2108ec93dbeb9bcab07d7f596617e78b94d93531'],
    'BTNpick-later.blp': ['64x64', 'e3cdefe7c3a5c09be367ad989de180a721628acf671294bebbbbf4145d4b1a18'],
    'FrameTest.blp': ['771x133', 'bbee9dc4b58cfe5cfd1fe2851e51f8f881756fff7d2a4d18df562b79ff1aa77c'],
    'NetherRayTC.blp': ['256x256', 'd7907c3f5c9e850a288a0afb39e67acfd19f990089f6b186801a39c84dabf097'],
    'btn-afk-check.dds': ['128x128', 'd4bc1f6b44eff54606ae057dc2f8894902382a95e88cc9e7a0a89865bdfcd08a'],
    'fake_alpha.blp': ['256x128', '115074f22f896454dc060495d32bba389e1a8d69330bba31f44a8639ebea5d74'],
    'firering6.blp': ['64x64', 'a6a49a2a0b503113b44cd30f91b2e74c7757265f2c14cced9b26e6f5f02c7713'],
    'no_alpha.blp': ['771x133', 'bbee9dc4b58cfe5cfd1fe2851e51f8f881756fff7d2a4d18df562b79ff1aa77c'],
    'war3mapMap.blp': ['256x256', '3233233cf7c102d50d5debc0e5a57748ae821749805a79772fe9dab639a06ecf'],
};

function loadDecoder() {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const javascript = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    new Function('exports', 'module', 'require', javascript)(module.exports, module, require);
    return module.exports.decodeRasterPreview;
}

const fixtureNames = fs.readdirSync(fixtureDir)
    .filter((name) => /\.(blp|dds|tga)$/i.test(name))
    .sort();
assert.deepEqual(fixtureNames, Object.keys(expected).sort(), 'update snapshots when adding texture fixtures');

const decodeRasterPreview = loadDecoder();
const war3ModelEntry = require.resolve('war3-model');
assert.equal(require.cache[war3ModelEntry], undefined, 'war3-model should stay lazy until a JPEG BLP is decoded');
decodeRasterPreview(new Uint8Array(fs.readFileSync(path.join(fixtureDir, 'btn-afk-check.dds'))), '.dds');
assert.equal(require.cache[war3ModelEntry], undefined, 'decoding DDS must not load war3-model');

for (const name of fixtureNames) {
    const ext = path.extname(name).toLowerCase();
    const bytes = new Uint8Array(fs.readFileSync(path.join(fixtureDir, name)));
    const decoded = decodeRasterPreview(bytes, ext);
    assert.equal(decoded.mode, 'rgba', `${name}: extension consumers require normalized RGBA`);
    const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
    assert.equal(rgba.length, decoded.width * decoded.height * 4, `${name}: invalid RGBA length`);
    const dimensions = `${decoded.width}x${decoded.height}`;
    const hash = crypto.createHash('sha256').update(rgba).digest('hex');
    assert.deepEqual([dimensions, hash], expected[name], `${name}: decoded pixels changed`);
}
assert.ok(require.cache[war3ModelEntry], 'JPEG BLP decoding should load the custom war3-model decoder');

console.log(`image decoder fixture tests passed (${fixtureNames.length} textures)`);
