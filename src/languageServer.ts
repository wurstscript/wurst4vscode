'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient/node';
import { RUNTIME_DIR, COMPILER_JAR } from './paths';
import { getLanguageServerJava, checkCustomJavaVersion, getInstalledVersionString, ensureInstalledOrOfferMigration, maybeOfferUpdate } from './install/installer';
import type { UpdateAvailable } from './install/installer';
import { appendDiagnostic, formatDiagnosticError } from './features/diagnostics';

let clientRef: LanguageClient | null = null;

// The status item exists from the first activation frame, before any install check or JVM start,
// so the user sees Wurst is active and what it is doing while the server boots and builds.
type ServerState =
    | { kind: 'noWorkspace' }
    | { kind: 'starting' }
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'failed'; reason: string }
    | { kind: 'stopped' };

let statusItem: vscode.StatusBarItem | undefined;
let serverState: ServerState = { kind: 'noWorkspace' };
let installedVersion: string | undefined;
let availableUpdate: UpdateAvailable | undefined;

// A workspace/symbol query that matches nothing. The server's worker answers user requests only
// after its init and initial full build, so the reply marks the end of the initial workspace load.
const INITIAL_BUILD_PROBE_QUERY = '\u0000wurst-initial-build-probe';

export function showWurstStatusItem(context: ExtensionContext): void {
    if (statusItem) return;
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.command = 'wurst.showDiagnosticsActions';
    statusItem = item;
    context.subscriptions.push(item, { dispose: () => { if (statusItem === item) statusItem = undefined; } });
    renderStatusItem();
    item.show();
}

function setServerState(state: ServerState): void {
    serverState = state;
    renderStatusItem();
}

function renderStatusItem(): void {
    const sb = statusItem;
    if (!sb) return;
    const busy = serverState.kind === 'starting' || serverState.kind === 'loading';
    const update = busy ? undefined : availableUpdate;
    let icon: string;
    let summary: string;
    switch (serverState.kind) {
        case 'noWorkspace':
            icon = '$(circle-outline)';
            summary = 'Open a folder containing a Wurst project to start the language server.';
            break;
        case 'starting':
            icon = '$(sync~spin)';
            summary = 'Starting the WurstScript language server...';
            break;
        case 'loading':
            icon = '$(sync~spin)';
            summary = 'Loading the workspace...';
            break;
        case 'ready':
            icon = '$(check)';
            summary = 'WurstScript language server is running.';
            break;
        case 'failed':
            icon = '$(warning)';
            summary = `WurstScript language server is not running: ${serverState.reason}`;
            break;
        case 'stopped':
            icon = '$(circle-slash)';
            summary = 'WurstScript language server was stopped.';
            break;
    }
    sb.text = update ? '$(circle-filled) WurstScript Update' : `${icon} WurstScript`;
    sb.color = update ? '#3794ff' : undefined;
    sb.tooltip = [
        summary,
        update ? 'A newer WurstScript version is available.' : undefined,
        installedVersion ? `Version: ${installedVersion}` : undefined,
        update ? `Latest: ${update.latestSha.slice(0, 7)}` : undefined,
        update ? 'Click to update WurstScript.' : 'Click for WurstScript actions.',
    ].filter(Boolean).join('\n');
}

async function waitForInitialBuild(client: LanguageClient): Promise<void> {
    try {
        await client.sendRequest('workspace/symbol', { query: INITIAL_BUILD_PROBE_QUERY });
    } catch (error) {
        appendDiagnostic('VS Code extension', `Initial workspace load probe failed: ${formatDiagnosticError(error)}`);
    }
}

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
    setServerState({ kind: 'stopped' });
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
    setServerState({ kind: 'starting' });

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
        setServerState({ kind: 'failed', reason: unavailableReason.message });
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

    setServerState({ kind: 'loading' });
    void waitForInitialBuild(client).then(() => {
        if (clientRef === client) setServerState({ kind: 'ready' });
    });

    client.onNotification('wurst/updateGamePath', (params) => {
        workspace.getConfiguration().update('wurst.wc3path', params);
    });

    context.subscriptions.push(registerFileChanges(client));

    // Version detection may start a JVM (once per installed jar, then served from a disk cache) and
    // the update check performs network I/O. Neither should delay language features or block the
    // extension host.
    void getInstalledVersionString().then((version) => {
        installedVersion = version ?? 'unknown';
        renderStatusItem();
    });
    void maybeOfferUpdate((update) => {
        availableUpdate = update;
        renderStatusItem();
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

    const java = getLanguageServerJava();
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
