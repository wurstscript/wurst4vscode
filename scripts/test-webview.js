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
    assert.ok(languageServer.includes('void maybeOfferUpdate(context)'), 'update checks should still run in the background');
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
    assert.ok(render, 'uncached model thumbnails should ask the webview to render, even for large models');
    assert.equal(render.skipTextures, undefined, 'model thumbnail renders must load textures by default');
    assert.ok(render.mdxBase64, 'model bytes should still be sent for thumbnail rendering');
    assert.ok(
        !posted.some((message) => message.type === 'modelThumbMissing' && message.reason === 'too-large'),
        'large resolved models must not be skipped before thumbnail rendering'
    );
}

function testAssetBrowserForwardsModelTextures() {
    const src = fs.readFileSync(path.join(root, 'src/features/assetLinks.ts'), 'utf8');
    const match = src.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>`/);
    assert.ok(match, 'asset browser inline script should be present');
    const script = match[1].replace(
        'var initial = ${initialJson};',
        "var initial = { activeTab: 'model', tabs: { icon: [], model: [] }, currentValue: '' };"
    );
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
        !/type === 'requestTextures'\)\s*return/.test(script),
        'asset browser must not silently drop model texture requests'
    );
}

function testNoThumbnailTimingFallbacks() {
    const host = fs.readFileSync(path.join(root, 'src/features/preview/modelPreviewHost.ts'), 'utf8');
    const objmod = fs.readFileSync(path.join(root, 'src/webview/objModEditorWebview.ts'), 'utf8');
    const assetLinks = fs.readFileSync(path.join(root, 'src/features/assetLinks.ts'), 'utf8');
    const objmodE2e = fs.readFileSync(path.join(root, 'scripts/objmod-thumbnail-e2e.js'), 'utf8');
    const modelE2e = fs.readFileSync(path.join(root, 'scripts/model-thumbnail-e2e.js'), 'utf8');

    assert.ok(!host.includes('WURST_MODEL_THUMB_MAX_MODEL_BYTES'), 'thumbnail host must not expose a size cutoff for rendering');
    assert.ok(!host.includes('too-large'), 'thumbnail host must not skip large models');
    assert.ok(!host.includes('bad-cache-hit'), 'thumbnail host must not suppress retries based on old failures');
    assert.ok(!objmod.includes('TEXTURE_WAIT_RETRIES'), 'objmod thumbnails must wait for texture completion instead of retry-budget capture');
    assert.ok(!objmod.includes('texture-wait-timeout'), 'objmod thumbnails must not fail because texture loading took too long');
    assert.ok(!objmod.includes('texture-failed'), 'objmod thumbnails must not become question marks just because a texture reply was missing/unsupported');
    assert.ok(!objmod.includes('MODEL_THUMB_RENDER_TIMEOUT'), 'objmod thumbnails must not have a render timeout fallback');
    assert.ok(!objmod.includes('MODEL_THUMB_MAX_QUEUE'), 'objmod thumbnails must not drop queued renders because of a fixed queue budget');
    assert.ok(!assetLinks.includes('TEXTURE_WAIT_RETRIES'), 'asset picker thumbnails must wait for texture completion instead of retry-budget capture');
    assert.ok(!objmodE2e.includes('WURST_OBJMOD_E2E_MAX_MS'), 'objmod thumbnail e2e must not enforce a per-thumbnail timing budget');
    assert.ok(!modelE2e.includes('WURST_MODEL_THUMB_MAX_MS'), 'model thumbnail e2e must not enforce a per-thumbnail timing budget');
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

async function main() {
    testSignals();
    await testIconLoader();
    await testFolderModeMapAssetResolution();
    testBc5DdsDecode();
    testInstallerVersionShaParsing();
    testNonBlockingStartupAndForcedReinstallWiring();
    testWurstProcessMatching();
    await testModelThumbnailRequestsTexturesByDefault();
    testAssetBrowserForwardsModelTextures();
    testNoThumbnailTimingFallbacks();
    testStaticMdxWithoutSequences();
    await testIssueReportingPrivacyAndDeduplication();
    testObjModSaveCommitsFocusedEditor();
    console.log('webview harness tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
