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
// They ask for the client through getLanguageClient(), which reflects three states and nothing
// else: running (resolve now), starting (wait for that start), or not running (reject now with the
// reason). There is deliberately no "pending until something happens" state — an intentional stop,
// a failed start and a window without a workspace folder all fall into "not running", so a command
// can never hang on a handle that nothing will ever settle.
let startingClient: Promise<LanguageClient> | null = null;
let unavailableReason: Error = new Error(
    'The WurstScript language server has not been started. Open a folder containing a Wurst project.',
);

/** Resolves with the running language client, or rejects with why there is none. */
export function getLanguageClient(): Promise<LanguageClient> {
    if (clientRef) return Promise.resolve(clientRef);
    if (startingClient) return startingClient;
    return Promise.reject(unavailableReason);
}

/** The running client if there is one right now (no waiting). */
export function getRunningLanguageClient(): LanguageClient | null {
    return clientRef;
}

export async function stopLanguageServerIfRunning(): Promise<boolean> {
    if (!clientRef) return false;
    try {
        await clientRef.stop();
    } catch (error) {
        appendDiagnostic('VS Code extension', `Language server stop failed: ${formatDiagnosticError(error)}`);
    }
    clientRef = null;
    // Nothing restarts the server after an intentional stop (the install flow reloads the window
    // instead), so commands issued from now on fail fast with this reason.
    unavailableReason = new Error('The WurstScript language server was stopped.');
    return true;
}

export async function startLanguageClient(context: ExtensionContext): Promise<void> {
    if (clientRef || startingClient) return;
    let announceStarted!: (client: LanguageClient) => void;
    let announceFailed!: (error: unknown) => void;
    startingClient = new Promise<LanguageClient>((resolve, reject) => {
        announceStarted = resolve;
        announceFailed = reject;
    });
    // Consumed through getLanguageClient(); avoid an unhandled-rejection report when nobody waits.
    startingClient.catch(() => undefined);

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
        startingClient = null;
        unavailableReason = error instanceof Error ? error : new Error(String(error));
        appendDiagnostic('VS Code extension', `Wurst language server failed to start: ${formatDiagnosticError(error)}`);
        announceFailed(error);
        throw error;
    }
    startingClient = null;
    if (clientRef !== client) {
        // Stopped (or replaced) while it was still starting up: report the stop, not a client that
        // is no longer running.
        announceFailed(unavailableReason);
        return;
    }
    announceStarted(client);

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
