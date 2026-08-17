'use strict';

/**
 * Boots the *real* object-editor host (`ObjModEditorProvider` from src/features/objModPreview.ts)
 * outside VS Code, against the fake panel in customEditorHost.js.
 *
 * This is not a reimplementation: `openCustomDocument`, `resolveCustomEditor`, `buildHtml`, the
 * message handler, the undo/redo edits and `saveCustomDocument` are the shipping code paths. Only
 * VS Code itself is faked, so a Playwright page driving the real webview bundle against this
 * exercises the same host<->webview contract the extension ships.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTsLoader, root } = require('./tsLoader');
const { createVscodeMock, fileUri } = require('./vscodeMock');
const { mountCustomEditor } = require('./customEditorHost');

// Reaching into module-private values rather than adding test-only exports to the production file.
// A rename there fails loudly here (ReferenceError at load), which is the intended signal.
const OBJMOD_INTERNALS = `
export const __e2e = { ObjModEditorProvider, ObjModDocument, loadEditableObjMod, buildHtml, applyFieldEdit, modDisplayValue, serializeValidated };
`;

function createMemento(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: (key, value) => { store.set(key, value); return Promise.resolve(); },
        keys: () => Array.from(store.keys()),
        _store: store,
    };
}

/** Copies a fixture directory into a temp dir so save/edit tests never mutate the repo copy. */
function copyFixtureDir(fixtureDir, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    for (const name of fs.readdirSync(fixtureDir)) {
        const from = path.join(fixtureDir, name);
        if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dir, name));
    }
    return dir;
}

/**
 * @param {object} opts
 * @param {string} opts.origin       Harness server origin. Becomes the webview's cspSource, so the
 *                                   page's real CSP has to genuinely admit the bundle it loads — a
 *                                   CSP regression fails the test instead of passing quietly.
 * @param {string} [opts.fixtureDir] Directory holding war3map.w3u & friends. Defaults to e2e/.
 * @param {string} [opts.fileName]   File within it to open. Defaults to war3map.w3u.
 * @param {Record<string, unknown>} [opts.config]  wurst.* settings the host should read.
 */
async function createObjModHost(opts) {
    const fixtureDir = copyFixtureDir(opts.fixtureDir || path.join(root, 'e2e'), 'wurst-e2e-objmod-');
    const fileName = opts.fileName || 'war3map.w3u';
    const target = path.join(fixtureDir, fileName);

    let mounted;
    const vscodeMock = createVscodeMock({
        config: opts.config || {},
        workspaceFolders: [{ uri: fileUri(fixtureDir), name: 'fixture', index: 0 }],
        // The webview forwards Ctrl+Z / Ctrl+S to the host as VS Code commands; wiring them to the
        // real edit stack means a keystroke in the page actually undoes or saves.
        onCommand: (command) => {
            if (!mounted) return undefined;
            if (command === 'undo') mounted.undo();
            else if (command === 'redo') mounted.redo();
            else if (command === 'workbench.action.files.save') return mounted.save();
            return undefined;
        },
    });

    const load = createTsLoader({
        mocks: { vscode: vscodeMock },
        augment: { 'src/features/objModPreview.ts': OBJMOD_INTERNALS },
    });
    const mod = load('src/features/objModPreview.ts');

    const workspaceState = createMemento(opts.workspaceState);
    const globalState = createMemento(opts.globalState);
    const provider = new mod.__e2e.ObjModEditorProvider(fileUri(root), workspaceState, globalState);

    mounted = await mountCustomEditor({ origin: opts.origin, provider, uri: fileUri(target) });

    Object.assign(mounted, {
        fixtureDir,
        filePath: target,
        vscodeMock,
        workspaceState,
        globalState,
        internals: mod.__e2e,
        readFile: (name) => fs.readFileSync(path.join(fixtureDir, name || fileName)),
        dispose: () => {
            mounted.panel.dispose();
            mounted.doc.dispose();
            fs.rmSync(fixtureDir, { recursive: true, force: true });
        },
    });
    // Object.assign would evaluate this getter once and freeze the result, so define it directly.
    Object.defineProperty(mounted, 'isDirty', {
        get() { return mounted.doc.currentRevision !== mounted.doc.savedRevision; },
    });
    return mounted;
}

module.exports = { createObjModHost, createMemento, copyFixtureDir };
