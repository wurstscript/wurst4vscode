'use strict';

import * as path from 'path';

import * as vscode from 'vscode';
import { workspace, Disposable, ExtensionContext, LanguageConfiguration } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, Executable } from 'vscode-languageclient';
import * as fs from 'fs';

import {registerCommands} from './features/commands'
import {registerFileCreation} from './features/fileCreation'
import os_homedir = require('os-homedir');


export async function activate(context: ExtensionContext) {
    console.log("Wurst extension activated!!")

    let config: LanguageConfiguration = {
        comments: {
            lineComment: "//",
            blockComment: ["/*","*/"]
        },
        brackets: [
            ["{", "}"],
            ["[", "]"],
            ["(", ")"]
        ],
        indentationRules: {
            increaseIndentPattern: /^\s*(if|while|for|function|class|module|interface)\s.*$/,
            decreaseIndentPattern: /^\s*(else|end)\s.*$/,
        }
    };

    vscode.languages.setLanguageConfiguration('wurst', config);

    await startLanguageClient(context).then(
        (value) => console.log(`init done : ${value}`),
        (err) => console.log(`init error: ${err}`)
    );

}

async function startLanguageClient(context: ExtensionContext) {
    let cfg = vscode.workspace.getConfiguration("wurst")

    let clientOptions: LanguageClientOptions = {
		// Register the server for Wurst-documents
		documentSelector: ['wurst'],
		synchronize: {
			// Synchronize the setting section 'wurst' to the server
			configurationSection: 'wurst',
            // Notify the server about file changes to '.wurst files contain in the workspace
            // currently disabled, because not working
            // using manual workaround in registerFileChanges instead
			// fileEvents: workspace.createFileSystemWatcher('**/*.wurst')
		}
    }

    let serverOptions = await getServerOptions();

    let client = new LanguageClient("wurstLanguageServer", serverOptions, clientOptions);
    context.subscriptions.push(client.start());

    context.subscriptions.push(registerCommands(client));
    context.subscriptions.push(registerFileCreation());
    context.subscriptions.push(registerFileChanges(client));
}

/** register file events and manually send them to language client */
function registerFileChanges(client: LanguageClient): vscode.FileSystemWatcher {
    let watcher = workspace.createFileSystemWatcher('**/*.wurst');
    function notifyFileChange(type: number, uri: vscode.Uri) {
        let args /*: DidChangeWatchedFilesParams */ = {
            changes: [
                {
                    uri: uri.toString(),
                    type: type
                }
            ]
        };
        client.sendNotification("workspace/didChangeWatchedFiles", args);
    }

    watcher.onDidCreate(uri => notifyFileChange(1, uri));
    watcher.onDidChange(uri => notifyFileChange(2, uri));
    watcher.onDidDelete(uri => notifyFileChange(3, uri));
    return watcher;
}

async function getServerOptions(): Promise<ServerOptions> {
    let config = vscode.workspace.getConfiguration("wurst")

    // TODO make configurable
    let java = config.get<string>("javaExecutable")
    let wurstJar = config.get<string>("wurstJar").replace("$HOME", os_homedir());
    let debugMode = config.get<boolean>("debugMode")
    let hideExceptions = config.get<boolean>("hideExceptions")

    if (!(await doesFileExist(wurstJar))) {
        let msg = `Could not find ${wurstJar}. Please configure 'wurst.wurstJar' in your settings.json`
        vscode.window.showErrorMessage(msg);
        return Promise.reject(msg);
    }

    let args = ["-jar", wurstJar, "-languageServer"]
    if (debugMode == true) {
        if (await isPortOpen(5005)) {
            args = ["-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y"].concat(args);
        }
    }

    let exec: Executable = {
        command: java,
        args: args
    };

    let serverOptions: ServerOptions = {
		run : exec,
		debug: exec
	}
    return serverOptions;
}

function doesFileExist(filename): Promise<boolean> {
    return new Promise((resolve, reject) => {
        fs.stat(filename, (err, stats) => {
            resolve(!err);
        });
    });
}

function isPortOpen(port): Promise<boolean> {
    return new Promise((resolve, reject) => {
        let net = require('net');
        let tester = net.createServer();
        tester.once('error', function (err) {
            if (err.code == 'EADDRINUSE') {
                resolve(false);
            }
        });
        tester.once('listening', function() {
            tester.close()
            resolve(true);

        });
        tester.listen(port);
    });
}
