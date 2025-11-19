'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient, ExecuteCommandParams, ExecuteCommandRequest } from 'vscode-languageclient';
import { workspace, window } from 'vscode';

export function registerCommands(client: LanguageClient): vscode.Disposable {
    let _lastMapConfig: string | undefined = undefined;

    let buildMap = async (args: any[]) => {
        let config = vscode.workspace.getConfiguration('wurst');
        let wc3path = config.get<string>('wc3path');

        let mapPromise: Thenable<string | undefined>;
        if (args && args.length > 0) {
            mapPromise = Promise.resolve(args[0]);
        } else {
            let items = workspace
                .findFiles('{*.w3x,*.w3m}', null, 10)
                .then((uris) =>
                    uris.sort(function (a, b) {
                        return fs.statSync(b.fsPath).mtime.getTime() - fs.statSync(a.fsPath).mtime.getTime();
                    })
                )
                .then((uris) => uris.map((uri) => uri.path));
            mapPromise = window.showQuickPick(items);
        }
        let mappath = await mapPromise;
        if (!mappath) {
            return Promise.reject('No map selected.');
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

    let startMap = async (cmd: 'wurst.startmap' | 'wurst.hotstartmap', args: any[]) => {
        let config = vscode.workspace.getConfiguration('wurst');
        let wc3path = config.get<string>('wc3path');
        let gameExePath = config.get<string>('gameExePath');

        let mapPromise: Thenable<string | undefined>;
        if (args && args.length > 0) {
            mapPromise = Promise.resolve(args[0]);
        } else {
            let items = workspace
                .findFiles('{*.w3x,*.w3m}', null, 10)
                .then((uris) =>
                    uris.sort(function (a, b) {
                        return fs.statSync(b.fsPath).mtime.getTime() - fs.statSync(a.fsPath).mtime.getTime();
                    })
                )
                .then((uris) => uris.map((uri) => uri.path));
            mapPromise = window.showQuickPick(items);
        }
        let mappath = await mapPromise;
        if (!mappath) {
            return Promise.reject('No map selected.');
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

    return vscode.Disposable.from(
        vscode.commands.registerCommand('wurst.startmap', (args: any[]) => startMap('wurst.startmap', args)),
        vscode.commands.registerCommand('wurst.hotstartmap', (args: any[]) => startMap('wurst.hotstartmap', args)),
        vscode.commands.registerCommand('wurst.hotreload', () => reloadMap()),
        vscode.commands.registerCommand('wurst.startlast', () => startLast()),
        vscode.commands.registerCommand('wurst.buildmap', (args: any[]) => buildMap(args)),
        vscode.commands.registerCommand('wurst.tests', (args: any[]) => tests('all', args)),
        vscode.commands.registerCommand('wurst.tests_file', (args: any[]) => tests('file', args)),
        vscode.commands.registerCommand('wurst.tests_func', (args: any[]) => tests('func', args)),
        vscode.commands.registerCommand('wurst.perform_code_action', (args: any[]) => performCodeAction(args))
    );
}
