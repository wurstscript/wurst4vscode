'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient/node';
import { RUNTIME_DIR, COMPILER_JAR } from './paths';
import { getBundledJava, checkCustomJavaVersion, getInstalledVersionString, ensureInstalledOrOfferMigration, maybeOfferUpdate } from './install/installer';
import type { UpdateAvailable } from './install/installer';
import { registerCommands } from './features/commands';
import { registerFileCreation } from './features/fileCreation';
import { appendDiagnostic, formatDiagnosticError } from './features/diagnostics';

let clientRef: LanguageClient | null = null;

export async function stopLanguageServerIfRunning(): Promise<boolean> {
    if (!clientRef) return false;
    try {
        await clientRef.stop();
    } catch (error) {
        appendDiagnostic('VS Code extension', `Language server stop failed: ${formatDiagnosticError(error)}`);
    }
    clientRef = null;
    return true;
}

export async function startLanguageClient(context: ExtensionContext): Promise<void> {
    if (clientRef) return;

    await ensureInstalledOrOfferMigration(false);

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
        const detail = formatDiagnosticError(error);
        const message = error instanceof Error ? error.message : String(error);
        appendDiagnostic('VS Code extension', `Wurst language server failed to start: ${detail}`);
        vscode.window.showErrorMessage(`Wurst language server failed to start: ${message}`);
        throw error;
    }

    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    let installedVersion = 'detecting...';
    let availableUpdate: UpdateAvailable | undefined;
    const updateStatusBar = () => {
        sb.text = availableUpdate ? '$(cloud-download) WurstScript Update' : '$(check) WurstScript';
        sb.tooltip = [
            availableUpdate ? 'A newer WurstScript version is available.' : 'WurstScript language server is running.',
            `Version: ${installedVersion}`,
            availableUpdate ? `Latest: ${availableUpdate.latestSha.slice(0, 7)}` : undefined,
            'Click for WurstScript actions.',
        ].filter(Boolean).join('\n');
    };
    updateStatusBar();
    sb.command = 'wurst.showDiagnosticsActions';
    sb.show();
    context.subscriptions.push(sb);

    client.onNotification('wurst/updateGamePath', (params) => {
        workspace.getConfiguration().update('wurst.wc3path', params);
    });

    context.subscriptions.push(registerCommands(client));
    context.subscriptions.push(registerFileCreation());
    context.subscriptions.push(registerFileChanges(client));

    // Version detection starts a JVM and the update check performs network I/O.
    // Neither should delay language features or block the extension host.
    void getInstalledVersionString().then((version) => {
        try {
            installedVersion = version ?? 'unknown';
            updateStatusBar();
        } catch { /* status item was disposed during shutdown */ }
    });
    void maybeOfferUpdate((update) => {
        try {
            availableUpdate = update;
            updateStatusBar();
        } catch { /* status item was disposed during shutdown */ }
    });
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
    if (customJava) await checkCustomJavaVersion(customJava);
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
