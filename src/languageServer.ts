'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient/node';
import { RUNTIME_DIR, COMPILER_JAR } from './paths';
import { getBundledJava, checkCustomJavaVersion, getInstalledVersionString, ensureInstalledOrOfferMigration, maybeOfferUpdate } from './install/installer';
import type { UpdateAvailable } from './install/installer';
import { appendDiagnostic, formatDiagnosticError } from './features/diagnostics';

let clientRef: LanguageClient | null = null;

// Commands that talk to the server are registered at activation, before (and independent of) the
// JVM start, so they exist in the palette even while the server is still booting or when it failed.
// They await this handle; it resolves once the client is running and rejects when startup failed,
// so a command never hangs silently and can point the user at the install/update action instead.
type ClientDeferred = {
    promise: Promise<LanguageClient>;
    resolve: (client: LanguageClient) => void;
    reject: (error: unknown) => void;
    settled: boolean;
};

function newClientDeferred(): ClientDeferred {
    const deferred = {} as ClientDeferred;
    deferred.settled = false;
    deferred.promise = new Promise<LanguageClient>((resolve, reject) => {
        deferred.resolve = (client) => { deferred.settled = true; resolve(client); };
        deferred.reject = (error) => { deferred.settled = true; reject(error); };
    });
    // A rejected handle is consumed through getLanguageClient(); avoid an unhandled-rejection report
    // when nobody happens to be waiting on it.
    deferred.promise.catch(() => undefined);
    return deferred;
}

let clientDeferred = newClientDeferred();

/** Resolves with the running language client, or rejects if the server could not be started. */
export function getLanguageClient(): Promise<LanguageClient> {
    return clientDeferred.promise;
}

/** The running client if there is one right now (no waiting). */
export function getRunningLanguageClient(): LanguageClient | null {
    return clientRef;
}

function resetClientHandle(): void {
    if (clientDeferred.settled) clientDeferred = newClientDeferred();
}

export async function stopLanguageServerIfRunning(): Promise<boolean> {
    if (!clientRef) return false;
    try {
        await clientRef.stop();
    } catch (error) {
        appendDiagnostic('VS Code extension', `Language server stop failed: ${formatDiagnosticError(error)}`);
    }
    clientRef = null;
    resetClientHandle();
    return true;
}

export async function startLanguageClient(context: ExtensionContext): Promise<void> {
    if (clientRef) return;
    resetClientHandle();

    let client: LanguageClient;
    try {
        await ensureInstalledOrOfferMigration(false);

        const serverOptions = await getServerOptions();
        const clientOptions: LanguageClientOptions = {
            documentSelector: ['wurst'],
            synchronize: { configurationSection: 'wurst' },
        };

        client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);
        clientRef = client;

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
        appendDiagnostic('VS Code extension', `Wurst language server failed to start: ${formatDiagnosticError(error)}`);
        clientDeferred.reject(error);
        throw error;
    }
    clientDeferred.resolve(client);

    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    let installedVersion = 'detecting...';
    let availableUpdate: UpdateAvailable | undefined;
    const updateStatusBar = () => {
        sb.text = availableUpdate ? '$(circle-filled) WurstScript Update' : '$(check) WurstScript';
        sb.color = availableUpdate ? '#3794ff' : undefined;
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

    context.subscriptions.push(registerFileChanges(client));

    // Version detection may start a JVM (once per installed jar, then served from a disk cache) and
    // the update check performs network I/O. Neither should delay language features or block the
    // extension host.
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
