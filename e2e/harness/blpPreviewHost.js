'use strict';

/**
 * Harness for the readonly image/model preview (`wurst.blpPreview`): the real `BlpPreviewProvider`
 * from src/features/blpPreview.ts mounted on the fake panel, previewing a file copied to a temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTsLoader, root } = require('./tsLoader');
const { createVscodeMock, fileUri } = require('./vscodeMock');
const { mountCustomEditor } = require('./customEditorHost');

const BLP_INTERNALS = `export const __e2e = { BlpPreviewProvider };`;

/**
 * Uncompressed 32-bit top-left-origin TGA: the left half opaque red, the right half fully
 * transparent blue, so a test can tell the alpha channel survived the round trip.
 */
function buildTga(width, height) {
    const out = Buffer.alloc(18 + width * height * 4);
    out[2] = 2; // uncompressed true-colour
    out.writeUInt16LE(width, 12);
    out.writeUInt16LE(height, 14);
    out[16] = 32;
    out[17] = 0x28; // 8 alpha bits, top-left origin
    for (let i = 0; i < width * height; i++) {
        const opaqueRed = (i % width) < width / 2;
        out.set(opaqueRed ? [0, 0, 255, 255] : [255, 0, 0, 0], 18 + i * 4); // BGRA
    }
    return out;
}

async function createBlpPreviewHost(opts) {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-blp-e2e-'));
    // `copyFrom` previews a checked-in asset (e.g. wc3data/melon.mdx) instead of the generated TGA.
    const target = path.join(fixtureDir, opts.copyFrom ? path.basename(opts.copyFrom) : 'swatch.tga');
    if (opts.copyFrom) fs.copyFileSync(path.join(root, opts.copyFrom), target);
    else fs.writeFileSync(target, buildTga(opts.width || 8, opts.height || 4));

    const vscodeMock = createVscodeMock({ workspaceFolders: [{ uri: fileUri(fixtureDir), name: 'fixture', index: 0 }] });
    const load = createTsLoader({ mocks: { vscode: vscodeMock }, augment: { 'src/features/blpPreview.ts': BLP_INTERNALS } });
    const provider = new (load('src/features/blpPreview.ts').__e2e.BlpPreviewProvider)(fileUri(root));

    const mounted = await mountCustomEditor({ origin: opts.origin, provider, uri: fileUri(target) });
    mounted.dispose = () => {
        mounted.panel.dispose();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    };
    return mounted;
}

module.exports = { createBlpPreviewHost };
