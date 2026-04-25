'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureInstalledOrOfferMigration, ensureGrillAvailable, runGrillGenerate } from '../install/installer';

export async function createNewWurstProject(): Promise<void> {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new Wurst project (folder name)',
        value: 'MyWurstProject',
        validateInput: (value) => {
            if (!value.trim()) return 'Project name must not be empty';
            if (value.indexOf('/') >= 0 || value.indexOf('\\') >= 0) return 'Project name must not contain path separators';
            return undefined;
        },
    });
    if (!name) return;

    const parentPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select parent folder for the new Wurst project',
    });
    if (!parentPick || parentPick.length === 0) return;

    const destDir = path.join(parentPick[0].fsPath, name);

    if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
        await vscode.window.showWarningMessage(
            `The folder "${name}" already exists and is not empty.\n\nPlease choose an empty folder for Grill project generation.`,
            { modal: true }
        );
        return;
    } else if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating Wurst project', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Ensuring WurstScript/Grill installation…', increment: 10 });
            const installOptions = { offerPostInstallActions: false };
            await ensureInstalledOrOfferMigration(false, installOptions);
            await ensureGrillAvailable(installOptions);

            progress.report({ message: 'Generating project with Grill…', increment: 30 });
            if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
                throw new Error(`Destination folder is not empty:\n${destDir}`);
            }
            await runGrillGenerate(destDir);
            progress.report({ message: 'Project created.', increment: 60 });
        }
    );

    const choice = await vscode.window.showInformationMessage(
        `Wurst project created at:\n${destDir}`, 'Open Folder', 'Close'
    );
    if (choice === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destDir), true);
    }
}
