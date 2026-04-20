'use strict';

/**
 * Lightweight factory for read-only parsed-data webview editors.
 * Eliminates the CustomDocument / CustomReadonlyEditorProvider boilerplate
 * that is identical across doo, objMod, wpm, and trigger previewers.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export interface ParsedPreviewerOpts<TData> {
    viewType: string;
    parse: (data: Buffer, fileName: string) => TData;
    render: (data: TData, fileName: string) => string;
    supportsMultipleEditorsPerDocument?: boolean;
    /** Options forwarded to panel.webview.options (enableScripts, localResourceRoots, etc.) */
    webviewOptions?: vscode.WebviewOptions;
    /** Options forwarded to registerCustomEditorProvider (retainContextWhenHidden, etc.) */
    panelOptions?: vscode.WebviewPanelOptions;
}

class ParsedDocument<TData> implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        readonly data: TData,
        readonly html: string,
    ) {}
    dispose(): void {}
}

class ParsedEditorProvider<TData> implements vscode.CustomReadonlyEditorProvider<ParsedDocument<TData>> {
    constructor(private readonly opts: ParsedPreviewerOpts<TData>) {}

    async openCustomDocument(uri: vscode.Uri): Promise<ParsedDocument<TData>> {
        const fileName = path.basename(uri.fsPath);
        const raw      = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const data     = this.opts.parse(raw, fileName);
        const html     = this.opts.render(data, fileName);
        return new ParsedDocument(uri, data, html);
    }

    resolveCustomEditor(doc: ParsedDocument<TData>, panel: vscode.WebviewPanel): void {
        panel.webview.options = this.opts.webviewOptions ?? { enableScripts: false };
        panel.webview.html = doc.html;
    }
}

export function registerParsedPreviewer<TData>(
    opts: ParsedPreviewerOpts<TData>,
): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        opts.viewType,
        new ParsedEditorProvider(opts),
        {
            supportsMultipleEditorsPerDocument: opts.supportsMultipleEditorsPerDocument ?? true,
            webviewOptions: opts.panelOptions,
        },
    );
}
