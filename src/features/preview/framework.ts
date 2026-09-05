'use strict';

/**
 * Shared scaffolding for the binary-format custom editors.
 *
 * Two layers:
 *  - `registerParsedPreviewer` — read-only viewers (doo, wct/wtg, map-data): parse bytes, render HTML,
 *    optionally answer webview messages. Removes the CustomDocument / CustomReadonlyEditorProvider
 *    boilerplate that was identical across every previewer.
 *  - `EditableBinaryEditorProvider` — editable formats (wpm, w3c, ...): the CustomEditorProvider
 *    lifecycle VS Code expects (undo/redo via revision counters, dirty tracking, save, save-as, revert,
 *    hot-exit backup) implemented once. A format supplies `parse`, a `serialize` that includes its own
 *    round-trip safety gate, how to render, and how to turn webview messages into edits.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { buildPage } from '../webviewShared';
import { escapeHtml } from '../webviewUtils';
import { offerIssueReport } from '../issueReporting';
import { showErrorWithLogs } from '../diagnostics';

export interface ParsedPreviewerOpts<TData> {
    viewType: string;
    parse: (data: Buffer, fileName: string, context: ParsedPreviewContext) => TData | Promise<TData>;
    render: (data: TData, fileName: string, context: ParsedPreviewContext) => string | Promise<string>;
    supportsMultipleEditorsPerDocument?: boolean;
    /** Options forwarded to panel.webview.options (enableScripts, localResourceRoots, etc.) */
    webviewOptions?: vscode.WebviewOptions;
    /** Options forwarded to registerCustomEditorProvider (retainContextWhenHidden, etc.) */
    panelOptions?: vscode.WebviewPanelOptions;
    onMessage?: (message: unknown, webview: vscode.Webview, data: TData, context: ParsedPreviewContext) => void | Promise<void>;
}

class ParsedDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
    ) {}
    dispose(): void {}
}

export interface ParsedPreviewContext {
    uri: vscode.Uri;
    webview: vscode.Webview;
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
            const context: ParsedPreviewContext = { uri: doc.uri, webview: panel.webview };
            const data = await this.opts.parse(raw, fileName, context);
            if (this.opts.onMessage) {
                panel.webview.onDidReceiveMessage((message) => {
                    void this.opts.onMessage?.(message, panel.webview, data, context);
                });
            }
            panel.webview.html = await this.opts.render(data, fileName, context);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.webview.html = buildErrorHtml(fileName, message);
            offerIssueReport({
                area: `${this.opts.viewType} preview`,
                message,
                resource: doc.uri,
                details: error instanceof Error ? error.stack : undefined,
            });
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
  <div class="wv-loading-overlay visible" role="status" aria-live="polite" aria-busy="true">
    <div>
      <div class="wv-spinner"></div>
      <div class="wv-loading-text">Loading ${escapeHtml(fileName)}...</div>
    </div>
  </div>
</main>`,
    });
}

function buildErrorHtml(fileName: string, message: string, title = `Failed to load ${fileName}`): string {
    return buildPage({
        csp: "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(fileName),
        body: `<div class="wv-state" role="alert">
  <span>${escapeHtml(title)}</span>
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

// ---------------------------------------------------------------------------
// Editable binary documents
// ---------------------------------------------------------------------------

/** One reversible change to a document's model. `apply` is also what `redo` runs. */
export interface BinaryEdit {
    apply: () => void;
    revert: () => void;
}

/**
 * Base document for editable formats. Dirty state is tracked with revision numbers rather than an
 * edit-depth counter: after undo → new edit → undo, a depth counter can read "clean" while the model
 * differs from disk, whereas a revision comparison cannot.
 */
export class EditableBinaryDocument<TFile> implements vscode.CustomDocument {
    currentRevision = 0;
    savedRevision = 0;
    nextRevision = 1;
    webview?: vscode.Webview;

    constructor(readonly uri: vscode.Uri, public file: TFile) {}

    get isDirty(): boolean {
        return this.currentRevision !== this.savedRevision;
    }

    get fileName(): string {
        return this.uri.path.slice(this.uri.path.lastIndexOf('/') + 1);
    }

    dispose(): void {}
}

export interface EditableBinaryEditorOpts<TFile extends { error?: string }, TDoc extends EditableBinaryDocument<TFile>> {
    /** Short lowercase name used in user-facing messages, e.g. `'pathing map'`. */
    label: string;
    parse: (data: Buffer) => TFile;
    /**
     * Serialize for writing. Must contain the format's own round-trip safety gate (serialize →
     * re-parse → compare) and throw to refuse the write; the provider never writes without it.
     */
    serialize: (file: TFile, name: string) => Buffer;
    createDocument: (uri: vscode.Uri, file: TFile) => TDoc;
    /** Full page HTML for a successfully parsed document. */
    render: (doc: TDoc) => string;
    /** Translate a webview message into zero or more `provider.pushEdit` calls. */
    handleMessage: (message: unknown, doc: TDoc, provider: EditableBinaryEditorProvider<TFile, TDoc>) => void;
    /** Push the model/dirty state to the webview. Called after every edit, undo, redo and save. */
    postState: (doc: TDoc) => void;
    /** Sidecar writes that belong to a save (e.g. `war3map.wts`), after the main file was written. */
    onSave?: (doc: TDoc, target: vscode.Uri) => Promise<void>;
    /** Reset sidecar state when the document is reverted to disk. */
    onRevert?: (doc: TDoc) => void;
    webviewOptions?: vscode.WebviewOptions;
}

export class EditableBinaryEditorProvider<TFile extends { error?: string }, TDoc extends EditableBinaryDocument<TFile>>
    implements vscode.CustomEditorProvider<TDoc> {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TDoc>>();
    readonly onDidChangeCustomDocument = this._onDidChange.event;

    constructor(protected readonly opts: EditableBinaryEditorOpts<TFile, TDoc>) {}

    async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<TDoc> {
        const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
        const doc = this.opts.createDocument(uri, this.opts.parse(Buffer.from(await vscode.workspace.fs.readFile(source))));
        // A restored hot-exit backup differs from what is on disk, so it has to open dirty.
        if (openContext.backupId) {
            doc.currentRevision = 1;
            doc.nextRevision = 2;
        }
        return doc;
    }

    async resolveCustomEditor(doc: TDoc, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = this.opts.webviewOptions ?? { enableScripts: true, localResourceRoots: [] };
        doc.webview = panel.webview;
        panel.onDidDispose(() => { if (doc.webview === panel.webview) doc.webview = undefined; });
        panel.webview.onDidReceiveMessage((message) => this.opts.handleMessage(message, doc, this));
        this.render(doc);
    }

    /** Replace the whole page (initial open, revert). Incremental updates go through `postState`. */
    render(doc: TDoc): void {
        if (!doc.webview) return;
        doc.webview.html = doc.file.error
            ? buildErrorHtml(doc.fileName, doc.file.error, `Failed to parse ${this.opts.label}`)
            : this.opts.render(doc);
    }

    /**
     * Apply an edit, mark the document dirty and hand VS Code its undo/redo. `postState` runs after
     * every step; `rerender` additionally replaces the whole page for editors whose incremental update
     * cannot express the change (e.g. a form whose controls mirror a flag word).
     */
    pushEdit(doc: TDoc, label: string, edit: BinaryEdit, rerender: { onApply?: boolean; onUndoRedo?: boolean } = {}): void {
        const beforeRevision = doc.currentRevision;
        const afterRevision = doc.nextRevision++;
        edit.apply();
        doc.currentRevision = afterRevision;
        this.opts.postState(doc);
        if (rerender.onApply) this.render(doc);
        this._onDidChange.fire({
            document: doc,
            label,
            undo: () => {
                edit.revert();
                doc.currentRevision = beforeRevision;
                this.opts.postState(doc);
                if (rerender.onUndoRedo) this.render(doc);
            },
            redo: () => {
                edit.apply();
                doc.currentRevision = afterRevision;
                this.opts.postState(doc);
                if (rerender.onUndoRedo) this.render(doc);
            },
        });
    }

    async saveCustomDocument(doc: TDoc): Promise<void> {
        try {
            await this.writeIfChanged(doc, doc.uri);
            await this.opts.onSave?.(doc, doc.uri);
            doc.savedRevision = doc.currentRevision;
            this.opts.postState(doc);
        } catch (err) {
            void showErrorWithLogs(`Could not save ${this.opts.label}: ${err instanceof Error ? err.message : String(err)}`, err);
            throw err;
        }
    }

    async saveCustomDocumentAs(doc: TDoc, target: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.writeFile(target, this.opts.serialize(doc.file, target.path));
        await this.opts.onSave?.(doc, target);
    }

    async revertCustomDocument(doc: TDoc): Promise<void> {
        doc.file = this.opts.parse(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)));
        this.opts.onRevert?.(doc);
        doc.currentRevision = 0;
        doc.savedRevision = 0;
        doc.nextRevision = 1;
        this.render(doc);
    }

    async backupCustomDocument(doc: TDoc, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, this.opts.serialize(doc.file, doc.uri.path));
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination).then(() => undefined, () => undefined),
        };
    }

    private async writeIfChanged(doc: TDoc, uri: vscode.Uri): Promise<void> {
        const bytes = this.opts.serialize(doc.file, uri.path);
        try {
            if (Buffer.from(await vscode.workspace.fs.readFile(uri)).equals(bytes)) return;
        } catch { /* missing → write */ }
        await vscode.workspace.fs.writeFile(uri, bytes);
    }
}
