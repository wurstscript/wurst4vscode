'use strict';

import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { initPathManager } from './install/pathManager';
import { installWithRetry } from './install/installer';
import { startLanguageClient, stopLanguageServerIfRunning } from './languageServer';
import {
    findConflictingWurstProcesses,
    forceStopWurstProcesses,
    InstallCoordinationCancelledError,
} from './install/installCoordination';
import { setupDecorators } from './features/compileTimeDecorator';
import { createNewWurstProject } from './features/newProject';
import { registerBlpPreview } from './features/blpPreview';
import { registerSoundPreview } from './features/soundPreview';
import { registerMpqViewer } from './features/mpqViewer';
import { registerAssetLinks } from './features/assetLinks';
import { registerImagePreviewHover } from './features/imagePreviewHover';
import { registerInlineImageDecorations } from './features/inlineImageDecorations';
import { registerObjModPreview } from './features/objModPreview';
import { registerWpmPreview } from './features/wpmPreview';
import { registerDooPreview } from './features/dooPreview';
import { registerTriggerPreview } from './features/triggerPreview';
import { registerMapDataPreview } from './features/mapDataPreview';
import { registerMapPreview } from './features/mapPreview';
import { registerAgentsGuideOffer } from './features/agentsGuide';
import { openIssueReport } from './features/issueReporting';

export async function activate(context: ExtensionContext) {
    console.log('Wurst extension activated!');
    initPathManager(context.environmentVariableCollection);

    setupDecorators(context);
    context.subscriptions.push(registerBlpPreview(context));
    context.subscriptions.push(registerSoundPreview(context));
    context.subscriptions.push(registerMpqViewer(context));
    context.subscriptions.push(registerAssetLinks(context));
    context.subscriptions.push(registerImagePreviewHover(context));
    context.subscriptions.push(registerInlineImageDecorations(context));
    context.subscriptions.push(registerObjModPreview(context));
    context.subscriptions.push(...registerWpmPreview(context));
    context.subscriptions.push(registerDooPreview(context));
    context.subscriptions.push(...registerTriggerPreview(context));
    context.subscriptions.push(registerMapDataPreview(context));
    context.subscriptions.push(registerMapPreview(context));
    context.subscriptions.push(registerAgentsGuideOffer(context));

    registerBasicCommands(context);
    openObjModE2eFixture();

    await startLanguageClientWhenWorkspaceIsOpen(context);
}

function openObjModE2eFixture(): void {
    const file = process.env.WURST_OBJMOD_E2E === '1' ? process.env.WURST_OBJMOD_E2E_FILE : '';
    if (!file) return;
    setTimeout(() => {
        void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'wurst.objModPreview', { preview: false });
    }, 250);
}

function registerBasicCommands(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.chooseGameExecutable', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { Executables: ['exe', 'bin', '*'] },
                openLabel: 'Select Game Executable',
            });
            if (uris && uris.length > 0) {
                const exePath = uris[0].fsPath;
                await workspace.getConfiguration().update('wurst.gameExePath', exePath, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage(`Wurst game executable path set: ${exePath}`);
            }
        }),
        vscode.commands.registerCommand('wurst.installOrUpdate', async () => {
            const choice = await vscode.window.showWarningMessage(
                'Reinstall WurstScript from the latest nightly build? VS Code will reload when installation completes.',
                { modal: true },
                'Reinstall'
            );
            if (choice !== 'Reinstall') return;
            try {
                await installWithRetry({ offerPostInstallActions: false });
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            } catch (e: any) {
                if (e instanceof InstallCoordinationCancelledError) return;
                vscode.window.showErrorMessage(`Install/Update failed: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('wurst.stopAllProcesses', async () => {
            const conflicts = await findConflictingWurstProcesses();
            if (conflicts.length === 0) {
                const stoppedLocalServer = await stopLanguageServerIfRunning();
                vscode.window.showInformationMessage(stoppedLocalServer
                    ? 'Stopped the WurstScript language server in this VS Code window.'
                    : 'No running WurstScript processes were found.');
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `Force stop ${conflicts.length} WurstScript Java process${conflicts.length === 1 ? '' : 'es'}?`,
                {
                    modal: true,
                    detail: `Process IDs: ${conflicts.map((item) => item.pid).join(', ')}\n\n` +
                        'Only Java processes using this Wurst installation will be terminated.',
                },
                'Force Stop'
            );
            if (choice !== 'Force Stop') return;
            await stopLanguageServerIfRunning();
            const remaining = await forceStopWurstProcesses(await findConflictingWurstProcesses());
            if (remaining.length > 0) {
                vscode.window.showErrorMessage(
                    `Could not stop Wurst process${remaining.length === 1 ? '' : 'es'} ${remaining.map((item) => item.pid).join(', ')}.`,
                    { modal: true },
                );
                return;
            }
            vscode.window.showInformationMessage('Stopped all detected WurstScript processes.');
        }),
        vscode.commands.registerCommand('wurst.newProject', async () => {
            try {
                await createNewWurstProject();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to create Wurst project: ${e?.message ?? String(e)}`);
            }
        }),
        vscode.commands.registerCommand('wurst.reportIssue', () => openIssueReport())
    );
}

async function startLanguageClientWhenWorkspaceIsOpen(context: ExtensionContext): Promise<void> {
    if (!workspace.workspaceFolders?.length) {
        const listener = workspace.onDidChangeWorkspaceFolders(async () => {
            if (workspace.workspaceFolders?.length) {
                listener.dispose();
                await startLanguageClientWhenWorkspaceIsOpen(context);
            }
        });
        context.subscriptions.push(listener);
        return;
    }

    try {
        await startLanguageClient(context);
    } catch (err) {
        console.error('Failed to start language client:', err);
        vscode.window.showWarningMessage(`Wurst language features disabled: ${err}`);
    }
}
