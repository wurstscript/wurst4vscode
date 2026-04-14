'use strict';

import * as fs from 'fs';
import * as path from 'path';
import {
    WURST_HOME, RUNTIME_DIR, COMPILER_DIR, GRILL_HOME_DIR, LEGACY_GRILL_DIR,
} from '../paths';

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

export async function upgradeFolder(src: string, dest: string) {
    try {
        if (fs.existsSync(dest)) await removeDirSafe(dest);
        await withRetry(() => fs.renameSync(src, dest));
        return;
    } catch {
        copyDirContents(src, dest);
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
