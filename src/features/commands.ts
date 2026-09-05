'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient, ExecuteCommandParams, ExecuteCommandRequest } from 'vscode-languageclient/node';
import { workspace, window } from 'vscode';
import { WURST_HOME } from '../paths';
import { appendDiagnostic, buildDiagnosticsText, formatDiagnosticError, showDiagnosticOutput, showErrorWithLogs } from './diagnostics';
import { getRunningLanguageClient } from '../languageServer';

function showLanguageServerOutput(): void {
    try {
        const client = getRunningLanguageClient();
        if (client) {
            client.outputChannel.show();
            return;
        }
        void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    } catch (error) {
        appendDiagnostic('VS Code extension', `Could not show language server output: ${formatDiagnosticError(error)}`);
        void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
    }
}

async function copyDiagnostics(): Promise<void> {
    try {
        await vscode.env.clipboard.writeText(buildDiagnosticsText(WURST_HOME));
        void vscode.window.showInformationMessage('Copied Wurst diagnostics to the clipboard.');
    } catch (error) {
        void showErrorWithLogs('Could not copy Wurst diagnostics.', error);
    }
}

async function openWurstHome(): Promise<void> {
    try {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(WURST_HOME));
    } catch (error) {
        void showErrorWithLogs('Could not open Wurst home.', error);
    }
}

export function registerWurstDiagnosticsCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.openWurstHome', () => openWurstHome()),
        vscode.commands.registerCommand('wurst.copyDiagnostics', () => copyDiagnostics()),
        vscode.commands.registerCommand('wurst.showLogs', () => showLanguageServerOutput()),
        vscode.commands.registerCommand('wurst.showExtensionLogs', () => showDiagnosticOutput()),
        vscode.commands.registerCommand('wurst.showDiagnosticsActions', async () => {
            const choice = await vscode.window.showQuickPick([
                { label: '$(cloud-download) Install/update WurstScript', command: 'wurst.installOrUpdate' },
                { label: '$(folder-opened) Open Wurst home', command: 'wurst.openWurstHome' },
                { label: '$(copy) Copy diagnostics', command: 'wurst.copyDiagnostics' },
                { label: '$(output) Open Wurst output', command: 'wurst.showLogs' },
                { label: '$(output) Open extension error logs', command: 'wurst.showExtensionLogs' },
            ], { placeHolder: 'WurstScript actions' });
            if (choice) await vscode.commands.executeCommand(choice.command);
        }),
    );
}

function showClientOutput(client: LanguageClient): void {
    try {
        (client as any).outputChannel?.show();
    } catch {}
}

function runTests(client: LanguageClient, request: ExecuteCommandParams): Thenable<unknown> {
    // Show the Wurst output so users see progress immediately
    showClientOutput(client);
    return client.sendRequest(ExecuteCommandRequest.type, request).then(
        (result: unknown) => {
            // Non-modal heads-up; users can jump to Output again if they closed it
            vscode.window.showInformationMessage('Wurst tests finished.', 'Open Output').then((btn) => {
                if (btn === 'Open Output') showClientOutput(client);
            });
            return result;
        },
        (err) => {
            showClientOutput(client);
            appendDiagnostic('VS Code extension', `Wurst tests failed: ${formatDiagnosticError(err)}`);
            vscode.window.showErrorMessage('Wurst tests failed. See "WurstScript" output for details.', 'View Logs').then((btn) => {
                if (btn === 'View Logs') showClientOutput(client);
            });
            throw err;
        }
    );
}

/**
 * Registers the commands that forward to the language server. `getClient` resolves once the server
 * is running (and rejects if it could not start), so these can be registered at activation and
 * still behave sensibly while the JVM is booting: the command waits, or reports why the server is
 * unavailable, instead of VS Code claiming the command does not exist.
 */
export function registerCommands(getClient: () => Promise<LanguageClient>): vscode.Disposable {
    let _lastMapConfig: string | undefined = undefined;

    const withClient = async <T>(action: (client: LanguageClient) => Thenable<T> | T): Promise<T | undefined> => {
        let client: LanguageClient;
        try {
            client = await getClient();
        } catch (error) {
            appendDiagnostic('VS Code extension', `Command skipped, language server unavailable: ${formatDiagnosticError(error)}`);
            const reason = error instanceof Error ? error.message : String(error);
            const choice = await vscode.window.showErrorMessage(
                `This command needs the WurstScript language server, which is not running. ${reason}`,
                'Install/Update', 'View Logs',
            );
            if (choice === 'Install/Update') void vscode.commands.executeCommand('wurst.installOrUpdate');
            else if (choice === 'View Logs') showDiagnosticOutput();
            return undefined;
        }
        return action(client);
    };

    // Accepts both archive files (*.w3x, *.w3m) and folder-mode directories (*.w3x/, *.w3m/)
    const isMapPath = (value: string | undefined): value is string => {
        if (!value) return false;
        // eslint-disable-next-line sonarjs/super-linear-regex -- single char-class quantifier anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
        const lower = value.toLowerCase().replace(/[\\/]+$/, '');
        if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) return true;
        try { return fs.statSync(value).isDirectory() && (lower.endsWith('.w3x') || lower.endsWith('.w3m')); }
        catch { return false; }
    };

    // Keep old name as alias so nothing else breaks
    const isMapFilePath = isMapPath;

    const getMapPathFromArg = (arg: any): string | undefined => {
        if (!arg) return undefined;
        if (typeof arg === 'string') return arg;
        if (arg instanceof vscode.Uri) return arg.fsPath || arg.path;
        if (typeof arg?.fsPath === 'string') return arg.fsPath;
        if (typeof arg?.path === 'string') return arg.path;
        if (arg?.resourceUri instanceof vscode.Uri) return arg.resourceUri.fsPath || arg.resourceUri.path;
        return undefined;
    };

    const getMapPathFromInvocation = (args: any): string | undefined => {
        if (Array.isArray(args) && args.length > 0) {
            return getMapPathFromArg(args[0]);
        }
        return getMapPathFromArg(args);
    };

    // Finds both *.w3x/*.w3m archive files and *.w3x/*.w3m folder-mode directories
    const findMapPaths = (): Thenable<string[]> =>
        // eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
        workspace.findFiles('{*.w3x,*.w3m}', null, 10).then((uris) => {
            // Collect archive files
            const files = uris.map((u) => u.fsPath);
            // Also scan workspace roots for map-folders (dirs ending in .w3x/.w3m)
            const folders: string[] = [];
            for (const wsFolder of workspace.workspaceFolders ?? []) {
                try {
                    for (const entry of fs.readdirSync(wsFolder.uri.fsPath)) {
                        const lower = entry.toLowerCase();
                        if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) {
                            const full = `${wsFolder.uri.fsPath}${require('path').sep}${entry}`;
                            try {
                                if (fs.statSync(full).isDirectory()) folders.push(full);
                            } catch { /* ignore */ }
                        }
                    }
                } catch { /* ignore */ }
            }
            return [...files, ...folders].sort((a, b) => {
                try { return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime(); }
                catch { return 0; }
            });
        });

    const buildMap = async (args: any) => {
        const config = vscode.workspace.getConfiguration('wurst');
        const wc3path = config.get<string>('wc3path');

        let mapPromise: Thenable<string | undefined>;
        const mapPathFromArgs = getMapPathFromInvocation(args);
        if (isMapFilePath(mapPathFromArgs)) {
            mapPromise = Promise.resolve(mapPathFromArgs);
        } else {
            mapPromise = window.showQuickPick(findMapPaths(), {
                title: 'Wurst: Select map to build',
                placeHolder: 'Choose a .w3x/.w3m map file or folder',
            });
        }
        const mappath = await mapPromise;
        if (!mappath) {
            window.showWarningMessage('No map selected for build. Choose a .w3x or .w3m map file or folder and try again.');
            return;
        }

        const request: ExecuteCommandParams = {
            command: 'wurst.buildmap',
            arguments: [
                {
                    mappath: mappath,
                    wc3path: wc3path,
                },
            ],
        };
        return withClient((client) => client.sendRequest(ExecuteCommandRequest.type, request));
    };

    const startMap = async (cmd: 'wurst.startmap' | 'wurst.hotstartmap', args: any) => {
        const config = vscode.workspace.getConfiguration('wurst');
        const wc3path = config.get<string>('wc3path');
        const gameExePath = config.get<string>('gameExePath');

        let mapPromise: Thenable<string | undefined>;
        const mapPathFromArgs = getMapPathFromInvocation(args);
        if (isMapFilePath(mapPathFromArgs)) {
            mapPromise = Promise.resolve(mapPathFromArgs);
        } else {
            mapPromise = window.showQuickPick(findMapPaths(), {
                title: cmd === 'wurst.hotstartmap' ? 'Wurst: Select map to hot run' : 'Wurst: Select map to run',
                placeHolder: 'Choose a .w3x/.w3m map file or folder',
            });
        }
        const mappath = await mapPromise;
        if (!mappath) {
            window.showWarningMessage('No map selected to run. Choose a .w3x or .w3m map file or folder and try again.');
            return;
        }

        const request: ExecuteCommandParams = {
            command: cmd,
            arguments: [
                {
                    mappath: mappath,
                    wc3path: wc3path,
                    gameExePath: gameExePath,
                },
            ],
        };
        _lastMapConfig = mappath;
        return withClient((client) => client.sendRequest(ExecuteCommandRequest.type, request));
    };

    const reloadMap = async () => {
        const request: ExecuteCommandParams = {
            command: 'wurst.hotreload',
            arguments: [{}],
        };
        return withClient((client) => client.sendRequest(ExecuteCommandRequest.type, request));
    };

    const startLast = () => {
        if (_lastMapConfig) {
            return startMap('wurst.startmap', [_lastMapConfig]);
        } else {
            return startMap('wurst.startmap', []);
        }
    };

    const runMapSmart = (args: any) => {
        const fromInvocation = getMapPathFromInvocation(args);
        if (isMapFilePath(fromInvocation)) {
            return startMap('wurst.startmap', [fromInvocation]);
        }

        const activePath = window.activeTextEditor?.document?.uri?.fsPath;
        if (isMapFilePath(activePath)) {
            return startMap('wurst.startmap', [activePath]);
        }

        return startLast();
    };

    const tests = (mode: 'all' | 'file' | 'func', args: any) => {
        if (!args) {
            const data: any = {};
            if (mode != 'all') {
                data.filename = window.activeTextEditor?.document.fileName;
            }
            if (mode == 'func') {
                const sel = window.activeTextEditor?.selection;
                if (sel) {
                    data.line = sel.start.line;
                    data.column = sel.start.character;
                }
            }
            args = [data];
        }

        const request: ExecuteCommandParams = { command: 'wurst.tests', arguments: args };
        return withClient((client) => runTests(client, request));
    };

    const performCodeAction = (args: any[]) => {
        const request: ExecuteCommandParams = {
            command: 'wurst.perform_code_action',
            arguments: args,
        };
        return withClient((client) => client.sendRequest(ExecuteCommandRequest.type, request));
    };

    const fixAllQuickfixes = () => {
        const request: ExecuteCommandParams = {
            command: 'wurst.fix_all_quickfixes',
            arguments: [],
        };
        return withClient((client) => client.sendRequest(ExecuteCommandRequest.type, request));
    };

    return vscode.Disposable.from(
        vscode.commands.registerCommand('wurst.startmap', (args: any[]) => startMap('wurst.startmap', args)),
        vscode.commands.registerCommand('wurst.hotstartmap', (args: any[]) => startMap('wurst.hotstartmap', args)),
        vscode.commands.registerCommand('wurst.hotreload', () => reloadMap()),
        vscode.commands.registerCommand('wurst.runmap', (args: any) => runMapSmart(args)),
        vscode.commands.registerCommand('wurst.startlast', () => startLast()),
        vscode.commands.registerCommand('wurst.buildmap', (args: any[]) => buildMap(args)),
        vscode.commands.registerCommand('wurst.tests', (args: any[]) => tests('all', args)),
        vscode.commands.registerCommand('wurst.tests_file', (args: any[]) => tests('file', args)),
        vscode.commands.registerCommand('wurst.tests_func', (args: any[]) => tests('func', args)),
        vscode.commands.registerCommand('wurst.perform_code_action', (args: any[]) => performCodeAction(args)),
        vscode.commands.registerCommand('wurst.fix_all_quickfixes', () => fixAllQuickfixes())
    );
}
