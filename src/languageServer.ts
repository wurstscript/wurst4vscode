'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient/node';
import { RUNTIME_DIR, COMPILER_JAR } from './paths';
import { getBundledJava, checkCustomJavaVersion, getInstalledVersionString, ensureInstalledOrOfferMigration, maybeOfferUpdate } from './install/installer';
import { registerCommands } from './features/commands';
import { registerFileCreation } from './features/fileCreation';

let clientRef: LanguageClient | null = null;

export async function stopLanguageServerIfRunning(): Promise<void> {
    if (!clientRef) return;
    try { await clientRef.stop(); } catch {}
    clientRef = null;
}

export async function startLanguageClient(context: ExtensionContext): Promise<void> {
    if (clientRef) return;

    await ensureInstalledOrOfferMigration(false);
    await maybeOfferUpdate();

    const serverOptions = await getServerOptions();
    const clientOptions: LanguageClientOptions = {
        documentSelector: ['wurst'],
        synchronize: { configurationSection: 'wurst' },
    };

    const client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);
    clientRef = client;

    try {
        const startResult = client.start();
        if (isDisposable(startResult)) {
            context.subscriptions.push(startResult);
        } else {
            context.subscriptions.push({ dispose: () => client.stop() });
            await startResult;
        }

        const anyClient = client as LanguageClient & { onReady?: () => Promise<void> };
        if (typeof anyClient.onReady === 'function') await anyClient.onReady();
    } catch (error) {
        clientRef = null;
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Wurst language server failed to start: ${message}`);
        throw error;
    }

    const version = getInstalledVersionString() ?? 'unknown';
    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    sb.text = '$(check) WurstScript';
    sb.tooltip = ['WurstScript language server is running.', `Version: ${version}`, 'Click to open logs.'].join('\n');
    sb.command = 'wurst.showLogs';
    sb.show();
    context.subscriptions.push(sb);

    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.showLogs', () => {
            try { client.outputChannel.show(); }
            catch { vscode.commands.executeCommand('workbench.action.output.toggleOutput'); }
        })
    );

    client.onNotification('wurst/updateGamePath', (params) => {
        workspace.getConfiguration().update('wurst.wc3path', params);
    });

    context.subscriptions.push(registerCommands(client));
    context.subscriptions.push(registerFileCreation());
    context.subscriptions.push(registerFileChanges(client));
}

export function registerFileChanges(client: LanguageClient): vscode.FileSystemWatcher {
    const watcher = workspace.createFileSystemWatcher('**/*.wurst');
    const notify = (type: number, uri: vscode.Uri) =>
        client.sendNotification('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type }] });
    watcher.onDidCreate((uri) => notify(1, uri));
    watcher.onDidChange((uri) => notify(2, uri));
    watcher.onDidDelete((uri) => notify(3, uri));
    return watcher;
}

async function getServerOptions(): Promise<ServerOptions> {
    const config = workspace.getConfiguration('wurst');
    const javaOpts = config.get<string[]>('javaOpts') ?? [];
    const debugMode = config.get<boolean>('debugMode', false) === true;
    const customJava = config.get<string>('javaExecutable')?.trim() || '';

    if (!customJava && (!fs.existsSync(RUNTIME_DIR) || !fs.existsSync(COMPILER_JAR))) {
        throw new Error('WurstScript is not installed. Use the "Wurst: Install/Update" command.');
    }
    if (customJava && !fs.existsSync(COMPILER_JAR)) {
        throw new Error('WurstScript compiler not found. Use the "Wurst: Install/Update" command.');
    }

    const java = customJava || getBundledJava();
    if (customJava) checkCustomJavaVersion(customJava);
    const platformOpts = process.platform === 'darwin' ? ['-Dapple.awt.UIElement=true'] : [];
    const args = [...platformOpts, ...javaOpts, '-jar', COMPILER_JAR, '-languageServer'];

    if (debugMode && (await isPortOpen(5005))) {
        args.unshift('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y');
    }

    const exec: Executable = { command: java, args };
    return { run: exec, debug: exec };
}

function isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', (err: { code: string }) => resolve(err.code !== 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port);
    });
}

function isDisposable(value: unknown): value is vscode.Disposable {
    return !!value && typeof (value as vscode.Disposable).dispose === 'function';
}
