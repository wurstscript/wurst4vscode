'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Maps "ClassName.memberName" → raw asset path string
export type AssetIndex = Map<string, string>;

// static constant foo = "path"  (with optional public/private modifier)
const WURST_CONST_RE = /^\s*(?:(?:public|private|protected)\s+)?static\s+constant\s+(\w+)\s*=\s*"([^"]+\.(blp|dds|tga|png|jpg|jpeg))"/;

function findWurstFiles(dir: string, cb: (p: string) => void, maxDepth: number): void {
    if (maxDepth <= 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            findWurstFiles(full, cb, maxDepth - 1);
        } else if (e.isFile() && e.name.endsWith('.wurst')) {
            cb(full);
        }
    }
}

function parseAssetFile(filePath: string, index: AssetIndex): void {
    let text: string;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }

    const classMatch = /^\s*(?:public\s+)?class\s+(\w+)/m.exec(text);
    if (!classMatch) return;
    const className = classMatch[1];

    for (const line of text.split('\n')) {
        const m = WURST_CONST_RE.exec(line);
        if (m) index.set(`${className}.${m[1]}`, m[2]);
    }
}

function buildAssetIndex(): AssetIndex {
    const index: AssetIndex = new Map();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsRoot) return index;

    const searchRoots = [wsRoot];
    const depsDir = path.join(wsRoot, '_build', 'dependencies');
    if (fs.existsSync(depsDir)) searchRoots.push(depsDir);

    for (const searchRoot of searchRoots) {
        findWurstFiles(searchRoot, (filePath) => {
            parseAssetFile(filePath, index);
        }, 8);
    }

    return index;
}

let cachedIndex: AssetIndex | null = null;
let cachedForWs: string | null = null;

export function getAssetIndex(): AssetIndex {
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
