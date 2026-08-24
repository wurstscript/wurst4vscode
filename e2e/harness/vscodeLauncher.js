'use strict';

/**
 * Launches a real VS Code with this extension loaded and attaches Playwright to it over CDP.
 *
 * This replaces the hand-rolled DevTools WebSocket client, target tracking and execution-context
 * bookkeeping the local e2e scripts used to carry: Playwright's `connectOverCDP` already attaches to
 * every target, and webviews surface as ordinary frames, so "find the objmod webview" is a frame
 * search instead of a Target/Runtime protocol dance.
 *
 * Local-only by nature — it needs an installed VS Code (and, for the thumbnail suites, a Warcraft III
 * install), so nothing here runs in CI.
 */

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { chromium } = require('@playwright/test');

const { root } = require('./tsLoader');

function codeCandidates() {
    const explicit = process.env.WURST_OBJMOD_E2E_CODE;
    const candidates = explicit ? [explicit] : [];
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const programFiles = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
        candidates.push(
            path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
            path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
            ...programFiles.map((dir) => path.join(dir, 'Microsoft VS Code', 'bin', 'code.cmd')),
            ...programFiles.map((dir) => path.join(dir, 'Microsoft VS Code', 'Code.exe')),
        );
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
    } else {
        candidates.push('code', 'code-insiders');
    }
    if (!explicit && process.env.VSCODE_PATH) candidates.push(process.env.VSCODE_PATH);
    return candidates;
}

function findCode() {
    // The `code.cmd` shim re-execs and detaches, which loses the remote-debugging port, so prefer the
    // executable sitting next to it.
    if (process.platform === 'win32' && !process.env.WURST_OBJMOD_E2E_CODE) {
        const localShim = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
        const localExe = path.resolve(path.dirname(localShim), '..', 'Code.exe');
        if (fs.existsSync(localExe)) return localExe;
    }
    for (const candidate of codeCandidates()) {
        if (!candidate) continue;
        const clean = String(candidate).replace(/^['"]|['"]$/g, '');
        const normalized = /(?:^|[\\/])code\.cmd$/i.test(clean)
            ? path.resolve(path.dirname(clean), '..', 'Code.exe')
            : clean;
        if (normalized.includes(path.sep) && !fs.existsSync(normalized)) continue;
        return normalized;
    }
    throw new Error('Could not find VS Code. Set WURST_OBJMOD_E2E_CODE.');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = '';
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error(`Timed out requesting ${url}`)));
    });
}

async function waitForDevtools(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        for (const host of ['127.0.0.1', 'localhost']) {
            try {
                const version = await requestJson(`http://${host}:${port}/json/version`);
                if (version && version.webSocketDebuggerUrl) return `http://${host}:${port}`;
            } catch (error) { lastError = error; }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for VS Code DevTools on port ${port}: ${lastError && lastError.message}`);
}

/**
 * VS Code's own window has to be the OS foreground window for clipboard keystrokes to work:
 * Chromium refuses copy/cut when `document.hasFocus()` is false, so a background window silently
 * turns Ctrl+C into a no-op and a later Ctrl+V pastes whatever was already on the clipboard.
 *
 * The script matches windows by looking for the needle in the process command line, which is why the
 * unique temp user-data-dir is what gets passed.
 */
function bringWindowToForeground(userDataDir) {
    if (process.platform !== 'win32') return '';
    const script = path.join(root, 'scripts', 'bring-to-foreground.ps1');
    if (!fs.existsSync(script)) return '';
    try {
        return String(childProcess.execFileSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Needle', userDataDir],
            { encoding: 'utf8', windowsHide: true, timeout: 10000 },
        )).trim();
    } catch {
        return '';
    }
}

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') {
            childProcess.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch { /* already gone */ }
}

/**
 * Every binary format this extension owns a custom editor for.
 *
 * Passing such a file on the command line opens it in whichever editor VS Code considers default at
 * that moment — and on a cold `--extensionDevelopmentPath` start the extension host has usually not
 * registered its custom editors yet, so the file lands in the *text* editor ("the file is not
 * displayed... because it is either binary") and no webview is ever created. Pinning the association
 * up front makes the custom editor win regardless of activation timing.
 */
const EDITOR_ASSOCIATIONS = {
    '*.w3u': 'wurst.objModPreview',
    '*.w3t': 'wurst.objModPreview',
    '*.w3a': 'wurst.objModPreview',
    '*.w3b': 'wurst.objModPreview',
    '*.w3d': 'wurst.objModPreview',
    '*.w3h': 'wurst.objModPreview',
    '*.w3q': 'wurst.objModPreview',
    '*.w3i': 'wurst.w3iEditor',
    '*.wpm': 'wurst.wpmPreview',
    '*.mmp': 'wurst.mmpEditor',
    '*.w3c': 'wurst.w3cEditor',
    '*.w3r': 'wurst.w3rEditor',
};

function writeUserSettings(userDataDir, settings) {
    const dir = path.join(userDataDir, 'User');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
        'workbench.editorAssociations': EDITOR_ASSOCIATIONS,
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'extensions.autoUpdate': false,
        ...settings,
    }, null, 2));
}

/**
 * @param {object} opts
 * @param {string} opts.projectPath  Folder to open as the workspace.
 * @param {string[]} [opts.files]    Files to open in editors.
 * @param {Record<string,unknown>} [opts.settings]  Extra user settings.
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeoutMs]
 */
async function launchVsCode(opts) {
    const timeoutMs = opts.timeoutMs || Number(process.env.WURST_OBJMOD_E2E_TIMEOUT_MS || 60000);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-e2e-user-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-e2e-ext-'));
    writeUserSettings(userDataDir, opts.settings);
    const code = findCode();
    const port = Number(process.env.WURST_OBJMOD_E2E_DEBUG_PORT || await freePort());

    const env = { ...process.env, ...(opts.env || {}) };
    delete env.ELECTRON_RUN_AS_NODE;

    const args = [
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--disable-workspace-trust',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--extensionDevelopmentPath=${root}`,
        opts.projectPath,
        ...(opts.files || []),
    ];

    const child = /\.cmd$/i.test(code)
        ? childProcess.spawn('cmd.exe', ['/d', '/c', code, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] })
        : childProcess.spawn(code, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-8000);
    });

    let browser;
    try {
        const endpoint = await waitForDevtools(port, timeoutMs);
        browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
        killTree(child);
        throw new Error(`${error.message}\n--- VS Code stderr ---\n${stderr}`);
    }

    const session = {
        browser,
        userDataDir,
        extensionsDir,
        get stderr() { return stderr; },
        bringToForeground: () => bringWindowToForeground(userDataDir),

        /** Every frame across every attached page — webviews included. */
        allFrames() {
            return browser.contexts().flatMap((context) => context.pages()).flatMap((page) => page.frames());
        },

        /** The workbench page (the one hosting the VS Code UI itself). */
        async workbenchPage() {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                for (const page of browser.contexts().flatMap((context) => context.pages())) {
                    const isWorkbench = await page.evaluate(() => !!document.querySelector('.monaco-workbench'))
                        .catch(() => false);
                    if (isWorkbench) return page;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            throw new Error('Timed out waiting for the VS Code workbench page.');
        },

        /**
         * Waits for the frame in which `predicate` evaluates truthy. Used to find a specific webview
         * by a marker it installs on `window` (e.g. the objmod editor's debug hook).
         */
        async waitForFrame(predicate, description, waitMs = timeoutMs) {
            const deadline = Date.now() + waitMs;
            while (Date.now() < deadline) {
                for (const frame of session.allFrames()) {
                    const found = await frame.evaluate(predicate).catch(() => false);
                    if (found) return frame;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
            }
            const seen = session.allFrames().map((frame) => frame.url()).join('\n  ');
            throw new Error(`Timed out waiting for ${description}. Frames:\n  ${seen}`);
        },

        async close() {
            await browser.close().catch(() => undefined);
            killTree(child);
            for (const dir of [userDataDir, extensionsDir]) {
                try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* locked */ }
            }
        },
    };

    return session;
}

/** Polls `fn` until `predicate` passes, then returns the value. */
async function waitFor(fn, predicate, description, waitMs = 15000) {
    const deadline = Date.now() + waitMs;
    let last;
    while (Date.now() < deadline) {
        last = await fn().catch(() => undefined);
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(last)}`);
}

module.exports = { launchVsCode, waitFor };
