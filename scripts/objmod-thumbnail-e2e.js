'use strict';

/**
 * Local-only VS Code extension e2e for objmod asset-browser thumbnails.
 *
 * Enable explicitly, never in CI:
 *   $env:WURST_OBJMOD_E2E='1'
 *   npm run test:e2e:objmod-thumbs:local
 *
 * Optional knobs:
 *   WURST_OBJMOD_E2E_PROJECT    defaults to ./e2e
 *   WURST_OBJMOD_E2E_FILE       defaults to ./e2e/war3map.w3u
 *   WURST_OBJMOD_E2E_CODE       Code.exe path, if it cannot be found
 *   WURST_OBJMOD_E2E_COUNT      max visible thumbnails to assert, default all visible
 *   WURST_OBJMOD_E2E_MAX_MS     max host-start -> loaded/missing time, default 200
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
    console.log('local objmod thumbnail e2e skipped (set WURST_OBJMOD_E2E=1 to enable)');
    process.exit(0);
}

if (typeof WebSocket !== 'function') {
    throw new Error('This harness needs Node with global WebSocket support (Node 22+).');
}

const defaultProjectPath = path.join(root, 'e2e');
const defaultObjmodFile = path.join(defaultProjectPath, 'war3map.w3u');
const projectPath = process.env.WURST_OBJMOD_E2E_PROJECT || defaultProjectPath;
const objmodFile = process.env.WURST_OBJMOD_E2E_FILE || defaultObjmodFile;
const sampleCountRaw = process.env.WURST_OBJMOD_E2E_COUNT;
const sampleCount = sampleCountRaw ? Number(sampleCountRaw) : 0;
const sampleLimit = Number.isFinite(sampleCount) && sampleCount > 0 ? sampleCount : Number.POSITIVE_INFINITY;
const maxMs = Number(process.env.WURST_OBJMOD_E2E_MAX_MS || 200);
const timeoutMs = Number(process.env.WURST_OBJMOD_E2E_TIMEOUT_MS || 45000);

assert.ok(projectPath && fs.existsSync(projectPath), 'Set WURST_OBJMOD_E2E_PROJECT to a real Wurst project folder, or keep ./e2e present.');
assert.ok(objmodFile && fs.existsSync(objmodFile), 'Set WURST_OBJMOD_E2E_FILE to a real .w3u/.w3a/... file, or keep ./e2e/war3map.w3u present.');

function log(message) {
    console.log(`[objmod-thumb-e2e] ${message}`);
}

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

function waitForExit(child, timeoutMs = 5000) {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
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

async function waitForNoWindowsCodeProfile(userDataDir, timeoutMs = 5000) {
    if (process.platform !== 'win32') return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!windowsCodePidsForUserDataDir(userDataDir).length) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

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
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
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
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    close() {
        try { this.ws.close(); } catch {}
    }
}

async function waitForWebviewContext(client) {
    const contexts = new Map();
    const attachedTargets = new Set();
    const attachedSessions = new Set();
    client.on('Runtime.executionContextCreated', ({ context }, sessionId) => {
        if (context && context.id && sessionId) contexts.set(`${sessionId}:${context.id}`, { sessionId, context });
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const targets = await client.send('Target.getTargets').catch(() => undefined);
        for (const target of targets?.targetInfos || []) {
            if (!target.targetId || attachedTargets.has(target.targetId)) continue;
            if (!['page', 'iframe', 'webview'].includes(target.type)) continue;
            try {
                const attached = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                if (attached?.sessionId) {
                    attachedTargets.add(target.targetId);
                    attachedSessions.add(attached.sessionId);
                    await client.send('Runtime.enable', {}, attached.sessionId);
                }
            } catch {
                attachedTargets.add(target.targetId);
            }
        }
        for (const { sessionId, context } of contexts.values()) {
            const result = await client.send('Runtime.evaluate', {
                contextId: context.id,
                expression: '!!window.__wurstModelThumbDebug',
                returnByValue: true,
            }, sessionId).catch(() => undefined);
            if (result?.result?.value) return { sessionId, contextId: context.id };
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

function terminalKeys(state) {
    const terminals = new Set();
    for (const event of state.events) {
        if (event.type === 'loaded' || event.type === 'missing' || event.type === 'failed') terminals.add(event.key);
    }
    return terminals;
}

function durationsByKey(events) {
    const starts = new Map();
    const out = new Map();
    for (const event of events) {
        if (event.type === 'host-start' && !starts.has(event.key)) starts.set(event.key, event.at);
        if ((event.type === 'loaded' || event.type === 'missing' || event.type === 'failed') && starts.has(event.key) && !out.has(event.key)) {
            out.set(event.key, event.at - starts.get(event.key));
        }
    }
    return out;
}

function profileForKey(events, key) {
    return events
        .filter((event) => event.key === key && (event.type === 'host-start' || event.type === 'render-start' || event.type === 'loaded' || event.type === 'missing' || event.type === 'failed' || event.type.startsWith('profile:')))
        .map((event) => {
            const phase = event.type.replace(/^profile:/, '');
            const elapsed = event.elapsedMs == null ? '' : `@${event.elapsedMs}ms`;
            const reason = event.reason ? ` reason=${event.reason}` : '';
            return `${phase}${elapsed}${event.detail ? ` ${event.detail}` : ''}${reason}`;
        });
}

async function main() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-objmod-e2e-user-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-objmod-e2e-ext-'));
    const code = findCode();
    const devtoolsPort = Number(process.env.WURST_OBJMOD_E2E_DEBUG_PORT || await freePort());
    const childEnv = {
        ...process.env,
        WURST_MODEL_THUMB_DISABLE_CACHE: '1',
        WURST_OBJMOD_E2E_PROJECT: projectPath,
        WURST_OBJMOD_E2E_FILE: objmodFile,
    };
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
        const version = await waitForDevtoolsHttp(devtoolsPort);
        client = new CdpClient(version.webSocketDebuggerUrl);
        await client.connect();
        const { sessionId, contextId } = await waitForWebviewContext(client);
        await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.openModelAssetBrowser()');

        let initialKeys = [];
        const violations = [];
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const state = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.state()');
            const visibleAll = state.visible.filter((slot) => slot.visible);
            const visible = visibleAll.slice(0, sampleLimit);
            if (!initialKeys.length && visible.length >= Math.min(sampleLimit, 8)) {
                initialKeys = visible.map((slot) => slot.key);
                log(`observing ${initialKeys.length} visible thumbnails`);
            }
            if (initialKeys.length) {
                const terminals = terminalKeys(state);
                for (const slot of visible.filter((slot) => initialKeys.includes(slot.key))) {
                    if (!terminals.has(slot.key) && !slot.pending) {
                        violations.push(`${slot.key} was neither pending nor terminal while visible`);
                    }
                }
                if (initialKeys.every((key) => terminals.has(key))) {
                    const terminalOrder = [];
                    const seenTerminal = new Set();
                    for (const event of state.events) {
                        if (!(event.type === 'loaded' || event.type === 'missing' || event.type === 'failed') || !initialKeys.includes(event.key) || seenTerminal.has(event.key)) continue;
                        seenTerminal.add(event.key);
                        terminalOrder.push(event.key);
                    }
                    if (terminalOrder.slice(0, initialKeys.length).join('\n') !== initialKeys.join('\n')) {
                        console.error(`[objmod-thumb-e2e] expected order:\n${initialKeys.join('\n')}`);
                        console.error(`[objmod-thumb-e2e] actual order:\n${terminalOrder.slice(0, initialKeys.length).join('\n')}`);
                    }
                    assert.deepEqual(terminalOrder.slice(0, initialKeys.length), initialKeys, 'terminal thumbnail order must match visible DOM order');
                    assert.equal(violations.length, 0, violations.join('\n'));

                    const durations = durationsByKey(state.events);
                    const failures = [];
                    const numbers = [];
                    const visibleByKey = new Map(state.visible.map((slot) => [slot.key, slot]));
                    for (const key of initialKeys) {
                        const slot = visibleByKey.get(key);
                        if (!slot || !slot.loaded) {
                            const reason = slot?.reason ? JSON.stringify(slot.reason) : (slot?.missing ? '{"reason":"missing"}' : '{"reason":"no-loaded-img"}');
                            failures.push(`${key}: expected concrete thumbnail image, got ${reason}`);
                        }
                    }
                    const timedKeys = initialKeys.slice(1);
                    for (const key of timedKeys) {
                        const ms = durations.get(key);
                        if (typeof ms !== 'number') failures.push(`${key}: missing duration`);
                        else {
                            numbers.push(ms);
                            if (ms > maxMs) failures.push(`${key}: ${ms}ms > ${maxMs}ms`);
                        }
                    }
                    if (numbers.length) {
                        const half = Math.max(1, Math.floor(numbers.length / 2));
                        const firstAvg = numbers.slice(0, half).reduce((a, b) => a + b, 0) / half;
                        const lastAvg = numbers.slice(-half).reduce((a, b) => a + b, 0) / half;
                        if (lastAvg > firstAvg * 1.5 && lastAvg - firstAvg > 50) {
                            failures.push(`degraded over time: firstAvg=${firstAvg.toFixed(1)}ms lastAvg=${lastAvg.toFixed(1)}ms`);
                        }
                    }
                    for (const key of initialKeys) log(`${key}${key === initialKeys[0] ? ' warmup' : ''} ${durations.get(key)}ms`);
                    if (failures.length) {
                        console.error(`objmod thumbnail e2e failures:\n${failures.join('\n')}`);
                        for (const key of initialKeys) {
                            const profile = profileForKey(state.events, key);
                            console.error(`[objmod-thumb-e2e] ${key} profile ${profile.join(' -> ')}`);
                        }
                    }
                    assert.equal(failures.length, 0, failures.join('\n'));
                    log(`passed ${timedKeys.length} timed thumbnails + 1 warmup, max=${Math.max(...numbers)}ms`);
                    return;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const state = await evalInContext(client, sessionId, contextId, 'window.__wurstModelThumbDebug.state()').catch(() => undefined);
        if (state && initialKeys.length) {
            const terminals = terminalKeys(state);
            for (const key of initialKeys) {
                if (terminals.has(key)) continue;
                const slot = state.visible.find((candidate) => candidate.key === key);
                console.error(`[objmod-thumb-e2e] unfinished ${key} slot=${JSON.stringify(slot || null)} profile ${profileForKey(state.events, key).join(' -> ')}`);
            }
        }
        throw new Error(`Timed out waiting for ${initialKeys.length || 'visible'} thumbnail decisions.`);
    } finally {
        client?.close();
        await killProcessTree(child, userDataDir);
        cleanupTempDir(userDataDir);
        cleanupTempDir(extensionsDir);
        if (stderr) console.error(stderr);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
