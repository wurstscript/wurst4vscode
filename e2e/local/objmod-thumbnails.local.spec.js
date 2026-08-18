'use strict';

/**
 * Model-thumbnail generation in the objmod asset browser, inside a real VS Code.
 *
 * Nothing here can move to the headless suite: the thumbnails come out of a real extension host
 * resolving assets against a local Warcraft III install, rendered by a WebGL worker. What is being
 * asserted is the *scheduling* contract from AGENTS.md — visible thumbnails drain strictly in DOM
 * order, one complete lifecycle at a time, and each warm one lands inside its budget.
 *
 * Ported from scripts/objmod-thumbnail-e2e.js.
 *
 * Knobs: WURST_OBJMOD_E2E_PROJECT / _FILE (use a real map instead of the checked-in fixture),
 * _SEARCH, _COUNT, _MAX_MS (default 200), _CODE_FILE (CodeLens asset-browser check).
 */

const path = require('path');

const { test, expect, waitFor, root, skipUnlessEnabled } = require('./fixtures');

skipUnlessEnabled();

const MAX_THUMBNAIL_MS = Number(process.env.WURST_OBJMOD_E2E_MAX_MS || 200);
const SAMPLE_COUNT = Number(process.env.WURST_OBJMOD_E2E_COUNT || 0);
const SAMPLE_LIMIT = Number.isFinite(SAMPLE_COUNT) && SAMPLE_COUNT > 0 ? SAMPLE_COUNT : Number.POSITIVE_INFINITY;
const SEARCH_QUERY = process.env.WURST_OBJMOD_E2E_SEARCH || '';
const CODE_ASSET_FILE = process.env.WURST_OBJMOD_E2E_CODE_FILE || '';

const PROJECT_PATH = process.env.WURST_OBJMOD_E2E_PROJECT || path.join(root, 'e2e');
const OBJMOD_FILE = process.env.WURST_OBJMOD_E2E_FILE || path.join(PROJECT_PATH, 'war3map.w3u');

// Measure real generation, not a cache read — otherwise the timing budget proves nothing.
const THUMB_ENV = { WURST_MODEL_THUMB_DISABLE_CACHE: '1' };

const terminalTypes = new Set(['loaded', 'missing', 'failed']);

function terminalKeys(state) {
    const terminals = new Set();
    for (const event of state.events) if (terminalTypes.has(event.type)) terminals.add(event.key);
    for (const slot of state.visible || []) if (slot.loaded || slot.missing) terminals.add(slot.key);
    return terminals;
}

function durationsByKey(events) {
    const starts = new Map();
    const out = new Map();
    for (const event of events) {
        if (event.type === 'host-start' && !starts.has(event.key)) starts.set(event.key, event.at);
        if (terminalTypes.has(event.type) && starts.has(event.key) && !out.has(event.key)) {
            out.set(event.key, event.at - starts.get(event.key));
        }
    }
    return out;
}

/** The renderer mode a thumbnail used — the first of each mode pays a one-off warm-up cost. */
function rendererModeForKey(events, key) {
    const parsed = events.find((event) => event.key === key && event.type === 'profile:worker-parsed');
    if (!parsed || !parsed.detail) return 'unknown';
    try { return JSON.parse(parsed.detail).isHD ? 'hd' : 'sd'; } catch { return 'unknown'; }
}

function describeEvent(event) {
    const phase = event.type.replace(/^profile:/, '');
    const elapsed = event.elapsedMs == null ? '' : `@${event.elapsedMs}ms`;
    const detail = event.detail ? ` ${event.detail}` : '';
    const reason = event.reason ? ` reason=${event.reason}` : '';
    return phase + elapsed + detail + reason;
}

function profileForKey(events, key) {
    return events
        .filter((event) => event.key === key &&
            (event.type === 'host-start' || event.type === 'render-start' ||
             terminalTypes.has(event.type) || event.type.startsWith('profile:')))
        .map(describeEvent);
}

async function openAssetBrowser(frame) {
    await frame.evaluate(() => window.__wurstModelThumbDebug.openModelAssetBrowser());
    if (SEARCH_QUERY) {
        await frame.evaluate((query) => window.__wurstModelThumbDebug.searchModelAssetBrowser(query), SEARCH_QUERY);
    }
}

/** A visible slot must be either pending or already finished — never idle in between. */
function idleVisibleSlots(state, visible, initialKeys) {
    const terminals = terminalKeys(state);
    return visible
        .filter((slot) => initialKeys.includes(slot.key) && !terminals.has(slot.key) && !slot.pending)
        .map((slot) => `${slot.key} was neither pending nor terminal while visible`);
}

/**
 * Watches the asset browser until every thumbnail that was visible at the start reached a terminal
 * state, recording any slot that went idle on screen along the way.
 */
async function drainVisibleThumbnails(frame, timeoutMs) {
    let initialKeys = [];
    const violations = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await frame.evaluate(() => window.__wurstModelThumbDebug.state());
        const visible = state.visible.filter((slot) => slot.visible).slice(0, SAMPLE_LIMIT);
        if (!initialKeys.length && visible.length >= Math.min(SAMPLE_LIMIT, 8)) {
            initialKeys = visible.map((slot) => slot.key);
        }
        if (initialKeys.length) {
            violations.push(...idleVisibleSlots(state, visible, initialKeys));
            const terminals = terminalKeys(state);
            if (initialKeys.every((key) => terminals.has(key))) return { state, initialKeys, violations };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out draining thumbnails (observed ${initialKeys.length} visible slots).`);
}

test.describe('objmod model thumbnails', () => {
    test.slow();

    test('visible thumbnails finish in DOM order, one lifecycle at a time', async ({ openVsCode }) => {
        const session = await openVsCode({ projectPath: PROJECT_PATH, files: [OBJMOD_FILE], env: THUMB_ENV });
        const frame = await session.waitForFrame(() => !!window.__wurstModelThumbDebug, 'the objmod webview');
        await openAssetBrowser(frame);

        const { state, initialKeys, violations } = await drainVisibleThumbnails(frame, 90000);

        expect(violations, violations.join('\n')).toEqual([]);

        const terminalOrder = [];
        const seen = new Set();
        for (const event of state.events) {
            if (!terminalTypes.has(event.type) || !initialKeys.includes(event.key) || seen.has(event.key)) continue;
            seen.add(event.key);
            terminalOrder.push(event.key);
        }
        expect(terminalOrder.slice(0, initialKeys.length), 'terminal order must match visible DOM order')
            .toEqual(initialKeys);
    });

    test('every visible thumbnail renders, and warm ones stay inside the time budget', async ({ openVsCode }) => {
        const session = await openVsCode({ projectPath: PROJECT_PATH, files: [OBJMOD_FILE], env: THUMB_ENV });
        const frame = await session.waitForFrame(() => !!window.__wurstModelThumbDebug, 'the objmod webview');
        await openAssetBrowser(frame);

        const { state, initialKeys } = await drainVisibleThumbnails(frame, 90000);
        expect(state.worker && state.worker.state, 'the thumbnail worker should have started').toBe('ready');

        const bySlot = new Map(state.visible.map((slot) => [slot.key, slot]));
        const notRendered = initialKeys.filter((key) => !(bySlot.get(key) || {}).loaded);
        expect(notRendered.map((key) => `${key}: ${JSON.stringify(profileForKey(state.events, key))}`)).toEqual([]);

        // The first thumbnail of each renderer mode pays a one-off warm-up, so it is excluded from
        // the per-thumbnail budget rather than being allowed to hide a regression in the rest.
        const warmupKeys = new Set();
        const warmedModes = new Set();
        for (const key of initialKeys) {
            if (!state.events.some((event) => event.key === key && event.type === 'render-start')) continue;
            const mode = rendererModeForKey(state.events, key);
            if (warmedModes.has(mode)) continue;
            warmedModes.add(mode);
            warmupKeys.add(key);
        }

        const durations = durationsByKey(state.events);
        const overBudget = [];
        for (const key of initialKeys.filter((key) => !warmupKeys.has(key))) {
            const ms = durations.get(key);
            if (typeof ms !== 'number') overBudget.push(`${key}: missing duration`);
            else if (ms > MAX_THUMBNAIL_MS) overBudget.push(`${key}: ${ms}ms exceeded the ${MAX_THUMBNAIL_MS}ms budget`);
        }
        expect(overBudget, overBudget.join('\n')).toEqual([]);
    });

    test('iconless model objects use thumbnail slots rather than inert placeholders', async ({ objmodFrame }) => {
        const { frame } = objmodFrame;
        const state = await waitFor(
            () => frame.evaluate(() => window.__wurstModelThumbDebug.state()),
            (value) => !!value,
            'objmod editor state',
        );
        expect(state.inert3dPlaceholders).toBe(0);
    });

    test('the narrow layout keeps both panes usable and unforcing it restores side-by-side', async ({ objmodFrame }) => {
        const { frame } = objmodFrame;
        await frame.evaluate(() => window.__wurstModelThumbDebug.forceNarrowLayout(true));
        const stacked = await waitFor(
            () => frame.evaluate(() => window.__wurstModelThumbDebug.layout()),
            (value) => value && value.listVisible && value.detailsVisible && value.stacked,
            'the stacked narrow layout',
        );
        expect(stacked.details.height).toBeGreaterThanOrEqual(200);

        await frame.evaluate(() => window.__wurstModelThumbDebug.forceNarrowLayout(false));
        const sideBySide = await waitFor(
            () => frame.evaluate(() => window.__wurstModelThumbDebug.layout()),
            (value) => value && value.listVisible && value.detailsVisible && !value.stacked,
            'the side-by-side layout',
        );
        expect(sideBySide.list.right).toBeLessThanOrEqual(sideBySide.details.left + 8);
        expect(sideBySide.list.width).toBeLessThanOrEqual(sideBySide.editor.width * 0.5);
    });

    test('both sibling object files are reported in the header', async ({ objmodFrame }) => {
        const { frame } = objmodFrame;
        const state = await waitFor(
            () => frame.evaluate(() => window.__wurstModelThumbDebug.state()),
            (value) => value && value.fileInfo,
            'objmod file info',
        );
        expect(state.fileInfo.mainName).toBe('war3map.w3a');
        expect(state.fileInfo.skinName).toBe('war3mapSkin.w3a');
    });

    test('a "Browse model" CodeLens opens the asset browser with relevance-sorted results', async ({ openVsCode }) => {
        // Without an override, the generated fixture supplies its own AssetBrowserE2e.wurst.
        const session = CODE_ASSET_FILE
            ? await openVsCode({ projectPath: PROJECT_PATH, files: [CODE_ASSET_FILE], env: THUMB_ENV })
            : await openVsCode({ openCodeFile: true, env: THUMB_ENV });
        const workbench = await session.workbenchPage();
        session.bringToForeground();
        await workbench.bringToFront().catch(() => undefined);

        // The clickable region is the anchor inside the decoration, not the decoration box itself —
        // a centre-click on the container lands beside it and silently does nothing.
        const lens = workbench.locator('.codelens-decoration a', { hasText: 'Browse model' }).first();
        await lens.waitFor({ state: 'visible', timeout: 60000 });
        await lens.click();

        const browser = await session.waitForFrame(
            () => !!window.__wurstCodeAssetBrowserDebug,
            'the CodeLens-launched asset browser',
            30000,
        );
        await browser.evaluate(() => window.__wurstCodeAssetBrowserDebug.search('footman'));
        const state = await waitFor(
            () => browser.evaluate(() => window.__wurstCodeAssetBrowserDebug.state()),
            (value) => value && value.query === 'footman' && Array.isArray(value.results) && value.results.length > 0,
            'footman asset search results',
        );

        expect(state.activeTab, 'a model string should open the Models tab').toBe('model');
        expect(state.results.some((entry) => /footman/i.test(`${entry.label} ${entry.value}`))).toBe(true);
        // Fuzzy matching must not drag in unrelated results just because they share a few letters.
        expect(state.results.filter((entry) => !/footm[ae]n/i.test(`${entry.label} ${entry.value}`))).toEqual([]);
        for (let i = 1; i < state.results.length; i++) {
            expect(state.results[i - 1].score).toBeLessThanOrEqual(state.results[i].score);
        }
    });
});
