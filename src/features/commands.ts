'use strict';

import {WurstServer} from '../WurstServer';
import * as path from 'path';
import * as vscode from 'vscode';


export function registerCommands(server: WurstServer): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand('wurst.restart', () => server.restart()),
		vscode.commands.registerCommand('wurst.clean', () => server.clean()),
		vscode.commands.registerCommand('wurst.startmap', (args: any[]) => server.startmap(args)),
		vscode.commands.registerCommand('wurst.startlast', () => server.startlast()),
		vscode.commands.registerCommand('wurst.tests', () => server.tests('all')),
		vscode.commands.registerCommand('wurst.tests_file', () => server.tests('file')),
		vscode.commands.registerCommand('wurst.tests_func', () => server.tests('func'))
	);
}