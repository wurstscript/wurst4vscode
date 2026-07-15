'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { COMPILER_JAR, RUNTIME_DIR } from '../paths';
import { sleep } from './fsUtils';

export interface WurstProcess {
    pid: number;
    executablePath: string;
    commandLine: string;
    languageServer: boolean;
}

const INSTALL_LOCK_PATH = path.join(os.tmpdir(), 'wurstscript-vscode-install.lock');

function normalizeProcessPath(value: string): string {
    return value.replace(/\\/g, '/').toLowerCase();
}

export function matchesWurstInstallationProcess(
    processInfo: Pick<WurstProcess, 'executablePath' | 'commandLine'>,
    runtimeDir = RUNTIME_DIR,
    compilerJar = COMPILER_JAR,
): boolean {
    const executable = normalizeProcessPath(processInfo.executablePath || '');
    const commandLine = normalizeProcessPath(processInfo.commandLine || '');
    const runtime = `${normalizeProcessPath(runtimeDir).replace(/\/$/, '')}/`;
    const jar = normalizeProcessPath(compilerJar);
    return executable.startsWith(runtime) || commandLine.includes(runtime) || commandLine.includes(jar);
}

function execFileText(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout || '');
        });
    });
}

function parseWindowsProcesses(raw: string): WurstProcess[] {
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row): WurstProcess[] => {
        if (!row || typeof row !== 'object') return [];
        const value = row as { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown };
        const pid = Number(value.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) return [];
        const executablePath = typeof value.ExecutablePath === 'string' ? value.ExecutablePath : '';
        const commandLine = typeof value.CommandLine === 'string' ? value.CommandLine : '';
        return [{ pid, executablePath, commandLine, languageServer: /(?:^|\s)-languageserver(?:\s|$)/i.test(commandLine) }];
    });
}

function parsePosixProcesses(raw: string): WurstProcess[] {
    const result: WurstProcess[] = [];
    for (const line of raw.split(/\r?\n/)) {
        // \S at the start of group 2 (rather than a bare .+ right after \s+) avoids ambiguous
        // whitespace-adjacency backtracking, since the command always starts right after the pid's
        // trailing whitespace in real `ps`-style output.
        const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        const commandLine = match[2];
        const executablePath = /^"([^"]+)"|^(\S+)/.exec(commandLine)?.slice(1).find(Boolean) ?? '';
        result.push({ pid, executablePath, commandLine, languageServer: /(?:^|\s)-languageserver(?:\s|$)/i.test(commandLine) });
    }
    return result;
}

export async function findConflictingWurstProcesses(): Promise<WurstProcess[]> {
    try {
        let processes: WurstProcess[];
        if (process.platform === 'win32') {
            try {
                processes = parseWindowsProcesses(await execFileText('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe','javaw.exe') } | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
                ]));
            } catch {
                // Some managed Windows environments deny Win32_Process/CIM
                // command-line access. Executable paths still identify every
                // process using the bundled runtime.
                processes = parseWindowsProcesses(await execFileText('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    "@(Get-Process -Name java,javaw -ErrorAction SilentlyContinue | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='ExecutablePath';Expression={$_.Path}},@{Name='CommandLine';Expression={''}}) | ConvertTo-Json -Compress",
                ]));
            }
        } else {
            processes = parsePosixProcesses(await execFileText('ps', ['-eo', 'pid=,args=']));
        }
        return processes.filter((item) => item.pid !== process.pid && matchesWurstInstallationProcess(item));
    } catch (error) {
        console.warn('[wurst] Could not inspect running Wurst processes:', error);
        return [];
    }
}

function isPidRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === 'EPERM';
    }
}

export async function forceStopWurstProcesses(processes: readonly WurstProcess[]): Promise<WurstProcess[]> {
    for (const item of processes) {
        try { process.kill(item.pid, 'SIGTERM'); } catch {}
    }
    for (let attempt = 0; attempt < 20; attempt++) {
        const remaining = processes.filter((item) => isPidRunning(item.pid));
        if (remaining.length === 0) return [];
        await sleep(150);
    }
    const remaining = processes.filter((item) => isPidRunning(item.pid));
    for (const item of remaining) {
        try { process.kill(item.pid, 'SIGKILL'); } catch {}
    }
    await sleep(200);
    return processes.filter((item) => isPidRunning(item.pid));
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
export async function ensureConflictingWurstProcessesStopped(): Promise<void> {
    while (true) {
        const conflicts = await findConflictingWurstProcesses();
        if (conflicts.length === 0) return;

        const languageServers = conflicts.filter((item) => item.languageServer).length;
        const detail = [
            `Detected ${conflicts.length} Wurst Java process${conflicts.length === 1 ? '' : 'es'} ` +
                `(${languageServers} language server${languageServers === 1 ? '' : 's'}).`,
            `Process IDs: ${conflicts.map((item) => item.pid).join(', ')}`,
            '',
            'Close other VS Code windows using WurstScript, then choose Check Again. ' +
                'Alternatively, Force Stop terminates only Java processes using this Wurst installation.',
        ].join('\n');
        const choice = await vscode.window.showWarningMessage(
            'Other WurstScript processes are using files required by the update.',
            { modal: true, detail },
            'Force Stop',
            'Check Again',
        );
        if (choice === 'Check Again') continue;
        if (choice !== 'Force Stop') throw new InstallCoordinationCancelledError();

        const remaining = await forceStopWurstProcesses(conflicts);
        if (remaining.length === 0) {
            // Language clients in older extension windows may auto-restart after
            // an external termination. Re-scan once before touching install files.
            await sleep(500);
            if ((await findConflictingWurstProcesses()).length === 0) return;
            continue;
        }
        await vscode.window.showErrorMessage(
            `Could not stop Wurst process${remaining.length === 1 ? '' : 'es'} ${remaining.map((item) => item.pid).join(', ')}. ` +
            'Close the corresponding VS Code windows and try again.',
            { modal: true },
        );
    }
}

export class InstallCoordinationCancelledError extends Error {
    readonly code = 'WURST_INSTALL_CANCELLED';
    constructor(message = 'WurstScript installation was cancelled.') {
        super(message);
        this.name = 'InstallCoordinationCancelledError';
    }
}

function readLockOwnerPid(): number | undefined {
    try {
        const value = JSON.parse(fs.readFileSync(INSTALL_LOCK_PATH, 'utf8')) as { pid?: unknown };
        const pid = Number(value.pid);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

async function acquireInstallLock(token: vscode.CancellationToken): Promise<{ release: () => void; waited: boolean }> {
    const lockToken = `${process.pid}:${Date.now()}:${Math.random()}`;
    let waited = false;
    while (true) {
        if (token.isCancellationRequested) throw new InstallCoordinationCancelledError();
        try {
            const fd = fs.openSync(INSTALL_LOCK_PATH, 'wx');
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: lockToken, startedAt: Date.now() }));
            fs.closeSync(fd);
            return {
                waited,
                release: () => {
                    try {
                        const current = JSON.parse(fs.readFileSync(INSTALL_LOCK_PATH, 'utf8')) as { token?: unknown };
                        if (current.token === lockToken) fs.unlinkSync(INSTALL_LOCK_PATH);
                    } catch {}
                },
            };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error;
            waited = true;
            const ownerPid = readLockOwnerPid();
            if (!ownerPid || !isPidRunning(ownerPid)) {
                try { fs.unlinkSync(INSTALL_LOCK_PATH); } catch {}
                continue;
            }
            await sleep(300);
        }
    }
}

export async function withWurstInstallLock<T>(action: (waited: boolean) => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Coordinating WurstScript update across VS Code windows',
            cancellable: true,
        },
        async (_progress, token) => {
            const lock = await acquireInstallLock(token);
            try {
                return await action(lock.waited);
            } finally {
                lock.release();
            }
        },
    );
}
