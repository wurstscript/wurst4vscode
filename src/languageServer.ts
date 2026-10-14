'use strict';

import * as fs from 'fs';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable, State, DidOpenTextDocumentNotification } from 'vscode-languageclient/node';
import { RUNTIME_DIR, COMPILER_JAR } from './paths';
import { appCdsJvmOptions } from './install/fsUtils';
import { getLanguageServerJava, checkCustomJavaVersion, getInstalledVersionString, ensureInstalledOrOfferMigration, maybeOfferUpdate, getCompilerVersionPin } from './install/installer';
import type { UpdateAvailable } from './install/installer';
import { stableCompilerVersion, compilerReleaseNotesUrl, fetchCompilerReleaseSummary } from './install/downloader';
import { appendDiagnostic, formatDiagnosticError } from './features/diagnostics';

let clientRef: LanguageClient | null = null;
let clientSubscriptions: vscode.Disposable | undefined;
let startGeneration = 0;
let rejectStartingClient: ((error: Error) => void) | undefined;

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
let versionDetectionPending = false;
let compilerVersionPin: string | undefined;
let availableUpdate: UpdateAvailable | undefined;
let startupStartedAt: number | undefined;
let initializedAfterMs: number | undefined;
let startupCompletion: { afterMs: number; kind: 'ready' | 'failed' | 'stopped' } | undefined;
const releaseSummaries = new Map<string, string[] | null | undefined>();
// Bumped whenever a probe's answer stops being meaningful (server restart, stop), so a late reply
// from an earlier server process cannot mark the current one ready.
let probeGeneration = 0;

// A workspace/symbol query that matches nothing. The server's worker answers user requests only
// after its init and initial full build, so the reply marks the end of the initial workspace load.
const INITIAL_BUILD_PROBE_QUERY = '\u0000wurst-initial-build-probe';

export function showWurstStatusItem(context: ExtensionContext): void {
    if (statusItem) return;
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.name = 'WurstScript compiler';
    item.command = 'wurst.showDiagnosticsActions';
    statusItem = item;
    compilerVersionPin = getCompilerVersionPin();
    context.subscriptions.push(item, { dispose: () => { if (statusItem === item) statusItem = undefined; } });
    renderStatusItem();
    item.show();
}

function setServerState(state: ServerState): void {
    const now = performance.now();
    if (state.kind === 'starting' && serverState.kind !== 'starting') {
        startupStartedAt = now;
        initializedAfterMs = undefined;
        startupCompletion = undefined;
    }
    if (startupStartedAt !== undefined) {
        if (state.kind === 'loading' && initializedAfterMs === undefined) {
            initializedAfterMs = now - startupStartedAt;
        }
        if ((state.kind === 'ready' || state.kind === 'failed' || state.kind === 'stopped') && startupCompletion === undefined) {
            startupCompletion = { afterMs: now - startupStartedAt, kind: state.kind };
        }
    }
    serverState = state;
    renderStatusItem();
}

function renderStatusItem(): void {
    const sb = statusItem;
    if (!sb) return;
    // Only a healthy server may trade its icon for the update badge; starting, loading, failed and
    // stopped keep their own icon and mention a known update in the tooltip instead.
    const update = availableUpdate;
    const showUpdateBadge = !!update && serverState.kind === 'ready';
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
            summary = serverState.reason;
            break;
        case 'stopped':
            icon = '$(circle-slash)';
            summary = 'WurstScript language server was stopped.';
            break;
    }
    const version = installedVersion ? stableCompilerVersion(installedVersion) : null;
    const versionLabel = version ? ` ${version}` : '';
    sb.text = `${showUpdateBadge ? '$(circle-filled)' : icon} WurstScript${versionLabel}${showUpdateBadge ? ' Update' : ''}`;
    sb.color = showUpdateBadge ? new vscode.ThemeColor('statusBarItem.prominentForeground') : undefined;
    const updateSummary = update ? ` Update available: ${update.latestVersion}.` : '';
    sb.accessibilityInformation = { label: `WurstScript ${version ?? ''}. ${summary}${updateSummary}` };
    sb.tooltip = buildStatusHover(icon, summary, version);
}

function buildStatusHover(icon: string, summary: string, version: string | null): vscode.MarkdownString {
    const update = availableUpdate;
    const versionLabel = version ? ` ${version}` : '';
    const hover = new vscode.MarkdownString('', true);
    hover.isTrusted = { enabledCommands: ['wurst.showDiagnosticsActions', 'wurst.showLogs', 'wurst.chooseCompilerVersion', 'wurst.installOrUpdate'] };
    const stateLabel = { noWorkspace: 'Waiting for a project', starting: 'Starting compiler', loading: 'Building workspace', ready: 'Ready', failed: 'Needs attention', stopped: 'Stopped' }[serverState.kind];
    hover.appendMarkdown(`### $(terminal) WurstScript${versionLabel}\n\n${icon} **${stateLabel}**\n\n`);
    hover.appendText(summary);
    hover.appendMarkdown('\n\n---\n\n');
    hover.appendMarkdown('| | Details |\n| :--- | :--- |\n');
    const pendingVersionLabel = versionDetectionPending ? 'Detecting version…' : 'Version check deferred until server startup';
    hover.appendMarkdown(`| $(versions) Compiler | ${statusTableText(installedVersion ?? pendingVersionLabel)} |\n`);
    hover.appendMarkdown(`| $(folder) Workspace | ${statusTableText(workspace.workspaceFolders?.[0]?.name ?? 'No folder open')} |\n`);
    const updatePolicy = compilerVersionPin ? `Pinned to ${statusTableText(compilerVersionPin)}` : 'Following latest stable';
    hover.appendMarkdown(`| $(pin) Updates | ${updatePolicy} |\n`);
    appendStartupTimings(hover);
    if (update) {
        hover.appendMarkdown(`\n---\n\n$(cloud-download) **Update available: ${statusTableText(update.latestVersion)}**\n\n`);
        hover.appendMarkdown(`[Install update](command:wurst.installOrUpdate) · [What’s new in ${update.latestVersion}](${compilerReleaseNotesUrl(update.latestVersion)})\n`);
        appendReleaseSummary(hover, update.latestVersion);
    }
    const notesLabel = version ? `What’s new in ${version}` : 'What’s new';
    hover.appendMarkdown(`\n---\n\n$(book) [${notesLabel}](${compilerReleaseNotesUrl(installedVersion)})\n\n`);
    if (version) appendReleaseSummary(hover, version);
    hover.appendMarkdown('[Choose version](command:wurst.chooseCompilerVersion) · [Server output](command:wurst.showLogs) · [All actions](command:wurst.showDiagnosticsActions)');
    return hover;
}

function loadReleaseSummary(version: string | undefined): void {
    const stable = version ? stableCompilerVersion(version) : null;
    if (!stable || releaseSummaries.has(stable)) return;
    releaseSummaries.set(stable, undefined);
    void fetchCompilerReleaseSummary(stable).then((summary) => {
        releaseSummaries.set(stable, summary);
        renderStatusItem();
    });
}

function appendReleaseSummary(hover: vscode.MarkdownString, version: string): void {
    const stable = stableCompilerVersion(version);
    if (!stable) return;
    const summary = releaseSummaries.get(stable);
    if (summary === undefined) {
        hover.appendMarkdown('\n*Loading release highlights…*\n\n');
    } else if (summary === null) {
        hover.appendMarkdown('\n*Release highlights unavailable. Read the full notes using the link above.*\n\n');
    } else if (summary.length === 0) {
        hover.appendMarkdown('\n*This release has no published highlights.*\n\n');
    } else {
        for (const highlight of summary) {
            hover.appendMarkdown('\n- ');
            hover.appendText(highlight);
        }
        hover.appendMarkdown('\n\n');
    }
}

function appendStartupTimings(hover: vscode.MarkdownString): void {
    if (initializedAfterMs !== undefined) hover.appendMarkdown(`| $(rocket) Server initialized | ${formatStartupDuration(initializedAfterMs)} |\n`);
    if (startupCompletion !== undefined) {
        const label = startupCompletion.kind === 'ready' ? 'Workspace ready' : 'Startup attempt';
        hover.appendMarkdown(`| $(watch) ${label} | ${formatStartupDuration(startupCompletion.afterMs)} |\n`);
    }
    if (initializedAfterMs !== undefined && startupCompletion?.kind === 'ready') {
        hover.appendMarkdown(`| $(tools) Initial build | ${formatStartupDuration(startupCompletion.afterMs - initializedAfterMs)} |\n`);
    }
    if (startupStartedAt !== undefined) hover.appendMarkdown('\n*Timings cover this startup, including installation checks, through the initial workspace build.*\n');
}

function statusTableText(value: string): string {
    return new vscode.MarkdownString().appendText(value).value.replace(/\r?\n/g, ' ').replace(/\|/g, '&#124;');
}

function formatStartupDuration(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Resolves true once the server answered the probe, false if the request failed. */
async function waitForInitialBuild(client: LanguageClient): Promise<boolean> {
    try {
        await client.sendRequest('workspace/symbol', { query: INITIAL_BUILD_PROBE_QUERY });
        return true;
    } catch (error) {
        appendDiagnostic('VS Code extension', `Initial workspace load probe failed: ${formatDiagnosticError(error)}`);
        return false;
    }
}

type InitialBuild = { supported: boolean; state?: ServerState };

function probeInitialBuild(client: LanguageClient, initialBuild: InitialBuild): void {
    // Notifications never flush client 10's delayed opens. Preserve a completion that arrived
    // during start(), before its promise resolved and this Running transition was handled.
    if (initialBuild.supported) {
        setServerState(initialBuild.state ?? { kind: 'loading' });
        return;
    }
    const generation = ++probeGeneration;
    setServerState({ kind: 'loading' });
    void waitForInitialBuild(client).then((loaded) => {
        if (generation !== probeGeneration || clientRef !== client) return;
        setServerState(loaded
            ? { kind: 'ready' }
            : { kind: 'failed', reason: 'The initial workspace load could not be confirmed. See the Wurst output for details.' });
    });
}

/** Follows crashes; the static feature chooses readiness after restart capabilities arrive. */
function trackClientState(client: LanguageClient, sentDocuments: Set<string>, initialBuild: InitialBuild): vscode.Disposable {
    const subscription = client.onDidChangeState(({ newState }) => {
        if (newState !== State.Running) sentDocuments.clear();
        if (clientRef !== client) return;
        if (newState === State.Running) return;
        probeGeneration++;
        initialBuild.supported = false;
        initialBuild.state = undefined;
        unavailableReason = new Error(newState === State.Starting
            ? 'The WurstScript language server is restarting. Retry when it is ready.'
            : 'The WurstScript language server stopped unexpectedly. See the Wurst output for details.');
        setServerState(newState === State.Starting
            ? { kind: 'starting' }
            : { kind: 'failed', reason: unavailableReason.message });
    });
    return vscode.Disposable.from(subscription, { dispose: () => sentDocuments.clear() });
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
    if (startingClient) return startingClient;
    const client = getRunningLanguageClient();
    if (client) return Promise.resolve(client);
    return Promise.reject(unavailableReason);
}

/** The running client if there is one right now (no waiting). */
export function getRunningLanguageClient(): LanguageClient | null {
    return !startingClient && clientRef?.isRunning() ? clientRef : null;
}

/** Version already resolved by normal startup; UI actions must not launch another detector. */
export function getKnownCompilerVersion(): string | undefined {
    return installedVersion;
}

// Install and repair may be called by activation itself. They stop an existing client;
// only explicit user stops and extension disposal cancel a pre-client startup.
export async function stopLanguageServerIfRunning(cancelPendingStart = false): Promise<boolean> {
    const client = clientRef;
    if (!client && (!startingClient || !cancelPendingStart)) return false;
    // Detach before stopping so the client's own Stopped transition is not reported as a crash.
    clientRef = null;
    startGeneration++;
    probeGeneration++;
    setServerState({ kind: 'stopped' });
    // Nothing restarts the server after an intentional stop (the install flow reloads the window
    // instead), so commands issued from now on fail fast with this reason.
    unavailableReason = new Error('The WurstScript language server was stopped.');
    rejectStartingClient?.(unavailableReason);
    rejectStartingClient = undefined;
    startingClient = null;
    clientSubscriptions?.dispose();
    clientSubscriptions = undefined;
    try {
        // The library cannot stop an initializing client. The startup continuation stops it
        // after initialization if this generation was cancelled in the meantime.
        if (client?.isRunning()) await client.stop();
    } catch (error) {
        appendDiagnostic('VS Code extension', `Language server stop failed: ${formatDiagnosticError(error)}`);
    }
    return true;
}

export async function startLanguageClient(context: ExtensionContext): Promise<void> {
    if (clientRef || startingClient) return;
    const generation = ++startGeneration;
    let announceStarted!: (client: LanguageClient) => void;
    let announceFailed!: (error: unknown) => void;
    startingClient = new Promise<LanguageClient>((resolve, reject) => {
        announceStarted = resolve;
        announceFailed = reject;
    });
    rejectStartingClient = announceFailed;
    // Consumed through getLanguageClient(); avoid an unhandled-rejection report when nobody waits.
    startingClient.catch(() => undefined);
    setServerState({ kind: 'starting' });
    context.subscriptions.push({ dispose: () => {
        if (generation === startGeneration) void stopLanguageServerIfRunning(true);
    } });

    let client: LanguageClient | undefined;
    try {
        await ensureInstalledOrOfferMigration(false);
        compilerVersionPin = getCompilerVersionPin();
        if (generation !== startGeneration) return;

        const serverOptions = await getServerOptions();
        if (generation !== startGeneration) return;
        const watcher = workspace.createFileSystemWatcher('**/*.{wurst,jurst,j}');
        clientSubscriptions = watcher;
        const sentDocuments = new Set<string>();
        const clientOptions: LanguageClientOptions = {
            // Wurst uses one root; retain the same folder for initialization and build output actions.
            workspaceFolder: workspace.workspaceFolders?.[0],
            documentSelector: ['wurst'],
            // Client 10 drops hidden open/close pairs and flushes pending opens before
            // edits or requests, preserving the server's document/version ordering.
            textSynchronization: { delayOpenNotifications: true },
            middleware: {
                didOpen: (document, next) => {
                    const uri = document.uri.toString();
                    sentDocuments.add(uri);
                    return next(document).catch((error) => { sentDocuments.delete(uri); throw error; });
                },
                // In client 10.1.2 the workspace close listener can discard a delayed
                // open before the close handler checks for it. Don't send an unpaired close.
                didClose: (document, next) => sentDocuments.delete(document.uri.toString()) ? next(document) : Promise.resolve(),
            },
            // The language client batches events and owns notification error handling and
            // restart subscriptions. Keep external edits to every supported source format.
            synchronize: { configurationSection: 'wurst', fileEvents: watcher },
        };

        client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);
        const activeClient = client;
        const initialBuild: InitialBuild = { supported: false };
        activeClient.registerFeature({
            fillClientCapabilities(capabilities) {
                capabilities.experimental = { ...capabilities.experimental, wurstInitialBuildStatus: true };
            },
            initialize(capabilities) {
                initialBuild.supported = capabilities?.experimental?.wurstInitialBuildStatus === true;
                // Client 10.1.2 registration retains live hidden documents. Use its normal
                // open path to capture immutable snapshots before incremental edits arrive.
                const opens = activeClient.getFeature(DidOpenTextDocumentNotification.method);
                for (const document of workspace.textDocuments) {
                    if (activeClient.visibleDocuments.isVisible(document)) continue;
                    const pending = opens.getProvider(document)?.send(document);
                    void pending?.catch((error) => {
                        appendDiagnostic('VS Code extension', `Could not snapshot an initial document: ${formatDiagnosticError(error)}`);
                    });
                }
                // Running precedes feature initialization in client 10. Decide only now,
                // after the restarted server's capabilities have arrived.
                if (!startingClient && clientRef === activeClient) probeInitialBuild(activeClient, initialBuild);
            },
            getState: () => ({ kind: 'static' }),
            clear() { initialBuild.supported = false; initialBuild.state = undefined; },
        });
        clientRef = client;
        clientSubscriptions = vscode.Disposable.from(watcher, trackClientState(client, sentDocuments, initialBuild),
            client.onNotification('wurst/initialBuildStatus', (params: { state?: string }) => {
                if (clientRef !== activeClient || activeClient.state !== State.Running) return;
                // initialized is sent before static features initialize; a fast server may
                // finish first. initializeResult is already available at that point.
                if (!initialBuild.supported && activeClient.initializeResult?.capabilities.experimental?.wurstInitialBuildStatus !== true) return;
                if (params?.state === 'loading' || params?.state === 'ready') {
                    initialBuild.state = { kind: params.state };
                } else if (params?.state === 'failed') {
                    initialBuild.state = { kind: 'failed', reason: 'The initial workspace build failed. See the Wurst output for details.' };
                    appendDiagnostic('VS Code extension', initialBuild.state.reason);
                } else return;
                if (initialBuild.state) setServerState(initialBuild.state);
            }),
            client.onNotification('wurst/updateGamePath', (params) => {
                void workspace.getConfiguration().update('wurst.wc3path', params).then(undefined, (error) => {
                    appendDiagnostic('VS Code extension', `Could not update game path: ${formatDiagnosticError(error)}`);
                });
            }));
        await client.start();
        if (generation !== startGeneration) {
            if (client.isRunning()) await client.stop();
            return;
        }
        if (!client.isRunning()) throw new Error('The WurstScript language server stopped during startup.');
        probeInitialBuild(client, initialBuild);
    } catch (error) {
        if (generation !== startGeneration) return;
        clientRef = null;
        startingClient = null;
        rejectStartingClient = undefined;
        clientSubscriptions?.dispose();
        clientSubscriptions = undefined;
        unavailableReason = error instanceof Error ? error : new Error(String(error));
        appendDiagnostic('VS Code extension', `Wurst language server failed to start: ${formatDiagnosticError(error)}`);
        setServerState({ kind: 'failed', reason: `WurstScript language server is not running: ${unavailableReason.message}` });
        announceFailed(error);
        try { await client?.stop(); } catch { /* Best-effort cleanup of a failed start. */ }
        throw error;
    }
    startingClient = null;
    rejectStartingClient = undefined;
    announceStarted(client);

    // Version detection may start a JVM (once per installed jar, then served from a disk cache) and
    // the update check performs network I/O. Neither should delay language features or block the
    // extension host.
    versionDetectionPending = true;
    renderStatusItem();
    void getInstalledVersionString().then((version) => {
        versionDetectionPending = false;
        installedVersion = version ?? 'unknown';
        loadReleaseSummary(installedVersion);
        renderStatusItem();
    }, (error) => {
        versionDetectionPending = false;
        installedVersion = 'unknown';
        appendDiagnostic('VS Code extension', `Compiler version detection failed: ${formatDiagnosticError(error)}`);
        renderStatusItem();
    });
    void maybeOfferUpdate((update) => {
        availableUpdate = update;
        loadReleaseSummary(update.latestVersion);
        renderStatusItem();
    });
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
    const args = [...platformOpts, ...(debugMode ? [] : appCdsJvmOptions(java, COMPILER_JAR, javaOpts)), ...javaOpts, '-jar', COMPILER_JAR, '-languageServer'];

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
