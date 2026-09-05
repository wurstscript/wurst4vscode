'use strict';

/**
 * Loads the extension's real TypeScript sources into Node, transpiled in-memory, with arbitrary
 * modules (`vscode`, CASC storage, ...) swapped for mocks.
 *
 * Shared by the fast unit harness (scripts/test-webview.js) and the Playwright e2e harness, which
 * needs it to call the *real* host-side HTML builders and message handlers without VS Code.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', '..');
// Node resolves bare specifiers relative to the *requiring* file, and this harness may be invoked
// from outside the repo (Playwright's runner, a scratch script), so resolve them against the repo.
const repoRequire = Module.createRequire(path.join(root, 'package.json'));

function resolveRelative(fromFile, request) {
    const resolved = path.resolve(path.dirname(fromFile), request);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    if (fs.existsSync(`${resolved}.ts`)) return `${resolved}.ts`;
    if (fs.existsSync(path.join(resolved, 'index.ts'))) return path.join(resolved, 'index.ts');
    return resolved;
}

function toRepoRelative(abs) {
    return path.relative(root, abs).replace(/\\/g, '/');
}

/**
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.mocks]
 *   Keyed by either a bare module specifier ('vscode') or a repo-relative path
 *   ('src/features/preview/cascStorage.ts').
 * @param {Record<string, string>} [options.augment]
 *   Extra source appended to a module before transpiling, keyed by repo-relative path. Used to
 *   re-export module-private functions for tests, so production sources keep no test-only exports.
 *   A rename on the production side surfaces as a loud ReferenceError here, which is the point.
 */
function createTsLoader(options = {}) {
    const mocks = options.mocks || {};
    const augment = options.augment || {};
    const cache = new Map();

    const load = (relPath) => {
        const abs = path.resolve(root, relPath);
        if (cache.has(abs)) return cache.get(abs).exports;

        const rel = toRepoRelative(abs);
        let src = fs.readFileSync(abs, 'utf8');
        if (Object.prototype.hasOwnProperty.call(augment, rel)) src += `\n${augment[rel]}\n`;

        const js = ts.transpileModule(src, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
            fileName: abs,
        }).outputText;

        const mod = { exports: {} };
        cache.set(abs, mod);
        const localRequire = (request) => {
            if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
            if (request.startsWith('.')) {
                const target = resolveRelative(abs, request);
                const targetRel = toRepoRelative(target);
                if (Object.prototype.hasOwnProperty.call(mocks, targetRel)) return mocks[targetRel];
                // Mirrors webpack's `asset/source` rule for stylesheets: the import is the file's text.
                if (target.endsWith('.css')) return { __esModule: true, default: fs.readFileSync(target, 'utf8') };
                return load(targetRel);
            }
            return repoRequire(request);
        };
        // Webpack collapses all of src/ into dist/extension.js, so shipped code sees `__dirname` as
        // <root>/dist regardless of which source file it was written in — which is how
        // compilerKnowledgeBase.ts resolves ../resources/wc3-knowledge-base.json. Reproduce that
        // here; using the real source directory would silently break that lookup.
        const bundleDir = rel.startsWith('src/') ? path.join(root, 'dist') : path.dirname(abs);
        new Function('exports', 'module', 'require', '__filename', '__dirname', js)(
            mod.exports, mod, localRequire, path.join(bundleDir, 'extension.js'), bundleDir,
        );
        return mod.exports;
    };

    // Exposed so a caller can reset between tests, or pre-seed a `{ exports }` entry to stub out a
    // heavy sibling module without threading it through `mocks`.
    load.cache = cache;
    return load;
}

/** Convenience for the common "no mocks, one shared cache" case. */
const sharedLoader = createTsLoader();

module.exports = { createTsLoader, sharedLoader, repoRequire, root };
