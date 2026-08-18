'use strict';

/**
 * MDX model-thumbnail render benchmark: loads dist/webview/mdxViewer.js into a real browser, renders
 * a deterministic still frame per fixture, and checks the result is neither blank nor black — plus an
 * optional pixel-hash snapshot so a silent rendering change is caught.
 *
 * Local-only because the interesting fixtures are models from a Warcraft III install; the checked-in
 * war3-model fixture is the default so it can still run without one.
 *
 * Ported from scripts/model-thumbnail-e2e.js. Knobs: WURST_MODEL_BENCH_MODELS,
 * WURST_MODEL_TEXTURE_ROOTS, WURST_MODEL_SNAPSHOT_FILE, WURST_MODEL_UPDATE_SNAPSHOTS.
 */

const fs = require('fs');
const path = require('path');

const { test, expect } = require('@playwright/test');

const { startHarnessServer } = require('../harness/server');
const { root } = require('../harness/tsLoader');
const {
    BENCH_PAGE_HTML, SNAPSHOT_FILE, buildFixtures, resolveModelPaths,
    runModelBench, readSnapshots, writeSnapshots,
} = require('../harness/modelBench');

const enabled = process.env.WURST_MODEL_E2E === '1' || process.env.WURST_LOCAL_E2E === '1';
const perModelTimeoutMs = Number(process.env.WURST_MODEL_E2E_MODEL_TIMEOUT_MS || 15000);
const updateSnapshots = process.env.WURST_MODEL_UPDATE_SNAPSHOTS === '1';

test.skip(!enabled, 'local model e2e is opt-in — set WURST_MODEL_E2E=1 to run it');

test.describe('mdx model thumbnail rendering', () => {
    test.slow();

    /** @type {{ results: any[] }} */
    let bench;

    test.beforeAll(async ({ browser }) => {
        const models = resolveModelPaths();
        expect(models.length, 'no model fixtures found — set WURST_MODEL_BENCH_MODELS').toBeGreaterThan(0);
        expect(
            fs.existsSync(path.join(root, 'dist', 'webview', 'mdxViewer.js')),
            'missing dist/webview/mdxViewer.js — run npm run compile-web first',
        ).toBe(true);

        const server = await startHarnessServer();
        const page = await browser.newPage();
        try {
            await page.goto(server.publish(BENCH_PAGE_HTML), { waitUntil: 'load' });
            await page.waitForFunction(() => !!window.War3Viewer, null, { timeout: 20000 });
            const fixtures = buildFixtures(models);
            const results = await page.evaluate(runModelBench, { fixtures, timeoutMs: perModelTimeoutMs });
            bench = { results };
            if (updateSnapshots) writeSnapshots(results);
            for (const result of results) {
                console.log(
                    `${result.warmup ? 'warmup' : 'bench '} ${result.name}: total=${result.totalMs.toFixed(1)}ms ` +
                    `load=${result.loadMs.toFixed(1)}ms textures=${result.textureMs.toFixed(1)}ms render=${result.renderMs.toFixed(1)}ms ` +
                    `visible=${result.visiblePixels} tex=${result.loadedTextures}/${result.requestedTextures} hash=${result.snapshotHash}` +
                    (result.missingTextures.length ? ` missing=${result.missingTextures.join(',')}` : ''),
                );
            }
        } finally {
            await page.close();
            await server.close();
        }
    });

    test('every fixture renders something visible', () => {
        const blank = bench.results
            .filter((result) => !result.warmup && result.visiblePixels < 24)
            .map((result) => `${result.name}: ${result.visiblePixels} visible pixels, ${result.alphaPixels} alpha pixels`);
        expect(blank, blank.join('\n')).toEqual([]);
    });

    test('no fixture renders as an all-but-black square', () => {
        // A model that loads but never gets lit produces a technically non-blank, useless thumbnail.
        const dark = bench.results
            .filter((result) => !result.warmup && result.avgLuma < 3 && result.maxLuma < 16)
            .map((result) => `${result.name}: avg=${result.avgLuma.toFixed(1)} max=${result.maxLuma.toFixed(1)}`);
        expect(dark, dark.join('\n')).toEqual([]);
    });

    test('rendered pixels match the snapshot baseline', () => {
        const snapshots = readSnapshots();
        test.skip(
            !Object.keys(snapshots).length,
            `no snapshot baseline at ${SNAPSHOT_FILE} — set WURST_MODEL_UPDATE_SNAPSHOTS=1 to create one`,
        );
        const changed = bench.results
            .filter((result) => !result.warmup && snapshots[result.name])
            .filter((result) => snapshots[result.name].snapshotHash !== result.snapshotHash)
            .map((result) => `${result.name}: ${snapshots[result.name].snapshotHash} -> ${result.snapshotHash}`);
        expect(changed, changed.join('\n')).toEqual([]);
    });

    test('every texture a fixture asks for is one the harness could supply', () => {
        // A missing texture is not necessarily a bug (stock game paths need a WC3 install), so this
        // only fails when the model's own directory should have covered it.
        const missing = bench.results
            .filter((result) => !result.warmup && result.missingTextures.length && result.loadedTextures === 0)
            .map((result) => `${result.name}: no textures resolved (${result.missingTextures.join(', ')})`);
        expect(missing, missing.join('\n')).toEqual([]);
    });
});
