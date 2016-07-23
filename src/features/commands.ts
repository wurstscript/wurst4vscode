'use strict';

import {WurstServer} from '../WurstServer';
import * as path from 'path';
import * as vscode from 'vscode';


export function registerCommands(server: WurstServer): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('wurst.restart', () => server.restart()),
		vscode.commands.registerCommand('wurst.clean', () => server.clean()),
		vscode.commands.registerCommand('wurst.startmap', (args: any[]) => server.startmap(args))
	);
}