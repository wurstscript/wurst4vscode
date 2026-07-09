'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { workspace } from 'vscode';
import {
    WURST_HOME, RUNTIME_DIR, COMPILER_DIR, COMPILER_JAR, GRILL_HOME_DIR,
} from '../paths';
import {
    normalizeInstallerPaths, migrateLegacyGrillLayout, installLauncherExecutable,
    isRecoverableInstallError, cleanupOldWurstHome, cleanupWurstSetupJar,
    removeDirSafe, upgradeFolder, ensureDirectoryPath,
    copyDirContents, withRetry,
} from './fsUtils';
import { fetchNightlyZipAsset, fetchLatestGrillAsset, fetchNightlyCommitSha, downloadFileWithProgress, extractZipWithByteProgress } from './downloader';
import { ensureCliOnPath, offerPostInstallActions } from './pathManager';
import { stopLanguageServerIfRunning } from '../languageServer';

type InstallOptions = {
    offerPostInstallActions?: boolean;
};

type PreparedNightlyInstall = {
    tmpWork: string;
    unpack: string;
    grillJar: string;
};

const UPDATE_SNOOZE_UNTIL_KEY = 'wurst.updatePrompt.snoozedUntil';

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

export async function ensureInstalledOrOfferMigration(forcePrompt: boolean, options: InstallOptions = {}): Promise<void> {
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
            await installWithRetry(options);
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
        await installWithRetry(options);
        return;
    }

    if (!fs.existsSync(COMPILER_JAR)) {
        await installWithRetry(options);
    }
}

export async function ensureGrillAvailable(options: InstallOptions = {}): Promise<void> {
    if (getBundledGrillExecutable() || isGrillOnPath()) return;
    await installWithRetry(options);
    if (!getBundledGrillExecutable() && !isGrillOnPath()) {
        throw new Error('Grill CLI is not available. Please run "Wurst: Install/Update" and try again.');
    }
}

export async function installWithRetry(options: InstallOptions = {}): Promise<void> {
    let autoRepairAttempted = false;
    let prepared: PreparedNightlyInstall | undefined;
    try {
        while (true) {
            try {
                prepared = await prepareNightlyInstall(prepared);
                await installPreparedNightly(prepared, options);
                return;
            } catch (error) {
                if (!autoRepairAttempted && isRecoverableInstallError(error)) {
                    autoRepairAttempted = true;
                    try { await repairInstallationLayout(); continue; } catch {}
                }
                const message = error instanceof Error ? error.message : String(error);
                const detail = [
                    prepared ? 'Retry and Repair will reuse the already downloaded installer files.' : undefined,
                    isRecoverableInstallError(error)
                        ? 'If a file is locked, close running Wurst/Java/Warcraft processes or old terminals, then Retry.'
                        : undefined,
                ].filter(Boolean).join('\n\n') || undefined;
                const choice = await vscode.window.showErrorMessage(
                    `Installation failed: ${message}`, { modal: true, detail }, 'Retry', 'Repair'
                );
                if (choice === 'Repair') { await repairInstallationLayout(); continue; }
                if (choice !== 'Retry') throw error;
            }
        }
    } finally {
        if (prepared) {
            try { await removeDirSafe(prepared.tmpWork); } catch {}
        }
    }
}

async function prepareNightlyInstall(existing?: PreparedNightlyInstall): Promise<PreparedNightlyInstall> {
    if (existing && fs.existsSync(existing.unpack) && fs.existsSync(existing.grillJar)) {
        return existing;
    }

    let tmpWork: string | undefined;
    try {
        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Preparing WurstScript installer', cancellable: false },
            async (progress) => {
                progress.report({ message: 'Fetching release info...', increment: 5 });
                const asset = await fetchNightlyZipAsset();

                tmpWork = path.join(os.tmpdir(), `wurst-install-${Date.now()}-${process.pid}`);
                const tmpZip = path.join(tmpWork, 'payload.zip');
                const unpack = path.join(tmpWork, 'unpacked');
                const grillJar = path.join(tmpWork, 'grill.jar');
                fs.mkdirSync(unpack, { recursive: true });

                let last = 0;
                const DL_WEIGHT = 70, EX_WEIGHT = 18, GRILL_WEIGHT = 10;

                await downloadFileWithProgress(asset.url, tmpZip, (pct) => {
                    const scaled = (pct / 100) * DL_WEIGHT;
                    const inc = Math.max(0, scaled - last); last += inc;
                    progress.report({ message: `Downloading compiler... ${Math.floor(pct)}%`, increment: inc });
                });

                await extractZipWithByteProgress(tmpZip, unpack, (pct) => {
                    const scaled = DL_WEIGHT + (pct / 100) * EX_WEIGHT;
                    const inc = Math.max(0, scaled - last); last += inc;
                    progress.report({ message: `Extracting compiler... ${Math.floor(pct)}%`, increment: inc });
                });
                try { fs.unlinkSync(tmpZip); } catch {}

                const srcRuntime = path.join(unpack, 'wurst-runtime');
                const srcCompiler = path.join(unpack, 'wurst-compiler');
                if (!fs.existsSync(srcRuntime) || !fs.existsSync(path.join(srcCompiler, 'wurstscript.jar'))) {
                    throw new Error('Installation incomplete: runtime or compiler not found after extraction.');
                }

                const grillAsset = await fetchLatestGrillAsset();
                await downloadFileWithProgress(grillAsset.url, grillJar, (pct) => {
                    const scaled = DL_WEIGHT + EX_WEIGHT + (pct / 100) * GRILL_WEIGHT;
                    const inc = Math.max(0, scaled - last); last += inc;
                    progress.report({ message: `Downloading Grill CLI... ${Math.floor(pct)}%`, increment: inc });
                });

                progress.report({ message: 'Installer ready', increment: Math.max(0, 100 - last) });
                return { tmpWork, unpack, grillJar };
            }
        );
    } catch (error) {
        if (tmpWork) {
            try { await removeDirSafe(tmpWork); } catch {}
        }
        throw error;
    }
}

async function installPreparedNightly(prepared: PreparedNightlyInstall, options: InstallOptions): Promise<void> {
    await stopLanguageServerIfRunning();

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing WurstScript', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Preparing local install files...', increment: 5 });
            const attemptWork = path.join(prepared.tmpWork, `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            const attemptUnpack = path.join(attemptWork, 'unpacked');

            try {
                copyDirContents(prepared.unpack, attemptUnpack);

                const srcRuntime = path.join(attemptUnpack, 'wurst-runtime');
                const srcCompiler = path.join(attemptUnpack, 'wurst-compiler');
                const srcLauncher = path.join(attemptUnpack, process.platform === 'win32' ? 'wurstscript.cmd' : 'wurstscript');
                const srcGrill = path.join(attemptUnpack, process.platform === 'win32' ? 'grill.cmd' : 'grill');

                progress.report({ message: 'Installing bundled runtime...', increment: 25 });
                fs.mkdirSync(WURST_HOME, { recursive: true });
                await upgradeFolder(srcRuntime, RUNTIME_DIR);

                progress.report({ message: 'Installing compiler...', increment: 35 });
                await upgradeFolder(srcCompiler, COMPILER_DIR);
                installLauncherExecutable(srcLauncher);
                installLauncherExecutable(srcGrill);
                chmodRuntimeExecutables();

                progress.report({ message: 'Installing Grill CLI...', increment: 20 });
                ensureDirectoryPath(GRILL_HOME_DIR);
                const grillDest = path.join(GRILL_HOME_DIR, 'grill.jar');
                await withRetry(() => fs.copyFileSync(prepared.grillJar, grillDest));
                console.log('[wurst] Installed Grill CLI at', grillDest);

                cleanupOldWurstHome();
                cleanupWurstSetupJar();
            } finally {
                try { await removeDirSafe(attemptWork); } catch {}
            }

            progress.report({ message: 'Finishing up installation...', increment: 15 });

            const pathUpdate = await ensureCliOnPath();
            if (options.offerPostInstallActions !== false) {
                await offerPostInstallActions(pathUpdate);
            }
        }
    );
}

export async function maybeOfferUpdate(context?: vscode.ExtensionContext): Promise<void> {
    try {
        if (!hasNewLayout() || !fs.existsSync(COMPILER_JAR)) return;
        const snoozedUntil = context?.globalState.get<number>(UPDATE_SNOOZE_UNTIL_KEY) ?? 0;
        if (snoozedUntil > Date.now()) return;

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
        if (choice === 'Update') {
            await context?.globalState.update(UPDATE_SNOOZE_UNTIL_KEY, undefined);
            await installWithRetry();
        } else if (choice === 'Later') {
            await context?.globalState.update(UPDATE_SNOOZE_UNTIL_KEY, nextLocalDayStartMs());
        }
    } catch (e) {
        console.warn('Update check failed:', e);
    }
}

function nextLocalDayStartMs(): number {
    const next = new Date();
    next.setHours(24, 0, 0, 0);
    return next.getTime();
}
