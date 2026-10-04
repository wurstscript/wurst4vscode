'use strict';

import { TextDocument } from 'vscode';
import { workspace, Disposable, WorkspaceEdit, Position } from 'vscode';
import { basename, extname } from 'path';
import { window } from 'vscode';
import { showErrorWithLogs } from './diagnostics';

export async function insertPackageHeader(td: TextDocument | undefined = window.activeTextEditor?.document): Promise<void> {
    if (!td) return;
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
    edit.insert(td.uri, new Position(0, 0), newText);
    try {
        if (!await workspace.applyEdit(edit)) throw new Error('The package header edit was rejected.');
    } catch (error) { await showErrorWithLogs('Could not insert the package header.', error); }
}

export function registerFileCreation(): Disposable {
    return workspace.onDidOpenTextDocument((doc) => {
        if (workspace.getConfiguration('wurst', doc.uri).get<boolean>('autoPackageHeader', false)) void insertPackageHeader(doc);
    });
}
