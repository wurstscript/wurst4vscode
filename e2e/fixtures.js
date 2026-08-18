'use strict';

/**
 * Playwright fixtures that put the real webview bundle in a real browser, talking to the real host.
 *
 * The bridge is deliberately thin — `acquireVsCodeApi()` in the page forwards straight to the host's
 * `onDidReceiveMessage`, and everything the host posts is replayed as a `window.postMessage`. Nothing
 * between the two is stubbed, so a broken message contract on either side fails these tests.
 */

const fs = require('fs');
const path = require('path');
const { test: base, expect } = require('@playwright/test');

const { startHarnessServer } = require('./harness/server');
const { createObjModHost } = require('./harness/objmodHost');
const { createW3iHost, createWpmHost } = require('./harness/mapEditorHosts');
const { root } = require('./harness/tsLoader');

/** Mirrors the webview API surface the shipped code uses. State lives in sessionStorage so it
 *  survives a reload the same way VS Code's per-webview state does — that's what the persistence
 *  tests reload against. */
const VSCODE_API_SHIM = `
window.__e2eOutbox = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (message) {
      var plain;
      try { plain = JSON.parse(JSON.stringify(message)); } catch (e) { plain = { type: message && message.type }; }
      window.__e2eOutbox.push(plain);
      window.__e2eToHost(plain);
    },
    getState: function () {
      try { return JSON.parse(sessionStorage.getItem('__wv_state') || 'null'); } catch (e) { return null; }
    },
    setState: function (state) {
      try { sessionStorage.setItem('__wv_state', JSON.stringify(state)); } catch (e) { /* quota */ }
      return state;
    },
  };
};
`;

/**
 * Wires a page to a host and navigates to its HTML.
 * @returns {Promise<{ pageErrors: Error[], consoleErrors: string[], gotoHtml: (html: string) => Promise<void> }>}
 */
async function attachPageToHost(page, server, host) {
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await page.exposeFunction('__e2eToHost', (message) => { host.receive(message); });
    await page.addInitScript(VSCODE_API_SHIM);

    // Serialize host->page delivery: several posts can land in the same tick (details + icons), and
    // the webview's handlers are order-sensitive.
    let chain = Promise.resolve();
    host.onPost((message) => {
        chain = chain.then(async () => {
            try {
                await page.evaluate((m) => window.postMessage(m, '*'), JSON.parse(JSON.stringify(message)));
            } catch {
                // Page closed or navigating — the real webview drops these too.
            }
        });
    });

    const gotoHtml = async (html) => {
        await page.goto(server.publish(html), { waitUntil: 'domcontentloaded' });
    };
    await gotoHtml(host.html);

    return { pageErrors, consoleErrors, gotoHtml, flush: () => chain };
}

const test = base.extend({
    // One server per worker: starting/stopping an http listener per test is pure overhead.
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument to be a destructuring pattern, even when nothing is used.
    server: [async ({}, use) => {
        const server = await startHarnessServer();
        await use(server);
        await server.close();
    }, { scope: 'worker' }],

    /** Opens the object editor. `openObjMod({ config, fixtureDir, fileName })` -> { host, ... }. */
    openObjMod: async ({ page, server }, use) => {
        const opened = [];
        await use(async (options = {}) => {
            const bundle = path.join(root, 'dist', 'webview', 'objModEditorWebview.js');
            if (!fs.existsSync(bundle)) {
                throw new Error(`Missing ${path.relative(root, bundle)} — run "npm run compile-web" before the e2e suite.`);
            }
            const host = await createObjModHost({ origin: server.origin, ...options });
            opened.push(host);
            const wiring = await attachPageToHost(page, server, host);
            const handle = { host, page, ...wiring };
            // The tree/details panel paint from a reactive effect during bundle evaluation, so by the
            // time #tree has rows the editor is genuinely interactive.
            await page.waitForSelector('#object-editor', { state: 'attached' });
            return handle;
        });
        for (const host of opened) host.dispose();
    },

    /** Opens the editable .w3i map-info editor. */
    openW3i: async ({ page, server }, use) => {
        const opened = [];
        await use(async (options = {}) => {
            const host = await createW3iHost({ origin: server.origin, ...options });
            opened.push(host);
            const wiring = await attachPageToHost(page, server, host);
            return { host, page, ...wiring };
        });
        for (const host of opened) host.dispose();
    },

    /** Opens the editable .wpm pathing-map editor. */
    openWpm: async ({ page, server }, use) => {
        const opened = [];
        await use(async (options = {}) => {
            const host = await createWpmHost({ origin: server.origin, ...options });
            opened.push(host);
            const wiring = await attachPageToHost(page, server, host);
            return { host, page, ...wiring };
        });
        for (const host of opened) host.dispose();
    },
});

module.exports = { test, expect, root };
