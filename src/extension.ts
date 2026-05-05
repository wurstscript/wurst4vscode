'use strict';

import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { initPathManager } from './install/pathManager';
import { ensureInstalledOrOfferMigration } from './install/installer';
import { startLanguageClient } from './languageServer';
import { setupDecorators } from './features/compileTimeDecorator';
import { createNewWurstProject } from './features/newProject';
import { registerBlpPreview } from './features/blpPreview';
import { registerMpqViewer } from './features/mpqViewer';
import { registerAssetLinks } from './features/assetLinks';
import { registerImagePreviewHover } from './features/imagePreviewHover';
import { registerInlineImageDecorations } from './features/inlineImageDecorations';
import { registerObjModPreview } from './features/objModPreview';
import { registerWpmPreview } from './features/wpmPreview';
import { registerDooPreview } from './features/dooPreview';
import { registerTriggerPreview } from './features/triggerPreview';
import { registerAgentsGuideOffer } from './features/agentsGuide';

export async function activate(context: ExtensionContext) {
    console.log('Wurst extension activated!');
    initPathManager(context.environmentVariableCollection);

    setupDecorators(context);
    context.subscriptions.push(registerBlpPreview(context));
    context.subscriptions.push(registerMpqViewer(context));
    context.subscriptions.push(registerAssetLinks(context));
    context.subscriptions.push(registerImagePreviewHover(context));
    context.subscriptions.push(registerInlineImageDecorations(context));
    context.subscriptions.push(registerObjModPreview(context));
    context.subscriptions.push(...registerWpmPreview(context));
    context.subscriptions.push(registerDooPreview(context));
    context.subscriptions.push(...registerTriggerPreview(context));
    context.subscriptions.push(registerAgentsGuideOffer(context));

    registerBasicCommands(context);

    await startLanguageClientWhenWorkspaceIsOpen(context);
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
            try {
                await ensureInstalledOrOfferMigration(true);
                vscode.window.showInformationMessage('WurstScript is installed and up to date.');
            } catch (e: any) {
                vscode.window.showErrorMessage(`Install/Update failed: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('wurst.newProject', async () => {
            try {
                await createNewWurstProject();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to create Wurst project: ${e?.message ?? String(e)}`);
            }
        })
    );
}

async function startLanguageClientWhenWorkspaceIsOpen(context: ExtensionContext): Promise<void> {
    if (!workspace.workspaceFolders?.length) {
        context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(async () => {
            if (workspace.workspaceFolders?.length) {
                await startLanguageClientWhenWorkspaceIsOpen(context);
            }
        }));
        return;
    }

    try {
        await startLanguageClient(context);
    } catch (err) {
        console.error('Failed to start language client:', err);
        vscode.window.showWarningMessage(`Wurst language features disabled: ${err}`);
    }
}
