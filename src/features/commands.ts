'use strict';

import {WurstServer} from '../WurstServer';
import * as path from 'path';
import * as vscode from 'vscode';


export function registerCommands(server: WurstServer): vscode.Disposable {
	let d1 = vscode.commands.registerCommand('wurst.restart', () => server.restart());
	let d2 = vscode.commands.registerCommand('wurst.clean', () => server.clean());
    
	return vscode.Disposable.from(d1, d2);
}