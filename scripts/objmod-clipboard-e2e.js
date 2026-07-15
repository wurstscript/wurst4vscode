'use strict';

/**
 * Local-only VS Code extension e2e for the objmod tooltip editor's copy/cut/paste.
 *
 * Enable explicitly, never in CI:
 *   $env:WURST_OBJMOD_E2E='1'
 *   npm run test:e2e:objmod-clipboard:local
 *
 * Unlike the other e2e scripts here, this one dispatches *real* OS-trusted keystrokes via CDP's
 * Input.dispatchKeyEvent — document.execCommand('copy'/'cut') silently no-ops for a script-synthesized
 * event with no user gesture behind it, so calling debug-hook functions alone (as the thumbnail e2e
 * does) can't actually prove copy/cut/paste works; it can only prove the DOM/selection state is right.
 *
 * Optional knobs:
 *   WURST_OBJMOD_E2E_CODE       Code.exe path, if it cannot be found
 *   WURST_OBJMOD_E2E_TIMEOUT_MS total wait timeout, default 45000
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const enabled = process.env.WURST_OBJMOD_E2E === '1' || process.env.WURST_LOCAL_E2E === '1';

if (!enabled) {
    console.log('local objmod clipboard e2e skipped (set WURST_OBJMOD_E2E=1 to enable)');
    process.exit(0);
}

if (typeof WebSocket !== 'function') {
    throw new Error('This harness needs Node with global WebSocket support (Node 22+).');
}

const timeoutMs = Number(process.env.WURST_OBJMOD_E2E_TIMEOUT_MS || 45000);

function log(message) {
    console.log(`[objmod-clipboard-e2e] ${message}`);
}

// A color-coded value (not just a "tooltip"-labelled field) is what actually routes this field
// through the rich tooltip editor (see needsColorEditor in fieldDisplay.ts) — using the Name field
// keeps this fixture minimal instead of having to know a real ability's tooltip field id.
const CLIPBOARD_TEST_VALUE = '|cffffcc00Copy Paste Test|r';

function writeGeneratedObjmodFixture() {
    const { serializeObjMod } = require('casc-ts/formats');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-objmod-clip-fixture-'));
    fs.writeFileSync(path.join(dir, 'wurst.build'), 'projectName = objmod-clipboard-e2e\n');
    const main = {
        version: 3,
        ext: '.w3a',
        extended: true,
        origObjs: [{
            baseId: 'Ahrp',
            newId: null,
            mods: [
                { fieldId: 'anam', varType: 'string', level: 0, dataPt: 0, value: 'Repair E2E Override', endToken: '\0\0\0\0' },
            ],
        }],
        customObjs: [{
            baseId: 'Ahrp',
            newId: 'Z001',
            mods: [
                { fieldId: 'anam', varType: 'string', level: 0, dataPt: 0, value: CLIPBOARD_TEST_VALUE, endToken: '\0\0\0\0' },
            ],
        }],
    };
    const skin = {
        version: 3,
        ext: '.w3a',
        extended: true,
        origObjs: [{
            baseId: 'Ahrp',
            newId: null,
            mods: [
                { fieldId: 'aart', varType: 'string', level: 0, dataPt: 0, value: 'ReplaceableTextures\\CommandButtons\\BTNRepair.blp', endToken: '\0\0\0\0' },
            ],
        }],
        customObjs: [],
    };
    fs.writeFileSync(path.join(dir, 'war3map.w3a'), serializeObjMod(main));
    fs.writeFileSync(path.join(dir, 'war3mapSkin.w3a'), serializeObjMod(skin));
    return { dir, file: path.join(dir, 'war3map.w3a') };
}

const generated = writeGeneratedObjmodFixture();
const projectPath = generated.dir;
const objmodFile = generated.file;

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

function spawnCode(code, args, childEnv) {
    if (process.platform === 'win32' && /\.cmd$/i.test(code)) {
        return childProcess.spawn('cmd.exe', ['/d', '/c', code, ...args], {
            env: childEnv,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
    }
    return childProcess.spawn(code, args, {
        env: childEnv,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
    });
}

function waitForExit(child, waitMs = 5000) {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

// CDP's Page.bringToFront only reorders Chromium's own internal compositing/target activation; it does
// not call the Win32 SetForegroundWindow the OS actually uses to decide which window receives real
// keyboard input. Without this, VS Code's keybinding service silently ignores every CDP-dispatched
// keystroke (Ctrl+Shift+P, Ctrl+C, ...) because the BrowserWindow never became the real foreground
// window — whatever window the calling terminal/IDE last had focus on stays in front.
function bringVsCodeWindowToForeground(userDataDir) {
    if (process.platform !== 'win32') return;
    const result = childProcess.spawnSync('powershell.exe', [
        '-NoProfile',
        '-File', path.join(__dirname, 'bring-to-foreground.ps1'),
        '-Needle', userDataDir,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (process.env.WURST_E2E_VERBOSE === '1') {
        const stderrSuffix = result.stderr ? ' stderr=' + result.stderr.trim() : '';
        console.log(`[verbose] bringVsCodeWindowToForeground: ${(result.stdout || '').trim() || '(no matching window)'}${stderrSuffix}`);
    }
}

function windowsCodePidsForUserDataDir(userDataDir) {
    if (process.platform !== 'win32' || !userDataDir) return [];
    const result = childProcess.spawnSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        '$needle=$env:WURST_E2E_USER_DATA_DIR; ' +
            'Get-CimInstance Win32_Process -Filter "name = \'Code.exe\'" | ' +
            'Where-Object { $_.CommandLine -like "*$needle*" } | ' +
            'ForEach-Object { $_.ProcessId }',
    ], {
        env: { ...process.env, WURST_E2E_USER_DATA_DIR: userDataDir },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
    });
    if (result.status !== 0) return [];
    return result.stdout
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForNoWindowsCodeProfile(userDataDir, waitMs = 5000) {
    if (process.platform !== 'win32') return;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        if (!windowsCodePidsForUserDataDir(userDataDir).length) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
async function killProcessTree(child, userDataDir) {
    if (process.platform === 'win32') {
        const pids = new Set(windowsCodePidsForUserDataDir(userDataDir));
        if (child?.pid && child.exitCode == null && child.signalCode == null) pids.add(child.pid);
        for (const pid of pids) {
            childProcess.spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 10000,
            });
        }
        await waitForNoWindowsCodeProfile(userDataDir);
    } else {
        if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        await waitForExit(child, 2000);
        if (child.exitCode == null && child.signalCode == null) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
    }
    await waitForExit(child, 5000);
}

function cleanupTempDir(dir) {
    if (!dir || !path.resolve(dir).startsWith(os.tmpdir())) return;
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
            });
        }).on('error', reject);
    });
}

async function requestFirstJson(urls) {
    let lastError;
    for (const url of urls) {
        try {
            return await requestJson(url);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('No DevTools URL candidates.');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForDevtoolsHttp(port) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const version = await requestFirstJson([
                `http://127.0.0.1:${port}/json/version`,
                `http://localhost:${port}/json/version`,
            ]);
            if (version && version.webSocketDebuggerUrl) return version;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Timed out waiting for VS Code DevTools on port ${port}.`);
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id) {
                const pending = this.pending.get(msg.id);
                if (!pending) return;
                this.pending.delete(msg.id);
                if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else pending.resolve(msg.result);
                return;
            }
            const listeners = this.listeners.get(msg.method) || [];
            for (const listener of listeners) listener(msg.params || {}, msg.sessionId || '');
        };
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out connecting to DevTools WebSocket: ${this.wsUrl}`)), 10000);
            this.ws.onopen = () => {
                clearTimeout(timer);
                resolve();
            };
            this.ws.onerror = (event) => {
                clearTimeout(timer);
                reject(event instanceof Error ? event : new Error(`DevTools WebSocket error: ${this.wsUrl}`));
            };
        });
    }

    on(method, listener) {
        const listeners = this.listeners.get(method) || [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }

    send(method, params = {}, sessionId = '') {
        const id = this.nextId++;
        this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for CDP ${method}`));
            }, 10000);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
        });
    }

    close() {
        try { this.ws.close(); } catch {}
    }
}

// VS Code sometimes loses the race between "guess how to display this file" (which, for a raw
// serialized objmod binary, concludes "binary/unsupported, show a placeholder") and the extension
// finishing activation and registering wurst.objModPreview as the default editor for it — whichever
// wins, the file's tab is stuck on whatever it picked (it does not retry once the extension shows up
// late). Recovering from that requires actually driving the UI: open the command palette for real and
// run "Reopen Editor With..." against the currently-active (placeholder) tab.
async function pressKeyCombo(client, sessionId, keys) {
    for (const k of keys) {
        await client.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', modifiers: k.modifiers || 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
        }, sessionId);
    }
    for (const k of [...keys].reverse()) {
        await client.send('Input.dispatchKeyEvent', {
            type: 'keyUp', modifiers: 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
        }, sessionId);
    }
}

async function typeText(client, sessionId, text) {
    for (const ch of text) {
        await client.send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
}

async function pressEnter(client, sessionId) {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
}

async function recoverStuckEditorPlaceholder(client, pageSessionId, userDataDir) {
    log('recovering from the "guessed wrong editor" startup race via Reopen Editor With...');
    // CDP Input.dispatchKeyEvent delivers the event to Chromium's input pipeline regardless of OS-level
    // focus, but VS Code's own keybinding dispatch appears to no-op silently if the BrowserWindow isn't
    // the real foreground window (e.g. this terminal, or another VS Code window, has focus instead) —
    // bring it to the front first (both the CDP way and, since that alone wasn't enough, the real Win32
    // SetForegroundWindow) so the synthetic keystrokes actually land on something listening.
    await client.send('Page.bringToFront', {}, pageSessionId).catch(() => {});
    bringVsCodeWindowToForeground(userDataDir);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const CTRL = 2, SHIFT = 8;
    await pressKeyCombo(client, pageSessionId, [
        { key: 'Control', code: 'ControlLeft', vk: 17, modifiers: CTRL | SHIFT },
        { key: 'Shift', code: 'ShiftLeft', vk: 16, modifiers: CTRL | SHIFT },
        { key: 'p', code: 'KeyP', vk: 80, modifiers: CTRL | SHIFT },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await typeText(client, pageSessionId, '>Reopen Editor With');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await pressEnter(client, pageSessionId);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await typeText(client, pageSessionId, 'WC3 Object Data');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await pressEnter(client, pageSessionId);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
async function waitForWebviewContext(client, userDataDir) {
    const contexts = new Map();
    const attachedTargets = new Set();
    const sessionByTargetId = new Map();
    let pageSessionId;
    let recoveryAttemptedAt = 0;
    client.on('Runtime.executionContextCreated', ({ context }, sessionId) => {
        if (context && context.id && sessionId) contexts.set(`${sessionId}:${context.id}`, { sessionId, context });
    });
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastLog = 0;
    while (Date.now() < deadline) {
        const targets = await client.send('Target.getTargets').catch(() => undefined);
        if (process.env.WURST_E2E_VERBOSE === '1' && Date.now() - lastLog > 3000) {
            lastLog = Date.now();
            const summary = (targets?.targetInfos || []).map((t) => `${t.type}:${t.title || t.url || t.targetId}`).join(' | ');
            console.log(`[verbose] targets: ${summary}; contexts known: ${contexts.size}; attached: ${attachedTargets.size}`);
        }
        for (const target of targets?.targetInfos || []) {
            if (!target.targetId || attachedTargets.has(target.targetId)) continue;
            if (!['page', 'iframe', 'webview'].includes(target.type)) continue;
            try {
                const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                if (attached?.sessionId) {
                    attachedTargets.add(target.targetId);
                    sessionByTargetId.set(target.targetId, attached.sessionId);
                    await client.send('Runtime.enable', {}, attached.sessionId);
                    if (process.env.WURST_E2E_SCREENSHOT === '1') await client.send('Page.enable', {}, attached.sessionId).catch(() => {});
                    if (process.env.WURST_E2E_VERBOSE === '1') console.log(`[verbose] attached to ${target.type}:${target.title || target.url} sessionId=${attached.sessionId}`);
                }
            } catch (err) {
                attachedTargets.add(target.targetId);
                if (process.env.WURST_E2E_VERBOSE === '1') console.log(`[verbose] attach failed for ${target.type}:${target.title || target.url}: ${err.message}`);
            }
        }
        // The page's title only becomes "[Extension Development Host] <file> - ..." once the workbench
        // has actually rendered — well *after* it was first attached (when its title was still the bare
        // vscode-file:// workbench.html URL) — so this has to be re-checked against the latest target
        // info every iteration, not just once at attach time.
        for (const target of targets?.targetInfos || []) {
            if (target.type === 'page' && /Extension Development Host/.test(target.title || '') && sessionByTargetId.has(target.targetId)) {
                pageSessionId = sessionByTargetId.get(target.targetId);
            }
        }
        for (const { sessionId, context } of contexts.values()) {
            const result = await client.send('Runtime.evaluate', {
                contextId: context.id,
                expression: '!!window.__wurstModelThumbDebug',
                returnByValue: true,
            }, sessionId).catch((err) => ({ __err: err.message }));
            if (result?.result?.value) return { sessionId, contextId: context.id };
        }
        // Give the extension a real chance to activate & win the race on its own first; only drive the
        // UI recovery once, and only after a generous head start.
        if (pageSessionId && !recoveryAttemptedAt && Date.now() - startedAt > 8000) {
            recoveryAttemptedAt = Date.now();
            await recoverStuckEditorPlaceholder(client, pageSessionId, userDataDir).catch((err) => {
                log(`recovery attempt failed (continuing to wait anyway): ${err.message}`);
            });
            if (process.env.WURST_E2E_SCREENSHOT === '1') {
                try {
                    await client.send('Page.enable', {}, pageSessionId).catch(() => {});
                    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, pageSessionId);
                    if (shot?.data) {
                        const outPath = path.join(os.tmpdir(), `wurst-e2e-post-recovery-${Date.now()}.png`);
                        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
                        console.log(`[verbose] post-recovery screenshot: ${outPath}`);
                    }
                } catch (err) {
                    console.log(`[verbose] post-recovery screenshot failed: ${err.message}`);
                }
            }
        }
        if (process.env.WURST_E2E_SCREENSHOT === '1' && Date.now() - (waitForWebviewContext._lastShot || 0) > 8000) {
            waitForWebviewContext._lastShot = Date.now();
            for (const { sessionId } of contexts.values()) {
                try {
                    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
                    if (shot?.data) {
                        const outPath = path.join(os.tmpdir(), `wurst-e2e-shot-${Date.now()}.png`);
                        fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
                        console.log(`[verbose] screenshot saved: ${outPath}`);
                    }
                } catch (err) {
                    console.log(`[verbose] screenshot failed: ${err.message}`);
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const targets = await client.send('Target.getTargets').catch(() => undefined);
    const summary = (targets?.targetInfos || []).map((target) => `${target.type}:${target.title || target.url || target.targetId}`).join(' | ');
    throw new Error(`Timed out waiting for objmod webview debug hook. Targets: ${summary}`);
}

async function evalInContext(client, sessionId, contextId, expression) {
    const result = await client.send('Runtime.evaluate', {
        contextId,
        expression,
        awaitPromise: true,
        returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'webview evaluation failed');
    }
    return result.result.value;
}

async function waitForEval(client, sessionId, contextId, expression, predicate, label, waitMs = timeoutMs) {
    const deadline = Date.now() + waitMs;
    let last;
    while (Date.now() < deadline) {
        last = await evalInContext(client, sessionId, contextId, expression);
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

// Real, OS-trusted keystrokes via CDP Input — NOT execCommand and NOT a synthesized DOM KeyboardEvent.
// This is the whole point of this script: a JS-invoked execCommand('copy') silently no-ops without a
// genuine user gesture, so it can't tell us anything a plain debug-hook call couldn't already.
async function dispatchRawKey(client, sessionId, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
    await client.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
    }, sessionId);
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
    }, sessionId);
}

const CTRL_MODIFIER = 2; // CDP Input modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8

async function ctrlKeyCombo(client, sessionId, letterKey, letterCode, vk) {
    await client.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', modifiers: CTRL_MODIFIER, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
    }, sessionId);
    await dispatchRawKey(client, sessionId, { key: letterKey, code: letterCode, windowsVirtualKeyCode: vk, modifiers: CTRL_MODIFIER });
    await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers: 0, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17,
    }, sessionId);
}

async function ctrlC(client, sessionId) { await ctrlKeyCombo(client, sessionId, 'c', 'KeyC', 67); }
async function ctrlX(client, sessionId) { await ctrlKeyCombo(client, sessionId, 'x', 'KeyX', 88); }
async function ctrlV(client, sessionId) { await ctrlKeyCombo(client, sessionId, 'v', 'KeyV', 86); }

async function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-objmod-clip-e2e-user-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-objmod-clip-e2e-ext-'));
    const code = findCode();
    const devtoolsPort = Number(process.env.WURST_OBJMOD_E2E_DEBUG_PORT || await freePort());
    // extension.ts's openObjModE2eFixture() explicitly opens this file with the wurst.objModPreview
    // editor on activation (see WURST_OBJMOD_E2E_FILE there) — this is what actually avoids the CLI-arg
    // open race (VS Code guessing "binary file" before the extension finishes registering the custom
    // editor), not the various UI-automation recovery/foreground tricks below (which stayed in as a
    // defensive fallback, but shouldn't be needed once this env var is set correctly).
    const childEnv = { ...process.env, WURST_OBJMOD_E2E_PROJECT: projectPath, WURST_OBJMOD_E2E_FILE: objmodFile };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    log(`code=${code}`);
    log(`project=${projectPath}`);
    log(`file=${objmodFile}`);
    log(`devtoolsPort=${devtoolsPort}`);

    const child = spawnCode(code, [
        '--new-window',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--remote-debugging-port=${devtoolsPort}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--extensionDevelopmentPath=${root}`,
        projectPath,
        objmodFile,
    ], childEnv);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 8000) stderr = stderr.slice(stderr.length - 8000);
    });

    let client;
    try {
        log('waiting for DevTools HTTP');
        const version = await waitForDevtoolsHttp(devtoolsPort);
        log('connecting DevTools WebSocket');
        client = new CdpClient(version.webSocketDebuggerUrl);
        await client.connect();
        log('waiting for objmod webview');
        const { sessionId, contextId } = await waitForWebviewContext(client, userDataDir);
        // Clipboard-relevant keystrokes need the window to actually be the OS foreground window (see
        // the comment in recoverStuckEditorPlaceholder) — keep it in front for the rest of the run.
        await client.send('Page.bringToFront', {}, sessionId).catch(() => {});
        bringVsCodeWindowToForeground(userDataDir);

        log('selecting fixture object');
        const selected = await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.selectObject("Z001")',
            (value) => value === true,
            'Z001 fixture object selectable',
            15000,
        );
        assert.equal(selected, true, 'fixture object should be selectable');

        log('opening the tooltip field editor');
        await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.openFirstTooltipField()',
            (value) => value === true,
            'a .tt-collapsed tooltip field to exist and open',
            15000,
        );
        await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.getEditableBodyText()',
            (value) => typeof value === 'string' && value.length > 0,
            'editable tooltip body to contain the fixture text',
            5000,
        );
        const originalText = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getEditableBodyText()');
        log(`editable body text: ${JSON.stringify(originalText)}`);
        assert.ok(originalText && originalText.includes('Copy Paste Test'), `unexpected fixture text: ${JSON.stringify(originalText)}`);

        // Sanity check the floating toolbar sits beside the box, not detached off to the side (this
        // was a real regression: the toolbar used to anchor to the outer row, which also contains the
        // source-pill, throwing its position off by however wide that pill was).
        const toolbarRect = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getFloatToolbarRect()');
        const boxRect = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getEditableBoxRect()');
        assert.ok(toolbarRect && boxRect, 'expected both the floating toolbar and the editable box to be present');
        const rectGap = Math.abs(toolbarRect.right - boxRect.right);
        assert.ok(rectGap < 40, `floating toolbar should anchor near the box's right edge, got gap=${rectGap}px (toolbar=${JSON.stringify(toolbarRect)}, box=${JSON.stringify(boxRect)})`);
        log(`toolbar anchored correctly (gap=${rectGap}px)`);

        // ---- COPY: select all, real Ctrl+C, clear the box, real Ctrl+V, expect the text back ----
        log('testing copy + paste');
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.selectAllInEditableBody()');
        await new Promise((resolve) => setTimeout(resolve, 150));
        await ctrlC(client, sessionId);
        const clipboardAfterCopy = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.readClipboardText()');
        log(`clipboard read-back right after Ctrl+C: ${JSON.stringify(clipboardAfterCopy)}`);
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.setEditableBodyText("")');
        const clearedForCopy = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getEditableBodyText()');
        assert.equal(clearedForCopy, '', 'body should be empty right before the paste-back check');
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.focusEditableBody()');
        await ctrlV(client, sessionId);
        const afterPaste = await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.getEditableBodyText()',
            (value) => typeof value === 'string' && value.length > 0,
            'pasted text to appear after Ctrl+V',
            5000,
        );
        assert.ok(afterPaste.includes('Copy Paste Test'), `COPY+PASTE FAILED: expected pasted text to include the copied text, got ${JSON.stringify(afterPaste)}`);
        const afterPasteHtml = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getEditableBodyHtml()');
        assert.ok(/color:\s*#ffcc00/i.test(afterPasteHtml), `COLOR ROUND-TRIP FAILED: pasted text lost its WC3 color code, got HTML ${JSON.stringify(afterPasteHtml)}`);
        log('copy + paste OK (color preserved)');

        // ---- CUT: restore original, select all, real Ctrl+X, expect empty, then Ctrl+V restores it ----
        log('testing cut + paste');
        await evalInContext(client, sessionId, contextId, `window.__wurstModelThumbDebug.setEditableBodyText(${JSON.stringify(originalText)})`);
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.selectAllInEditableBody()');
        await new Promise((resolve) => setTimeout(resolve, 400));
        const preCutDebug = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.getSelectionDebugInfo()');
        log(`pre-cut selection/focus state: ${JSON.stringify(preCutDebug)}`);
        await ctrlX(client, sessionId);
        const afterCut = await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.getEditableBodyText()',
            (value) => value === '',
            'body to be emptied by Ctrl+X',
            5000,
        );
        assert.equal(afterCut, '', 'CUT FAILED: body should be empty immediately after Ctrl+X');
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.focusEditableBody()');
        await ctrlV(client, sessionId);
        const afterCutPaste = await waitForEval(
            client, sessionId, contextId,
            'window.__wurstModelThumbDebug.getEditableBodyText()',
            (value) => typeof value === 'string' && value.length > 0,
            'pasted text to reappear after cut + Ctrl+V',
            5000,
        );
        assert.ok(afterCutPaste.includes('Copy Paste Test'), `CUT+PASTE FAILED: expected the cut text back, got ${JSON.stringify(afterCutPaste)}`);
        log('cut + paste OK');

        log('ALL CLIPBOARD CHECKS PASSED');
    } finally {
        client?.close();
        await killProcessTree(child, userDataDir);
        cleanupTempDir(userDataDir);
        cleanupTempDir(extensionsDir);
        cleanupTempDir(generated.dir);
        if (stderr) console.error(stderr);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
