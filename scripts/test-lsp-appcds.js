'use strict';

// Opt-in cross-repository test: pass the compiler jar of a built distribution and the java of its runtime
// (the runtime needs the base CDS archive for compact object headers, classes_coh.jsa): node scripts/test-lsp-appcds.js <compiler.jar> <java>
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { createProtocolConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-languageserver-protocol/node');
const { createTsLoader } = require('../e2e/harness/tsLoader');

const { appCdsJvmOptions, COMPACT_OBJECT_HEADERS } = createTsLoader()('src/install/fsUtils.ts');

// the options the extension starts the server with, as getServerOptions builds them
function serverOptions(java, jar, javaOpts = []) {
    return [COMPACT_OBJECT_HEADERS, ...appCdsJvmOptions(java, jar, [COMPACT_OBJECT_HEADERS, ...javaOpts]), ...javaOpts];
}

function archiveOf(options) {
    const flag = options.find((option) => option.startsWith('-XX:SharedArchiveFile='));
    assert.ok(flag, 'the options name no archive');
    return flag.slice('-XX:SharedArchiveFile='.length);
}

async function session(java, jar, project, options) {
    const child = spawn(java, [...options, '-jar', jar, '-languageServer'], { windowsHide: true, stdio: 'pipe' });
    const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    const closed = new Promise((resolve) => child.on('close', resolve));
    const states = [];
    let protocolErrors = 0;
    let finished;
    const ready = new Promise((resolve) => { finished = resolve; });
    connection.onNotification('wurst/initialBuildStatus', (params) => {
        states.push(params.state);
        if (params.state === 'ready' || params.state === 'failed') finished();
    });
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('workspace/configuration', () => []);
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    connection.onNotification(() => {});
    connection.onError(() => { protocolErrors++; });
    connection.listen();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no readiness: ${stderr}`)), 60000); });
    const started = Date.now();
    try {
        await Promise.race([(async () => {
            await connection.sendRequest('initialize', {
                processId: process.pid, rootUri: pathToFileURL(project).toString(),
                capabilities: { window: { workDoneProgress: false }, experimental: { wurstInitialBuildStatus: true } },
            });
            await connection.sendNotification('initialized', {});
            await ready;
        })(), timeout]);
        const readyMs = Date.now() - started;
        await connection.sendRequest('shutdown');
        await connection.sendNotification('exit');
        const code = await closed;
        return { code, states, protocolErrors, readyMs };
    } finally {
        clearTimeout(timer);
        child.kill();
    }
}

async function main() {
    const [jar, java] = process.argv.slice(2);
    assert.ok(jar && java, 'usage: node scripts/test-lsp-appcds.js <compiler.jar> <java>');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-appcds-lsp-'));
    try {
        const project = path.join(root, 'project');
        fs.mkdirSync(path.join(project, 'wurst'), { recursive: true });
        fs.writeFileSync(path.join(project, 'wurst', 'Main.wurst'), 'package Main\nfunction beforeEdit()\n    skip\n');
        // a copy, so that the archive is not written into the distribution which is being tested
        const compilerDir = path.join(root, 'wurst-compiler');
        fs.mkdirSync(compilerDir);
        const copy = path.join(compilerDir, path.basename(jar));
        fs.copyFileSync(jar, copy);

        const options = serverOptions(java, copy);
        assert.ok(options.includes('-XX:+AutoCreateSharedArchive'), 'the options have no archive');
        const archive = archiveOf(options);

        const first = await session(java, copy, project, options);
        assert.deepStrictEqual(first.states, ['loading', 'ready']);
        assert.strictEqual(first.protocolErrors, 0);
        assert.strictEqual(first.code, 0, 'the first session ends cleanly');
        assert.ok(fs.existsSync(archive) && fs.statSync(archive).size > 0, 'the first session writes the archive');
        const written = fs.statSync(archive).mtimeMs;

        const second = await session(java, copy, project, options);
        assert.deepStrictEqual(second.states, ['loading', 'ready']);
        assert.strictEqual(second.protocolErrors, 0);
        assert.strictEqual(second.code, 0);
        assert.strictEqual(fs.statSync(archive).mtimeMs, written, 'the second session starts from the archive and leaves it');

        // an update: the options name another archive, the old one goes, and the first session writes the new one
        fs.appendFileSync(copy, '');
        const stat = fs.statSync(copy);
        fs.utimesSync(copy, stat.atime, new Date(stat.mtimeMs + 5000));
        const updatedOptions = serverOptions(java, copy);
        assert.notDeepStrictEqual(updatedOptions, options);
        assert.ok(!fs.existsSync(archive), 'the archive of the old jar is removed');
        const third = await session(java, copy, project, updatedOptions);
        assert.deepStrictEqual(third.states, ['loading', 'ready']);
        assert.strictEqual(third.code, 0);
        const updatedArchive = archiveOf(updatedOptions);
        assert.ok(fs.existsSync(updatedArchive));

        // people already have the option in wurst.javaOpts, so the server is started with it twice: the same archive,
        // and a session which starts from it
        const twice = serverOptions(java, copy, ['-XX:+UseCompactObjectHeaders']);
        assert.strictEqual(twice.filter((option) => option === '-XX:+UseCompactObjectHeaders').length, 2);
        assert.strictEqual(archiveOf(twice), updatedArchive);
        const writtenUpdated = fs.statSync(updatedArchive).mtimeMs;
        const duplicate = await session(java, copy, project, twice);
        assert.deepStrictEqual(duplicate.states, ['loading', 'ready']);
        assert.strictEqual(duplicate.protocolErrors, 0);
        assert.strictEqual(duplicate.code, 0, 'the option twice starts and ends cleanly');
        assert.strictEqual(fs.statSync(updatedArchive).mtimeMs, writtenUpdated, 'and starts from the archive');

        // a wurst.javaOpts entry which switches the headers off: the runtime has no base archive for that mode, so the
        // server starts without any archive, and ends cleanly
        const plain = serverOptions(java, copy, ['-XX:-UseCompactObjectHeaders']);
        const fourth = await session(java, copy, project, plain);
        assert.deepStrictEqual(fourth.states, ['loading', 'ready']);
        assert.strictEqual(fourth.protocolErrors, 0);
        assert.strictEqual(fourth.code, 0, 'the server ends cleanly without compact object headers');
        console.log(`appcds language server ok (ready after ${first.readyMs} ms, then ${second.readyMs} ms)`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
