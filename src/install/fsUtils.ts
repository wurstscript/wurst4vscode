'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    WURST_HOME, RUNTIME_DIR, COMPILER_DIR, GRILL_HOME_DIR, LEGACY_GRILL_DIR,
} from '../paths';

/**
 * The language server holds millions of small objects, which compact object headers make 6% smaller on a large
 * project (castle fight: 488 to 457 MB after a collection), at the same start time. It is always passed first, so a
 * `wurst.javaOpts` entry can still switch it off.
 */
export const COMPACT_OBJECT_HEADERS = '-XX:+UseCompactObjectHeaders';

/** Whether a JVM started with these options has compact object headers: the last of the two options wins. */
export function hasCompactObjectHeaders(jvmOptions: string[]): boolean {
    let compact = false;
    for (const option of jvmOptions) {
        if (option === '-XX:+UseCompactObjectHeaders') compact = true;
        else if (option === '-XX:-UseCompactObjectHeaders') compact = false;
    }
    return compact;
}

/**
 * JVM options which start the language server from an AppCDS archive next to the compiler jar: the JVM writes the
 * archive when the first session ends, and the sessions after it start from it (about 15% sooner).
 *
 * The archive is named after what it was recorded for (runtime, jar path, size and modification time). The JVM
 * only ignores an archive which does not fit, it does not write a new one, so an update would leave the server
 * without; the archives of other jars and runtimes are removed here instead. No options when the folder cannot
 * be written, because the JVM then aborts when the session ends. `-Xlog:disable` because the JVM reports archive
 * trouble on stdout, which is the protocol stream.
 *
 * Needs the runtime's own base archive, which the distribution builds, for compact object headers (classes_coh.jsa);
 * without it the JVM runs as before. A JVM uses an archive only for the object header mode it runs with, so the mode
 * is part of what the archive is named after; `jvmOptions` are the options the server is started with.
 */
export function appCdsJvmOptions(javaExecutable: string, compilerJar: string, jvmOptions: string[]): string[] {
    try {
        const dir = path.dirname(compilerJar);
        // access(W_OK) says yes to any folder on Windows
        const probe = path.join(dir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);

        let release = '';
        try {
            release = fs.readFileSync(path.join(path.dirname(path.dirname(javaExecutable)), 'release'), 'utf8');
        } catch {
            // a java without a release file (from PATH) is told apart by its path
        }
        const jar = fs.statSync(compilerJar);
        const key = crypto.createHash('sha1')
            .update([javaExecutable, release, compilerJar, jar.size, Math.floor(jar.mtimeMs),
                hasCompactObjectHeaders(jvmOptions)].join('|'))
            .digest('hex').slice(0, 12);
        const archive = path.join(dir, `wurstscript-${key}.jsa`);
        for (const entry of fs.readdirSync(dir)) {
            if (/^wurstscript-[0-9a-f]{12}\.jsa$/.test(entry) && entry !== path.basename(archive)) {
                try { fs.unlinkSync(path.join(dir, entry)); } catch { /* in use by a session of the old version */ }
            }
        }
        return ['-XX:+AutoCreateSharedArchive', `-XX:SharedArchiveFile=${archive}`, '-Xlog:disable'];
    } catch {
        return [];
    }
}

export function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

export async function withRetry<T>(fn: () => T | Promise<T>, attempts = 8, delayMs = 200): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            lastErr = e;
            if (e?.code !== 'EBUSY' && e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
            await sleep(delayMs * Math.pow(1.4, i));
        }
    }
    throw lastErr;
}

export function copyDirContents(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, entry);
        const d = path.join(destDir, entry);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
            copyDirContents(s, d);
        } else if (st.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

export async function copyDirContentsWithRetry(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, entry);
        const d = path.join(destDir, entry);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
            await copyDirContentsWithRetry(s, d);
        } else if (st.isFile()) {
            await withRetry(() => fs.copyFileSync(s, d));
        }
    }
}

export async function upgradeFolder(src: string, dest: string) {
    try {
        if (fs.existsSync(dest)) await removeDirSafe(dest);
        await withRetry(() => fs.renameSync(src, dest));
        return;
    } catch {
        await copyDirContentsWithRetry(src, dest);
        try { await removeDirSafe(src); } catch {}
    }
}

export async function removeDirSafe(dir: string) {
    if (!fs.existsSync(dir)) return;
    await withRetry(() => fs.rmSync(dir, { recursive: true, force: true }));
}

export function forceDeletePath(p: string): boolean {
    try {
        fs.rmSync(p, { recursive: true, force: true });
        return !fs.existsSync(p);
    } catch {}
    try { fs.chmodSync(p, 0o666); } catch {}
    try {
        fs.unlinkSync(p);
        return !fs.existsSync(p);
    } catch {}
    return false;
}

export function isDirectoryPath(p: string): boolean {
    try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

export function ensureDirectoryPath(dir: string) {
    if (fs.existsSync(dir)) {
        if (fs.lstatSync(dir).isDirectory()) return;
        if (!forceDeletePath(dir)) throw new Error(`Path exists but is not a directory: ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true });
}

export function ensureDirOrDeleteConflictingPath(p: string) {
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); return; }
    if (isDirectoryPath(p)) return;
    if (!forceDeletePath(p)) throw new Error(`Conflicting non-directory path cannot be removed: ${p}`);
    fs.mkdirSync(p, { recursive: true });
}

export function migrateLegacyGrillLayout() {
    if (!fs.existsSync(WURST_HOME) || !fs.existsSync(LEGACY_GRILL_DIR)) return;
    let st: fs.Stats;
    try { st = fs.lstatSync(LEGACY_GRILL_DIR); } catch { return; }
    if (!st.isDirectory()) return;

    ensureDirectoryPath(GRILL_HOME_DIR);
    try {
        for (const entry of fs.readdirSync(LEGACY_GRILL_DIR)) {
            if (!entry.toLowerCase().endsWith('.jar')) continue;
            const src = path.join(LEGACY_GRILL_DIR, entry);
            const dst = path.join(GRILL_HOME_DIR, entry);
            if (fs.existsSync(dst)) { forceDeletePath(src); continue; }
            try { fs.renameSync(src, dst); } catch {
                try { fs.copyFileSync(src, dst); forceDeletePath(src); } catch {}
            }
        }
    } catch {}
    forceDeletePath(LEGACY_GRILL_DIR);
}

export function installLauncherExecutable(srcExecutable: string) {
    if (!fs.existsSync(srcExecutable)) return;
    const target = path.join(WURST_HOME, path.basename(srcExecutable));
    try {
        if (fs.existsSync(target) && !forceDeletePath(target)) throw new Error(`Failed to replace: ${target}`);
        fs.renameSync(srcExecutable, target);
        if (process.platform !== 'win32') {
            try { fs.chmodSync(target, 0o755); } catch {}
        }
    } catch { /* ignore */ }
}

export function normalizeInstallerPaths() {
    ensureDirOrDeleteConflictingPath(WURST_HOME);
    ensureDirOrDeleteConflictingPath(RUNTIME_DIR);
    ensureDirOrDeleteConflictingPath(COMPILER_DIR);
    ensureDirOrDeleteConflictingPath(GRILL_HOME_DIR);
    migrateLegacyGrillLayout();
}

export function isRecoverableInstallError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return ['eexist', 'enotdir', 'enotempty', 'eperm', 'ebusy', 'path exists but is not a directory']
        .some((m) => msg.includes(m));
}

export function cleanupOldWurstHome() {
    const allowed = new Set(['logs', 'grill', 'grill-cli', 'grill.cmd', 'wurstscript', 'wurstscript.cmd', 'wurst-runtime', 'wurst-compiler']);
    if (!fs.existsSync(WURST_HOME)) return;
    for (const entry of fs.readdirSync(WURST_HOME)) {
        if (!allowed.has(entry)) forceDeletePath(path.join(WURST_HOME, entry));
    }
}

export function cleanupWurstSetupJar() {
    if (!fs.existsSync(WURST_HOME)) return;
    const jarPattern = /^wurstsetup.*\.jar$/i;
    for (const dir of [WURST_HOME, GRILL_HOME_DIR, LEGACY_GRILL_DIR]) {
        if (!fs.existsSync(dir)) continue;
        try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
        for (const entry of fs.readdirSync(dir)) {
            if (jarPattern.test(entry)) forceDeletePath(path.join(dir, entry));
        }
    }
}
