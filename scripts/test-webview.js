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
        seen = count.get();
    });
    assert.equal(seen, 0);
    assert.equal(runs, 1);
    count.set(1);
    assert.equal(seen, 1);
    assert.equal(runs, 2);
    count.set(1);
    assert.equal(runs, 2, 'same value should not rerun effects');
    stop();
    count.set(2);
    assert.equal(seen, 1, 'disposed effects should stop observing');

    const pickLeft = signal(true);
    const left = signal('left-a');
    const right = signal('right-a');
    let branch = '';
    let branchRuns = 0;
    effect(() => {
        branchRuns++;
        branch = pickLeft.get() ? left.get() : right.get();
    });
    assert.equal(branch, 'left-a');
    pickLeft.set(false);
    assert.equal(branch, 'right-a');
    const afterSwitchRuns = branchRuns;
    left.set('left-b');
    assert.equal(branchRuns, afterSwitchRuns, 'stale branch dependency should be cleaned up');
    right.set('right-b');
    assert.equal(branch, 'right-b');

    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a.get() + b.get());
    let sumSeen = 0;
    let sumRuns = 0;
    effect(() => {
        sumRuns++;
        sumSeen = sum.get();
    });
    assert.equal(sumSeen, 3);
    batch(() => {
        a.set(3);
        b.set(4);
    });
    assert.equal(sumSeen, 7);
    assert.equal(sumRuns, 2, 'batch should coalesce dependent effect reruns');

    const tracked = signal('tracked-a');
    const ignored = signal('ignored-a');
    let mixed = '';
    let mixedRuns = 0;
    effect(() => {
        mixedRuns++;
        mixed = `${tracked.get()}/${untracked(() => ignored.get())}`;
    });
    ignored.set('ignored-b');
    assert.equal(mixedRuns, 1, 'untracked reads should not subscribe');
    tracked.set('tracked-b');
    assert.equal(mixed, 'tracked-b/ignored-b');
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
            writeJpegPreviewFile: async () => undefined,
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

async function main() {
    testSignals();
    await testIconLoader();
    await testFolderModeMapAssetResolution();
    testBc5DdsDecode();
    console.log('webview harness tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
