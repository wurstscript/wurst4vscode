'use strict';

/**
 * Harnesses for the editable map-data formats (`.w3i`, `.mmp`, `.w3c`, `.w3r`, `.wpm`) and the map
 * terrain and placement editor on `war3mapUnits.doo`.
 *
 * Their page scripts used to be checked only by parsing them with `vm.Script` and grepping the
 * surrounding source for expected substrings, neither of which can tell whether the thing actually
 * works. Running the real emitted page in a browser can.
 */

const fs = require('fs');

const { createTsLoader, root } = require('./tsLoader');
const { createVscodeMock, fileUri } = require('./vscodeMock');
const { mountCustomEditor } = require('./customEditorHost');
const { makeMapFixtureDir, makePlacementMapFixtureDir } = require('./makeFixtures');

const W3I_INTERNALS = `export const __e2e = { W3iEditorProvider, W3iDocument, renderW3iEditor };`;
const WPM_INTERNALS = `export const __e2e = { WpmEditorProvider, WpmDocument, buildWpmHtml };`;
const MMP_INTERNALS = `export const __e2e = { MmpEditorProvider, MmpDocument, renderMmpEditor, parseMmpFile };`;
const W3C_INTERNALS = `export const __e2e = { W3cEditorProvider, W3cDocument, renderW3cEditor, parseW3cFile };`;
const W3R_INTERNALS = `export const __e2e = { W3rEditorProvider, W3rDocument, renderW3rEditor, parseW3rFile };`;
const MAP_PLACEMENT_INTERNALS = `export const __e2e = { MapPlacementEditorProvider, MapPlacementDocument, terrainHeightAt };`;

/** No game data: terrain tiles fall back to their deterministic colours on every machine, and the
 *  placement picker lists only knowledge-base and map-local types. */
const NO_GAME_DATA = {
    'src/features/preview/cascStorage.ts': {
        findGameTexture: async () => null,
        findGameAsset: async () => null,
        logGameData: () => {},
    },
};

async function createEditorHost(opts, sourceFile, internals, fileName, providerFactory, isDirty, setup = {}) {
    const fixtureDir = opts.fixtureDir || (setup.makeFixtureDir || makeMapFixtureDir)();
    const ownsFixtureDir = !opts.fixtureDir;
    const target = `${fixtureDir}/${opts.fileName || fileName}`;

    let mounted;
    const vscodeMock = createVscodeMock({
        config: opts.config || {},
        workspaceFolders: [{ uri: fileUri(fixtureDir), name: 'fixture', index: 0 }],
        onCommand: (command) => {
            if (!mounted) return undefined;
            if (command === 'undo') mounted.undo();
            else if (command === 'redo') mounted.redo();
            else if (command === 'workbench.action.files.save') return mounted.save();
            return undefined;
        },
    });

    const load = createTsLoader({ mocks: { vscode: vscodeMock, ...setup.mocks }, augment: { [sourceFile]: internals } });
    const mod = load(sourceFile);
    const provider = providerFactory(mod.__e2e);

    mounted = await mountCustomEditor({ origin: opts.origin, provider, uri: fileUri(target) });

    Object.assign(mounted, {
        fixtureDir,
        filePath: target,
        vscodeMock,
        internals: mod.__e2e,
        readFile: (name) => fs.readFileSync(`${fixtureDir}/${name || opts.fileName || fileName}`),
        readText: (name) => fs.readFileSync(`${fixtureDir}/${name}`, 'utf8'),
        fileExists: (name) => fs.existsSync(`${fixtureDir}/${name}`),
        dispose: () => {
            mounted.panel.dispose();
            mounted.doc.dispose();
            if (ownsFixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
        },
    });
    // Defined rather than assigned: Object.assign would evaluate the getter once and freeze it.
    Object.defineProperty(mounted, 'isDirty', { get: () => isDirty(mounted.doc) });
    return mounted;
}

function createW3iHost(opts) {
    return createEditorHost(
        opts, 'src/features/mapDataPreview.ts', W3I_INTERNALS, 'war3map.w3i',
        (e2e) => new e2e.W3iEditorProvider(),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

function createWpmHost(opts) {
    return createEditorHost(
        opts, 'src/features/wpmPreview.ts', WPM_INTERNALS, 'war3map.wpm',
        (e2e) => new e2e.WpmEditorProvider(fileUri(root)),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

function createMmpHost(opts) {
    return createEditorHost(
        opts, 'src/features/mapDataPreview.ts', MMP_INTERNALS, 'war3map.mmp',
        (e2e) => new e2e.MmpEditorProvider(),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

function createW3cHost(opts) {
    return createEditorHost(
        opts, 'src/features/mapDataPreview.ts', W3C_INTERNALS, 'war3map.w3c',
        (e2e) => new e2e.W3cEditorProvider(),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

function createW3rHost(opts) {
    return createEditorHost(
        opts, 'src/features/mapDataPreview.ts', W3R_INTERNALS, 'war3map.w3r',
        (e2e) => new e2e.W3rEditorProvider(),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

function createMapPlacementHost(opts) {
    return createEditorHost(
        opts, 'src/features/mapPreview.ts', MAP_PLACEMENT_INTERNALS, 'war3mapUnits.doo',
        (e2e) => new e2e.MapPlacementEditorProvider(fileUri(root)),
        (doc) => doc.currentRevision !== doc.savedRevision,
        { mocks: NO_GAME_DATA, makeFixtureDir: makePlacementMapFixtureDir },
    );
}

module.exports = { createW3iHost, createWpmHost, createMmpHost, createW3cHost, createW3rHost, createMapPlacementHost };
