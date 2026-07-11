'use strict';

import { TextDocument } from 'vscode';
import { workspace, Disposable, WorkspaceEdit, Position } from 'vscode';
import { basename, extname } from 'path';

function onDocumentOpen(td: TextDocument) {
    const extension = extname(td.fileName);
    if (extension != '.wurst' && extension != '.jurst') {
        return;
    }
    if (td.lineCount > 1 || td.getText().length > 0) {
        return;
    }

    const packageName = basename(td.fileName, extension);
    const newText = `package ${packageName}\n\n`;

    const edit = new WorkspaceEdit();
    edit.insert(td.uri, new Position(1, 1), newText);
    workspace.applyEdit(edit);
}

export function registerFileCreation(): Disposable {
    return workspace.onDidOpenTextDocument(onDocumentOpen);
}
