'use strict';

/**
 * Fast unit harness for browser-side webview modules.
 *
 * It transpiles the real TypeScript files in-memory, then runs them against a tiny
 * DOM shim. Keep tests here for pure/lite webview behavior that should not need a
 * full VS Code integration launch.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const moduleCache = new Map();

function loadTsModule(relPath) {
    const abs = path.resolve(root, relPath);
    if (moduleCache.has(abs)) return moduleCache.get(abs).exports;

    const src = fs.readFileSync(abs, 'utf8');
    const js = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    const mod = { exports: {} };
    moduleCache.set(abs, mod);
    const localRequire = (request) => {
        if (request.startsWith('.')) {
            const resolved = path.resolve(path.dirname(abs), request);
            const withExt = fs.existsSync(resolved) ? resolved : `${resolved}.ts`;
            return loadTsModule(path.relative(root, withExt));
        }
        return require(request);
    };
    new Function('exports', 'module', 'require', js)(mod.exports, mod, localRequire);
    return mod.exports;
}

function loadTsModuleWithMocks(relPath, mocks) {
    const localCache = new Map();
    const load = (nextRelPath) => {
        const abs = path.resolve(root, nextRelPath);
        if (localCache.has(abs)) return localCache.get(abs).exports;

        const src = fs.readFileSync(abs, 'utf8');
        const js = ts.transpileModule(src, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;

        const mod = { exports: {} };
        localCache.set(abs, mod);
        const localRequire = (request) => {
            if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
            if (request.startsWith('.')) {
                const resolved = path.resolve(path.dirname(abs), request);
                const withExt = fs.existsSync(resolved) ? resolved : `${resolved}.ts`;
                const relative = path.relative(root, withExt).replace(/\\/g, '/');
                if (Object.prototype.hasOwnProperty.call(mocks, relative)) return mocks[relative];
                return load(relative);
            }
            return require(request);
        };
        new Function('exports', 'module', 'require', js)(mod.exports, mod, localRequire);
        return mod.exports;
    };
    return load(relPath);
}

function testSignals() {
    const { signal, effect, batch, computed, untracked } = loadTsModule('src/webview/signals.ts');

    const count = signal(0);
    let seen = -1;
    let runs = 0;
    const stop = effect(() => {
        runs++;
        seen = count.value;
    });
    assert.equal(seen, 0);
    assert.equal(runs, 1);
    count.value = 1;
    assert.equal(seen, 1);
    assert.equal(runs, 2);
    count.value = 1;
    assert.equal(runs, 2, 'same value should not rerun effects');
    stop.dispose();
    count.value = 2;
    assert.equal(seen, 1, 'disposed effects should stop observing');

    const pickLeft = signal(true);
    const left = signal('left-a');
    const right = signal('right-a');
    let branch = '';
    let branchRuns = 0;
    effect(() => {
        branchRuns++;
        branch = pickLeft.value ? left.value : right.value;
    });
    assert.equal(branch, 'left-a');
    pickLeft.value = false;
    assert.equal(branch, 'right-a');
    const afterSwitchRuns = branchRuns;
    left.value = 'left-b';
    assert.equal(branchRuns, afterSwitchRuns, 'stale branch dependency should be cleaned up');
    right.value = 'right-b';
    assert.equal(branch, 'right-b');

    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a.value + b.value);
    let sumSeen = 0;
    let sumRuns = 0;
    effect(() => {
        sumRuns++;
        sumSeen = sum.value;
    });
    assert.equal(sumSeen, 3);
    batch(() => {
        a.value = 3;
        b.value = 4;
    });
    assert.equal(sumSeen, 7);
    assert.equal(sumRuns, 2, 'batch should coalesce dependent effect reruns');

    const tracked = signal('tracked-a');
    const ignored = signal('ignored-a');
    let mixed = '';
    let mixedRuns = 0;
    effect(() => {
        mixedRuns++;
        mixed = `${tracked.value}/${untracked(() => ignored.value)}`;
    });
    ignored.value = 'ignored-b';
    assert.equal(mixedRuns, 1, 'untracked reads should not subscribe');
    tracked.value = 'tracked-b';
    assert.equal(mixed, 'tracked-b/ignored-b');
}

// Regression test for the exact dependency-tracking pattern objModEditor's tree/details reactive
// wiring relies on (see objectRowReplacementHtml/selectObject in objectTree.ts and the two effects in
// detailsPanel.ts's setupDetails()): a "structural" signal (query/collapse state) should trigger a
// full rebuild, while a "selection" signal read via untracked() must NOT — selection instead moves
// via a separate, cheap, explicit DOM update (setActiveRow), same shape as the real webview code.
function testObjModTreeSelectionStaysUntracked() {
    const { signal, effect, untracked } = loadTsModule('src/webview/signals.ts');

    const query = signal('');
    const selectedKey = signal('a');
    let treeRebuilds = 0;
    let lastActiveInTree = null;
    effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reading .value here (and discarding it) is what registers the tracked dependency; see signals.ts's dependency-tracking design.
        query.value; // tracked: a query change must rebuild the tree
        treeRebuilds++;
        lastActiveInTree = untracked(() => selectedKey.value); // NOT tracked: selection alone must not rebuild
    });
    assert.equal(treeRebuilds, 1, 'tree effect should run once on creation');
    assert.equal(lastActiveInTree, 'a');

    selectedKey.value = 'b'; // simulates selectObject()'s signal write
    assert.equal(treeRebuilds, 1, 'selecting a different object must not trigger a full tree rebuild');

    query.value = 'footman';
    assert.equal(treeRebuilds, 2, 'a query change must still trigger a tree rebuild');
    assert.equal(lastActiveInTree, 'b', 'the rebuild reflects the current selection even though it is not a tracked dependency');
}

// Mirrors the two-effect split in detailsPanel.ts's setupDetails(): a full rebuild reacts to
// selection/technical-mode (which change the table's shape), while density/search/category filters
// reroute to a separate, lighter effect that only re-applies visibility. state.ts's collapsedNodes/
// hiddenCategories are Sets that bump a `.version` signal on mutation (see reactiveSet there) — a bare
// counter signal is all that's needed here to exercise the same "does mutating this dependency trigger
// only the filter effect" property, without reimplementing that Set wrapper.
function testObjModDetailsRebuildVsFilterEffectSplit() {
    const { signal, effect } = loadTsModule('src/webview/signals.ts');

    const selectedKey = signal('a');
    const showTechnical = signal(false);
    const hideEmpty = signal(false);
    const hiddenCategoriesVersion = signal(0); // stands in for state.ts's reactiveSet(...).version

    let fullRebuilds = 0;
    let filterApplies = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reading .value (and discarding it) registers the tracked dependency; see signals.ts.
    effect(() => { selectedKey.value; showTechnical.value; fullRebuilds++; });
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- same as above
    effect(() => { hideEmpty.value; hiddenCategoriesVersion.value; filterApplies++; });

    assert.equal(fullRebuilds, 1);
    assert.equal(filterApplies, 1);

    hideEmpty.value = true;
    assert.equal(fullRebuilds, 1, 'toggling hide-empty must not rebuild the whole table');
    assert.equal(filterApplies, 2);

    hiddenCategoriesVersion.value++; // simulates ui.hiddenCategories.add('abil')
    assert.equal(fullRebuilds, 1, 'hiding a category must not rebuild the whole table');
    assert.equal(filterApplies, 3);

    showTechnical.value = true;
    assert.equal(fullRebuilds, 2, 'toggling technical mode must rebuild the table (headers differ)');
    assert.equal(filterApplies, 3, 'a full rebuild alone must not double-run the filter effect');

    selectedKey.value = 'b';
    assert.equal(fullRebuilds, 3, 'selecting a different object must rebuild the details table');
}

// Minimal DOM + vscodeApi stub for loading src/webview/objModEditor/state.ts, which reads
// document.getElementById/acquireVsCodeApi/window.__OBJMOD_INITIAL__ at module-load time.
function installObjModStateDom(persistedState) {
    global.window = { __OBJMOD_INITIAL__: undefined };
    const els = { tree: new FakeElement(), details: new FakeElement(), search: new FakeElement() };
    global.document = { getElementById: (id) => els[id] || null };
    let state = persistedState || {};
    global.acquireVsCodeApi = () => ({
        postMessage: () => {},
        getState: () => state,
        setState: (next) => { state = next; },
    });
    return { getState: () => state };
}

// state.ts is meant to make a reopened editor (a webview reload after our external-change auto-reload
// or revert, or a fresh VS Code session) pick back up where the user left off, instead of resetting to
// a blank slate — see the persistUi effect and the restoredSelectedKey logic there.
function testObjModStateRestoresAndPersistsUiState() {
    moduleCache.clear();
    const objects = [{ key: 'Custom:0' }, { key: 'Custom:1' }];
    const dom = installObjModStateDom({
        selectedKey: 'Custom:1',
        query: 'foo',
        fieldQuery: 'dmg',
        showTechnical: true,
        hideEmpty: true,
        hideUnmodified: false,
        collapsedNodes: ['group:Original'],
        hiddenCategories: ['art'],
        treeScrollTop: 240,
        detailsScrollTop: 150,
        listW: 321, // unrelated persisted field (splitter width) the persist effect must not clobber
    });
    global.window.__OBJMOD_INITIAL__ = { objects, selectedKey: 'Custom:0', isPendingJump: false, extended: false };

    const state = loadTsModule('src/webview/objModEditor/state.ts');

    assert.equal(state.ui.selectedKey, 'Custom:1', 'a valid restored selection should win over the host default');
    assert.equal(state.ui.query, 'foo');
    assert.equal(state.ui.fieldQuery, 'dmg');
    assert.equal(state.ui.showTechnical, true);
    assert.equal(state.ui.hideEmpty, true);
    assert.equal(state.ui.hideUnmodified, false);
    assert.equal(state.collapsedNodes.has('group:Original'), true);
    assert.equal(state.ui.hiddenCategories.has('art'), true);
    assert.equal(state.ui.treeScrollTop, 240, 'the tree scroll position should be restored too');
    assert.equal(state.ui.detailsScrollTop, 150, 'the details/field table scroll position should be restored too');

    state.ui.query = 'bar';
    const persistedAfter = dom.getState();
    assert.equal(persistedAfter.query, 'bar', 'writing a signal should re-persist automatically, with no explicit setState call at the write site');
    assert.equal(persistedAfter.treeScrollTop, 240, 'persisting one field must not drop the others');
    assert.equal(persistedAfter.detailsScrollTop, 150, 'persisting one field must not drop the others');
    assert.equal(persistedAfter.selectedKey, 'Custom:1', 'unrelated restored fields must survive a later persist');
    assert.equal(persistedAfter.listW, 321, 'fields unrelated to reactive ui state (e.g. splitter width) must not be clobbered');
}

function testObjModStatePendingJumpOverridesRestoredSelection() {
    moduleCache.clear();
    const objects = [{ key: 'Custom:0' }, { key: 'Custom:1' }];
    installObjModStateDom({ selectedKey: 'Custom:1' });
    global.window.__OBJMOD_INITIAL__ = { objects, selectedKey: 'Custom:0', isPendingJump: true, extended: false };

    const state = loadTsModule('src/webview/objModEditor/state.ts');
    assert.equal(state.ui.selectedKey, 'Custom:0', 'a deliberate cross-file rawcode jump must win over a restored selection');
}

function testObjModStateIgnoresStaleRestoredSelection() {
    moduleCache.clear();
    const objects = [{ key: 'Custom:0' }]; // 'Custom:99' below no longer exists in this file
    installObjModStateDom({ selectedKey: 'Custom:99' });
    global.window.__OBJMOD_INITIAL__ = { objects, selectedKey: 'Custom:0', isPendingJump: false, extended: false };

    const state = loadTsModule('src/webview/objModEditor/state.ts');
    assert.equal(state.ui.selectedKey, 'Custom:0', 'a restored selection for an object that no longer exists should fall back to the host default');
}

// renderTree() reassigns tree.innerHTML on every call, which resets scrollTop to 0 in a real browser —
// this exercises the explicit capture/restore in objectTree.ts that works around that, using the
// shared moduleCache to stub out objectTree.ts's heavier sibling modules (model thumbnails/field
// display/model preview panel) instead of actually loading them.
function testObjModTreeRenderPreservesScrollPosition() {
    moduleCache.clear();
    const objects = [
        { key: 'Custom:0', group: 'Custom', race: 'human', displayName: 'Alpha', baseId: 'a000' },
        { key: 'Custom:1', group: 'Custom', race: 'human', displayName: 'Beta', baseId: 'b000' },
    ];
    installObjModStateDom({ treeScrollTop: 240 });
    global.window.__OBJMOD_INITIAL__ = { objects, selectedKey: '', isPendingJump: false, extended: false };
    global.IntersectionObserver = FakeIntersectionObserver;

    moduleCache.set(path.resolve(root, 'src/webview/objModEditor/modelThumbnails.ts'), { exports: { observeModelThumbs: () => {} } });
    moduleCache.set(path.resolve(root, 'src/webview/objModEditor/fieldDisplay.ts'), { exports: { sourcePill: () => '' } });
    moduleCache.set(path.resolve(root, 'src/webview/objModEditor/modelPreviewPanel.ts'), { exports: { hideModelPreview: () => {} } });

    const state = loadTsModule('src/webview/objModEditor/state.ts');
    const objectTree = loadTsModule('src/webview/objModEditor/objectTree.ts');

    objectTree.renderTree();
    assert.equal(state.tree.scrollTop, 240, 'the first render should apply the scroll position restored from persisted state');

    state.tree.scrollTop = 77; // simulate the user having scrolled since the first paint
    objectTree.renderTree();
    assert.equal(state.tree.scrollTop, 77, 'a later render (e.g. triggered by a search or collapse change) must preserve the current scroll, not jump back to the originally-restored one');
}

class FakeClassList {
    constructor(classes) {
        this.classes = new Set(classes);
    }
    add(...classes) {
        for (const cls of classes) this.classes.add(cls);
    }
    remove(...classes) {
        for (const cls of classes) this.classes.delete(cls);
    }
    contains(cls) {
        return this.classes.has(cls);
    }
}

class FakeElement {
    constructor(classes = [], attrs = {}) {
        this.classList = new FakeClassList(classes);
        this.attrs = new Map(Object.entries(attrs));
        this.children = [];
        this.innerHTML = '';
    }
    appendChild(child) {
        this.children.push(child);
    }
    getAttribute(name) {
        return this.attrs.has(name) ? this.attrs.get(name) : null;
    }
    querySelectorAll(selector) {
        const out = [];
        const visit = (el) => {
            if (matchesSelector(el, selector)) out.push(el);
            for (const child of el.children) visit(child);
        };
        visit(this);
        return out;
    }
}

function matchesSelector(el, selector) {
    if (selector === '.object-icon') return el.classList.contains('object-icon');
    if (selector === '.object-icon[data-icon]') {
        return el.classList.contains('object-icon') && el.getAttribute('data-icon') != null;
    }
    if (selector === '.object-icon[data-key]') {
        return el.classList.contains('object-icon') && el.getAttribute('data-key') != null;
    }
    return false;
}

class FakeIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        this.targets = [];
        FakeIntersectionObserver.last = this;
    }
    observe(target) {
        this.targets.push(target);
    }
    unobserve(target) {
        this.targets = this.targets.filter((candidate) => candidate !== target);
    }
    intersectAll() {
        this.callback(this.targets.map((target) => ({ target, isIntersecting: true })));
    }
}

function installIconDom(rootElement) {
    global.window = {};
    global.document = {
        querySelectorAll: (selector) => rootElement.querySelectorAll(selector),
        createElement: (tag) => {
            assert.equal(tag, 'canvas');
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    putImageData() {},
                    drawImage() {},
                    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
                    set imageSmoothingQuality(_value) {},
                }),
                toDataURL: () => 'data:image/png;base64,ok',
            };
        },
    };
    global.IntersectionObserver = FakeIntersectionObserver;
    global.ImageData = class ImageData {
        constructor(data, width, height) {
            this.data = data;
            this.width = width;
            this.height = height;
        }
    };
    global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
}

async function testIconLoader() {
    moduleCache.clear();
    const rootEl = new FakeElement();
    const key = 'Original:0:field:1:ReplaceableTextures\\CommandButtons\\BTNHero.blp';
    const siblingKey = 'Original:0:icon:ReplaceableTextures\\CommandButtons\\BTNHero.blp';
    const iconPath = 'ReplaceableTextures\\CommandButtons\\BTNHero.blp';
    const first = new FakeElement(['object-icon', 'loading'], { 'data-key': key, 'data-icon': iconPath });
    const second = new FakeElement(['object-icon', 'loading'], { 'data-key': key, 'data-icon': iconPath });
    const sidebar = new FakeElement(['object-icon', 'loading'], { 'data-key': siblingKey, 'data-icon': iconPath });
    rootEl.appendChild(first);
    rootEl.appendChild(second);
    rootEl.appendChild(sidebar);
    installIconDom(rootEl);

    const messages = [];
    const { createIconLoader } = loadTsModule('src/webview/objModIconLoader.ts');
    const loader = createIconLoader({ postMessage: (message) => messages.push(message) });
    loader.observe(rootEl);
    FakeIntersectionObserver.last.intersectAll();

    assert.equal(messages.length, 1, 'duplicate icon slots should share one host request by asset path');
    assert.deepEqual(messages[0], { type: 'loadObjectIcon', key, iconPath });

    const rgbaBase64 = Buffer.from([255, 0, 0, 255]).toString('base64');
    loader.handleLoaded({ key, mode: 'rgba', rgbaBase64, width: 1, height: 1 });
    await Promise.resolve();
    assert.equal(first.classList.contains('loading'), false);
    assert.equal(second.classList.contains('loading'), false);
    assert.equal(sidebar.classList.contains('loading'), false);
    assert.ok(first.innerHTML.includes('data:image/png;base64,ok'));
    assert.ok(second.innerHTML.includes('data:image/png;base64,ok'));
    assert.ok(sidebar.innerHTML.includes('data:image/png;base64,ok'));

    const later = new FakeElement(['object-icon', 'loading'], { 'data-key': 'Custom:0:icon:BTNHero.blp', 'data-icon': iconPath });
    rootEl.appendChild(later);
    loader.observe(later);
    assert.equal(later.classList.contains('loading'), false, 'late duplicate slot should use cached icon data');
    assert.ok(later.innerHTML.includes('data:image/png;base64,ok'));

    const missingKey = 'Custom:12:icon:bad[path].blp';
    const missing = new FakeElement(['object-icon', 'loading'], { 'data-key': missingKey, 'data-icon': 'bad[path].blp' });
    rootEl.appendChild(missing);
    loader.handleMissing(missingKey);
    assert.equal(missing.classList.contains('loading'), false);
    assert.equal(missing.classList.contains('missing'), true);
}

async function testFolderModeMapAssetResolution() {
    const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wurst-assets-'));
    const workspace = path.join(tmpRoot, 'workspace');
    const mapFolder = path.join(workspace, 'FixtureMap.w3x');
    const imported = path.join(mapFolder, 'war3mapImported');
    fs.mkdirSync(imported, { recursive: true });
    const texturePath = path.join(imported, 'BrutalLord.blp');
    fs.writeFileSync(texturePath, Buffer.from([1, 2, 3, 4]));
    const modelPath = path.join(imported, 'BrutalLord.mdx');
    fs.writeFileSync(modelPath, Buffer.from([5, 6, 7, 8]));
    const docPath = path.join(mapFolder, 'war3map.w3u');
    fs.writeFileSync(docPath, Buffer.from([0]));

    const vscodeMock = {
        workspace: {
            workspaceFolders: [{ uri: { fsPath: workspace } }],
            fs: {
                readFile: async (uri) => fs.promises.readFile(uri.fsPath),
            },
        },
        Uri: {
            file: (fsPath) => ({ fsPath }),
        },
    };
    const mod = loadTsModuleWithMocks('src/features/imageAssetSupport.ts', {
        vscode: vscodeMock,
        './blpPreview': {
            decodeRasterPreview: () => ({ mode: 'rgba', width: 1, height: 1, rgbaBase64: '', description: 'stub' }),
            ensureGameAssetCached: async () => undefined,
        },
        './preview/cascStorage': {
            getGameAssetCacheDir: () => path.join(tmpRoot, 'game-cache'),
            ensureGameTextureCached: async () => undefined,
        },
    });

    const roots = await mod.getCandidateRoots(docPath);
    assert.ok(
        roots.some((candidate) => path.resolve(candidate) === path.resolve(imported)),
        'folder-mode map import directory should be a candidate root'
    );
    const resolved = await mod.resolveAssetPathWithCasc('BrutalLord.blp', roots, 'texture');
    assert.equal(path.resolve(resolved), path.resolve(texturePath));
    const resolvedFromWrongTextureExt = await mod.resolveAssetPathWithCasc('BrutalLord.tif', roots, 'texture');
    assert.equal(
        path.resolve(resolvedFromWrongTextureExt),
        path.resolve(texturePath),
        'texture lookup should match by asset stem and allowed texture extensions'
    );
    const resolvedModelNoExt = await mod.resolveAssetPathWithCasc('BrutalLord', roots, 'model');
    assert.equal(
        path.resolve(resolvedModelNoExt),
        path.resolve(modelPath),
        'model lookup should match by asset stem and model extensions without picking a texture'
    );
    const resolvedTextureNoExt = await mod.resolveAssetPathWithCasc('BrutalLord', roots, 'texture');
    assert.equal(
        path.resolve(resolvedTextureNoExt),
        path.resolve(texturePath),
        'texture lookup should match by asset stem and texture extensions without picking a model'
    );

    const reforgedVariants = mod.assetPathVariants('Units\\Creeps\\ArachnathidWarrior\\ArachnathidWarrior_Diffuse.tif', 'texture');
    assert.ok(
        reforgedVariants.includes('Units\\Creeps\\ArachnathidWarrior\\ArachnathidWarrior_Diffuse.dds'),
        'Reforged .tif material references should probe .dds by replacing the extension'
    );
    assert.ok(
        !reforgedVariants.some((candidate) => candidate.toLowerCase().endsWith('.tif.dds')),
        'Reforged .tif material references should not append .dds after .tif'
    );
}

function makeBc5Dds4x4() {
    const buf = Buffer.alloc(128 + 16);
    buf.writeUInt32LE(0x20534444, 0);
    buf.writeUInt32LE(124, 4);
    buf.writeUInt32LE(4, 12);
    buf.writeUInt32LE(4, 16);
    buf.writeUInt32LE(1, 28);
    buf.writeUInt32LE(32, 76);
    buf.writeUInt32LE(0x4, 80);
    buf.write('ATI2', 84, 'ascii');
    buf[128] = 128;
    buf[129] = 128;
    buf[136] = 128;
    buf[137] = 128;
    return new Uint8Array(buf);
}

function testBc5DdsDecode() {
    const mod = loadTsModuleWithMocks('src/features/preview/imageDecoders.ts', {
        'casc-ts/formats': {
            decodeBlp: () => { throw new Error('not used'); },
            decodeDds: () => { throw new Error('unsupported DDS compression ATI2'); },
            decodeTga: () => { throw new Error('not used'); },
        },
    });

    const decoded = mod.decodeDds(makeBc5Dds4x4());
    assert.equal(decoded.mode, 'rgba');
    assert.equal(decoded.width, 4);
    assert.equal(decoded.height, 4);
    assert.ok(decoded.description.includes('ATI2'));
    const rgba = Buffer.from(decoded.rgbaBase64, 'base64');
    assert.deepEqual(
        Array.from(rgba.subarray(0, 4)),
        [128, 128, 255, 255],
        'BC5 normal maps should decode red/green channels and reconstruct blue'
    );
}

function testInstallerVersionShaParsing() {
    const noOp = () => undefined;
    const mod = loadTsModuleWithMocks('src/install/installer.ts', {
        vscode: { workspace: {}, window: {}, ProgressLocation: {} },
        '../paths': {
            WURST_HOME: '', RUNTIME_DIR: '', COMPILER_DIR: '', COMPILER_JAR: '', GRILL_HOME_DIR: '',
        },
        './fsUtils': {
            normalizeInstallerPaths: noOp, migrateLegacyGrillLayout: noOp, installLauncherExecutable: noOp,
            isRecoverableInstallError: () => false, cleanupOldWurstHome: noOp, cleanupWurstSetupJar: noOp,
            removeDirSafe: noOp, upgradeFolder: noOp, ensureDirectoryPath: noOp, copyDirContents: noOp,
            withRetry: noOp,
        },
        './downloader': {},
        './pathManager': {},
        '../languageServer': {},
    });

    assert.equal(mod.extractGitSha('WurstScript nightly-5c596122'), '5c596122');
    assert.equal(mod.extractGitSha('WurstScript nightly-g5C596122-dirty'), '5c596122');
    assert.equal(mod.extractGitSha('commit 5c5961223c7b189aaf044ae04aaaa9a1e03c5e9c'), '5c5961223c7b189aaf044ae04aaaa9a1e03c5e9c');
    assert.equal(mod.extractGitSha('1.9.0.0-v0.0.0-3-5a0290ea-10-g73dfd74a6'), '73dfd74a6');
    assert.equal(mod.extractGitSha('WurstScript nightly'), null);
    const full = '5c5961223c7b189aaf044ae04aaaa9a1e03c5e9c';
    assert.equal(mod.gitShasMatch('5c59612', full), true, 'GitHub 7-char labels must match full SHAs');
    assert.equal(mod.gitShasMatch('5c5961223', full), true, 'adaptive git-describe abbreviations must match full SHAs');
    assert.equal(mod.gitShasMatch(full, '5c59612'), true, 'comparison must work regardless of which side is abbreviated');
    assert.equal(mod.gitShasMatch('73dfd74a6', full), false, 'different revisions must not match');
    assert.equal(mod.gitShasMatch('123', full), false, 'unsafe abbreviations shorter than 7 must not match');
    assert.equal(mod.displayGitSha('73DFD74A6'), '73dfd74', 'prompt display must always use 7 lowercase characters');
}

function testNonBlockingStartupAndForcedReinstallWiring() {
    const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
    const languageServer = fs.readFileSync(path.join(root, 'src/languageServer.ts'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'src/install/installer.ts'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    assert.ok(extension.includes('await installWithRetry({ offerPostInstallActions: false })'), 'manual install/update must force installation');
    assert.ok(extension.includes("workbench.action.reloadWindow"), 'forced reinstall must reload the stopped language server');
    assert.ok(!extension.includes('ensureInstalledOrOfferMigration(true)'), 'manual install/update must not use the no-op ensure path');
    assert.ok(!languageServer.includes('await maybeOfferUpdate(context)'), 'update checks must not delay language-client startup');
    assert.ok(languageServer.includes('void maybeOfferUpdate()'), 'update checks should still run in the background');
    assert.ok(installer.includes("execFile(java, ['-jar', COMPILER_JAR, '--version']"), 'version detection must use an asynchronous child process');
    assert.ok(!manifest.activationEvents.includes('workspaceContains:**/*.wurst'), 'activation must not recursively scan for loose Wurst files');
    assert.ok(manifest.activationEvents.includes('onLanguage:wurst'), 'opening a Wurst document must activate the extension');
    assert.ok(installer.includes('withWurstInstallLock('), 'install replacement must be serialized across VS Code windows');
    assert.ok(installer.includes('activeInstallPromise'), 'same-window install requests must share one download/install operation');
    assert.ok(installer.includes('getInstallationStamp() !== initialInstallationStamp'), 'a mutex waiter must skip duplicate work after another completed install');
    assert.ok(extension.includes("registerCommand('wurst.stopAllProcesses'"), 'force-stop command must be registered');
    assert.ok(manifest.contributes.commands.some((item) => item.command === 'wurst.stopAllProcesses'), 'force-stop command must be contributed');
}

function testWurstProcessMatching() {
    const runtime = 'C:\\Users\\tester\\.wurst\\wurst-runtime';
    const jar = 'C:\\Users\\tester\\.wurst\\wurst-compiler\\wurstscript.jar';
    const mod = loadTsModuleWithMocks('src/install/installCoordination.ts', {
        vscode: { window: {}, ProgressLocation: {}, Disposable: class { constructor(dispose) { this.dispose = dispose; } } },
        '../paths': { RUNTIME_DIR: runtime, COMPILER_JAR: jar },
        './fsUtils': { sleep: async () => undefined },
    });
    assert.equal(mod.matchesWurstInstallationProcess({
        executablePath: `${runtime}\\bin\\java.exe`, commandLine: '',
    }, runtime, jar), true, 'bundled Java must be detected');
    assert.equal(mod.matchesWurstInstallationProcess({
        executablePath: 'C:\\Program Files\\Java\\bin\\java.exe', commandLine: `java -jar "${jar}" -languageServer`,
    }, runtime, jar), true, 'custom Java running the Wurst compiler must be detected');
    assert.equal(mod.matchesWurstInstallationProcess({
        executablePath: 'C:\\Program Files\\Java\\bin\\java.exe', commandLine: 'java -jar unrelated.jar',
    }, runtime, jar), false, 'unrelated Java processes must never be targeted');
}

async function testModelThumbnailRequestsTexturesByDefault() {
    const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wurst-model-thumb-'));
    const modelPath = path.join(tmpRoot, 'Footman.mdx');
    const docPath = path.join(tmpRoot, 'war3map.w3u');
    fs.writeFileSync(modelPath, Buffer.alloc(256 * 1024, 7));
    fs.writeFileSync(docPath, Buffer.from([0]));

    const posted = [];
    const mod = loadTsModuleWithMocks('src/features/preview/modelPreviewHost.ts', {
        vscode: {
            workspace: {
                fs: {
                    readFile: async (uri) => fs.promises.readFile(uri.fsPath),
                },
            },
            Uri: {
                file: (fsPath) => ({ fsPath }),
            },
        },
        '../imageAssetSupport': {
            getCandidateRoots: async () => [tmpRoot],
            resolveAssetPathWithCasc: async () => modelPath,
            assetPathVariants: () => [],
            fastByteHash: () => 'abc123',
        },
        './cascStorage': {
            getModelThumbCacheDir: () => path.join(tmpRoot, 'thumb-cache'),
        },
        './imageDecoders': {
            decodeToRgba: () => ({ rgba: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1 }),
        },
    });

    await mod.requestModelThumbnail('Footman.mdx', 'asset-model:0:Footman', { fsPath: docPath }, {
        postMessage: async (message) => {
            posted.push(message);
            return true;
        },
    });

    const render = posted.find((message) => message.type === 'modelThumbRender');
    assert.ok(render, 'uncached model thumbnails should render regardless of model byte size');
    assert.equal(render.skipTextures, undefined, 'model thumbnail renders must load textures by default');
    assert.ok(render.mdxBase64, 'model bytes should still be sent for thumbnail rendering');

    posted.length = 0;
    await mod.requestModelThumbnail('Footman.mdx', 'asset-model:1:Footman', { fsPath: docPath }, {
        asWebviewUri: () => ({ toString: () => 'vscode-webview://model/Footman.mdx' }),
        postMessage: async (message) => {
            posted.push(message);
            return true;
        },
    }, true);
    const uriRender = posted.find((message) => message.type === 'modelThumbRender');
    assert.equal(uriRender.modelUri, 'vscode-webview://model/Footman.mdx', 'objmod thumbnails should fetch large models directly from an allowed webview URI');
    assert.equal(uriRender.mdxBase64, undefined, 'URI-backed model loads should avoid base64 IPC duplication');
}

function testAssetBrowserForwardsModelTextures() {
    const src = fs.readFileSync(path.join(root, 'src/features/assetLinks.ts'), 'utf8');
    const match = src.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>`/);
    assert.ok(match, 'asset browser inline script should be present');
    const script = match[1].replace(
        'var initial = ${initialJson};',
        "var initial = { activeTab: 'model', tabs: { icon: [], model: [] }, currentValue: '' };"
    );
    // eslint-disable-next-line sonarjs/constructor-for-side-effects -- constructed only to validate the extracted inline script parses (throws SyntaxError otherwise); the instance itself is unused on purpose.
    new vm.Script(script);
    assert.ok(
        script.includes("msg.type === 'requestTextures'"),
        'asset browser model renderer should handle texture requests'
    );
    assert.ok(
        script.includes("thumbKey: modelJob.key"),
        'asset browser texture requests should be keyed to the active thumbnail job'
    );
    assert.ok(
        script.includes("msg.type === 'mdxTexture'"),
        'asset browser should consume texture payload replies before thumbnail capture'
    );
    assert.ok(
        script.includes("msg.type === 'modelThumbTexturesComplete'"),
        'asset browser should finish texture waits with an explicit host batch-complete message'
    );
    assert.ok(
        !/type === 'requestTextures'\)\s*return/.test(script),
        'asset browser must not silently drop model texture requests'
    );
}

function testThumbnailLifecycleGuards() {
    const host = fs.readFileSync(path.join(root, 'src/features/preview/modelPreviewHost.ts'), 'utf8');
    const objmod = fs.readFileSync(path.join(root, 'src/webview/objModEditor/modelThumbnails.ts'), 'utf8');
    const modelPreviewPanel = fs.readFileSync(path.join(root, 'src/webview/objModEditor/modelPreviewPanel.ts'), 'utf8');
    const messageHandler = fs.readFileSync(path.join(root, 'src/webview/objModEditor/messageHandler.ts'), 'utf8');
    const assetBrowser = fs.readFileSync(path.join(root, 'src/webview/objModEditor/assetBrowser.ts'), 'utf8');
    const thumbnailWorker = fs.readFileSync(path.join(root, 'src/webview/mdxThumbnailWorker.ts'), 'utf8');
    const webpack = fs.readFileSync(path.join(root, 'webpack.config.js'), 'utf8');
    const assetLinks = fs.readFileSync(path.join(root, 'src/features/assetLinks.ts'), 'utf8');
    const viewer = fs.readFileSync(path.join(root, 'src/webview/mdxViewer.ts'), 'utf8');
    const hdFragment = fs.readFileSync(path.join(root, '../war3-model/renderer/shaders/webgl/hdNew.fs.glsl'), 'utf8');
    const hdVertex = fs.readFileSync(path.join(root, '../war3-model/renderer/shaders/webgl/hdHardwareSkinningNew.vs.glsl'), 'utf8');

    assert.ok(!host.includes('WURST_MODEL_THUMB_MAX_MODEL_BYTES'), 'thumbnail generation must not omit large models');
    assert.ok(!host.includes("reason: 'too-large'"), 'model size must not become a missing-thumbnail reason');
    assert.ok(host.includes("type: 'modelThumbTexturesComplete'"), 'thumbnail texture batches need an explicit terminal message');
    assert.ok(host.includes('MODEL_THUMB_TEXTURE_MAX_DIMENSION'), 'thumbnail textures should use a bounded upload size');
    assert.ok(host.includes('scaleDown(dec.rgba'), 'thumbnail textures should be downscaled before webview transfer and GPU upload');
    assert.ok(host.includes("if (ext === 'blp')"), 'BLP thumbnails should retain the renderer decoder rather than using the generic preview decoder');
    assert.ok(viewer.includes('downscaleTextureImageData'), 'decoded BLP thumbnail textures should be reduced before GPU upload');
    assert.ok(objmod.includes('maxTextureDimension: 256'), 'thumbnail renders should opt into bounded browser-side BLP uploads');
    assert.ok(host.includes('return `v8s-'), 'the cache version must invalidate thumbnails captured before isolated studio-light rendering');
    assert.ok(!objmod.includes('capture-dark-accepted'), 'dark frames must never be persisted as successful thumbnails');
    assert.ok(objmod.includes('reload-full-textures'), 'a dark fast-path render should retry with full-size textures before failing');
    assert.ok(objmod.includes('Array.from(new Set((texturePaths || [])'), 'thumbnail capture must wait for every referenced material texture');
    assert.ok(!objmod.includes('(?:normal|orm)'), 'thumbnail loading must not omit HD material textures');
    assert.ok(objmod.includes('freezeAnimation: true'), 'thumbnail renders should explicitly freeze animation');
    assert.ok(viewer.includes('if (animationFrozen) return'), 'the animation frame loop should not update or rerender frozen thumbnails');
    assert.ok(objmod.includes("toDataURL('image/webp', 0.84)"), 'small thumbnail captures should not use visibly blurry WebP compression');
    assert.ok(objmod.includes('new Worker(modelThumbWorkerBlobUrl'), 'objmod thumbnail rendering should run in a webview-compatible Blob worker');
    assert.ok(objmod.includes('fetch(initial.thumbnailWorkerUri'), 'the worker bundle must be fetched before creating its Blob URL');
    assert.ok(!objmod.includes('new Worker(initial.thumbnailWorkerUri)'), 'VS Code resource URLs cannot be passed directly to the Worker constructor');
    const ensureInit = /export function modelThumbEnsureInit\(\) \{([\s\S]*?)\n\}/.exec(objmod)?.[1] || '';
    assert.ok(!ensureInit.includes('mpvViewer()'), 'worker startup failure must not fall back to rendering on the objmod UI thread');
    assert.ok(webpack.includes("mdxThumbnailWorker: './src/webview/mdxThumbnailWorker.ts'"), 'the isolated thumbnail worker must be bundled');
    assert.ok(thumbnailWorker.includes('new OffscreenCanvas'), 'thumbnail WebGL should use a worker-owned OffscreenCanvas');
    assert.ok(
        thumbnailWorker.includes('empty-frame-after-${sampledFrames}-samples'),
        'a single invisible animation frame must not turn a renderable model into a missing thumbnail',
    );
    assert.ok(thumbnailWorker.includes('setEnvironmentMapProcessingEnabled(false)'), 'unused environment-map preprocessing must be disabled for thumbnails');
    assert.ok(
        thumbnailWorker.indexOf('setEnvironmentMapProcessingEnabled(false)') < thumbnailWorker.indexOf('renderer.initGL(gl)'),
        'environment-map preprocessing must be disabled before renderer initialization',
    );
    assert.ok(hdFragment.includes('normalize(vTBN * normal)'), 'HD normal maps must retain their outward-facing Z axis');
    assert.ok(!hdFragment.includes('normalize(vTBN * -normal)'), 'HD normal maps must not invert their surface-facing Z axis');
    assert.ok(hdVertex.includes('mat4 sum = mat4(0.0)'), 'HD skinning must initialize its weighted matrix sum');
    assert.ok(host.includes('thumbnail-diagnostics.jsonl'), 'thumbnail runs should produce a compact inspectable diagnostic file');
    assert.ok(host.includes('textureBytes:'), 'worker-decodable textures should cross the webview as binary data rather than base64');
    assert.ok(!thumbnailWorker.includes('fetch(message.textureUri)'), 'blob workers must not fetch authenticated VS Code resource URLs');
    assert.ok(
        host.includes('compactDdsForThumbnail(bytes)'),
        'large DDS textures must transfer only thumbnail-sized mip levels to the worker and GPU',
    );
    assert.ok(assetBrowser.includes('(e.ctrlKey || e.metaKey)'), 'Ctrl+clicking a model card should open its full preview');
    assert.ok(viewer.includes('applyCachedTexture(texturePath)'), 'the warm thumbnail viewer should reuse decoded textures');
    assert.ok(viewer.includes('clearModel()'), 'the model viewer should expose an explicit stale-preview reset');
    assert.ok(modelPreviewPanel.includes('mpvViewer().clearModel()'), 'inline preview must clear the prior model before resolving a new path');
    assert.ok(
        /msg\.type === 'mdxModelMissing'[\s\S]{0,120}clearModel\(\)/.test(messageHandler),
        'a missing full preview must not leave the previous successful model visible',
    );
    assert.ok(viewer.includes('renderer?.adoptTexture(texturePath, cached.texture)'), 'warm thumbnail renderers should reuse same-context GPU textures without uploading again');
    assert.ok(/setTextureCompressedImage[\s\S]{0,200}rememberDecodedTexture\(texPath, null\)/.test(viewer), 'compressed DDS GPU textures should join the warm renderer cache');
    assert.ok(viewer.includes("textureCacheKey: 'thumbnail'") || objmod.includes("textureCacheKey: 'thumbnail'"), 'thumbnail loads must opt into the warm texture cache');
    assert.ok(!host.includes('bad-cache-hit'), 'thumbnail host must not suppress retries based on old failures');
    assert.ok(!objmod.includes('TEXTURE_WAIT_RETRIES'), 'objmod thumbnails must wait for texture completion instead of retry-budget capture');
    assert.ok(!objmod.includes('texture-wait-timeout'), 'objmod thumbnails must not fail because texture loading took too long');
    assert.ok(!objmod.includes('texture-failed'), 'objmod thumbnails must not become question marks just because a texture reply was missing/unsupported');
    assert.ok(!objmod.includes('MODEL_THUMB_HOST_TIMEOUT_MS'), 'valid models must not be omitted by an arbitrary host timeout');
    assert.ok(!objmod.includes('MODEL_THUMB_RENDER_TIMEOUT_MS'), 'valid models must not be omitted by an arbitrary render timeout');
    assert.ok(!objmod.includes('MODEL_THUMB_MAX_QUEUE'), 'objmod thumbnails must not drop queued renders because of a fixed queue budget');
    assert.ok(!assetLinks.includes('TEXTURE_WAIT_RETRIES'), 'asset picker thumbnails must wait for texture completion instead of retry-budget capture');
}

function testStaticMdxWithoutSequences() {
    const fixturePath = path.join(root, 'wc3data', 'melon.mdx');
    assert.ok(fs.existsSync(fixturePath), 'static MDX regression fixture should exist');

    const { parseMDX } = require('war3-model');
    const bytes = fs.readFileSync(fixturePath);
    const model = parseMDX(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(model.Sequences.length, 0, 'melon fixture should exercise a sequence-less WC3 model');

    const previousWindow = global.window;
    global.window = {};
    try {
        const { ensureRenderableSequence } = loadTsModule('src/webview/mdxViewer.ts');
        assert.equal(ensureRenderableSequence(model), true, 'sequence-less models should receive a static render sequence');
        assert.equal(model.Sequences.length, 1);
        assert.deepEqual(Array.from(model.Sequences[0].Interval), [0, 0]);
        assert.equal(ensureRenderableSequence(model), false, 'the fallback must not modify a model twice');
        assert.equal(model.Sequences.length, 1);
    } finally {
        global.window = previousWindow;
    }
}

async function testIssueReportingPrivacyAndDeduplication() {
    const opened = [];
    const prompts = [];
    const vscodeMock = {
        version: '1.109.0-test',
        ConfigurationTarget: { Global: 1 },
        Uri: { parse: (value) => value },
        extensions: { getExtension: () => ({ packageJSON: { version: '0.test' } }) },
        env: {
            openExternal: async (uri) => { opened.push(uri); return true; },
            clipboard: { writeText: async () => {} },
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key, fallback) => fallback,
                update: async () => {},
            }),
        },
        window: {
            showInformationMessage: async (message) => { prompts.push(message); return undefined; },
        },
    };
    const reporter = loadTsModuleWithMocks('src/features/issueReporting.ts', { vscode: vscodeMock });
    const issue = {
        area: 'model preview renderer',
        message: 'Missing sequence interval in C:\\private\\maps\\melon.mdx',
        resource: { fsPath: 'C:\\private\\maps\\melon.mdx', path: '/private/maps/melon.mdx' },
    };

    await reporter.openIssueReport(issue);
    assert.equal(opened.length, 1);
    const reportUrl = new URL(opened[0]);
    const body = reportUrl.searchParams.get('body') || '';
    assert.ok(body.includes('melon.mdx'), 'prefilled report should identify the resource basename');
    assert.ok(!body.includes('private'), 'prefilled report must not disclose the local resource path');

    reporter.offerIssueReport(issue);
    await new Promise((resolve) => setImmediate(resolve));
    reporter.offerIssueReport(issue);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts.length, 1, 'the same failure shape should only prompt once per session');
}

function testObjModSaveCommitsFocusedEditor() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    // The objmod webview entry point delegates to src/webview/objModEditor/*.ts — concatenate the
    // whole split so this stays a check on the bundle's behavior, not on which file each piece lives in.
    const objModEditorDir = path.join(root, 'src/webview/objModEditor');
    const objmod = [
        fs.readFileSync(path.join(root, 'src/webview/objModEditorWebview.ts'), 'utf8'),
        ...fs.readdirSync(objModEditorDir).map((file) => fs.readFileSync(path.join(objModEditorDir, file), 'utf8')),
    ].join('\n');

    assert.ok(objmod.includes('function commitActiveEditor()'), 'objmod webview should expose an immediate focused-field commit helper');
    assert.ok(objmod.includes("el._commitNow = commit"), 'focused objmod editors should publish their commit function');
    assert.ok(objmod.includes("k === 's'"), 'objmod webview should handle Ctrl/Cmd+S explicitly');
    assert.ok(objmod.includes("vscodeApi.postMessage({ type: 'save' })"), 'objmod webview save shortcut should ask the host to save after committing');
    assert.ok(host.includes("msg.type === 'save'"), 'objmod host should handle save messages from the webview');
    assert.ok(host.includes("workbench.action.files.save"), 'objmod host save message should route through VS Code save');
    assert.ok(host.includes('doc.wtsEdits.clear()'), 'objmod host should clear staged WTS edits after a successful write');
}

function testObjModEditorTypeAndRecoveryGuards() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    const webviewFiles = [
        path.join(root, 'src/webview/objModEditorWebview.ts'),
        ...fs.readdirSync(path.join(root, 'src/webview/objModEditor'))
            .filter((file) => file.endsWith('.ts'))
            .map((file) => path.join(root, 'src/webview/objModEditor', file)),
    ];
    const webview = webviewFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    assert.ok(!webview.includes('@ts-nocheck'), 'objmod webview sources must remain typechecked');
    assert.ok(webview.includes("assetBrowserUi.activeTab !== 'model'"), 'thumbnail visibility must use shared reactive browser state');
    assert.ok(!webview.includes("from './assetBrowser';\nimport { resetMpvInited"), 'thumbnail scheduling must not depend on a circular asset-browser import');
    assert.ok(host.includes('openContext.backupId'), 'objmod documents must restore VS Code hot-exit backups');
    assert.ok(host.includes('skinBase64'), 'objmod backups must include the skin sibling');
    assert.ok(host.includes('wtsEdits: Array.from(doc.wtsEdits)'), 'objmod backups must include staged WTS edits');
    assert.ok(host.includes('currentRevision = beforeRevision'), 'undo must restore a history identity, not decrement a depth');
    assert.ok(!host.includes('doc.editDepth'), 'branch-unsafe edit depth tracking must not return');
}

async function main() {
    testSignals();
    testObjModTreeSelectionStaysUntracked();
    testObjModDetailsRebuildVsFilterEffectSplit();
    testObjModStateRestoresAndPersistsUiState();
    testObjModStatePendingJumpOverridesRestoredSelection();
    testObjModStateIgnoresStaleRestoredSelection();
    testObjModTreeRenderPreservesScrollPosition();
    await testIconLoader();
    await testFolderModeMapAssetResolution();
    testBc5DdsDecode();
    testInstallerVersionShaParsing();
    testObjModEditorTypeAndRecoveryGuards();
    testNonBlockingStartupAndForcedReinstallWiring();
    testWurstProcessMatching();
    await testModelThumbnailRequestsTexturesByDefault();
    testAssetBrowserForwardsModelTextures();
    testThumbnailLifecycleGuards();
    testStaticMdxWithoutSequences();
    await testIssueReportingPrivacyAndDeduplication();
    testObjModSaveCommitsFocusedEditor();
    console.log('webview harness tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
