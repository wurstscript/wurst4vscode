'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Maps "ClassName.memberName" → raw asset path string
export type AssetIndex = Map<string, string>;

// static constant foo = "path"  (with optional public/private modifier)
const WURST_CONST_RE = /^\s*(?:(?:public|private|protected)\s+)?static\s+constant\s+(\w+)\s*=\s*"([^"]+\.(blp|dds|tga|png|jpg|jpeg))"/;

// The whole walk is asynchronous on purpose: it runs on the extension host, which also carries the
// language client's JSON-RPC traffic. A synchronous recursive read of a large project (plus its
// `_build/dependencies`) stalled every LSP message for the duration, and it re-ran after each save.
async function findWurstFiles(dir: string, out: string[], maxDepth: number): Promise<void> {
    if (maxDepth <= 0) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    const subdirs: string[] = [];
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) subdirs.push(full);
        else if (e.isFile() && e.name.endsWith('.wurst')) out.push(full);
    }
    for (const sub of subdirs) await findWurstFiles(sub, out, maxDepth - 1);
}

async function parseAssetFile(filePath: string, index: AssetIndex): Promise<void> {
    let text: string;
    try { text = await fs.promises.readFile(filePath, 'utf8'); } catch { return; }

    // "public class" / "class" as whole alternatives (rather than an optional "public\s+" wrapped in
    // its own quantifier ahead of a separate \s+) removes the worst of the whitespace-adjacency
    // ambiguity, though the analyzer still isn't fully satisfied; local source-file text (not
    // attacker-controlled/network-facing input), so the residual risk is low.
    // eslint-disable-next-line sonarjs/super-linear-regex -- see comment above
    const classMatch = /^\s*(?:public\s+class|class)\s+(\w+)/m.exec(text);
    if (!classMatch) return;
    const className = classMatch[1];

    for (const line of text.split('\n')) {
        const m = WURST_CONST_RE.exec(line);
        if (m) index.set(`${className}.${m[1]}`, m[2]);
    }
}

async function buildAssetIndex(): Promise<AssetIndex> {
    const index: AssetIndex = new Map();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return index;

    const searchRoots = [wsRoot];
    const depsDir = path.join(wsRoot, '_build', 'dependencies');
    try {
        if ((await fs.promises.stat(depsDir)).isDirectory()) searchRoots.push(depsDir);
    } catch { /* no dependency dir */ }

    const files: string[] = [];
    for (const searchRoot of searchRoots) {
        await findWurstFiles(searchRoot, files, 8);
    }
    for (const filePath of files) {
        await parseAssetFile(filePath, index);
    }

    return index;
}

let cachedIndex: Promise<AssetIndex> | null = null;
let cachedForWs: string | null = null;

export function getAssetIndex(): Promise<AssetIndex> {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!cachedIndex || cachedForWs !== wsRoot) {
        cachedIndex = buildAssetIndex();
        cachedForWs = wsRoot;
    }
    return cachedIndex;
}

export function invalidateAssetIndex(): void {
    cachedIndex = null;
}
