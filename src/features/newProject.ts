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
    if (cwd) {
        watchForGeneratedProject(cwd, terminal);
    }
    terminal.sendText('grill generate');
}

// `grill generate` scaffolds a new project as a subfolder of `cwd`, named by the
// user during the interactive wizard. Once it finishes, the user is left in the
// parent folder, where the freshly generated wurst files error out because the
// workspace root is wrong. Watch for the project's `wurst.build` marker appearing
// one level below `cwd` and offer to reopen VS Code rooted at that folder.
function watchForGeneratedProject(cwd: string, terminal: vscode.Terminal): void {
    const pattern = new vscode.RelativePattern(cwd, '*/wurst.build');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);

    const disposables: vscode.Disposable[] = [watcher];
    let handled = false;
    const cleanup = () => {
        for (const d of disposables.splice(0)) {
            d.dispose();
        }
    };

    // Give up after a generous window so a watcher never lingers if the user
    // abandons the wizard. Also tear down if they close the terminal.
    const timer = setTimeout(cleanup, 30 * 60 * 1000);
    disposables.push({ dispose: () => clearTimeout(timer) });
    disposables.push(vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) cleanup();
    }));

    watcher.onDidCreate(async (uri) => {
        if (handled) return;
        handled = true;
        cleanup();
        await offerOpenGeneratedProject(path.dirname(uri.fsPath));
    });
}

async function offerOpenGeneratedProject(projectDir: string): Promise<void> {
    const name = path.basename(projectDir);
    const OPEN = 'Open';
    const OPEN_NEW = 'Open in New Window';
    const choice = await vscode.window.showInformationMessage(
        `Wurst project "${name}" generated. Open it as the workspace root?`,
        OPEN,
        OPEN_NEW
    );
    if (!choice) return;

    await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(projectDir),
        { forceNewWindow: choice === OPEN_NEW }
    );
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
