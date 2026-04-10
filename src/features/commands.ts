'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient, ExecuteCommandParams, ExecuteCommandRequest } from 'vscode-languageclient/node';
import { workspace, window } from 'vscode';

export function registerCommands(client: LanguageClient): vscode.Disposable {
    let _lastMapConfig: string | undefined = undefined;

    // Accepts both archive files (*.w3x, *.w3m) and folder-mode directories (*.w3x/, *.w3m/)
    const isMapPath = (value: string | undefined): value is string => {
        if (!value) return false;
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

    let buildMap = async (args: any) => {
        let config = vscode.workspace.getConfiguration('wurst');
        let wc3path = config.get<string>('wc3path');

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
        let mappath = await mapPromise;
        if (!mappath) {
            window.showWarningMessage('No map selected for build. Choose a .w3x or .w3m map file or folder and try again.');
            return;
        }

        let request: ExecuteCommandParams = {
            command: 'wurst.buildmap',
            arguments: [
                {
                    mappath: mappath,
                    wc3path: wc3path,
                },
            ],
        };
        return client.sendRequest(ExecuteCommandRequest.type, request);
    };

    let startMap = async (cmd: 'wurst.startmap' | 'wurst.hotstartmap', args: any) => {
        let config = vscode.workspace.getConfiguration('wurst');
        let wc3path = config.get<string>('wc3path');
        let gameExePath = config.get<string>('gameExePath');

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
        let mappath = await mapPromise;
        if (!mappath) {
            window.showWarningMessage('No map selected to run. Choose a .w3x or .w3m map file or folder and try again.');
            return;
        }

        let request: ExecuteCommandParams = {
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
        return client.sendRequest(ExecuteCommandRequest.type, request);
    };

    let reloadMap = async () => {
        let request: ExecuteCommandParams = {
            command: 'wurst.hotreload',
            arguments: [{}],
        };
        return client.sendRequest(ExecuteCommandRequest.type, request);
    };

    let startLast = () => {
        if (_lastMapConfig) {
            return startMap('wurst.startmap', [_lastMapConfig]);
        } else {
            return startMap('wurst.startmap', []);
        }
    };

    let runMapSmart = (args: any) => {
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

    let tests = (mode: 'all' | 'file' | 'func', args: any) => {
        if (!args) {
            let data: any = {};
            if (mode != 'all') {
                data.filename = window.activeTextEditor?.document.fileName;
            }
            if (mode == 'func') {
                let sel = window.activeTextEditor?.selection;
                if (sel) {
                    data.line = sel.start.line;
                    data.column = sel.start.character;
                }
            }
            args = [data];
        }

        // Show the Wurst output so users see progress immediately
        try {
            (client as any).outputChannel?.show();
        } catch {}

        const request: ExecuteCommandParams = { command: 'wurst.tests', arguments: args };

        return client.sendRequest(ExecuteCommandRequest.type, request).then(
            (result: any) => {
                // Non-modal heads-up; users can jump to Output again if they closed it
                vscode.window.showInformationMessage('Wurst tests finished.', 'Open Output').then((btn) => {
                    if (btn === 'Open Output') (client as any).outputChannel?.show();
                });
                return result;
            },
            (err) => {
                (client as any).outputChannel?.show();
                vscode.window.showErrorMessage('Wurst tests failed. See "WurstScript" output for details.');
                throw err;
            }
        );
    };

    let performCodeAction = (args: any[]) => {
        let request: ExecuteCommandParams = {
            command: 'wurst.perform_code_action',
            arguments: args,
        };
        return client.sendRequest(ExecuteCommandRequest.type, request);
    };

    let fixAllQuickfixes = () => {
        let request: ExecuteCommandParams = {
            command: 'wurst.fix_all_quickfixes',
            arguments: [],
        };
        return client.sendRequest(ExecuteCommandRequest.type, request);
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
