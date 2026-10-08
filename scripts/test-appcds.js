'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTsLoader } = require('../e2e/harness/tsLoader');

const { appCdsJvmOptions, hasCompactObjectHeaders, COMPACT_OBJECT_HEADERS } = createTsLoader()('src/install/fsUtils.ts');

// the server runs with compact object headers unless javaOpts say otherwise (the last option wins)
const COMPACT = [COMPACT_OBJECT_HEADERS];

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
    assert.strictEqual(COMPACT_OBJECT_HEADERS, '-XX:+UseCompactObjectHeaders');
    assert.strictEqual(hasCompactObjectHeaders([]), false);
    assert.strictEqual(hasCompactObjectHeaders(COMPACT), true);
    assert.strictEqual(hasCompactObjectHeaders([...COMPACT, '-Xmx2g']), true);
    assert.strictEqual(hasCompactObjectHeaders([...COMPACT, '-XX:-UseCompactObjectHeaders']), false);
    assert.strictEqual(hasCompactObjectHeaders([...COMPACT, '-XX:-UseCompactObjectHeaders', '-XX:+UseCompactObjectHeaders']), true);

    const options = appCdsJvmOptions(java, jar, COMPACT);
    assert.deepStrictEqual(options.filter((option) => !option.startsWith('-XX:SharedArchiveFile=')),
        ['-XX:+AutoCreateSharedArchive', '-Xlog:disable']);
    const archive = archiveOf(options);
    assert.strictEqual(path.dirname(archive), compiler);
    assert.match(path.basename(archive), /^wurstscript-[0-9a-f]{12}\.jsa$/);
    assert.deepStrictEqual(appCdsJvmOptions(java, jar, COMPACT), options, 'the same install gets the same archive');
    assert.deepStrictEqual(appCdsJvmOptions(java, jar, [...COMPACT, '-Xmx2g']), options, 'other options keep the archive');
    // people already have the option in wurst.javaOpts: given twice it is the same mode, so the same archive
    assert.deepStrictEqual(appCdsJvmOptions(java, jar, [...COMPACT, ...COMPACT]), options, 'the option twice keeps the archive');
    // a JVM uses an archive only for its object header mode, so switching it off gets an archive of its own
    const withoutCompact = appCdsJvmOptions(java, jar, [...COMPACT, '-XX:-UseCompactObjectHeaders']);
    assert.notStrictEqual(archiveOf(withoutCompact), archive);
    assert.deepStrictEqual(appCdsJvmOptions(java, jar, COMPACT), options, 'and the archive for compact headers is kept');
    assert.deepStrictEqual(fs.readdirSync(compiler), ['wurstscript.jar'], 'the write probe is removed');

    // an update: the archive of the old jar does not fit and is not replaced by the JVM, so it is removed here
    fs.writeFileSync(archive, 'archive of compiler 1');
    fs.writeFileSync(path.join(compiler, 'notes.jsa'), 'not ours');
    fs.writeFileSync(path.join(compiler, 'wurstscript-latest.jsa'), 'not ours');
    fs.writeFileSync(jar, 'compiler 2 is longer');
    const updated = archiveOf(appCdsJvmOptions(java, jar, COMPACT));
    assert.notStrictEqual(updated, archive);
    assert.ok(!fs.existsSync(archive), 'the archive of the old jar is removed');
    assert.deepStrictEqual(fs.readdirSync(compiler).sort(), ['notes.jsa', 'wurstscript-latest.jsa', 'wurstscript.jar']);

    // a jar with the same size, rewritten later, is another jar
    const stat = fs.statSync(jar);
    fs.utimesSync(jar, stat.atime, new Date(stat.mtimeMs + 5000));
    assert.notStrictEqual(archiveOf(appCdsJvmOptions(java, jar, COMPACT)), updated);

    // another runtime, at the same path or elsewhere, is another archive
    const other = install(path.join(tmp, 'other'), 'JAVA_VERSION="25.0.3"\n');
    fs.copyFileSync(jar, other.jar);
    fs.utimesSync(other.jar, fs.statSync(jar).atime, fs.statSync(jar).mtime);
    assert.notStrictEqual(archiveOf(appCdsJvmOptions(other.java, other.jar, COMPACT)).split(path.sep).pop(),
        archiveOf(appCdsJvmOptions(java, jar, COMPACT)).split(path.sep).pop());

    // a folder which cannot be written gets no options (the JVM aborts at exit when it cannot write the archive)
    assert.deepStrictEqual(appCdsJvmOptions(java, path.join(tmp, 'missing', 'wurstscript.jar'), COMPACT), []);
    // and so does a jar which is not there
    fs.unlinkSync(jar);
    assert.deepStrictEqual(appCdsJvmOptions(java, jar, COMPACT), []);
    assert.ok(!fs.readdirSync(compiler).some((entry) => entry.startsWith('.write-probe')));
    console.log('appcds options ok');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
