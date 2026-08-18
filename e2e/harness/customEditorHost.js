'use strict';

/**
 * The VS Code side of a `CustomEditorProvider`, faked: a webview panel, the undo/redo edit stack
 * VS Code maintains from `onDidChangeCustomDocument`, and the save call.
 *
 * Shared by every editable-format harness (objmod, .w3i, .wpm) so each one only has to say how to
 * build its provider — the lifecycle around it stays identical to what VS Code actually does.
 */

const path = require('path');

const { root } = require('./tsLoader');

/**
 * @param {object} opts
 * @param {string} opts.origin  Harness server origin, used for cspSource and asWebviewUri.
 * @param {object} opts.provider
 * @param {object} opts.uri     vscode.Uri of the document to open.
 * @param {object} [opts.openContext]
 */
async function mountCustomEditor(opts) {
    const { origin, provider, uri } = opts;

    /** @type {Array<{label: string, undo: () => void, redo: () => void}>} */
    const editStack = [];
    let editIndex = 0;

    const posted = [];
    const postListeners = new Set();
    const disposeListeners = [];
    let receiveMessage = () => {};
    let html = '';

    const webview = {
        options: {},
        cspSource: origin,
        get html() { return html; },
        set html(value) { html = value; },
        asWebviewUri: (target) => {
            const abs = path.resolve(target.fsPath);
            const distWebview = path.join(root, 'dist', 'webview');
            const url = abs.startsWith(distWebview)
                ? `${origin}/dist/webview/${path.relative(distWebview, abs).replace(/\\/g, '/')}`
                : `${origin}/file/${encodeURIComponent(abs)}`;
            return { toString: () => url };
        },
        postMessage: (message) => {
            posted.push(message);
            for (const listener of postListeners) listener(message);
            return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener) => { receiveMessage = listener; return { dispose() {} }; },
    };

    const panel = {
        webview,
        active: true,
        visible: true,
        viewColumn: 1,
        reveal() {},
        dispose() { for (const listener of disposeListeners) listener(); },
        onDidDispose: (listener) => { disposeListeners.push(listener); return { dispose() {} }; },
        onDidChangeViewState: () => ({ dispose() {} }),
    };

    provider.onDidChangeCustomDocument((event) => {
        // VS Code truncates the redo branch when a new edit is made after an undo.
        editStack.length = editIndex;
        editStack.push({ label: event.label, undo: event.undo, redo: event.redo });
        editIndex = editStack.length;
    });

    const doc = await provider.openCustomDocument(uri, opts.openContext || {});
    await provider.resolveCustomEditor(doc, panel);

    return {
        provider,
        doc,
        panel,
        webview,
        posted,
        get html() { return html; },
        /** Deliver a message from the webview to the host, exactly as VS Code would. */
        receive: (message) => receiveMessage(message),
        onPost: (listener) => { postListeners.add(listener); return () => postListeners.delete(listener); },
        get editLabels() { return editStack.map((entry) => entry.label); },
        get undoDepth() { return editIndex; },
        undo: () => { if (editIndex > 0) editStack[--editIndex].undo(); },
        redo: () => { if (editIndex < editStack.length) editStack[editIndex++].redo(); },
        save: () => provider.saveCustomDocument(doc),
        /** Re-runs the provider's own reload, which rebuilds `html` from current document state. */
        rerender: async () => {
            if (doc.reload) await doc.reload();
            return html;
        },
    };
}

module.exports = { mountCustomEditor };
