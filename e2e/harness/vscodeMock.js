'use strict';

/**
 * A `vscode` module stand-in with just enough surface for the host-side preview/editor modules to
 * load and build their webview HTML outside VS Code.
 *
 * Deliberately thin: anything a test actually asserts on (messages posted to the webview, files
 * written, commands executed) is recorded on the mock so the test can read it back, and everything
 * else is an inert no-op. If a module reaches for API this doesn't have, it fails loudly rather than
 * silently taking a different branch.
 */

const fs = require('fs');
const path = require('path');

function fileUri(fsPath) {
    const normalized = String(fsPath).replace(/\\/g, '/');
    const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return {
        scheme: 'file',
        fsPath: path.normalize(fsPath),
        path: withSlash,
        toString() { return `file://${withSlash}`; },
        with(change) { return fileUri(change.path ? change.path.replace(/^\//, '') : fsPath); },
    };
}

function createVscodeMock(options = {}) {
    const config = options.config || {};
    const recorded = {
        commands: [],
        info: [],
        warnings: [],
        errors: [],
        writes: new Map(),
    };

    class EventEmitter {
        constructor() {
            this.listeners = [];
            // `event` is a property rather than a method because consumers destructure and pass it
            // around detached, exactly as they do with the real vscode.EventEmitter.
            this.event = (listener) => this.subscribe(listener);
        }
        subscribe(listener) {
            this.listeners.push(listener);
            return { dispose: () => this.unsubscribe(listener) };
        }
        unsubscribe(listener) {
            this.listeners = this.listeners.filter((candidate) => candidate !== listener);
        }
        fire(value) { for (const listener of this.listeners.slice()) listener(value); }
        dispose() { this.listeners = []; }
    }

    const noopWatcher = () => ({
        onDidChange: () => ({ dispose() {} }),
        onDidCreate: () => ({ dispose() {} }),
        onDidDelete: () => ({ dispose() {} }),
        dispose() {},
    });

    const vscodeMock = {
        Uri: {
            file: fileUri,
            // `file:///C:/x` must come back as `C:\x`, not `\C:\x`: drop the slash before a drive letter.
            parse: (value) => fileUri(String(value).replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')),
            joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)),
        },
        workspace: {
            workspaceFolders: options.workspaceFolders || [],
            getWorkspaceFolder: () => (options.workspaceFolders || [])[0],
            asRelativePath: (target) => String((target && target.fsPath) || target),
            getConfiguration: (section) => ({
                get: (key, fallback) => {
                    const full = section ? `${section}.${key}` : key;
                    return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : fallback;
                },
                update: () => Promise.resolve(),
            }),
            onDidChangeConfiguration: () => ({ dispose() {} }),
            createFileSystemWatcher: noopWatcher,
            openTextDocument: () => Promise.resolve({ getText: () => '' }),
            fs: {
                readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
                writeFile: async (uri, bytes) => {
                    recorded.writes.set(uri.toString(), Buffer.from(bytes));
                    fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
                },
                stat: async (uri) => ({ size: fs.statSync(uri.fsPath).size }),
                delete: async (uri) => { fs.rmSync(uri.fsPath, { force: true }); },
                createDirectory: async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
            },
        },
        window: {
            createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
            registerCustomEditorProvider: () => ({ dispose() {} }),
            showInformationMessage: (message) => { recorded.info.push(message); return Promise.resolve(undefined); },
            showWarningMessage: (message) => { recorded.warnings.push(message); return Promise.resolve(undefined); },
            showErrorMessage: (message) => { recorded.errors.push(message); return Promise.resolve(undefined); },
            withProgress: (_opts, task) => task({ report() {} }, { isCancellationRequested: false }),
            activeTextEditor: undefined,
            visibleTextEditors: [],
        },
        commands: {
            registerCommand: () => ({ dispose() {} }),
            executeCommand: (command, ...args) => {
                recorded.commands.push({ command, args });
                // Lets a harness wire `undo`/`redo`/`workbench.action.files.save` to the real edit
                // stack, so a Ctrl+Z pressed in the page actually undoes rather than only being noted.
                if (options.onCommand) return Promise.resolve(options.onCommand(command, ...args));
                return Promise.resolve(undefined);
            },
        },
        EventEmitter,
        Disposable: class Disposable {
            constructor(fn) { this.dispose = fn || (() => {}); }
            static from(...items) { return { dispose: () => items.forEach((i) => i && i.dispose && i.dispose()) }; }
        },
        ViewColumn: { One: 1, Two: 2, Beside: -2 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ProgressLocation: { Notification: 15, Window: 10 },
        env: {
            openExternal: () => Promise.resolve(true),
            clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
        },
        Range: class Range {}, Position: class Position {}, Selection: class Selection {},
        WorkspaceEdit: class WorkspaceEdit {},
        RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
        TabInputCustom: class TabInputCustom {},
        recorded,
    };

    return vscodeMock;
}

module.exports = { createVscodeMock, fileUri };
