'use strict';

/**
 * Lightweight factory for read-only parsed-data webview editors.
 * Eliminates the CustomDocument / CustomReadonlyEditorProvider boilerplate
 * that is identical across doo, objMod, wpm, and trigger previewers.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { buildPage } from '../webviewShared';
import { escapeHtml } from '../webviewUtils';

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

class ParsedDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
    ) {}
    dispose(): void {}
}

class ParsedEditorProvider<TData> implements vscode.CustomReadonlyEditorProvider<ParsedDocument> {
    constructor(private readonly opts: ParsedPreviewerOpts<TData>) {}

    async openCustomDocument(uri: vscode.Uri): Promise<ParsedDocument> {
        return new ParsedDocument(uri);
    }

    async resolveCustomEditor(doc: ParsedDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = this.opts.webviewOptions ?? { enableScripts: false };
        const fileName = path.basename(doc.uri.fsPath || doc.uri.path);
        panel.webview.html = buildLoadingHtml(fileName);
        try {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(doc.uri));
            const data = this.opts.parse(raw, fileName);
            panel.webview.html = this.opts.render(data, fileName);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.webview.html = buildErrorHtml(fileName, message);
        }
    }
}

function buildLoadingHtml(fileName: string): string {
    return buildPage({
        csp: "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(fileName),
        extraCss: `
main {
  position: relative;
  flex: 1;
  min-height: 0;
}
.wv-loading-overlay {
  opacity: 1;
}`,
        body: `<main>
  <div class="wv-loading-overlay visible">
    <div>
      <div class="wv-spinner"></div>
      <div class="wv-loading-text">Loading ${escapeHtml(fileName)}...</div>
    </div>
  </div>
</main>`,
    });
}

function buildErrorHtml(fileName: string, message: string): string {
    return buildPage({
        csp: "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(fileName),
        body: `<div class="wv-state">
  <span>Failed to load ${escapeHtml(fileName)}</span>
  <span class="err">${escapeHtml(message)}</span>
</div>`,
    });
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
