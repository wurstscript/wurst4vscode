'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { WURST_HOME } from '../paths';

let envCollection: vscode.EnvironmentVariableCollection | null = null;
const prependedPathEntries = new Set<string>();

export function initPathManager(collection: vscode.EnvironmentVariableCollection) {
    envCollection = collection;
}

export function normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function prependPathForVsCodeTerminals(pathEntry: string) {
    if (!envCollection) return;
    const normalizedEntry = normalizePath(pathEntry);
    if (prependedPathEntries.has(normalizedEntry)) return;

    const envPath = process.env.PATH ?? '';
    const existingEntries = envPath.split(path.delimiter).filter(Boolean).map((e) => normalizePath(e));
    if (existingEntries.includes(normalizedEntry)) {
        prependedPathEntries.add(normalizedEntry);
        return;
    }

    envCollection.prepend('PATH', `${pathEntry}${path.delimiter}`);
    process.env.PATH = `${pathEntry}${path.delimiter}${envPath}`;
    prependedPathEntries.add(normalizedEntry);
}

export type CliPathUpdate = {
    updated: boolean;
    targetDir: string | null;
    needsTerminalRestart: boolean;
    notes: string[];
};

export async function ensureCliOnPath(): Promise<CliPathUpdate> {
    const notes: string[] = [];
    if (!fs.existsSync(WURST_HOME)) return { updated: false, targetDir: null, needsTerminalRestart: false, notes };
    const targetDir = WURST_HOME;

    const envPath = process.env.PATH ?? '';
    const entries = envPath.split(path.delimiter).filter(Boolean);
    const normalized = entries.map((e) => normalizePath(e));

    if (normalized.includes(normalizePath(targetDir))) {
        return { updated: false, targetDir, needsTerminalRestart: false, notes };
    }

    prependPathForVsCodeTerminals(targetDir);
    const updated = await updateUserPath(targetDir, notes);
    return { updated, targetDir, needsTerminalRestart: true, notes };
}

async function updateUserPath(pathEntry: string, notes: string[]): Promise<boolean> {
    if (process.platform === 'win32') {
        const updated = setWindowsUserPath(pathEntry);
        if (updated) notes.push('Updated Windows user PATH.');
        return updated;
    }
    return updateShellProfiles(pathEntry, notes);
}

function updateShellProfiles(pathEntry: string, notes: string[]): boolean {
    const home = os.homedir();
    let changed = false;
    changed = ensurePathExport(path.join(home, '.profile'), pathEntry, notes) || changed;
    changed = ensurePathExport(path.join(home, '.zprofile'), pathEntry, notes) || changed;
    return changed;
}

function ensurePathExport(profilePath: string, pathEntry: string, notes: string[]): boolean {
    const markerStart = '# >>> WurstScript CLI >>>';
    const markerEnd = '# <<< WurstScript CLI <<<';

    let content = '';
    if (fs.existsSync(profilePath)) {
        content = fs.readFileSync(profilePath, 'utf8');
        if (content.includes(markerStart) && content.includes(markerEnd)) return false;
    }

    const block = `\n${markerStart}\nexport PATH="${pathEntry}:$PATH"\n${markerEnd}\n`;
    try {
        fs.appendFileSync(profilePath, block, 'utf8');
        notes.push(`Added PATH export to ${profilePath}.`);
        return true;
    } catch (error) {
        notes.push(`Could not update ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

function setWindowsUserPath(pathEntry: string): boolean {
    const existing = getWindowsUserPath();
    const entries = existing ? existing.split(';').map((e) => e.trim()).filter(Boolean) : [];
    const normalized = entries.map((e) => normalizePath(e));
    if (normalized.includes(normalizePath(pathEntry))) return false;

    const updated = [...entries, pathEntry].join(';');
    const escaped = updated.replace(/'/g, "''");
    const res = spawnSync('powershell.exe',
        ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path', '${escaped}', 'User')`],
        { encoding: 'utf8', windowsHide: true }
    );
    return res.status === 0;
}

function getWindowsUserPath(): string {
    const res = spawnSync('powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
        { encoding: 'utf8', windowsHide: true }
    );
    return (res.stdout || '').trim();
}

export async function offerPostInstallActions(update: CliPathUpdate): Promise<void> {
    const extra = update.updated ? '\n\nRestart terminals or open a new shell to pick up PATH changes.' : '';
    const choice = await vscode.window.showInformationMessage(
        `WurstScript was updated. Restart VS Code now to use the new runtime?${extra}`,
        { modal: true }, 'Restart', 'Cancel'
    );
    if (choice === 'Restart') {
        if (update.needsTerminalRestart) {
            await vscode.commands.executeCommand('workbench.action.terminal.killAll');
            await vscode.commands.executeCommand('workbench.action.terminal.new');
        }
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}
