'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type AssetIndex = Map<string, string>;
const WURST_CONST_RE = /^\s*(?:(?:public|private|protected)\s+)?static\s+constant\s+(\w+)\s*=\s*"([^"]+\.(blp|dds|tga|png|jpg|jpeg))"/;
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '_build', 'build', 'out', 'dist']);

interface ProjectIndex {
    files: Map<string, AssetIndex>;
    dirty: Set<string>;
    initialized: boolean;
    pending?: Promise<AssetIndex>;
    index: AssetIndex;
}
const projects = new Map<string, ProjectIndex>();

function isIndexedFile(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !file.endsWith('.wurst')) return false;
    const parts = relative.split(path.sep);
    if (parts[0] === '_build' && parts[1] === 'dependencies') parts.splice(0, 2);
    return !parts.some((part) => EXCLUDED_DIRS.has(part));
}

async function findWurstFiles(dir: string, out: Set<string>, maxDepth: number): Promise<void> {
    if (maxDepth <= 0) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) await findWurstFiles(full, out, maxDepth - 1);
        else if (entry.isFile() && entry.name.endsWith('.wurst')) out.add(full);
    }
}

async function parseAssetFile(filePath: string): Promise<AssetIndex> {
    const index: AssetIndex = new Map();
    let text: string;
    try {
        const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
        text = open ? open.getText() : await fs.promises.readFile(filePath, 'utf8');
    } catch { return index; }
    // eslint-disable-next-line sonarjs/super-linear-regex -- local language source, bounded to one file
    const classMatch = /^\s*(?:public\s+class|class)\s+(\w+)/m.exec(text);
    if (!classMatch) return index;
    for (const line of text.split('\n')) {
        const match = WURST_CONST_RE.exec(line);
        if (match) index.set(`${classMatch[1]}.${match[1]}`, match[2]);
    }
    return index;
}

async function discoverFiles(root: string): Promise<Set<string>> {
    const files = new Set<string>();
    await findWurstFiles(root, files, 8);
    await findWurstFiles(path.join(root, '_build', 'dependencies'), files, 8);
    for (const doc of vscode.workspace.textDocuments) {
        if (isIndexedFile(root, doc.uri.fsPath)) files.add(doc.uri.fsPath);
    }
    return files;
}

async function rebuild(root: string, state: ProjectIndex): Promise<AssetIndex> {
    if (!state.initialized) {
        for (const file of await discoverFiles(root)) state.dirty.add(file);
        state.initialized = true;
    }
    // Changes arriving during I/O stay dirty for the next request.
    const dirty = [...state.dirty];
    dirty.forEach((file) => state.dirty.delete(file));
    for (const file of dirty) {
        const entries = await parseAssetFile(file);
        if (entries.size) state.files.set(file, entries);
        else state.files.delete(file);
    }
    const index: AssetIndex = new Map();
    for (const entries of state.files.values()) for (const [key, value] of entries) index.set(key, value);
    state.index = index;
    return index;
}

export function getAssetIndex(uri?: vscode.Uri): Promise<AssetIndex> {
    const root = (uri ? vscode.workspace.getWorkspaceFolder(uri) : vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
    if (!root) return Promise.resolve(new Map());
    let state = projects.get(root);
    if (!state) {
        state = { files: new Map(), dirty: new Set(), initialized: false, index: new Map() };
        projects.set(root, state);
    }
    if (state.pending) {
        const current = state;
        return current.pending!.then(() => current.dirty.size ? getAssetIndex(uri) : current.index);
    }
    if (state.initialized && !state.dirty.size) return Promise.resolve(state.index);
    const current = state;
    current.pending = rebuild(root, current).finally(() => { current.pending = undefined; });
    return current.pending;
}

export function invalidateAssetIndex(uri?: vscode.Uri): void {
    if (!uri) { projects.clear(); return; }
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (root && isIndexedFile(root, uri.fsPath)) projects.get(root)?.dirty.add(uri.fsPath);
}

/** Track disk edits and open buffers; parsing stays lazy until a visible reference needs it. */
export function registerAssetIndexChanges(onChange: () => void): vscode.Disposable {
    const changed = (uri: vscode.Uri) => { invalidateAssetIndex(uri); onChange(); };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.wurst');
    return vscode.Disposable.from(watcher,
        watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.contentChanges.length && event.document.fileName.endsWith('.wurst')) changed(event.document.uri);
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            if (doc.fileName.endsWith('.wurst')) changed(doc.uri);
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => { projects.clear(); onChange(); }),
        new vscode.Disposable(() => projects.clear()));
}
