'use strict';

/**
 * Fixtures for the local-only suite that drives a real VS Code window.
 *
 * These need an installed VS Code (and, for thumbnails, a Warcraft III install), so they are opt-in:
 * set WURST_OBJMOD_E2E=1. Without it every spec here skips rather than failing, which is what keeps
 * the suite safe to leave wired into the repo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { test: base, expect } = require('@playwright/test');

const { launchVsCode, waitFor } = require('../harness/vscodeLauncher');
const { repoRequire, root } = require('../harness/tsLoader');

const enabled = process.env.WURST_OBJMOD_E2E === '1' || process.env.WURST_LOCAL_E2E === '1';

/** A colour-coded value is what routes a field through the rich tooltip editor (needsColorEditor). */
const CLIPBOARD_TEST_VALUE = '|cffffcc00Copy Paste Test|r';

/**
 * Writes a self-contained Wurst project: a main + skin ability pair (so the header has both
 * siblings to report), a colour-coded name to exercise the rich tooltip editor, imported models for
 * the asset browser to thumbnail, and a .wurst file whose model string carries a "Browse model"
 * CodeLens.
 */
function writeAbilityFixture() {
    const { serializeObjMod } = repoRequire('casc-ts/formats');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-e2e-objmod-fixture-'));
    fs.writeFileSync(path.join(dir, 'wurst.build'), 'projectName = wurst-local-e2e\n');

    // Real model bytes, not placeholder text — the asset browser has to actually parse and render
    // these, and fake bytes would only ever produce a "missing" thumbnail.
    const importedModels = path.join(dir, 'imports', 'units');
    fs.mkdirSync(importedModels, { recursive: true });
    const modelFixture = path.join(root, 'wc3data', 'melon.mdx');
    if (!fs.existsSync(modelFixture)) throw new Error(`Missing model fixture: ${modelFixture}`);
    for (const name of ['Footman.mdx', 'FootmanPortrait.mdx', 'CaptainFootman.mdx', 'confirmation.mdx', 'AltarOfKings.mdx']) {
        fs.copyFileSync(modelFixture, path.join(importedModels, name));
    }

    const localFont = process.env.WURST_OBJMOD_E2E_FONT;
    if (localFont) {
        if (!fs.existsSync(localFont)) throw new Error(`WURST_OBJMOD_E2E_FONT does not exist: ${localFont}`);
        fs.copyFileSync(localFont, path.join(dir, 'tooltip-e2e.ttf'));
        fs.mkdirSync(path.join(dir, '.vscode'));
        fs.writeFileSync(
            path.join(dir, '.vscode', 'settings.json'),
            JSON.stringify({ 'wurst.objModTooltipFont': 'tooltip-e2e.ttf' }),
        );
    }

    const mod = (fieldId, value) => ({ fieldId, varType: 'string', level: 0, dataPt: 0, value, endToken: '\0\0\0\0' });
    fs.writeFileSync(path.join(dir, 'war3map.w3a'), serializeObjMod({
        version: 3,
        ext: '.w3a',
        extended: true,
        origObjs: [{ baseId: 'Ahrp', newId: null, mods: [mod('anam', 'Repair E2E Override')] }],
        customObjs: [{ baseId: 'Ahrp', newId: 'Z001', mods: [mod('anam', CLIPBOARD_TEST_VALUE)] }],
    }));
    fs.writeFileSync(path.join(dir, 'war3mapSkin.w3a'), serializeObjMod({
        version: 3,
        ext: '.w3a',
        extended: true,
        origObjs: [{ baseId: 'Ahrp', newId: null, mods: [mod('aart', 'ReplaceableTextures\\CommandButtons\\BTNRepair.blp')] }],
        customObjs: [],
    }));

    const codeFile = path.join(dir, 'AssetBrowserE2e.wurst');
    fs.writeFileSync(codeFile, 'package AssetBrowserE2e\n\nconstant TEST_MODEL = "imports\\\\units\\\\Footman.mdx"\n');
    return { dir, file: path.join(dir, 'war3map.w3a'), codeFile };
}

const test = base.extend({
    /**
     * `openVsCode({ projectPath, files, env })` launches VS Code and returns the attached session.
     * Everything it opens is torn down after the test, including the temp profile directories.
     */
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument to be a destructuring pattern, even when nothing is used.
    openVsCode: async ({}, use) => {
        const sessions = [];
        const fixtures = [];
        await use(async (options = {}) => {
            let { projectPath, files } = options;
            let codeFile;
            if (!projectPath) {
                const generated = writeAbilityFixture();
                fixtures.push(generated.dir);
                projectPath = generated.dir;
                codeFile = generated.codeFile;
                files = files || (options.openCodeFile ? [generated.codeFile] : [generated.file]);
            }
            const session = await launchVsCode({ projectPath, files, env: options.env });
            sessions.push(session);
            return Object.assign(session, { projectPath, files, codeFile });
        });
        for (const session of sessions) await session.close();
        for (const dir of fixtures) {
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* locked */ }
        }
    },

    /** The objmod editor webview frame in a freshly launched VS Code. */
    objmodFrame: async ({ openVsCode }, use) => {
        const session = await openVsCode();
        const frame = await session.waitForFrame(
            () => !!window.__wurstModelThumbDebug,
            'the objmod editor webview debug hook',
        );
        await use({ frame, session });
    },
});

/**
 * Every spec file must call this at top level. A `test.beforeEach` registered here instead would
 * only attach to whichever spec file imported this module first, silently leaving the others to
 * launch VS Code on an ordinary test run.
 */
function skipUnlessEnabled() {
    test.skip(!enabled, 'local VS Code e2e is opt-in — set WURST_OBJMOD_E2E=1 to run it');
}

module.exports = { test, expect, waitFor, root, enabled, skipUnlessEnabled, CLIPBOARD_TEST_VALUE };
