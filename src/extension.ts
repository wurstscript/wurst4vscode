'use strict';

import * as path from 'path';

import * as vscode from 'vscode';
import { workspace, Disposable, ExtensionContext, LanguageConfiguration } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind, Executable } from 'vscode-languageclient';
import * as fs from 'fs';

import {WurstServer} from './WurstServer';
import forwardChanges from './features/changeForwarding'
import WurstDefinitionProvider from './features/definitionProvider'
import WurstHoverProvider from './features/hoverProvider'
import WurstCompletionItemProvider from './features/completionProvider'
import {DiagnosticsProvider} from './features/diagnosticsProvider'
import WurstSignatureHelpProvider from './features/signatureHelpProvider'
import WurstDocumentHighlightProvider from './features/documentHighlightProvider'
import WurstReferenceProvider from './features/referenceProvider'
import {registerCommands} from './features/commands'
import {onDocumentOpen} from './features/fileCreation'


export function activate(context: ExtensionContext) {
    console.log("Wurst extension activated!!")
    context.extensionPath

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    var disposable = vscode.commands.registerCommand('extension.sayHello', () => {
        // The code you place here will be executed every time your command is executed

        // Display a message box to the user
        vscode.window.showInformationMessage('Hello World!');
    });
    
    context.subscriptions.push(disposable);    
    

    // const server = new WurstServer();
    // let started = server.start(workspace.rootPath);

    // stop server on deactivate
	// context.subscriptions.push(new vscode.Disposable(() => {
    //    server.stop();
    // }));
    /*
    context.subscriptions.push(registerCommands(server))
    
    started.then(value => {
        
        context.subscriptions.push(forwardChanges(server))
        
        context.subscriptions.push(new DiagnosticsProvider(server))
        
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider('wurst', new WurstDefinitionProvider(server)));
            
        context.subscriptions.push(
            vscode.languages.registerHoverProvider('wurst', new WurstHoverProvider(server)));
        
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider('wurst', new WurstCompletionItemProvider(server), '.')
        );
        
        context.subscriptions.push(
            vscode.languages.registerSignatureHelpProvider('wurst', new WurstSignatureHelpProvider(server), '(', ',')
        );

        context.subscriptions.push(
            vscode.languages.registerDocumentHighlightProvider('wurst', new WurstDocumentHighlightProvider(server))
        );

        context.subscriptions.push(
            vscode.languages.registerReferenceProvider('wurst', new WurstReferenceProvider(server))
        );

        context.subscriptions.push(
            workspace.onDidOpenTextDocument(onDocumentOpen)
        );

    });
    */
    
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

    startLanguageClient(context).then(
        (value) => console.log(`init done : ${value}`),
        (err) => console.log(`init error: ${err}`)
    );

}

async function startLanguageClient(context: ExtensionContext) {
    let cfg = vscode.workspace.getConfiguration("wurst")

    // TODO make configurable
    let java = cfg.get<string>("javaExecutable")
    let wurstJar = cfg.get<string>("wurstJar")
    let debugMode = cfg.get<boolean>("debugMode")
    let hideExceptions = cfg.get<boolean>("hideExceptions")





    let clientOptions: LanguageClientOptions = {
		// Register the server for Wurst-documents
		documentSelector: ['wurst'],
		synchronize: {
			// Synchronize the setting section 'wurst' to the server
			configurationSection: 'wurst',
			// Notify the server about file changes to '.wurst files contain in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/*.wurst')
		}
	}

    let serverOptions = await getServerOptions();

    let client = new LanguageClient("wurstLanguageServer", serverOptions, clientOptions);
    context.subscriptions.push(client.start());

    context.subscriptions.push(registerCommands(client));
}

async function getServerOptions(): Promise<ServerOptions> {
    let config = vscode.workspace.getConfiguration("wurst")

    // TODO make configurable
    let java = config.get<string>("javaExecutable")
    let wurstJar = config.get<string>("wurstJar")
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