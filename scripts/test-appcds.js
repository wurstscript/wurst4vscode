'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTsLoader } = require('../e2e/harness/tsLoader');

const { appCdsJvmOptions } = createTsLoader()('src/install/fsUtils.ts');

function install(root, release = 'JAVA_VERSION="25.0.1"\n') {
    const runtime = path.join(root, 'wurst-runtime');
    const compiler = path.join(root, 'wurst-compiler');
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.mkdirSync(compiler, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'release'), release);
    const java = path.join(runtime, 'bin', 'java.exe');
    const jar = path.join(compiler, 'wurstscript.jar');
    fs.writeFileSync(java, '');
    fs.writeFileSync(jar, 'compiler 1');
    return { java, jar, compiler };
}

function archiveOf(options) {
    const flag = options.find((option) => option.startsWith('-XX:SharedArchiveFile='));
    assert.ok(flag, `no archive in ${JSON.stringify(options)}`);
    return flag.slice('-XX:SharedArchiveFile='.length);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-appcds-'));
try {
    const { java, jar, compiler } = install(tmp);

    // the options: a JDK managed archive next to the jar, and no JVM log lines on the protocol stream
    const options = appCdsJvmOptions(java, jar);
    assert.deepStrictEqual(options.filter((option) => !option.startsWith('-XX:SharedArchiveFile=')),
        ['-XX:+AutoCreateSharedArchive', '-Xlog:disable']);
    const archive = archiveOf(options);
    assert.strictEqual(path.dirname(archive), compiler);
    assert.match(path.basename(archive), /^wurstscript-[0-9a-f]{12}\.jsa$/);
    assert.deepStrictEqual(appCdsJvmOptions(java, jar), options, 'the same install gets the same archive');
    assert.deepStrictEqual(fs.readdirSync(compiler), ['wurstscript.jar'], 'the write probe is removed');

    // an update: the archive of the old jar does not fit and is not replaced by the JVM, so it is removed here
    fs.writeFileSync(archive, 'archive of compiler 1');
    fs.writeFileSync(path.join(compiler, 'notes.jsa'), 'not ours');
    fs.writeFileSync(path.join(compiler, 'wurstscript-latest.jsa'), 'not ours');
    fs.writeFileSync(jar, 'compiler 2 is longer');
    const updated = archiveOf(appCdsJvmOptions(java, jar));
    assert.notStrictEqual(updated, archive);
    assert.ok(!fs.existsSync(archive), 'the archive of the old jar is removed');
    assert.deepStrictEqual(fs.readdirSync(compiler).sort(), ['notes.jsa', 'wurstscript-latest.jsa', 'wurstscript.jar']);

    // a jar with the same size, rewritten later, is another jar
    const stat = fs.statSync(jar);
    fs.utimesSync(jar, stat.atime, new Date(stat.mtimeMs + 5000));
    assert.notStrictEqual(archiveOf(appCdsJvmOptions(java, jar)), updated);

    // another runtime, at the same path or elsewhere, is another archive
    const other = install(path.join(tmp, 'other'), 'JAVA_VERSION="25.0.3"\n');
    fs.copyFileSync(jar, other.jar);
    fs.utimesSync(other.jar, fs.statSync(jar).atime, fs.statSync(jar).mtime);
    assert.notStrictEqual(archiveOf(appCdsJvmOptions(other.java, other.jar)).split(path.sep).pop(),
        archiveOf(appCdsJvmOptions(java, jar)).split(path.sep).pop());

    // a folder which cannot be written gets no options (the JVM aborts at exit when it cannot write the archive)
    assert.deepStrictEqual(appCdsJvmOptions(java, path.join(tmp, 'missing', 'wurstscript.jar')), []);
    // and so does a jar which is not there
    fs.unlinkSync(jar);
    assert.deepStrictEqual(appCdsJvmOptions(java, jar), []);
    assert.ok(!fs.readdirSync(compiler).some((entry) => entry.startsWith('.write-probe')));
    console.log('appcds options ok');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
