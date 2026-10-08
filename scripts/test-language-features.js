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
            getCompilerVersionPin: () => undefined,
        },
        'src/features/diagnostics.ts': { appendDiagnostic() {}, formatDiagnosticError: String },
    } });
    return { server: load('src/languageServer.ts'), context: { subscriptions: [] }, clients, watchers, states };
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


function releaseHarness(releases) {
    const { EventEmitter } = require('events');
    const requested = [];
    const load = createTsLoader({ mocks: {
        vscode: {},
        'src/paths.ts': { COMPILER_RELEASES_API: 'https://test/releases' },
        https: { request(url, _options, callback) {
            requested.push(url);
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = () => setImmediate(() => {
                const res = new EventEmitter();
                res.statusCode = 200;
                callback(res);
                res.emit('data', Buffer.from(JSON.stringify(releases)));
                res.emit('end');
            });
            return req;
        } },
    } });
    return { downloader: load('src/install/downloader.ts'), requested };
}

async function testStableCompilerReleases() {
    const platform = { win32: 'win', linux: 'linux', darwin: 'macos' }[process.platform];
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const release = (version, extra = {}) => ({
        tag_name: `v${version}`, draft: false, prerelease: false,
        assets: [{ name: `wurst-compiler-${version}-${platform}-${arch}.zip`, browser_download_url: `https://test/${version}.zip` }],
        ...extra,
    });
    const h = releaseHarness([
        release('1.9.0'), release('1.10.0'), release('2.0.0', { draft: true }),
        release('2.1.0', { prerelease: true }), release('3.0.0-beta.1'),
        release('4.0.0', { tag_name: 'nightly' }), release('5.0.0', { assets: [] }),
        release('6.0.0', { assets: [{ name: `wurst-compiler-nightly-${platform}-${arch}.zip`, browser_download_url: 'https://test/nightly' }] }),
    ]);
    const releases = await h.downloader.fetchCompilerReleases();
    assert.deepEqual(releases.map((r) => r.version), ['1.10.0', '1.9.0'], 'stable releases must sort numerically and require an exact versioned platform archive');
    assert.equal(releases[0].url, 'https://test/1.10.0.zip');
    assert.equal(releases[0].tag, 'v1.10.0');
    assert.ok(h.requested.every((url) => !url.includes('nightly')), 'release discovery must never resolve mutable nightly tags');
    const empty = releaseHarness([release('1.0.0', { prerelease: true })]);
    await assert.rejects(empty.downloader.fetchLatestCompilerRelease(), /No stable WurstScript compiler release/);
}

function versionInstallerHarness(version, releases, pinned) {
    let pin = pinned;
    let failDownload = false;
    const messages = [];
    const picks = [];
    const commands = [];
    const downloads = [];
    const replacements = [];
    let fetches = 0;
    const releaseApi = releaseHarness([]).downloader;
    const load = createTsLoader({ mocks: {
        vscode: {
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            window: {
                withProgress: async (_options, task) => task({ report() {} }),
                showErrorMessage: async () => undefined,
                showInformationMessage: async (...args) => { messages.push(args); return undefined; },
                showQuickPick: async (items, options) => { picks.push({ items, options }); return items.at(-1); },
            },
            commands: { executeCommand: async (...args) => commands.push(args) },
            ProgressLocation: { Notification: 15 },
        },
        fs: {
            existsSync: () => true,
            statSync: () => ({ size: 1, mtimeMs: 2, ctimeMs: 3 }),
            mkdirSync() {}, unlinkSync() {}, copyFileSync() {},
            writeFileSync: (file, contents) => { if (file === 'pin.json') pin = JSON.parse(contents).version; },
            rmSync: (file) => { if (file === 'pin.json') pin = undefined; },
            readFileSync: (file) => {
                if (file === 'pin.json' && pin) return JSON.stringify({ version: pin });
                if (file === 'compiler/installed-version.json') return JSON.stringify({ cacheKey: require('path').join('runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java') + '|1:2', version });
                throw new Error('missing');
            },
        },
        'src/paths.ts': { COMPILER_VERSION_PIN_FILE: 'pin.json', WURST_HOME: 'wurst-home', GRILL_HOME_DIR: 'grill', RUNTIME_DIR: 'runtime', COMPILER_DIR: 'compiler', COMPILER_JAR: 'compiler/wurstscript.jar', INSTALLED_VERSION_CACHE_FILE: 'compiler/installed-version.json' },
        'src/install/fsUtils.ts': {
            removeDirSafe: async () => {}, copyDirContents() {}, installLauncherExecutable() {},
            cleanupOldWurstHome() {}, cleanupWurstSetupJar() {}, ensureDirectoryPath() {},
            upgradeFolder: async (src, dest) => replacements.push({ src, dest }),
            withRetry: async (task) => task(), isRecoverableInstallError: () => false,
        },
        'src/install/downloader.ts': { stableCompilerVersion: releaseApi.stableCompilerVersion, compareCompilerVersions: releaseApi.compareCompilerVersions, fetchLatestCompilerRelease: async () => { fetches++; return releases[0]; }, fetchCompilerReleases: async () => releases,
            fetchLatestGrillAsset: async () => ({ url: 'grill-release' }),
            downloadFileWithProgress: async (url) => { if (failDownload) { throw new Error('download failed'); } downloads.push(url); return 1; },
            extractZipWithByteProgress: async () => {},
        },
        'src/install/pathManager.ts': { ensureCliOnPath: async () => {} },
        'src/languageServer.ts': { stopLanguageServerIfRunning: async () => false },
        'src/install/installCoordination.ts': {
            InstallCoordinationCancelledError: class extends Error {},
            withWurstInstallLock: async (task) => task(true),
            ensureConflictingWurstProcessesStopped: async () => {},
        },
        'src/features/diagnostics.ts': { appendDiagnostic() {}, formatDiagnosticError: String },
    } });
    return { installer: load('src/install/installer.ts'), messages, picks, commands, downloads, replacements, fetches: () => fetches, pin: () => pin, failDownloads: () => { failDownload = true; } };
}

async function testVersionedCompilerUpdates() {
    const releases = [{ version: '1.10.0', tag: 'v1.10.0', url: 'latest' }, { version: '1.9.0', tag: 'v1.9.0', url: 'older' }];
    for (const installed of ['1.10.0', '1.11.0']) {
        const h = versionInstallerHarness(installed, releases);
        await h.installer.maybeOfferUpdate();
        assert.equal(h.messages.length, 0, 'equal/newer installed stable releases must not offer a downgrade');
        assert.equal(h.installer.getAvailableUpdate(), undefined);
    }
    const older = versionInstallerHarness('1.9.0', releases);
    await older.installer.maybeOfferUpdate();
    assert.equal(older.installer.getAvailableUpdate().latestVersion, '1.10.0');
    assert.equal(older.installer.getAvailableUpdate().installedVersion, '1.9.0');
    assert.ok(older.messages[0][0].includes('1.10.0'));
    const nightly = versionInstallerHarness('1.9.0-482-gaaaaaaa', releases);
    await nightly.installer.maybeOfferUpdate();
    assert.ok(nightly.messages[0][0].includes('stable'), 'nightly builds must offer an explicit stable migration');
    await nightly.installer.chooseCompilerVersion();
    assert.ok(nightly.picks[0].options.placeHolder.includes('1.9.0-482-gaaaaaaa'));
    assert.ok(nightly.picks[0].items.every((item) => !item.description.includes('Installed')), 'a development build must not be mislabeled as the corresponding stable release');
    const picker = versionInstallerHarness('1.10.0', releases);
    assert.equal((await picker.installer.chooseCompilerVersion()).version, '1.9.0', 'picker must allow choosing an older stable release');
    assert.equal(picker.picks[0].items[1].description, 'Installed · Latest');
    assert.equal(picker.picks[0].items[2].description, 'Downgrade');
    await picker.installer.installWithRetry({ compilerRelease: releases[1], offerPostInstallActions: false });
    assert.equal(picker.pin(), '1.9.0', 'explicit version choice pins only after installation succeeds');
    assert.equal(picker.fetches(), 0, 'installing a selected older release must never switch back to latest');
    assert.deepEqual(picker.downloads, ['older', 'grill-release']);
    assert.deepEqual(picker.replacements.map((item) => item.dest), ['runtime', 'compiler'], 'selected versions must use the existing coordinated replacement pipeline');
}


async function testCompilerVersionPins() {
    const releases = [{ version: '2.1.0', tag: 'v2.1.0', url: 'latest' }, { version: '2.0.0', tag: 'v2.0.0', url: 'older' }];
    const pinned = versionInstallerHarness('2.0.0', releases, '2.0.0');
    await pinned.installer.maybeOfferUpdate();
    assert.equal(pinned.fetches(), 0, 'pinned installations must skip automatic release lookups and prompts');
    assert.equal(pinned.messages.length, 0);
    await pinned.installer.chooseCompilerVersion();
    assert.equal(pinned.picks[0].items[0].label, 'Follow latest stable');
    assert.ok(pinned.picks[0].items[2].description.includes('Pinned'));
    await pinned.installer.installWithRetry({ offerPostInstallActions: false });
    assert.equal(pinned.downloads[0], 'older', 'ordinary Install/Update must honor the stored version pin');
    assert.equal(pinned.pin(), '2.0.0');
    await pinned.installer.installWithRetry({ followLatest: true, offerPostInstallActions: false });
    assert.equal(pinned.downloads.at(-2), 'latest', 'Follow latest must ignore a saved pin');
    assert.equal(pinned.pin(), undefined, 'following latest clears the pin after a successful install');

    const failed = versionInstallerHarness('2.0.0', releases, '2.0.0');
    failed.failDownloads();
    await assert.rejects(failed.installer.installWithRetry({ compilerRelease: releases[0], followLatest: true }), /download failed/);
    assert.equal(failed.pin(), '2.0.0', 'a failed migration to latest must preserve the old pin');
    const freshFailed = versionInstallerHarness('2.1.0', releases);
    freshFailed.failDownloads();
    await assert.rejects(freshFailed.installer.installWithRetry({ compilerRelease: releases[1] }), /download failed/);
    assert.equal(freshFailed.pin(), undefined, 'a failed selected-version install must not create a pin');
}

function testInstallationCleanupPreservesPin() {
    const removed = [];
    const load = createTsLoader({ mocks: {
        'src/paths.ts': { WURST_HOME: 'wurst-home' },
        fs: {
            existsSync: () => true,
            readdirSync: () => ['compiler-version.json', 'wurst-compiler', 'obsolete.jar'],
            lstatSync: () => ({ isDirectory: () => false }),
            unlinkSync: (file) => removed.push(file),
        },
    } });
    load('src/install/fsUtils.ts').cleanupOldWurstHome();
    assert.deepEqual(removed.map((file) => require('path').basename(file)), ['obsolete.jar'], 'reinstallation cleanup must preserve the persistent compiler pin');
}

async function main() {
    testInstallationCleanupPreservesPin();
    await testCompilerVersionPins();
    await testStableCompilerReleases();
    await testVersionedCompilerUpdates();
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
