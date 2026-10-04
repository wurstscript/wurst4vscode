'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createTsLoader } = require('../e2e/harness/tsLoader');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
}
class TestDisposable {
    constructor(dispose = () => {}) { this.dispose = dispose; }
    static from(...items) { return new TestDisposable(() => items.forEach((item) => item.dispose())); }
}
const uri = (fsPath) => ({ fsPath, toString: () => fsPath });
function event() {
    const listeners = new Set();
    return {
        subscribe: (listener) => { listeners.add(listener); return new TestDisposable(() => listeners.delete(listener)); },
        fire: (value) => [...listeners].forEach((listener) => listener(value)),
    };
}

async function testIncrementalIndex(temp) {
    const a = path.join(temp, 'a');
    const b = path.join(temp, 'b');
    const files = [path.join(a, 'Icons.wurst'), path.join(a, '_build/dependencies/pkg/Models.wurst'), path.join(a, 'node_modules/ignored.wurst'), path.join(b, 'Icons.wurst')];
    for (const file of files) fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = (name, value) => `public class ${name}\n    static constant icon = "${value}.blp"\n`;
    files.forEach((file, i) => fs.writeFileSync(file, source(i === 1 ? 'Models' : 'Icons', `path${i}`)));
    const changed = event();
    const edited = event();
    const closed = event();
    const folders = [a, b].map((root) => ({ uri: uri(root) }));
    const reads = [];
    const documents = [];
    const load = createTsLoader({ mocks: {
        fs: { promises: { ...fs.promises, readFile: async (file, encoding) => { reads.push(file); return fs.promises.readFile(file, encoding); } } },
        vscode: { Disposable: TestDisposable, workspace: {
            workspaceFolders: folders, textDocuments: documents,
            getWorkspaceFolder: (value) => folders.find((folder) => value.fsPath.startsWith(folder.uri.fsPath + path.sep)),
            createFileSystemWatcher: () => ({ dispose() {}, onDidChange: changed.subscribe, onDidCreate: changed.subscribe, onDidDelete: changed.subscribe }),
            onDidChangeTextDocument: edited.subscribe, onDidCloseTextDocument: closed.subscribe,
            onDidChangeWorkspaceFolders: event().subscribe,
        } },
    } });
    const api = load('src/utils/assetIndex.ts');
    const registration = api.registerAssetIndexChanges(() => {});
    let index = await api.getAssetIndex(uri(files[0]));
    assert.equal(index.get('Icons.icon'), 'path0.blp');
    assert.equal(index.get('Models.icon'), 'path1.blp');
    assert.equal(reads.length, 2, 'exclude node_modules and visit dependencies once');
    await api.getAssetIndex(uri(files[0]));
    assert.equal(reads.length, 2, 'unchanged requests reuse the aggregate');
    changed.fire(uri(files[2]));
    assert.equal((await api.getAssetIndex(uri(files[0]))).get('Icons.icon'), 'path0.blp');
    assert.equal(reads.length, 2, 'excluded directories also stay excluded on watcher events');
    fs.writeFileSync(files[0], source('Icons', 'changed'));
    changed.fire(uri(files[0]));
    index = await api.getAssetIndex(uri(files[0]));
    assert.equal(index.get('Icons.icon'), 'changed.blp');
    assert.equal(reads.length, 3, 'one external edit reparses only its file');
    assert.equal((await api.getAssetIndex(uri(files[3]))).get('Icons.icon'), 'path3.blp', 'workspace indexes are independent');
    const doc = { uri: uri(files[0]), fileName: files[0], getText: () => source('Icons', 'unsaved') };
    documents.push(doc);
    edited.fire({ document: doc, contentChanges: [{}] });
    assert.equal((await api.getAssetIndex(doc.uri)).get('Icons.icon'), 'unsaved.blp');
    documents.pop();
    closed.fire(doc);
    assert.equal((await api.getAssetIndex(doc.uri)).get('Icons.icon'), 'changed.blp', 'closing a discarded buffer restores disk contents');
    fs.unlinkSync(files[0]);
    changed.fire(doc.uri);
    assert.equal((await api.getAssetIndex(doc.uri)).has('Icons.icon'), false, 'deleted contributions disappear');
    registration.dispose();
}

function decorationHarness(assets, roots = async () => []) {
    const edits = event();
    const visible = event();
    const active = event();
    const settings = event();
    let lean = false;
    let fullReads = 0;
    const applies = [];
    const doc = {
        uri: uri('/project/Main.wurst'), fileName: '/project/Main.wurst', version: 1, languageId: 'wurst', lineCount: 1,
        lineAt: () => ({ text: assets }), getText: (range) => { if (!range) { fullReads++; } return assets; },
        offsetAt: () => 0, positionAt: (offset) => ({ line: 0, character: offset }),
    };
    const editor = { document: doc, visibleRanges: [], setDecorations: (_type, ranges) => applies.push(ranges) };
    class Range {
        constructor(a, b, c, d) { this.start = typeof a === 'number' ? { line: a, character: b } : a; this.end = typeof a === 'number' ? { line: c, character: d } : b; }
    }
    const helpers = {
        getCandidateRoots: roots, getTempPreviewDir: () => '/cache', getCachedPreview: async () => undefined,
        ensurePreview: async (file) => ({ previewPath: file }), resolveAssetPath: async (asset) => asset,
        resolveAssetPathWithCasc: async () => undefined,
    };
    const window = {
        activeTextEditor: editor, createOutputChannel: () => ({ debug() {}, dispose() {} }),
        createTextEditorDecorationType: () => new TestDisposable(),
        onDidChangeActiveTextEditor: active.subscribe, onDidChangeTextEditorVisibleRanges: visible.subscribe,
    };
    const load = createTsLoader({ mocks: {
        vscode: { Disposable: TestDisposable, Range, ThemeColor: class {}, Uri: { file: uri }, window,
            workspace: { getConfiguration: () => ({ get: () => lean }), onDidChangeTextDocument: edits.subscribe, onDidChangeConfiguration: settings.subscribe } },
        'src/features/imageAssetSupport.ts': helpers,
        'src/features/preview/cascStorage.ts': { ensureGameTextureCached: async () => undefined },
        'src/utils/assetIndex.ts': { registerAssetIndexChanges: () => new TestDisposable(), getAssetIndex: async () => new Map() },
        'src/features/diagnostics.ts': { appendDiagnostic() {}, formatDiagnosticError: String },
    } });
    const api = load('src/features/inlineImageDecorations.ts');
    return { api, helpers, doc, editor, applies, edits, active, window, fullReads: () => fullReads,
        setLean: (value) => { lean = value; settings.fire({ affectsConfiguration: () => true }); } };
}

async function testDecorationOwnership() {
    const root = deferred();
    const h = decorationHarness('"a.png"', () => root.promise);
    const registration = h.api.registerInlineImageDecorations({});
    await delay(150);
    h.doc.version++;
    h.edits.fire({ document: h.doc });
    root.resolve([]);
    await tick();
    assert.equal(h.applies.length, 0, 'an edit invalidates a scan immediately, before debounce');
    registration.dispose();
    await delay(150);
    assert.equal(h.applies.length, 0, 'disposal cancels scheduled updates');

    const gate = deferred();
    const queued = decorationHarness('"a.png" "b.png" "c.png" "d.png"');
    const generated = [];
    queued.helpers.ensurePreview = async (file) => { generated.push(file); await gate.promise; return { previewPath: file }; };
    const disposable = queued.api.registerInlineImageDecorations({});
    await delay(150);
    assert.equal(generated.length, 2, 'thumbnail work respects concurrency');
    const before = queued.applies.length;
    queued.setLean(true);
    const cleared = queued.applies.length;
    assert(cleared >= before);
    gate.resolve();
    await delay(160);
    assert.equal(generated.length, 2, 'obsolete queued work never starts');
    assert.equal(queued.applies.length, cleared, 'old completions cannot decorate after lean mode is enabled');
    assert.equal(queued.fullReads(), 0, 'index detection only reads visible ranges');
    disposable.dispose();
}

function agentsHarness(storage, content) {
    const cache = new Map();
    const state = { get: (key, fallback) => cache.has(key) ? cache.get(key) : fallback, update: async (key, value) => cache.set(key, value) };
    const folder = { uri: uri(storage), name: 'project' };
    const context = { globalState: state, workspaceState: state, globalStorageUri: uri(path.join(storage, 'snapshots')) };
    let downloads = 0;
    let copied = '';
    const requests = [];
    const https = { get: (_url, options, callback) => {
        downloads++;
        const request = new EventEmitter();
        request.destroy = (error) => request.emit('error', error);
        options.signal.addEventListener('abort', () => request.destroy(new Error('aborted')));
        requests.push({ options, request });
        queueMicrotask(() => {
            if (content === null) return;
            const response = new EventEmitter();
            response.statusCode = 200;
            response.headers = {};
            callback(response);
            response.emit('data', Buffer.from(content));
            response.emit('end');
        });
        return request;
    } };
    const load = createTsLoader({ augment: { 'src/features/agentsGuide.ts': 'export { agentsTemplateWarning, createAgentsGuide, downloadAgentsGuide, requestAgentsGuide };' }, mocks: {
        https, vscode: { Uri: { file: uri }, workspace: { workspaceFolders: [folder] }, commands: { executeCommand: async () => {} },
            window: { showInformationMessage: async () => 'Copy Agent Prompt' }, env: { clipboard: { writeText: async (text) => { copied = text; } } } },
        'src/features/notificationOffer.ts': {}, 'src/features/diagnostics.ts': {},
    } });
    return { api: load('src/features/agentsGuide.ts'), context, folder, downloads: () => downloads, copied: () => copied, requests };
}

async function testAgentsUpdates(temp) {
    const directory = path.join(temp, 'guide');
    fs.mkdirSync(directory);
    const content = '<!-- WURST_AGENTS_TEMPLATE_VERSION: 2026-09-06 -->\nWurstScript Warcraft III map project notes\n';
    const h = agentsHarness(directory, content);
    await h.api.createAgentsGuide(h.folder, h.context);
    assert.equal(h.downloads(), 1);
    assert.equal(await h.api.downloadAgentsGuide(h.context), content);
    assert.equal(h.downloads(), 1, 'creation reuses a fresh template cache');
    const target = path.join(directory, 'AGENTS.md');
    assert.equal(await h.api.agentsTemplateWarning(target), undefined);
    fs.writeFileSync(target, content.replace('2026-09-06', '2026-10-01'));
    assert.equal(await h.api.agentsTemplateWarning(target), undefined, 'newer templates must not be called older');
    fs.writeFileSync(target, content.replace('2026-09-06', '2026-06-22') + '\nProject-specific rules\n');
    assert(await h.api.agentsTemplateWarning(target));
    const original = fs.readFileSync(target, 'utf8');
    await h.api.prepareAgentsGuideUpdate(h.context, h.folder);
    assert.equal(h.downloads(), 2, 'explicit review refreshes upstream');
    assert.equal(fs.readFileSync(target, 'utf8'), original, 'review never overwrites project guidance');
    assert(h.copied().includes('baseline-AGENTS.md'));
    assert(h.copied().includes('preserve all project-specific edits'));
    assert(h.copied().includes('https://raw.githubusercontent.com/wurstscript/WurstSetup'));
    assert(h.requests.every((entry) => entry.options.signal instanceof AbortSignal));
    const stalled = agentsHarness(directory, null);
    const originalTimeout = global.setTimeout;
    let deadline;
    global.setTimeout = (callback, ms) => { deadline = ms; return originalTimeout(callback, 1); };
    try {
        await assert.rejects(stalled.api.downloadAgentsGuide(stalled.context), /aborted/);
        assert.equal(deadline, 15000, 'downloads have a total deadline, including stalled responses');
    } finally { global.setTimeout = originalTimeout; }
}

async function testHoverCancellation() {
    for (const cancel of [false, true]) {
        const gate = deferred();
        let lookups = 0;
        const load = createTsLoader({ augment: { 'src/features/imagePreviewHover.ts': 'export { ImagePreviewHoverProvider };' }, mocks: {
            vscode: {},
            'src/features/preview/cascStorage.ts': {},
            'src/features/imageAssetSupport.ts': { getTempPreviewDir: () => '/cache', getCandidateRoots: () => gate.promise,
                resolveAssetPath: async () => { lookups++; return '/asset'; } },
        } });
        const doc = { uri: uri('/project/Main.wurst'), version: 1, lineAt: () => ({ text: '"a.blp"' }) };
        const token = { isCancellationRequested: false };
        const pending = new (load('src/features/imagePreviewHover.ts').ImagePreviewHoverProvider)().provideHover(doc, { character: 2 }, token);
        if (cancel) token.isCancellationRequested = true;
        else doc.version++;
        gate.resolve([]);
        assert.equal(await pending, undefined);
        assert.equal(lookups, 0, 'obsolete hovers stop before asset lookup');
    }
}

async function testExplicitPackageHeader() {
    const opened = event();
    const edits = [];
    let enabled = false;
    const load = createTsLoader({ mocks: {
        vscode: { window: {}, Position: class { constructor(line, character) { this.line = line; this.character = character; } },
            WorkspaceEdit: class { insert(...args) { this.inserted = args; } },
            workspace: { onDidOpenTextDocument: opened.subscribe, getConfiguration: () => ({ get: () => enabled }), applyEdit: async (edit) => { edits.push(edit); return true; } } },
        'src/features/diagnostics.ts': {},
    } });
    const api = load('src/features/fileCreation.ts');
    const registration = api.registerFileCreation();
    const doc = { uri: uri('/project/Example.wurst'), fileName: '/project/Example.wurst', lineCount: 1, getText: () => '' };
    opened.fire(doc);
    await tick();
    assert.equal(edits.length, 0, 'opening empty agent-created files does not edit them by default');
    await api.insertPackageHeader(doc);
    assert.equal(edits[0].inserted[1].line, 0);
    assert.equal(edits[0].inserted[2], 'package Example\n\n');
    enabled = true;
    opened.fire(doc);
    await tick();
    assert.equal(edits.length, 2, 'the legacy automatic behavior remains opt-in');
    registration.dispose();
}

async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-editor-tests-'));
    try {
        await testIncrementalIndex(temp);
        await testDecorationOwnership();
        await testAgentsUpdates(temp);
        await testHoverCancellation();
        await testExplicitPackageHeader();
        console.log('Editor work tests passed (incremental indexes, stale jobs, lean mode, bounded reads, AGENTS updates).');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
