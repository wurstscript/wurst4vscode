'use strict';

/**
 * Fast unit harness for browser-side webview modules.
 *
 * It transpiles the real TypeScript files in-memory, then runs them against a tiny
 * DOM shim. Keep tests here for pure/lite webview behavior that should not need a
 * full VS Code integration launch.
 *
 * For behavior that needs a real browser (layout, CSS, events, the host<->webview message
 * protocol), see the Playwright suite under e2e/ instead.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createTsLoader, sharedLoader, root } = require('../e2e/harness/tsLoader');

const loadTsModule = sharedLoader;
const moduleCache = sharedLoader.cache;
const loadTsModuleWithMocks = (relPath, mocks) => createTsLoader({ mocks })(relPath);

function testAssetPathNormalization() {
    const { normalizeAssetPath } = loadTsModule('src/webview/assetPathUtils.ts');
    assert.strictEqual(normalizeAssetPath('\uFEFF\\Textures//HeroLich.blp\\'), 'textures\\herolich.blp');
    assert.strictEqual(normalizeAssetPath('Textures/ HERO//HeroLich.blp'), 'textures\\ hero\\herolich.blp');
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
    const messages = [];
    global.acquireVsCodeApi = () => ({
        postMessage: (message) => { messages.push(message); },
        getState: () => state,
        setState: (next) => { state = next; },
    });
    return { getState: () => state, getMessages: () => messages };
}

// state.ts is meant to make a reopened editor (a webview reload after our external-change auto-reload
// or revert, or a fresh VS Code session) pick back up where the user left off, instead of resetting to
// a blank slate — see the persistUi effect and the restoredSelectedKey logic there.
function testObjModStateRestoresAndPersistsUiState() {
    moduleCache.clear();
    const objects = [
        { key: 'Custom:0', identity: 'Custom:hfoo|h001' },
        { key: 'Custom:1', identity: 'Custom:hrif|h002' },
    ];
    const dom = installObjModStateDom({
        selectedKey: 'Custom:0', // deliberately stale after an external reorder
        selectedIdentity: 'Custom:hrif|h002',
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
    assert.equal(persistedAfter.selectedIdentity, 'Custom:hrif|h002', 'selection persistence must use stable rawcodes, not an array index');
    assert.ok(dom.getMessages().some(message => message.type === 'selectionChanged' && message.identity === 'Custom:hrif|h002'),
        'the stable selection identity must be sent to the host for workspace-relative persistence');
    assert.equal(persistedAfter.listW, 321, 'fields unrelated to reactive ui state (e.g. splitter width) must not be clobbered');
}

function testObjModStatePendingJumpOverridesRestoredSelection() {
    moduleCache.clear();
    const objects = [
        { key: 'Custom:0', identity: 'Custom:hfoo|h001' },
        { key: 'Custom:1', identity: 'Custom:hrif|h002' },
    ];
    installObjModStateDom({ selectedKey: 'Custom:1', selectedIdentity: 'Custom:hrif|h002' });
    global.window.__OBJMOD_INITIAL__ = { objects, selectedKey: 'Custom:0', isPendingJump: true, extended: false };

    const state = loadTsModule('src/webview/objModEditor/state.ts');
    assert.equal(state.ui.selectedKey, 'Custom:0', 'a deliberate cross-file rawcode jump must win over a restored selection');
}

function testObjModStateIgnoresStaleRestoredSelection() {
    moduleCache.clear();
    const objects = [{ key: 'Custom:0', identity: 'Custom:hfoo|h001' }];
    installObjModStateDom({ selectedKey: 'Custom:99', selectedIdentity: 'Custom:old0|old1' });
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
        { key: 'Custom:0', identity: 'Custom:a000|a001', group: 'Custom', race: 'human', displayName: 'Alpha', baseId: 'a000' },
        { key: 'Custom:1', identity: 'Custom:b000|b001', group: 'Custom', race: 'human', displayName: 'Beta', baseId: 'b000' },
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
            findCachedGameAsset: async () => undefined,
            getGameAssetCacheDir: () => path.join(tmpRoot, 'game-cache'),
            ensureGameTextureCached: async () => undefined,
            normalizeGameAssetSeparators: (value) => String(value ?? '').replace(/[\\/]+/g, '\\').replace(/^\\/, '').replace(/\\$/, ''),
        },
    });

    const roots = await mod.getCandidateRoots(docPath);
    assert.ok(
        roots.some((candidate) => path.resolve(candidate) === path.resolve(imported)),
        'folder-mode map import directory should be a candidate root'
    );
    const gathered = await mod.gatherImportedAssets(docPath);
    assert.equal(gathered.icon.length, 1, 'the same imported texture reached through nested candidate roots must appear once');
    assert.equal(gathered.icon[0].value, 'BrutalLord.blp', 'the most specific asset root should provide the useful WC3-relative path');
    assert.equal(gathered.model.length, 1, 'the same imported model reached through nested candidate roots must appear once');
    assert.equal(gathered.model[0].value, 'BrutalLord.mdx');
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
    assert.ok(languageServer.includes('void maybeOfferUpdate((update) =>'), 'update checks should still run in the background and update the status item');
    assert.ok(languageServer.includes("'$(circle-filled) WurstScript Update'"), 'the status item must indicate when an update is available');
    assert.ok(!installer.includes("{ modal: true, detail }, 'Update', 'Later'"), 'the automatic update notification must not be modal');
    assert.ok(installer.includes("'Update', 'Later'"), 'the non-modal update notification must retain its actions');
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
    const script = match[1]
        .replace(
            'var initial = ${initialJson};',
            "var initial = { activeTab: 'model', tabs: { icon: [], model: [] }, currentValue: '' };"
        )
        .replace('${fuzzyMatch.toString()}', 'function fuzzyMatch() { return false; }')
        .replace('${assetSearchScore.toString()}', 'function assetSearchScore() { return Number.POSITIVE_INFINITY; }');
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
    assert.ok(
        script.includes('assetSearchScore(query, item.label, item.value, item.detail, fuzzyMatch)'),
        'code and object-data asset pickers should share the relevance scorer'
    );
    assert.ok(
        !script.includes('text.indexOf(q[i], pos)'),
        'asset search must not regress to scattered-letter subsequence matching'
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
    assert.ok(assetBrowser.includes('modelThumbEnsureInit()'), 'opening or selecting the model asset browser should prewarm the thumbnail worker');
    assert.ok(assetBrowser.includes("import { assetSearchScore, fuzzyMatch } from '../../features/preview/fuzzy'"), 'objmod asset search should use the shared relevance scorer');
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

function testObjModTooltipFontWiring() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const packageData = JSON.parse(packageJson);

    assert.ok(host.includes("get<string>(TOOLTIP_FONT_SETTING, '')"), 'objmod should support an explicit tooltip font setting');
    assert.ok(!host.includes("'**/*.ttf'"), 'objmod must not auto-discover arbitrary workspace fonts');
    assert.ok(host.includes('isWithinDirectory(root, configuredPath)'), 'configured tooltip fonts must stay inside the workspace');
    assert.ok(host.includes('webview.asWebviewUri(compatibleUri)'), 'project fonts must be converted to webview resource URIs');
    assert.ok(host.includes('repairTooltipTrueTypeFont(source)'), 'project fonts must repair glyph flags rejected by Chromium');
    assert.ok(host.includes('font-src ${context.webview.cspSource}'), 'objmod CSP must permit the project font resource');
    assert.ok(host.includes('@font-face'), 'objmod should declare the project font for tooltip previews');
    assert.ok(!host.includes("Buffer.from(bytes).toString('base64')"), 'project fonts should not be embedded as large data URLs');
    assert.ok(/\.tt-collapsed-box,\r?\n\.tt-preview \{/.test(host), 'the custom font should be assigned only to tooltip boxes');
    assert.ok(!host.includes('.tt-collapsed-box *'), 'the custom font should not use descendant-wide override selectors');
    assert.ok(host.includes('td.value { font-family: var(--font); }'), 'ordinary field values should use the VS Code UI font');
    assert.ok(host.includes('.tt-empty { color: var(--muted); font-style: normal; }'), 'ordinary empty values should not be italicized');
    assert.ok(host.includes('.tt-collapsed-box .tt-empty,'), 'only framed WC3 text may retain the italic empty placeholder');
    assert.ok(packageJson.includes('wurst.objModTooltipFont'), 'the tooltip font setting should be contributed by the extension');
    assert.equal(packageData.contributes.configuration.properties['wurst.objModTooltipFont'].default, '', 'the tooltip font setting must default to disabled');
}

function testTooltipFontRepairsChromiumRejectedGlyphFlags() {
    const { repairTooltipTrueTypeFont } = loadTsModule('src/features/preview/tooltipFont.ts');
    const font = Buffer.alloc(168);
    font.writeUInt32BE(0x00010000, 0);
    font.writeUInt16BE(4, 4);
    const writeTable = (index, tag, offset, length) => {
        const record = 12 + index * 16;
        font.write(tag, record, 4, 'ascii');
        font.writeUInt32BE(offset, record + 8);
        font.writeUInt32BE(length, record + 12);
    };
    writeTable(0, 'head', 76, 54);
    writeTable(1, 'maxp', 132, 6);
    writeTable(2, 'loca', 140, 8);
    writeTable(3, 'glyf', 148, 17);
    font.writeUInt32BE(0x00010000, 76);
    font.writeUInt32BE(0x5f0f3cf5, 88);
    font.writeInt16BE(1, 126);
    font.writeUInt32BE(0x00010000, 132);
    font.writeUInt16BE(1, 136);
    font.writeUInt32BE(17, 144);
    font.writeInt16BE(1, 148);
    font.writeUInt16BE(0, 158);
    font.writeUInt16BE(0, 160);
    font[162] = 0x96; // Valid point encoding plus reserved bit 7: rejected by Chromium OTS.
    font[163] = 1;
    font[164] = 1;

    const repaired = repairTooltipTrueTypeFont(font);
    assert.equal(repaired.repairedFlags, 1, 'the malformed glyph flag must be detected');
    assert.equal(repaired.bytes[162], 0x16, 'reserved glyph bits must be cleared without changing point encoding');
    const repairedBuffer = Buffer.from(repaired.bytes);
    let checksum = 0;
    for (let i = 0; i < repaired.bytes.length; i += 4) {
        checksum = (checksum + repairedBuffer.readUInt32BE(i)) >>> 0;
    }
    assert.equal(checksum, 0xb1b0afba, 'the repaired TrueType checksum must remain valid');
    const secondPass = repairTooltipTrueTypeFont(repaired.bytes);
    assert.equal(secondPass.repairedFlags, 0, 'repair must be idempotent');
    assert.deepEqual(Buffer.from(secondPass.bytes), Buffer.from(repaired.bytes));
}

function testObjModTooltipWidthWiring() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    const packageData = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const setting = packageData.contributes.configuration.properties['wurst.objModTooltipWidth'];

    assert.equal(setting.default, 280, 'tooltip width should preserve the existing default');
    assert.equal(setting.minimum, 160, 'tooltip width should reject unusably narrow values');
    assert.equal(setting.maximum, 1200, 'tooltip width should have a sensible upper bound');
    assert.equal(setting.scope, 'resource', 'tooltip width should be remembered per workspace folder');
    assert.ok(host.includes("get<number>(TOOLTIP_WIDTH_SETTING, DEFAULT_TOOLTIP_WIDTH_PX)"), 'objmod should read the configured tooltip width for the document resource');
    assert.ok(host.includes('--wc3-tip-width: ${tooltipWidthPx}px;'), 'objmod should apply the configured width to tooltip preview CSS');
    assert.ok(!host.includes('--wc3-tip-width: 280px;'), 'tooltip preview width should not remain hard-coded');
}

function testObjModTooltipPreviewHeaders() {
    const fieldDisplay = fs.readFileSync(path.join(root, 'src/webview/objModEditor/fieldDisplay.ts'), 'utf8');
    const detailsPanel = fs.readFileSync(path.join(root, 'src/webview/objModEditor/detailsPanel.ts'), 'utf8');

    assert.ok(fieldDisplay.includes("replace(/^(?:unit|building)\\s*\\/\\s*/i, '')"), 'unit and building tooltip markers should be hidden in previews');
    assert.ok(fieldDisplay.includes("label === 'name' || /\\bnames?$/"), 'player-facing name fields should use the framed WC3 text editor');
    assert.ok(detailsPanel.includes('renderWc3Colors(original)'), 'tooltip editing should restore the unmodified raw value');
    assert.ok(detailsPanel.includes('renderWc3Colors(tooltipPreviewText(value, isTooltipTemplateField(mod)))'), 'tooltip collapse should restore the cleaned preview only for tooltip fields');
}

function testObjModSavedAndUsedTooltipColors() {
    const messages = [];
    const fieldDisplay = loadTsModuleWithMocks('src/webview/objModEditor/fieldDisplay.ts', {
        './state': {
            initial: { customColors: ['#ABCDEF', 'invalid', 'abcdef', '123456', 'ffcc00'] },
            ui: {},
            vscodeApi: { postMessage: (message) => messages.push(message) },
        },
    });

    assert.deepEqual(fieldDisplay.customColors, ['abcdef', '123456'], 'saved colors should be normalized, deduplicated, and exclude presets');
    const colors = fieldDisplay.extractUsedColors(
        '|cff000001one|r |C80000002two|r ||cffff0000 literal |c7f000003three|r ' +
        '|cff000004four|r |cff000005five|r |czz000006invalid',
    );
    assert.deepEqual(colors, ['000001', '000002', '000003', '000004', '000005'], 'every distinct valid WC3 color should be recognized in source order');
    assert.equal((fieldDisplay.usedColorSwatchesHtml(colors.map((hex) => `|cff${hex}x|r`).join('')).match(/tt-used-sw/g) || []).length, 5, 'the toolbar should render every recognized color');
    assert.deepEqual(fieldDisplay.extractUsedColors('|cff010203x|r|c80040506y|r|cff070809z|r', 2), ['010203', '040506'], 'an explicit color limit should still be honored');
    assert.deepEqual(fieldDisplay.extractUsedColors('||cffff0000 escaped'), [], 'an escaped literal pipe must not be mistaken for a color marker');

    assert.equal(fieldDisplay.rememberCustomColor('#654321'), '654321');
    assert.deepEqual(fieldDisplay.customColors.slice(0, 3), ['654321', 'abcdef', '123456']);
    assert.deepEqual(messages, [{ type: 'rememberCustomColor', color: '654321' }]);
    assert.ok(fieldDisplay.customSwatchesHtml().includes('data-color="654321"'), 'remembered colors should render in the saved palette');
    fieldDisplay.rememberCustomColor('#654321');
    assert.equal(messages.length, 1, 'choosing the newest saved color again should not write duplicate state');

    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    assert.ok(host.includes("context.globalState"), 'saved custom colors should follow the user across workspaces');
    assert.ok(host.includes("msg.type === 'rememberCustomColor'"), 'the objmod host should persist custom colors sent by the picker');
    assert.ok(host.includes('customColors,'), 'saved custom colors should be restored into new objmod webviews');
    assert.ok(host.includes('.tt-custom-colors[hidden] { display: none; }'), 'an empty saved palette should remain hidden despite its flex layout');
}

function testObjModDensityAndTreeStyling() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    const webview = fs.readFileSync(path.join(root, 'src/webview/objModEditorWebview.ts'), 'utf8');

    assert.ok(host.includes('id="density-toggle" class="density-toggle" role="switch"'), 'density must render as an obvious switch control');
    assert.ok(host.includes('aria-label="Spacious density"'), 'density switch should have an unambiguous accessible name');
    assert.ok(host.includes('class="density-track"'), 'density switch should expose an animated visual track');
    assert.ok(host.includes('body.density-cozy .density-thumb { transform: translateX(14px)'), 'density switch thumb should animate between states');
    assert.ok(host.includes('@media (prefers-reduced-motion: reduce)'), 'density animation should respect reduced-motion preferences');
    assert.ok(webview.includes("setAttribute('aria-checked', String(cozy))"), 'density switch must expose its current state accessibly');
    assert.ok(/font-size: 11px;\r?\n {2}font-weight: 500;\r?\n {2}color: var\(--muted\);/.test(host), 'nested tree headings should share one typography baseline');
    assert.ok(!/\.race-heading \{\r?\n {2}padding: var\(--tree-heading-py\) var\(--ind-group\) var\(--tree-heading-py\) var\(--ind-race\);\r?\n {2}color: var\(--fg\);\r?\n {2}font-size: 12px;/.test(host), 'race headings should not introduce a third font treatment');
}

function testImportedAssetDedupeSafety() {
    const host = fs.readFileSync(path.join(root, 'src/features/objModPreview.ts'), 'utf8');
    const support = fs.readFileSync(path.join(root, 'src/features/imageAssetSupport.ts'), 'utf8');
    const e2e = fs.readFileSync(path.join(root, 'e2e/local/fixtures.js'), 'utf8');

    assert.ok(!support.includes('hashImportedAsset'), 'asset dedupe must not mistake size+mtime metadata for a content hash');
    assert.ok(!host.includes('opt.hash'), 'distinct imported files must not collapse through metadata collisions');
    assert.ok(host.includes("if (opt.source === 'import')"), 'imports in different folders should remain separate after exact-path dedupe');
    assert.ok(
        support.indexOf('if (seenFile.has(fileKey)) continue;') < support.indexOf('budget--;'),
        'duplicate physical assets must not consume the imported-asset scan budget',
    );
    assert.ok(e2e.includes("path.join(root, 'wc3data', 'melon.mdx')"), 'generated thumbnail search controls should copy a valid model fixture');
    assert.ok(!e2e.includes("'objmod search fixture'"), 'generated thumbnail fixtures must not contain fake text model bytes');
}

function testLocalE2eFixturesRemainOptIn() {
    const fixtures = fs.readFileSync(path.join(root, 'e2e/local/fixtures.js'), 'utf8');
    // Launching a real VS Code window from a plain `npm test` would be a nasty surprise, so the
    // local suite must stay behind an explicit env flag.
    assert.ok(fixtures.includes("process.env.WURST_OBJMOD_E2E === '1'"), 'local VS Code e2e must stay opt-in');
    assert.ok(fixtures.includes('test.skip(!enabled'), 'local VS Code e2e must skip, not fail, when disabled');
    // A beforeEach registered inside the shared fixtures module only attaches to whichever spec file
    // imported it first, so each spec has to opt in explicitly or it would launch VS Code unasked.
    for (const spec of fs.readdirSync(path.join(root, 'e2e/local')).filter((file) => file.endsWith('.spec.js'))) {
        const source = fs.readFileSync(path.join(root, 'e2e/local', spec), 'utf8');
        assert.ok(
            /^skipUnlessEnabled\(\);$/m.test(source) || /^test\.skip\(!enabled,/m.test(source),
            `${spec} must gate itself at top level on the local-e2e env flag`,
        );
    }
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
    assert.ok(host.includes('watcher.onDidDelete(onEvent)'), 'external-change detection must cover Git-style file replacement');
    assert.ok(host.includes('id="refresh-editor"'), 'the object editor must expose a manual refresh action');
    assert.ok(host.includes('preferredSelectionIdentity'), 'reloading must resolve selection by stable object identity');
    assert.ok(host.includes('objModSelectionPathKey(doc.uri)'), 'selection must be stored per workspace-relative document path');
}

function testWpmEditorInlineScriptAndRecoveryGuards() {
    const host = fs.readFileSync(path.join(root, 'src/features/wpmPreview.ts'), 'utf8');
    const match = host.match(/<script>\r?\n([\s\S]*?)\r?\n {2}<\/script>/);
    assert.ok(match, 'WPM editor inline script should be present');
    const script = match[1]
        .replace('${wpm.width}', '4')
        .replace('${wpm.height}', '4')
        .replace('${dataBase64}', 'AAAAAAAAAAAAAAAAAAAAAA==')
        .replace('${JSON.stringify(colorTable)}', '[[0, 0, 0]]')
        .replace('${JSON.stringify(WPM_FLAG_DEFS.map(({ bit, label }) => ({ bit, label })))}', '[]')
        .replace(/\\`/g, '`')
        .replace(/\\\$\{/g, '${');
    // eslint-disable-next-line sonarjs/constructor-for-side-effects -- parsing the real inline script is the assertion.
    new vm.Script(script);
    assert.ok(host.includes('openContext.backupId'), 'WPM documents must restore VS Code hot-exit backups');
    assert.ok(host.includes('currentRevision !== doc.savedRevision'), 'WPM dirty tracking must distinguish edit-history branches');
    assert.ok(!host.includes('doc.editDepth'), 'WPM dirty tracking must not use branch-unsafe edit depth');
}

function testWpmFlagSemantics() {
    const { WPM_FLAG_DEFS, WPM_KNOWN_VERSION, wpmCellRgb, wpmFlagLabels } = loadTsModule('src/features/wpmFlags.ts');
    assert.strictEqual(WPM_KNOWN_VERSION, 0);
    assert.deepStrictEqual(WPM_FLAG_DEFS.map((definition) => definition.bit), [1, 2, 4, 8, 16, 32, 64, 128]);
    assert.deepStrictEqual(wpmFlagLabels(0xd0), ['No Peon Harvest', 'No Water / Unfloatable', 'Unamphibious']);
    assert.deepStrictEqual(wpmCellRgb(0x0a), [255, 0, 255], 'primary pathing colors must remain RGB channels');
    assert.notDeepStrictEqual(wpmCellRgb(0x80), [0, 0, 0], 'amphibious cells must not render as an anonymous black cell');
}

async function main() {
    testAssetPathNormalization();
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
    testWpmEditorInlineScriptAndRecoveryGuards();
    testNonBlockingStartupAndForcedReinstallWiring();
    testWurstProcessMatching();
    await testModelThumbnailRequestsTexturesByDefault();
    testAssetBrowserForwardsModelTextures();
    testThumbnailLifecycleGuards();
    testStaticMdxWithoutSequences();
    await testIssueReportingPrivacyAndDeduplication();
    testObjModSaveCommitsFocusedEditor();
    testObjModTooltipFontWiring();
    testTooltipFontRepairsChromiumRejectedGlyphFlags();
    testObjModTooltipWidthWiring();
    testObjModTooltipPreviewHeaders();
    testObjModSavedAndUsedTooltipColors();
    testObjModDensityAndTreeStyling();
    testImportedAssetDedupeSafety();
    testLocalE2eFixturesRemainOptIn();
    testWpmFlagSemantics();
    console.log('webview harness tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
