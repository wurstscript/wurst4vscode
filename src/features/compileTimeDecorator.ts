'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

export function setupDecorators(context: vscode.ExtensionContext) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const extension = vscode.extensions.getExtension('peterzeller.wurst')!;
    const decorator = vscode.window.createTextEditorDecorationType({
        gutterIconPath: path.join(extension.extensionPath, 'images', 'gears.svg'),
        gutterIconSize: 'contain',
    });

    let activeEditor = vscode.window.activeTextEditor;

    function updateDecorations() {
        if (!activeEditor) return;
        const regEx = /@compiletime\s+(\s*(static|public|private)\s)*function.+/g;
        const text = activeEditor.document.getText();
        const decorations: vscode.DecorationOptions[] = [];
        let match: RegExpExecArray | null;
        while ((match = regEx.exec(text))) {
            const start = activeEditor.document.positionAt(match.index);
            const end = activeEditor.document.positionAt(match.index + match[0].length);
            decorations.push({ range: new vscode.Range(start, end), hoverMessage: 'This function will be executed at compile time.' });
        }
        activeEditor.setDecorations(decorator, decorations);
    }

    function triggerUpdate() {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(updateDecorations, 500);
    }

    if (activeEditor) triggerUpdate();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            activeEditor = editor;
            if (editor) triggerUpdate();
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (activeEditor && event.document === activeEditor.document) triggerUpdate();
        })
    );
}
