'use strict';

import {TextDocument} from 'vscode';
import { workspace, Disposable, ExtensionContext, LanguageConfiguration, WorkspaceEdit, Position } from 'vscode';
import {basename, extname} from 'path';

function onDocumentOpen(td: TextDocument) {
	let extension = extname(td.fileName);
	if (extension != ".wurst" && extension != ".jurst") {
		return;
	}
	if (td.lineCount > 1 || td.getText().length > 0) {
		return;
	}

	let packageName = basename(td.fileName, extension);
	let newText = `package ${packageName}\n\n`;

	let edit = new WorkspaceEdit()
	edit.insert(td.uri, new Position(1,1), newText)
	workspace.applyEdit(edit);


}

export function registerFileCreation(): Disposable {
	return workspace.onDidOpenTextDocument(onDocumentOpen);
}