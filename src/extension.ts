'use strict';

import * as path from 'path';

import * as vscode from 'vscode';
import { workspace, Disposable, ExtensionContext, LanguageConfiguration } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind } from 'vscode-languageclient';

import {WurstServer} from './WurstServer';
import forwardChanges from './features/changeForwarding'
import WurstDefinitionProvider from './features/definitionProvider'
import WurstHoverProvider from './features/hoverProvider'
import WurstCompletionItemProvider from './features/completionProvider'
import {DiagnosticsProvider} from './features/diagnosticsProvider'

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
    
    
    const server = new WurstServer();
    let started = server.start(workspace.rootPath);
    
    // stop server on deactivate
	context.subscriptions.push(new vscode.Disposable(() => {
       server.stop(); 
    }));
    
    started.then(value => {
        
        context.subscriptions.push(forwardChanges(server))
        
        context.subscriptions.push(new DiagnosticsProvider(server))
        
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider('wurst', new WurstDefinitionProvider(server)));
            
        context.subscriptions.push(
            vscode.languages.registerHoverProvider('wurst', new WurstHoverProvider(server)));
        
        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider('wurst', new WurstCompletionItemProvider(server))
        );
            
    });
    
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
    
}