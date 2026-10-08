'use strict';

const assert = require('assert');
const { createTsLoader } = require('../e2e/harness/tsLoader');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

class TestDisposable {
    constructor(dispose = () => {}) { this.dispose = dispose; }
    static from(...items) { return new TestDisposable(() => items.forEach((item) => item.dispose())); }
}

function lifecycleHarness(installation = Promise.resolve(), documents = []) {
    const clients = [];
    const watchers = [];
    const states = { Starting: 1, Running: 2, Stopped: 3 };
    class Client {
        features = [];
        registerFeature(feature) { this.features.push(feature); }
        getFeature() { return this.openFeature; }
        constructor(_name, _server, options) {
            this.options = options;
            this.started = deferred();
            this.state = states.Stopped;
            this.stopCount = 0;
            clients.push(this);
        }
        async start() {
            this.transition(states.Starting);
            try { await this.started.promise; }
            catch (error) { this.transition(states.Stopped); throw error; }
            this.transition(states.Running);
        }
        isRunning() { return this.state === states.Running; }
        stop() {
            if (this.state === states.Starting) return Promise.reject(new Error('cannot stop an initializing client'));
            this.stopCount++;
            this.transition(states.Stopped);
            return Promise.resolve();
        }
        transition(state) { this.state = state; this.listener?.({ newState: state }); }
        onDidChangeState(listener) {
            this.listener = listener;
            return new TestDisposable(() => { this.listener = undefined; });
        }
        notifications = new Map();
        requests = [];
        onNotification(method, handler) {
            this.notifications.set(method, handler);
            return new TestDisposable(() => this.notifications.delete(method));
        }
        sendRequest(method) { this.requests.push(method); return Promise.resolve([]); }
    }
    const vscode = {
        Disposable: TestDisposable,
        workspace: {
            workspaceFolders: [{ uri: { fsPath: require('path').resolve('initial-project') } }],
            textDocuments: documents,
            getConfiguration: () => ({ get: (key) => key === 'javaOpts' ? [] : undefined }),
            createFileSystemWatcher: (pattern) => {
                const watcher = { pattern, disposed: false, dispose() { this.disposed = true; } };
                watchers.push(watcher);
                return watcher;
            },
        },
    };
    const load = createTsLoader({ mocks: {
        vscode,
        fs: { existsSync: () => true },
        'vscode-languageclient/node': { LanguageClient: Client, State: states, DidOpenTextDocumentNotification: { method: 'textDocument/didOpen' } },
        'src/paths.ts': {},
        'src/install/installer.ts': {
            ensureInstalledOrOfferMigration: () => typeof installation === 'function' ? installation() : installation,
            getLanguageServerJava: () => 'java',
            getInstalledVersionString: () => Promise.resolve('test'),
            maybeOfferUpdate: () => Promise.resolve(),
        },
        'src/features/diagnostics.ts': { appendDiagnostic() {}, formatDiagnosticError: String },
    } });
    return { server: load('src/languageServer.ts'), context: { subscriptions: [] }, clients, watchers, states, workspace: vscode.workspace };
}

async function testClientReadinessAndRestarts() {
    const h = lifecycleHarness();
    const start = h.server.startLanguageClient(h.context);
    await tick();
    const client = h.clients[0];
    let resolved = false;
    const command = h.server.getLanguageClient().then((value) => { resolved = true; return value; });
    await tick();
    assert.equal(resolved, false, 'commands must wait for start to finish');
    assert.equal(h.server.getRunningLanguageClient(), null);
    client.started.resolve();
    await start;
    assert.equal(await command, client);
    assert.equal(h.server.getRunningLanguageClient(), client);
    client.transition(h.states.Stopped);
    assert.equal(h.server.getRunningLanguageClient(), null, 'crashed clients are unavailable');
    await assert.rejects(h.server.getLanguageClient(), /stopped unexpectedly/);
    client.transition(h.states.Starting);
    await assert.rejects(h.server.getLanguageClient(), /restarting/);
    client.transition(h.states.Running);
    assert.equal(await h.server.getLanguageClient(), client, 'automatic restart restores readiness');
    h.workspace.workspaceFolders = [{ uri: { fsPath: require('path').resolve('other-project') } }];
    assert.equal(client.options.workspaceFolder.uri.fsPath, require('path').resolve('initial-project'), 'the server root must remain pinned after workspace folders change');
    assert.equal(client.options.synchronize.fileEvents, h.watchers[0], 'the language client owns event batching');
    assert.equal(h.watchers[0].pattern, '**/*.{wurst,jurst,j}');
    await h.server.stopLanguageServerIfRunning();
    assert.equal(h.watchers[0].disposed, true);
    await assert.rejects(h.server.getLanguageClient(), /was stopped/);
}

async function testBuildNotificationsAvoidRequests() {
    const h = lifecycleHarness();
    const start = h.server.startLanguageClient(h.context);
    await tick();
    const client = h.clients[0];
    const feature = client.features[0];
    const capabilities = {};
    feature.fillClientCapabilities(capabilities);
    assert.equal(capabilities.experimental.wurstInitialBuildStatus, true);
    const serverCapabilities = { experimental: { wurstInitialBuildStatus: true } };
    client.initializeResult = { capabilities: serverCapabilities };
    client.transition(h.states.Running);
    client.notifications.get('wurst/initialBuildStatus')({ state: 'ready' });
    feature.initialize(serverCapabilities);
    client.started.resolve();
    await start;
    assert.deepEqual(client.requests, [], 'a capable server must not flush hidden opens with a readiness request');
    client.transition(h.states.Stopped);
    client.transition(h.states.Starting);
    client.transition(h.states.Running);
    feature.initialize(serverCapabilities);
    client.notifications.get('wurst/initialBuildStatus')({ state: 'failed' });
    assert.deepEqual(client.requests, [], 'automatic restarts and failed builds must also avoid the probe');
    client.transition(h.states.Stopped);
    client.transition(h.states.Starting);
    client.transition(h.states.Running);
    feature.initialize({});
    assert.deepEqual(client.requests, ['workspace/symbol'], 'legacy/no-signal servers must retain the readiness barrier');
    await h.server.stopLanguageServerIfRunning();
}

async function testStopDuringInstallation() {
    const installation = deferred();
    const h = lifecycleHarness(installation.promise);
    const start = h.server.startLanguageClient(h.context);
    const command = h.server.getLanguageClient();
    assert.equal(await h.server.stopLanguageServerIfRunning(true), true);
    await assert.rejects(command, /was stopped/);
    installation.resolve();
    await start;
    assert.equal(h.clients.length, 0, 'a cancelled install must not start a JVM later');
    assert.equal(await h.server.stopLanguageServerIfRunning(), false);
}

async function testInstallerPreservesItsOwnStartup() {
    const h = lifecycleHarness(async () => {
        assert.equal(await h.server.stopLanguageServerIfRunning(), false);
    });
    const start = h.server.startLanguageClient(h.context);
    await tick();
    assert.equal(h.clients.length, 1, 'installation must resume the activation which requested it');
    h.clients[0].started.resolve();
    await start;
    assert.equal(await h.server.getLanguageClient(), h.clients[0]);
    await h.server.stopLanguageServerIfRunning();
}

async function testFailedStartCleansUp() {
    const h = lifecycleHarness();
    const start = h.server.startLanguageClient(h.context);
    await tick();
    const command = h.server.getLanguageClient();
    const failure = new Error('startup failed');
    h.clients[0].started.reject(failure);
    await assert.rejects(start, /startup failed/);
    await assert.rejects(command, /startup failed/);
    assert.equal(h.watchers[0].disposed, true);
    assert.equal(h.clients[0].stopCount, 1);
    assert.equal(h.server.getRunningLanguageClient(), null);
}

async function testStoppedStartupCannotOverwriteReplacement() {
    const h = lifecycleHarness();
    const oldStart = h.server.startLanguageClient(h.context);
    await tick();
    const oldCommand = h.server.getLanguageClient();
    await h.server.stopLanguageServerIfRunning(true);
    await assert.rejects(oldCommand, /was stopped/);
    const replacementStart = h.server.startLanguageClient(h.context);
    await tick();
    const replacementCommand = h.server.getLanguageClient();
    h.clients[0].started.reject(new Error('late failure from stopped process'));
    await oldStart;
    h.clients[1].started.resolve();
    await replacementStart;
    assert.equal(await replacementCommand, h.clients[1]);
    assert.equal(h.server.getRunningLanguageClient(), h.clients[1]);
    assert.equal(h.watchers[1].disposed, false, 'old cleanup must not dispose the new watcher');
    await h.server.stopLanguageServerIfRunning();
}

async function testStoppedStartupTerminatesAfterInitialization() {
    const h = lifecycleHarness();
    const start = h.server.startLanguageClient(h.context);
    await tick();
    const command = h.server.getLanguageClient();
    await h.server.stopLanguageServerIfRunning(true);
    await assert.rejects(command, /was stopped/);
    h.clients[0].started.resolve();
    await start;
    assert.equal(h.clients[0].stopCount, 1, 'a late initialization must not leave an orphan JVM');
    assert.equal(h.server.getRunningLanguageClient(), null);
}

function linkHarness(resolveAssetPath, getCandidateRoots = async () => [], settings = { lean: false }) {
    class Range { constructor(start, end) { this.start = start; this.end = end; } }
    class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
    class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
    class Emitter { event = () => new TestDisposable(); dispose() {} }
    const load = createTsLoader({
        augment: { 'src/features/assetLinks.ts': 'export { WurstAssetLinkProvider, WurstAssetCodeLensProvider, TOC_LINE_RE, findAssetStrings, findAssetStringAt };' },
        mocks: {
            vscode: { Range, DocumentLink, CodeLens, EventEmitter: Emitter,
                CancellationError: class extends Error { constructor() { super('Canceled'); this.name = 'Canceled'; } },
                workspace: { getConfiguration: () => ({ get: () => settings.lean }) },
                Uri: { file: (fsPath) => ({ fsPath }), parse: (value) => value } },
            'src/features/imageAssetSupport.ts': { getCandidateRoots, resolveAssetPath },
            'src/features/objModPreview.ts': {}, 'src/features/preview/modelPreviewHost.ts': {},
            'src/features/preview/cascStorage.ts': {}, 'src/features/soundPreview.ts': {},
            'src/features/webviewShared.ts': {}, 'src/features/webviewUtils.ts': {},
            'src/features/diagnostics.ts': {}, 'src/features/preview/fuzzy.ts': {},
        },
    });
    return load('src/features/assetLinks.ts');
}

function document(text) {
    const doc = { uri: { fsPath: '/project/source.wurst', toString: () => '/project/source.wurst' }, languageId: 'wurst', version: 1,
        text, isClosed: false, reads: [], positionAt: (offset) => offset, offsetAt: (offset) => offset };
    doc.getText = (range) => { doc.reads.push(range); return range ? doc.text.slice(range.start, range.end) : doc.text; };
    return doc;
}

async function testConcurrentLinks(toc, textA, textB) {
    const gates = new Map();
    const calls = new Map();
    const api = linkHarness(async (asset) => {
        calls.set(asset, (calls.get(asset) ?? 0) + 1);
        if (calls.get(asset) === 1 && ['a-long-first.mdx', 'b.mdx', 'a-long-first.fdf', 'b.fdf'].includes(asset)) {
            await new Promise((resolve) => gates.set(asset, resolve));
        }
        return asset;
    });
    const provider = new api.WurstAssetLinkProvider(toc ? api.TOC_LINE_RE : undefined);
    const token = { isCancellationRequested: false };
    const [a, b] = await Promise.all([provider.provideDocumentLinks(document(textA), token), provider.provideDocumentLinks(document(textB), token)]);
    assert.equal(calls.size, 0, 'range discovery must not resolve assets');
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert(a.every((link) => link.target === undefined));
    const resolvedA = provider.resolveDocumentLink(a[0], token);
    const resolvedB = provider.resolveDocumentLink(b[0], token);
    await tick();
    // A third scan cannot disturb two in-flight resolutions.
    assert.equal([...api.findAssetStrings(document('"other.mdx"'))].length, 1);
    [...gates.values()][0]();
    assert.equal((await resolvedA).target.fsPath, a[0].tooltip);
    [...gates.values()][1]();
    assert.equal((await resolvedB).target.fsPath, b[0].tooltip);
    assert.equal(calls.size, 2, 'only requested links should touch the filesystem');
}

async function testLinkCancellationAndEdits() {
    for (const stage of ['roots', 'path']) {
        for (const invalidation of ['cancel', 'edit', 'close']) {
            const gate = deferred();
            let pathCalls = 0;
            const api = linkHarness(async () => {
                pathCalls++;
                if (stage === 'path') await gate.promise;
                return '/asset';
            }, async () => {
                if (stage === 'roots') await gate.promise;
                return [];
            });
            const provider = new api.WurstAssetLinkProvider();
            const doc = document('IncludeFile "a.fdf"\n"b.fdf"');
            const token = { isCancellationRequested: false };
            const links = await provider.provideDocumentLinks(doc, token);
            assert.equal(links.length, 2, 'FDF includes must not produce duplicate links');
            const pending = provider.resolveDocumentLink(links[0], token);
            await tick();
            if (invalidation === 'cancel') token.isCancellationRequested = true;
            if (invalidation === 'edit') doc.version++;
            if (invalidation === 'close') doc.isClosed = true;
            gate.resolve();
            assert.equal(await pending, undefined, 'obsolete resolutions must not produce link targets');
            assert.equal(links[0].target, undefined);
            assert.equal(pathCalls, stage === 'roots' ? 0 : 1, 'cancel during roots must prevent path I/O');
        }
    }
}

async function testLazyAssetActions() {
    const settings = { lean: false };
    let calls = 0;
    const api = linkHarness(async () => { calls++; return undefined; }, async () => { calls++; return []; }, settings);
    const token = { isCancellationRequested: false };
    const doc = document('"a.mdx"\n"b.wav"\n"c.blp"\n"unknown.other"');
    const links = new api.WurstAssetLinkProvider();
    const ranges = await links.provideDocumentLinks(doc, token);
    assert.equal(ranges.length, 3);
    assert.equal(calls, 0);
    assert.equal((await links.resolveDocumentLink(ranges[1], token)).target,
        `command:wurst.openAssetFromString?${encodeURIComponent(JSON.stringify(['b.wav']))}`);
    assert.equal(calls, 0, 'inline sound links must not probe files');
    assert((await links.resolveDocumentLink(ranges[0], token)).target.startsWith('command:wurst.openAssetFromString?'));
    assert.equal(await links.resolveDocumentLink(ranges[2], token), undefined, 'missing textures remain unresolved');

    const lenses = new api.WurstAssetCodeLensProvider();
    const items = await lenses.provideCodeLenses(doc, token);
    assert.equal(items.length, 4);
    assert(items.every((lens) => lens.command === undefined), 'offscreen lenses must have no command payloads');
    const fullReads = doc.reads.filter((range) => !range).length;
    assert.equal(lenses.resolveCodeLens(items[0], token).command.title, 'Browse model...');
    assert.deepEqual(lenses.resolveCodeLens(items[1], token).command.arguments, ['b.wav']);
    assert.equal(lenses.resolveCodeLens(items[2], token).command.title, 'Browse sound...');
    const texture = lenses.resolveCodeLens(items[3], token).command;
    assert.equal(texture.title, 'Browse asset...');
    assert.equal(texture.arguments[0].currentValue, 'c.blp');
    assert.equal(doc.reads.filter((range) => !range).length, fullReads, 'resolution reads only its literal range');
    assert.equal(api.findAssetStringAt(doc, { start: 11 }).currentValue, 'b.wav');
    settings.lean = true;
    assert.throws(() => lenses.resolveCodeLens(items[0], token), /Canceled/);
    const before = doc.reads.length;
    assert.deepEqual(await lenses.provideCodeLenses(doc, token), []);
    assert.equal(doc.reads.length, before, 'lean mode must not scan text');
    settings.lean = false;
    for (const invalidation of ['cancel', 'edit', 'close']) {
        const current = document('"a.mdx"');
        const item = (await lenses.provideCodeLenses(current, token))[0];
        if (invalidation === 'edit') current.version++;
        if (invalidation === 'close') current.isClosed = true;
        assert.throws(() => lenses.resolveCodeLens(item, { isCancellationRequested: invalidation === 'cancel' }), /Canceled/);
    }
}

async function testLargeScansYield() {
    const api = linkHarness(async () => { throw new Error('range scans must do no I/O'); });
    const doc = document('"first.mdx"\n' + '"a.wav"\n'.repeat(600));
    for (const provider of [new api.WurstAssetCodeLensProvider(), new api.WurstAssetLinkProvider()]) {
        for (const cancel of [false, true]) {
            const token = { isCancellationRequested: false };
            const pending = provider.provideCodeLenses ? provider.provideCodeLenses(doc, token) : provider.provideDocumentLinks(doc, token);
            // The scan must yield before finishing so this invalidation can take effect.
            if (cancel) token.isCancellationRequested = true;
            else doc.version++;
            assert.deepEqual(await pending, []);
        }
    }
}

async function testClient10DocumentSynchronization() {
    class Emitter {
        listeners = new Set();
        event = (listener) => { this.listeners.add(listener); return new TestDisposable(() => this.listeners.delete(listener)); };
        fire(value) { this.listeners.forEach((listener) => listener(value)); }
        dispose() { this.listeners.clear(); }
    }
    const opened = new Emitter();
    const closed = new Emitter();
    const shown = new Emitter();
    const visible = new Set();
    const sent = [];
    const protocol = require('vscode-languageserver-protocol');
    const initiallyOpen = [];
    const load = createTsLoader({ mocks: {
        'node_modules/vscode-languageclient/lib/common/codeConverter.js': {},
        'node_modules/vscode-languageclient/lib/common/protocolConverter.js': {},
        vscode: {
            EventEmitter: Emitter, CancellationError: class extends Error {}, CodeAction: class {}, Diagnostic: class {},
            workspace: { textDocuments: initiallyOpen, onDidOpenTextDocument: opened.event, onDidCloseTextDocument: closed.event },
            languages: { match: () => 1 },
        },
    } });
    const { BaseLanguageClient } = load('node_modules/vscode-languageclient/lib/common/client.js');
    const { DidOpenTextDocumentFeature, DidCloseTextDocumentFeature } = load('node_modules/vscode-languageclient/lib/common/textSynchronization.js');
    const options = lifecycleHarness(Promise.resolve(), initiallyOpen);
    const startup = options.server.startLanguageClient(options.context);
    await tick();
    const { textSynchronization, middleware } = options.clients[0].options;
    const client = {
        clientOptions: { textSynchronization }, _clientOptions: {}, middleware,
        _didChangeTextDocumentFeature: { syncKind: protocol.TextDocumentSyncKind.Incremental },
        visibleDocuments: { isVisible: (doc) => visible.has(doc), onClose: new Emitter().event, onOpen: shown.event },
        hasDedicatedTextSynchronizationFeature: () => false,
        protocol2CodeConverter: { asDocumentSelector: (selector) => selector },
        code2ProtocolConverter: {
            asOpenTextDocumentParams: (doc) => ({ textDocument: { uri: doc.uri.toString(), version: doc.version, languageId: doc.languageId, text: doc.getText() } }),
            asCloseTextDocumentParams: (doc) => ({ textDocument: { uri: doc.uri.toString() } }),
        },
        $start: async () => ({
            sendNotification: async (type, params) => { sent.push({ method: type.method, params }); },
            sendRequest: async (type, params) => { sent.push({ method: type.method, params }); return []; },
        }),
        sendNotification: BaseLanguageClient.prototype.sendNotification,
        sendRequest: BaseLanguageClient.prototype.sendRequest,
        error: (message, error) => { throw new Error(message, { cause: error }); },
    };
    const synced = new Map();
    const opens = new DidOpenTextDocumentFeature(client, synced);
    options.clients[0].openFeature = opens;
    options.clients[0].visibleDocuments = client.visibleDocuments;
    options.clients[0].sendRequest = client.sendRequest.bind(client);
    client._didOpenTextDocumentFeature = opens;
    const closes = new DidCloseTextDocumentFeature(client, synced, new Map());
    const capabilities = { resolvedTextDocumentSync: { openClose: true }, experimental: { wurstInitialBuildStatus: true } };
    const restored = document('unsaved restored buffer');
    initiallyOpen.push(restored);
    opens.initialize(capabilities, ['wurst']);
    options.clients[0].initializeResult = { capabilities };
    options.clients[0].transition(options.states.Running);
    options.clients[0].notifications.get('wurst/initialBuildStatus')({ state: 'ready' });
    options.clients[0].features[0].initialize(capabilities);
    closes.initialize(capabilities, ['wurst']);
    options.clients[0].started.resolve();
    await startup;
    assert.equal(sent.length, 0, 'startup readiness must leave real client 10 hidden opens pending');
    assert.equal(synced.size, 0);
    await closes.callback(restored);
    initiallyOpen.length = 0;
    const doc = document('original');
    await opens.callback(doc);
    assert.equal(sent.length, 0, 'hidden opens must be delayed');
    // The real client flushes the captured open before sending an unsaved edit.
    doc.text = 'changed'; doc.version++;
    await client.sendNotification(protocol.DidChangeTextDocumentNotification.type, { textDocument: { uri: doc.uri.toString(), version: 2 }, contentChanges: [{ text: 'changed' }] });
    assert.deepEqual(sent.map((item) => item.method), ['textDocument/didOpen', 'textDocument/didChange']);
    assert.equal(sent[0].params.textDocument.text, 'original');
    assert.equal(sent[0].params.textDocument.version, 1);
    await closes.callback(doc);
    assert.equal(sent.at(-1).method, 'textDocument/didClose');
    sent.length = 0;
    await opens.callback(doc);
    await closes.callback(doc);
    assert.equal(sent.length, 0, 'hidden open/close pairs must not reach the server');
    await opens.callback(doc);
    closed.fire(doc);
    await tick();
    assert.equal(sent.length, 0, 'the workspace close event must also drop hidden open/close pairs');
    await opens.callback(doc);
    await client.sendRequest(protocol.DocumentSymbolRequest.type, { textDocument: { uri: doc.uri.toString() } });
    assert.deepEqual(sent.map((item) => item.method), ['textDocument/didOpen', 'textDocument/documentSymbol']);
    sent.length = 0;
    await closes.callback(doc);
    sent.length = 0;
    await opens.callback(doc);
    visible.add(doc); shown.fire([doc.uri]);
    await tick();
    assert.deepEqual(sent.map((item) => item.method), ['textDocument/didOpen'], 'visible files must synchronize immediately');
    options.clients[0].transition(options.states.Stopped);
    let staleClose = false;
    await middleware.didClose(doc, async () => { staleClose = true; });
    assert.equal(staleClose, false, 'restart must clear the previous server process\'s open documents');
    opens.clear(); closes.clear();
    synced.clear(); visible.clear(); sent.length = 0;
    const initial = document('before registration edit');
    initiallyOpen.push(initial);
    options.clients[0].transition(options.states.Starting);
    options.clients[0].transition(options.states.Running);
    opens.initialize(capabilities, ['wurst']);
    options.clients[0].features[0].initialize(capabilities);
    options.clients[0].notifications.get('wurst/initialBuildStatus')({ state: 'ready' });
    assert.equal(sent.length, 0, 'restart readiness must also leave existing hidden buffers pending');
    initial.text = 'after registration edit'; initial.version++;
    const replacement = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'after' };
    await client.sendNotification(protocol.DidChangeTextDocumentNotification.type, { textDocument: { uri: initial.uri.toString(), version: 2 }, contentChanges: [replacement] });
    assert.equal(sent[0].params.textDocument.version, 1, 'initial hidden documents need an immutable registration snapshot');
    assert.equal(sent[0].params.textDocument.text, 'before registration edit');
    const openedText = sent[0].params.textDocument.text;
    assert.equal(replacement.text + openedText.slice(replacement.range.end.character), initial.text, 'the first incremental edit must apply to the original buffer, not its already edited content');
    opens.clear();
    await options.server.stopLanguageServerIfRunning();
}


function commandHarness() {
    const handlers = new Map();
    const notifications = [];
    const failures = [];
    const completions = [];
    const foldersOpened = [];
    const actions = [];
    const diagnostics = [];
    const listeners = new Map();
    const requests = [];
    const client = {
        clientOptions: { workspaceFolder: { uri: { fsPath: require('path').resolve('project') } } },
        outputChannel: { lines: [], shown: 0, appendLine(line) { this.lines.push(line); }, show() { this.shown++; } },
        onProgress(type, token, handler) {
            assert.equal(type, 'workDone');
            listeners.set(token, handler);
            return new TestDisposable(() => listeners.delete(token));
        },
        sendRequest(type, params) {
            assert.equal(type, 'executeCommand');
            const request = deferred();
            requests.push({ params, ...request });
            return request.promise;
        },
    };
    const vscode = {
        Disposable: TestDisposable,
        Uri: {
            joinPath: (root, name) => ({ fsPath: require('path').join(root.fsPath, name) }),
        },
        env: { openExternal: async (uri) => { foldersOpened.push(uri.fsPath); return true; } },
        ProgressLocation: { Notification: 15 },
        workspace: { workspaceFolders: [{ uri: { fsPath: require('path').resolve('project') } }], getConfiguration: () => ({ get: () => undefined }) },
        window: {
            withProgress(options, task) {
                const notification = { options, reports: [], closed: false };
                notifications.push(notification);
                return Promise.resolve(task({ report: (value) => notification.reports.push(value) }))
                    .finally(() => { notification.closed = true; });
            },
            showInformationMessage: async (message, ...buttons) => {
                completions.push({ message, buttons });
                return harness.completionDialog ? harness.completionDialog.promise : harness.completionChoice;
            },
            showErrorMessage: async (message, ...buttons) => {
                failures.push({ message, buttons });
                return harness.errorDialog ? harness.errorDialog.promise : harness.choice;
            },
        },
        commands: {
            registerCommand: (id, handler) => { handlers.set(id, handler); return new TestDisposable(); },
            executeCommand: async (id) => { actions.push(id); },
        },
    };
    const load = createTsLoader({ mocks: {
        vscode,
        'vscode-languageclient/node': { ExecuteCommandRequest: { type: 'executeCommand' }, WorkDoneProgress: { type: 'workDone' } },
        'src/paths.ts': {},
        'src/features/diagnostics.ts': { appendDiagnostic: (...args) => diagnostics.push(args), formatDiagnosticError: String },
        'src/languageServer.ts': {},
        'src/install/installer.ts': {},
        'src/features/issueReporting.ts': {},
        'src/features/preview/cascStorage.ts': {},
        'src/features/agentsGuide.ts': {},
        'src/features/fileCreation.ts': {},
        'src/features/assetLinks.ts': {},
    } });
    load('src/features/commands.ts').registerCommands(async () => client);
    const harness = { handlers, notifications, failures, completions, foldersOpened, actions, diagnostics, listeners, requests, client, workspace: vscode.workspace };
    return harness;
}

async function testMapCommandProgress() {
    const h = commandHarness();
    for (const [id, title] of [
        ['wurst.buildmap', 'Building Wurst map'],
        ['wurst.startmap', 'Running Wurst map'],
        ['wurst.hotstartmap', 'Running Wurst map'],
        ['wurst.hotreload', 'Reloading Wurst map'],
    ]) {
        const running = h.handlers.get(id)(['example.w3x']);
        await tick();
        const request = h.requests.at(-1);
        assert.ok(request, 'command must send its existing execute-command request');
        assert.equal(request.params.command, id);
        assert.equal(request.params.arguments[0].mappath, id === 'wurst.hotreload' ? undefined : 'example.w3x');
        const notification = h.notifications.at(-1);
        assert.ok(notification, 'build/run must open a native progress notification');
        assert.deepEqual(notification.options, { location: 15, title, cancellable: false });
        const handler = h.listeners.get(request.params.workDoneToken);
        assert.ok(handler, 'request token must have a listener before work begins');
        handler({ kind: 'begin', title: 'Server title', message: 'Preparing map' });
        handler({ kind: 'report', message: 'Compiling script', percentage: 80 });
        assert.deepEqual(notification.reports.slice(-2), [{ message: 'Preparing map', increment: undefined }, { message: 'Compiling script', increment: 80 }]);
        handler({ kind: 'report', percentage: 90 });
        handler({ kind: 'report', message: 'Finalizing map', percentage: 70 });
        handler({ kind: 'report', percentage: 120 });
        assert.deepEqual(notification.reports.slice(-3), [
            { message: undefined, increment: 10 },
            { message: 'Finalizing map', increment: 0 },
            { message: undefined, increment: 10 },
        ], 'absolute server percentages must become bounded, nonnegative VS Code increments');
        handler({ kind: 'end' });
        assert.equal(notification.closed, false, 'progress end must not conceal a pending command failure');
        request.resolve('ok');
        assert.equal(await running, 'ok');
        assert.equal(notification.closed, true);
        assert.equal(h.listeners.size, 0, 'listener must be disposed after success');
    }
    assert.equal(new Set(h.requests.map((r) => r.params.workDoneToken)).size, 4, 'each invocation needs a distinct token');
    assert.equal(h.failures.length, 0, 'success must not show an error');
    assert.equal(h.completions.length, 1, 'only Build shows a success notification');
    assert.deepEqual(h.completions[0].buttons, ['Open Build Folder', 'Show Log']);
    assert.ok(h.completions[0].message.includes(require('path').resolve('project', '_build')));

    const legacy = h.handlers.get('wurst.buildmap')(['example.w3x']);
    await tick();
    h.requests.at(-1).resolve('legacy');
    assert.equal(await legacy, 'legacy', 'older servers without progress events must still complete');

    assert.equal(h.completions.length, 1, 'unrecognized legacy responses must not claim success');
    const canceled = h.handlers.get('wurst.buildmap')(['example.w3x']);
    await tick();
    h.requests.at(-1).resolve({});
    await canceled;
    assert.equal(h.completions.length, 1, 'canceled builds must not show success');

    for (const choice of ['Show Problems', 'Show Log']) {
        h.errorDialog = deferred();
        const failing = h.handlers.get('wurst.buildmap')(['example.w3x']);
        await tick();
        h.requests.at(-1).reject(new Error('Generated script failed\nDetailed diagnostic'));
        await tick();
        assert.equal(h.notifications.at(-1).closed, true, 'failed progress must close before the user dismisses the error');
        assert.equal(h.listeners.size, 0);
        h.errorDialog.resolve(choice);
        await failing;
        assert.equal(h.listeners.size, 0, 'listener must be disposed after failure');
        assert.equal(h.notifications.at(-1).closed, true);
        assert.deepEqual(h.failures.at(-1).buttons, ['Show Problems', 'Show Log']);
        assert.equal(h.failures.at(-1).message, 'Generated script failed');
        assert.ok(h.client.outputChannel.lines.at(-1).includes('Detailed diagnostic'), 'full details must remain in output');
    }
    assert.equal(h.completions.length, 1, 'failed builds must not show success');
    assert.deepEqual(h.actions, ['workbench.actions.view.problems']);
    assert.equal(h.client.outputChannel.shown, 1);
}

async function testBuildCompletionActions() {
    const h = commandHarness();
    h.client.clientOptions.workspaceFolder = { uri: { fsPath: require('path').resolve('server-project') } };
    h.workspace.workspaceFolders = [];
    h.completionDialog = deferred();
    const building = h.handlers.get('wurst.buildmap')(['elsewhere.w3x']);
    await tick();
    h.requests.at(-1).resolve('ok');
    assert.equal(await building, 'ok', 'the command must finish without waiting for the completion toast');
    assert.equal(h.notifications[0].closed, true);
    h.completionDialog.resolve('Open Build Folder');
    await tick();
    assert.deepEqual(h.foldersOpened, [require('path').resolve('server-project', '_build')], 'open the server output folder, not the input map folder');

    h.completionDialog = undefined;
    h.completionChoice = 'Show Log';
    const nextBuild = h.handlers.get('wurst.buildmap')(['elsewhere.w3x']);
    await tick();
    h.requests.at(-1).resolve('ok');
    await nextBuild;
    await tick();
    assert.equal(h.client.outputChannel.shown, 1);
}

async function main() {
    await testMapCommandProgress();
    await testBuildCompletionActions();
    await testClientReadinessAndRestarts();
    await testBuildNotificationsAvoidRequests();
    await testStopDuringInstallation();
    await testInstallerPreservesItsOwnStartup();
    await testFailedStartCleansUp();
    await testStoppedStartupCannotOverwriteReplacement();
    await testStoppedStartupTerminatesAfterInitialization();
    await testConcurrentLinks(false, '"a-long-first.mdx"\n"a-second.mdx"', '"b.mdx"\n"c.mdx"');
    await testConcurrentLinks(false, 'IncludeFile "a-long-first.fdf"\nIncludeFile "a-second.fdf"', 'IncludeFile "b.fdf"\nIncludeFile "c.fdf"');
    await testConcurrentLinks(true, 'a-long-first.fdf\na-second.fdf', 'b.fdf\nc.fdf');
    await testLinkCancellationAndEdits();
    await testLazyAssetActions();
    await testLargeScansYield();
    await testClient10DocumentSynchronization();
    console.log('Language feature regression tests passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
