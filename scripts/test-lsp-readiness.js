'use strict';

// Opt-in cross-repository test: pass a newly built compiler jar as the first argument.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { createProtocolConnection, StreamMessageReader, StreamMessageWriter, WorkDoneProgress } = require('vscode-languageserver-protocol/node');

async function checkCompiler(jar, progressUi, readiness, failBuild) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-readiness-'));
    const source = path.join(project, 'wurst', 'Main.wurst');
    if (failBuild) fs.rmdirSync(project);
    else {
        fs.mkdirSync(path.dirname(source));
        fs.writeFileSync(source, 'package Main\nfunction beforeEdit()\n    skip\n');
    }
    const child = spawn(process.env.WURST_LSP_TEST_JAVA || 'java', ['-jar', jar, '-languageServer'], { windowsHide: true, stdio: 'pipe' });
    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const states = [];
    const progress = [];
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    let completed;
    const completion = new Promise((resolve) => { completed = resolve; });
    connection.onNotification('wurst/initialBuildStatus', (params) => {
        states.push(params.state);
        if (params.state === 'ready' || params.state === 'failed') completed();
    });
    connection.onRequest('window/workDoneProgress/create', ({ token }) => {
        connection.onProgress(WorkDoneProgress.type, token, (value) => progress.push(value.kind));
        return null;
    });
    connection.onRequest('workspace/configuration', () => []);
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    connection.onNotification(() => {});
    connection.listen();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Compiler readiness timed out: ${stderr}`)), 45000);
    });
    try {
        await Promise.race([(async () => {
            const root = pathToFileURL(project).toString();
            const result = await connection.sendRequest('initialize', {
                processId: process.pid, rootUri: root,
                capabilities: { window: { workDoneProgress: progressUi }, experimental: { wurstInitialBuildStatus: readiness } },
            });
            assert.equal(result.capabilities.experimental.wurstInitialBuildStatus, readiness);
            assert.deepEqual(states, [], 'readiness must wait for initialized');
            await connection.sendNotification('initialized', {});
            // No client request (or didOpen) may be necessary to finish a capable startup.
            if (readiness) await completion;
            else await connection.sendRequest('workspace/symbol', { query: '\u0000wurst-initial-build-probe' });
            assert.deepEqual(states, readiness ? ['loading', failBuild ? 'failed' : 'ready'] : []);
            assert.deepEqual(progress, progressUi ? ['begin', 'end'] : []);
            if (!failBuild) {
                const uri = pathToFileURL(source).toString();
                const unsaved = 'package Main\nfunction unsavedEdit()\n    skip\n';
                await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'wurst', version: 7, text: unsaved } });
                const symbols = await connection.sendRequest('textDocument/documentSymbol', { textDocument: { uri } });
                assert(JSON.stringify(symbols).includes('unsavedEdit'), 'a deferred unsaved buffer must replace disk content when opened');
                assert(!JSON.stringify(symbols).includes('beforeEdit'));
            }
            await connection.sendRequest('shutdown');
            await connection.sendNotification('exit');
        })(), timeout]);
    } finally {
        clearTimeout(timer);
        connection.dispose();
        child.kill();
        // mkdtemp owns this absolute directory; no user project is passed to cleanup.
        fs.rmSync(project, { recursive: true, force: true });
    }
}

async function main() {
    const jar = process.argv[2];
    if (!jar || !fs.existsSync(jar)) throw new Error('Usage: node scripts/test-lsp-readiness.js <newly-built-compiler.jar>');
    for (const [progress, readiness, failBuild] of [[true, true, false], [false, true, false], [false, false, false], [true, true, true]]) {
        await checkCompiler(path.resolve(jar), progress, readiness, failBuild);
    }
    console.log('Compiler protocol readiness tests passed (progress, no UI, legacy barrier, failed build, unsaved buffers).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
