'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import {
    WURST_HOME, RUNTIME_DIR, COMPILER_DIR, COMPILER_JAR, GRILL_HOME_DIR,
} from '../paths';
import {
    normalizeInstallerPaths, migrateLegacyGrillLayout, installLauncherExecutable,
    isRecoverableInstallError, cleanupOldWurstHome, cleanupWurstSetupJar,
    removeDirSafe, upgradeFolder, ensureDirectoryPath,
} from './fsUtils';
import { fetchNightlyZipAsset, fetchLatestGrillAsset, fetchNightlyCommitSha, downloadFileWithProgress, extractZipWithByteProgress } from './downloader';
import { ensureCliOnPath, offerPostInstallActions, prependPathForVsCodeTerminals } from './pathManager';
import { stopLanguageServerIfRunning } from '../languageServer';

export function hasNewLayout(): boolean {
    return fs.existsSync(RUNTIME_DIR) && fs.existsSync(COMPILER_DIR);
}

export function isGrillOnPath(): boolean {
    const result = process.platform === 'win32'
        ? spawnSync('where', ['grill'], { stdio: 'ignore' })
        : spawnSync('which', ['grill'], { stdio: 'ignore' });
    return result.status === 0;
}

export function getBundledJava(): string {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    return path.join(RUNTIME_DIR, 'bin', exe);
}

function chmodRuntimeExecutables(): void {
    if (process.platform === 'win32') return;
    const binDir = path.join(RUNTIME_DIR, 'bin');
    try {
        for (const entry of fs.readdirSync(binDir)) {
            const candidate = path.join(binDir, entry);
            try {
                if (fs.lstatSync(candidate).isFile()) fs.chmodSync(candidate, 0o755);
            } catch {}
        }
    } catch {}
    try { fs.chmodSync(path.join(RUNTIME_DIR, 'lib', 'jspawnhelper'), 0o755); } catch {}
}

export function checkCustomJavaVersion(javaBin: string): void {
    if (!fs.existsSync(javaBin)) {
        throw new Error(`Custom Java executable not found: "${javaBin}". Check your wurst.javaExecutable setting.`);
    }
    const res = spawnSync(javaBin, ['-version'], { encoding: 'utf8', windowsHide: true });
    const output = `${res.stderr || ''}${res.stdout || ''}`.trim();
    if (res.error || res.status !== 0) {
        throw new Error(`Failed to run custom Java at "${javaBin}": ${res.error?.message ?? output}`);
    }
    const match = output.match(/version "(\d+)/);
    if (!match) throw new Error(`Could not determine Java version from output:\n${output}`);
    const major = parseInt(match[1], 10);
    if (major < 25) {
        throw new Error(
            `WurstScript requires Java 25 or newer, but "${javaBin}" reports version ${major}.\n` +
            `On NixOS, add jdk25 (or newer) to your environment and update wurst.javaExecutable accordingly.`
        );
    }
}

export function getInstalledVersionString(): string | null {
    try {
        const customJava = workspace.getConfiguration('wurst').get<string>('javaExecutable')?.trim() || '';
        const java = customJava || getBundledJava();
        if (!customJava && (!fs.existsSync(java) || !fs.existsSync(COMPILER_JAR))) return null;
        if (customJava && !fs.existsSync(COMPILER_JAR)) return null;
        const res = spawnSync(java, ['-jar', COMPILER_JAR, '--version'], { encoding: 'utf8', windowsHide: true });
        const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
        if (!out) return null;
        return out.split(/\r?\n/).pop() || out;
    } catch { return null; }
}

export function extractShortSha(versionString: string): string | null {
    return versionString.substring(versionString.lastIndexOf('-') + 2);
}

export function getBundledGrillExecutable(): string | null {
    const p = path.join(WURST_HOME, process.platform === 'win32' ? 'grill.cmd' : 'grill');
    return fs.existsSync(p) ? p : null;
}

async function repairInstallationLayout() {
    await stopLanguageServerIfRunning();
    normalizeInstallerPaths();
    cleanupWurstSetupJar();
}

export async function ensureInstalledOrOfferMigration(forcePrompt: boolean): Promise<void> {
    migrateLegacyGrillLayout();
    const newLayout = hasNewLayout();
    const hasHomeDir = fs.existsSync(WURST_HOME);

    if (!newLayout) {
        if (!hasHomeDir) {
            if (!forcePrompt) {
                const choice = await vscode.window.showInformationMessage(
                    'Welcome to WurstScript! Would you like to install it now?',
                    { modal: true }, 'Install', 'Not now'
                );
                if (choice !== 'Install') throw new Error('WurstScript is not installed.');
            }
            await installWithRetry();
            return;
        }

        const msg = [
            'Old WurstScript installation detected.',
            '',
            'Wurst just got a major update! We now ship a bundled runtime and deliver updates directly via GitHub Releases through this extension.',
            '',
            'Highlights:',
            '• Much faster warm "runmap" (up to ~80%)',
            '• Many bug fixes and improvements',
            '• New language features',
            '',
            'Note:',
            'This release introduces - and future updates may continue to introduce - breaking changes to improve reliability and maintainability.',
            'If you encounter any issues, please let us know on GitHub or Discord.',
        ].join('\n');

        await vscode.window.showInformationMessage(msg, { modal: true }, 'Continue');
        await installWithRetry();
        return;
    }

    if (!fs.existsSync(COMPILER_JAR)) {
        await installWithRetry();
    }
}

export async function ensureGrillAvailable(): Promise<void> {
    if (getBundledGrillExecutable() || isGrillOnPath()) return;
    await installWithRetry();
    if (!getBundledGrillExecutable() && !isGrillOnPath()) {
        throw new Error('Grill CLI is not available. Please run "Wurst: Install/Update" and try again.');
    }
}

export async function installWithRetry(): Promise<void> {
    let autoRepairAttempted = false;
    while (true) {
        try {
            await installFreshFromNightly();
            return;
        } catch (error) {
            if (!autoRepairAttempted && isRecoverableInstallError(error)) {
                autoRepairAttempted = true;
                try { await repairInstallationLayout(); continue; } catch {}
            }
            const message = error instanceof Error ? error.message : String(error);
            const choice = await vscode.window.showErrorMessage(
                `Installation failed: ${message}`, { modal: true }, 'Retry', 'Repair', 'Cancel'
            );
            if (choice === 'Repair') { await repairInstallationLayout(); continue; }
            if (choice !== 'Retry') throw error;
        }
    }
}

async function installFreshFromNightly(): Promise<void> {
    await stopLanguageServerIfRunning();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing WurstScript', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Fetching release info…', increment: 5 });
            const asset = await fetchNightlyZipAsset();

            const tmpWork = path.join(os.tmpdir(), `wurst-install-${Date.now()}`);
            const tmpZip = path.join(tmpWork, 'payload.zip');
            const unpack = path.join(tmpWork, 'unpacked');
            fs.mkdirSync(unpack, { recursive: true });

            let last = 0;
            const DL_WEIGHT = 70, EX_WEIGHT = 18, GRILL_WEIGHT = 10;

            await downloadFileWithProgress(asset.url, tmpZip, (pct) => {
                const scaled = (pct / 100) * DL_WEIGHT;
                const inc = Math.max(0, scaled - last); last += inc;
                progress.report({ message: `Downloading compiler… ${Math.floor(pct)}%`, increment: inc });
            });

            await extractZipWithByteProgress(tmpZip, unpack, (pct) => {
                const scaled = DL_WEIGHT + (pct / 100) * EX_WEIGHT;
                const inc = Math.max(0, scaled - last); last += inc;
                progress.report({ message: `Extracting compiler… ${Math.floor(pct)}%`, increment: inc });
            });

            const srcRuntime = path.join(unpack, 'wurst-runtime');
            const srcCompiler = path.join(unpack, 'wurst-compiler');
            const srcLauncher = path.join(unpack, process.platform === 'win32' ? 'wurstscript.cmd' : 'wurstscript');
            const srcGrill = path.join(unpack, process.platform === 'win32' ? 'grill.cmd' : 'grill');

            if (!fs.existsSync(srcRuntime) || !fs.existsSync(path.join(srcCompiler, 'wurstscript.jar'))) {
                throw new Error('Installation incomplete: runtime or compiler not found after extraction.');
            }

            fs.mkdirSync(WURST_HOME, { recursive: true });
            await upgradeFolder(srcRuntime, RUNTIME_DIR);
            await upgradeFolder(srcCompiler, COMPILER_DIR);
            installLauncherExecutable(srcLauncher);
            installLauncherExecutable(srcGrill);

            chmodRuntimeExecutables();

            const grillAsset = await fetchLatestGrillAsset();
            ensureDirectoryPath(GRILL_HOME_DIR);
            const tmpGrillJar = path.join(tmpWork, 'grill.jar');

            await downloadFileWithProgress(grillAsset.url, tmpGrillJar, (pct) => {
                const scaled = DL_WEIGHT + EX_WEIGHT + (pct / 100) * GRILL_WEIGHT;
                const inc = Math.max(0, scaled - last); last += inc;
                progress.report({ message: `Downloading Grill CLI… ${Math.floor(pct)}%`, increment: inc });
            });

            const grillDest = path.join(GRILL_HOME_DIR, 'grill.jar');
            fs.copyFileSync(tmpGrillJar, grillDest);
            try { fs.unlinkSync(tmpGrillJar); } catch {}
            console.log('[wurst] Installed Grill CLI at', grillDest);

            cleanupOldWurstHome();
            cleanupWurstSetupJar();
            try { await removeDirSafe(tmpWork); } catch {}

            progress.report({ message: 'Finishing up installation…', increment: Math.max(0, 100 - last) });

            const pathUpdate = await ensureCliOnPath();
            await offerPostInstallActions(pathUpdate);
        }
    );
}

export async function maybeOfferUpdate(): Promise<void> {
    try {
        if (!hasNewLayout() || !fs.existsSync(COMPILER_JAR)) return;
        const installed = getInstalledVersionString();
        const installedShort = installed ? extractShortSha(installed) : null;
        const latestSha = await fetchNightlyCommitSha();
        if (installedShort && latestSha.startsWith(installedShort)) return;

        const detail = [
            installed ? `Installed: ${installedShort}` : 'Installed: unknown',
            `Latest: ${latestSha.slice(0, 7)}`,
        ].join('\n');

        const choice = await vscode.window.showInformationMessage(
            'A newer WurstScript version is available.',
            { modal: true, detail }, 'Update', 'Later'
        );
        if (choice === 'Update') await installWithRetry();
    } catch (e) {
        console.warn('Update check failed:', e);
    }
}

export async function runGrillGenerate(destDir: string): Promise<void> {
    const bundled = getBundledGrillExecutable();
    const grillCmd = bundled ?? 'grill';
    if (bundled) prependPathForVsCodeTerminals(WURST_HOME);

    await new Promise<void>((resolve, reject) => {
        const out: string[] = [];
        const push = (s: any) => {
            const str = String(s ?? '');
            if (!str) return;
            out.push(str);
            if (out.length > 2000) out.shift();
        };

        let child;
        if (process.platform === 'win32') {
            child = spawn('cmd.exe', ['/c', grillCmd, 'generate', destDir], { windowsHide: true });
        } else {
            child = spawn(grillCmd, ['generate', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        }

        child.on('error', (err: any) => {
            const details = out.join('').trim();
            if (err?.code === 'ENOENT') {
                reject(new Error([
                    `Could not execute "grill".`,
                    `Make sure Grill is installed and on PATH, or run "Wurst: Install/Update" once.`,
                    details ? `\nLast output:\n${details}` : '',
                ].join('\n')));
            } else {
                reject(new Error(`${err?.message ?? String(err)}${details ? `\n\n${details}` : ''}`));
            }
        });

        child.stdout?.on('data', push);
        child.stderr?.on('data', push);

        child.on('close', (code) => {
            const details = out.join('').trim();
            if (code === 0) return resolve();
            reject(new Error([`"grill generate" failed (exit code ${code}).`, details ? `\nOutput:\n${details}` : ''].join('\n')));
        });
    });
}
