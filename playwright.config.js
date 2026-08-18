'use strict';

const { defineConfig, devices } = require('@playwright/test');

/**
 * Browser-level e2e for the extension's webviews.
 *
 * These run the *real* host code (via e2e/harness) and the *real* webview bundles in Chromium, with
 * VS Code itself faked. No Warcraft III install and no VS Code launch is required, so unlike the
 * `test:e2e:*:local` scripts these are safe to run in CI.
 */
module.exports = defineConfig({
    // Every spec drives a UI whose failures are almost always deterministic; a retry mostly hides
    // a real race, so surface it instead.
    retries: 0,
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    timeout: 30_000,
    expect: { timeout: 7_000 },
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'webview',
            testDir: './e2e/specs',
        },
        {
            // Real VS Code / real Warcraft III data. Opt-in via WURST_OBJMOD_E2E=1 or
            // WURST_MODEL_E2E=1 (the specs skip themselves otherwise), never run in CI, and serial
            // because each test owns an OS window and, for the clipboard specs, the OS clipboard.
            name: 'local-vscode',
            testDir: './e2e/local',
            fullyParallel: false,
            workers: 1,
            timeout: 180_000,
        },
    ],
});
