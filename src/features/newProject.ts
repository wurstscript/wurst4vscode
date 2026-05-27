'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { WURST_HOME } from '../paths';
import { ensureInstalledOrOfferMigration, ensureGrillAvailable, getBundledGrillExecutable } from '../install/installer';
import { prependPathForVsCodeTerminals } from '../install/pathManager';

export async function createNewWurstProject(): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Starting Grill project wizard', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Ensuring WurstScript/Grill installation...', increment: 50 });
            const installOptions = { offerPostInstallActions: false };
            await ensureInstalledOrOfferMigration(false, installOptions);
            await ensureGrillAvailable(installOptions);
        }
    );

    const cwd = await pickTerminalWorkingDirectory();
    if (cwd === null) return;

    const hasBundledGrill = !!getBundledGrillExecutable();
    if (hasBundledGrill) {
        prependPathForVsCodeTerminals(WURST_HOME);
    }

    const terminal = vscode.window.createTerminal({
        name: 'Wurst: New Project',
        cwd: cwd ?? undefined,
        env: hasBundledGrill ? { PATH: `${WURST_HOME}${path.delimiter}${process.env.PATH ?? ''}` } : undefined,
    });
    terminal.show();
    terminal.sendText('grill generate');
}

async function pickTerminalWorkingDirectory(): Promise<string | null | undefined> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) return activeFolder.uri.fsPath;

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) return undefined;
    if (workspaceFolders.length === 1) return workspaceFolders[0].uri.fsPath;

    const picked = await vscode.window.showQuickPick(
        workspaceFolders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder,
        })),
        {
            title: 'Wurst: Select terminal folder',
            placeHolder: 'Choose where to start the Grill project wizard',
        }
    );
    return picked?.folder.uri.fsPath ?? null;
}
