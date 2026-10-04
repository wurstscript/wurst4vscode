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

function lifecycleHarness(installation = Promise.resolve()) {
    const clients = [];
    const watchers = [];
    const states = { Starting: 1, Running: 2, Stopped: 3 };
    class Client {
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
        onNotification() { return new TestDisposable(); }
        sendRequest() { return Promise.resolve([]); }
    }
    const vscode = {
        Disposable: TestDisposable,
        workspace: {
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
        'vscode-languageclient/node': { LanguageClient: Client, State: states },
        'src/paths.ts': {},
        'src/install/installer.ts': {
            ensureInstalledOrOfferMigration: () => typeof installation === 'function' ? installation() : installation,
            getLanguageServerJava: () => 'java',
            getInstalledVersionString: () => Promise.resolve('test'),
            maybeOfferUpdate: () => Promise.resolve(),
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

function linkHarness(resolveAssetPath, getCandidateRoots = async () => []) {
    class Range { constructor(start, end) { this.start = start; this.end = end; } }
    class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
    const load = createTsLoader({
        augment: { 'src/features/assetLinks.ts': 'export { WurstAssetLinkProvider, FdfLinkProvider, TocLinkProvider, findAssetStrings };' },
        mocks: {
            vscode: { Range, DocumentLink, Uri: { file: (fsPath) => ({ fsPath }), parse: (value) => value } },
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
    return { uri: { fsPath: '/project/source.wurst' }, version: 1, getText: () => text, positionAt: (offset) => offset };
}

async function testConcurrentLinks(providerName, textA, textB) {
    const gates = new Map();
    const calls = new Map();
    const api = linkHarness(async (asset) => {
        calls.set(asset, (calls.get(asset) ?? 0) + 1);
        if (calls.get(asset) === 1 && ['a-long-first.mdx', 'b.mdx', 'a-long-first.fdf', 'b.fdf'].includes(asset)) {
            await new Promise((resolve) => gates.set(asset, resolve));
        }
        return asset;
    });
    const provider = new api[providerName]();
    const token = { isCancellationRequested: false };
    const a = provider.provideDocumentLinks(document(textA), token);
    const b = provider.provideDocumentLinks(document(textB), token);
    await tick();
    // CodeLens scanning shares the string-expression definition too.
    api.findAssetStrings(document('"other.mdx"'));
    const firstGate = [...gates.values()][0];
    firstGate();
    const resultA = await a;
    [...gates.values()][1]();
    const resultB = await b;
    const expectedCount = providerName === 'FdfLinkProvider' ? 4 : 2;
    assert.equal(resultA.length, expectedCount);
    assert.equal(resultB.length, expectedCount);
    assert.equal(calls.get(providerName === 'WurstAssetLinkProvider' ? 'b.mdx' : 'b.fdf'), providerName === 'FdfLinkProvider' ? 2 : 1);
}

async function testLinkCancellationAndEdits() {
    for (const providerName of ['WurstAssetLinkProvider', 'FdfLinkProvider', 'TocLinkProvider']) {
        for (const cancel of [false, true]) {
            const gate = deferred();
            let calls = 0;
            const api = linkHarness(async () => { calls++; await gate.promise; return '/asset'; });
            const provider = new api[providerName]();
            const doc = document(providerName === 'TocLinkProvider' ? 'a.fdf\nb.fdf' : 'IncludeFile "a.fdf"\n"b.fdf"');
            const token = { isCancellationRequested: false };
            const pending = provider.provideDocumentLinks(doc, token);
            await tick();
            if (cancel) token.isCancellationRequested = true;
            else doc.version++;
            gate.resolve();
            assert.deepEqual(await pending, [], 'cancelled or changed documents must not receive stale links');
            assert.equal(calls, 1, 'obsolete requests must stop resolving further assets');
        }
    }
}

async function main() {
    await testClientReadinessAndRestarts();
    await testStopDuringInstallation();
    await testInstallerPreservesItsOwnStartup();
    await testFailedStartCleansUp();
    await testStoppedStartupCannotOverwriteReplacement();
    await testStoppedStartupTerminatesAfterInitialization();
    await testConcurrentLinks('WurstAssetLinkProvider', '"a-long-first.mdx"\n"a-second.mdx"', '"b.mdx"\n"c.mdx"');
    await testConcurrentLinks('FdfLinkProvider', 'IncludeFile "a-long-first.fdf"\nIncludeFile "a-second.fdf"', 'IncludeFile "b.fdf"\nIncludeFile "c.fdf"');
    await testConcurrentLinks('TocLinkProvider', 'a-long-first.fdf\na-second.fdf', 'b.fdf\nc.fdf');
    await testLinkCancellationAndEdits();
    const gate = deferred();
    let rootCalls = 0;
    const api = linkHarness(async () => '/asset', async () => {
        if (++rootCalls === 2) await gate.promise;
        return [];
    });
    const doc = document('"a.mdx"');
    const links = new api.FdfLinkProvider().provideDocumentLinks(doc, { isCancellationRequested: false });
    await tick();
    doc.version++;
    gate.resolve();
    assert.deepEqual(await links, [], 'FDF root lookup must reject stale links even without includes');
    console.log('Language feature regression tests passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
