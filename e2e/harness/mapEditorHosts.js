'use strict';

/**
 * Harnesses for the two editable map-data formats whose webview JS ships as an inline `<script>`
 * inside the host TypeScript: `.w3i` (W3iEditorProvider in mapDataPreview.ts) and `.wpm`
 * (WpmEditorProvider in wpmPreview.ts).
 *
 * Until now that inline script was only checked by parsing it with `vm.Script` and grepping the
 * surrounding source for expected substrings — neither of which can tell whether the thing actually
 * works. Running the real emitted page in a browser can.
 */

const fs = require('fs');

const { createTsLoader } = require('./tsLoader');
const { createVscodeMock, fileUri } = require('./vscodeMock');
const { mountCustomEditor } = require('./customEditorHost');
const { makeMapFixtureDir } = require('./makeFixtures');

const W3I_INTERNALS = `export const __e2e = { W3iEditorProvider, W3iDocument, renderW3iEditor };`;
const WPM_INTERNALS = `export const __e2e = { WpmEditorProvider, WpmDocument, buildWpmHtml };`;

async function createEditorHost(opts, sourceFile, internals, fileName, providerFactory, isDirty) {
    const fixtureDir = opts.fixtureDir || makeMapFixtureDir();
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

    const load = createTsLoader({ mocks: { vscode: vscodeMock }, augment: { [sourceFile]: internals } });
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
        (doc) => doc.editDepth !== doc.savedDepth,
    );
}

function createWpmHost(opts) {
    return createEditorHost(
        opts, 'src/features/wpmPreview.ts', WPM_INTERNALS, 'war3map.wpm',
        (e2e) => new e2e.WpmEditorProvider(),
        (doc) => doc.currentRevision !== doc.savedRevision,
    );
}

module.exports = { createW3iHost, createWpmHost };
