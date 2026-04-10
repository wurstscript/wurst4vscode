'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Asset file extensions we want to linkify
const ASSET_EXTS = new Set([
    'blp', 'dds', 'tga', 'png', 'jpg', 'jpeg',
    'mdx', 'mdl',
    'mp3', 'wav', 'ogg', 'flac',
    'slk', 'txt', 'fdf',
    'w3i', 'w3u', 'w3t', 'w3a', 'w3b', 'w3d', 'w3h', 'w3q', 'w3o', 'w3e',
    'w3r', 'w3c', 'w3s', 'w3l', 'wtg', 'wct', 'wts',
    'wpm', 'shd', 'mmp', 'doo',
]);

// Matches string literals: "some\\path\\file.ext" or "some/path/file.ext"
// Captures the content between the quotes
const STRING_LITERAL_RE = /"([^"\r\n]+\.([a-zA-Z0-9]+))"/g;

function isAssetExt(ext: string): boolean {
    return ASSET_EXTS.has(ext.toLowerCase());
}

/** Candidate roots to search for an asset path, in priority order. */
function candidateRoots(document: vscode.TextDocument): string[] {
    const roots: string[] = [];
    const docDir = path.dirname(document.uri.fsPath);

    // 1. Alongside the document itself
    roots.push(docDir);

    // 2. Workspace folders
    for (const wsf of vscode.workspace.workspaceFolders ?? []) {
        const root = wsf.uri.fsPath;
        if (!roots.includes(root)) roots.push(root);

        // Common map-project layouts
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets']) {
            const s = path.join(root, sub);
            if (!roots.includes(s)) roots.push(s);
        }

        // Folder-mode map dirs (*.w3x / *.w3m directories) in the workspace root
        try {
            for (const entry of fs.readdirSync(root)) {
                const lower = entry.toLowerCase();
                if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) {
                    const full = path.join(root, entry);
                    try {
                        if (fs.statSync(full).isDirectory()) {
                            roots.push(full);
                            roots.push(path.join(full, 'war3mapImported'));
                        }
                    } catch { /* skip */ }
                }
            }
        } catch { /* skip */ }
    }

    return roots;
}

function resolveAssetPath(assetPath: string, roots: string[]): vscode.Uri | undefined {
    // Normalise separators
    const normalised = assetPath.replace(/\\\\/g, '\\').replace(/\\/g, path.sep).replace(/\//g, path.sep);
    for (const root of roots) {
        const candidate = path.join(root, normalised);
        if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
    return undefined;
}

class WurstAssetLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const text = document.getText();
        const roots = candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        STRING_LITERAL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_LITERAL_RE.exec(text)) !== null) {
            const [, assetPath, ext] = m;
            if (!isAssetExt(ext)) continue;

            const startOffset = m.index + 1; // skip opening quote
            const endOffset   = startOffset + assetPath.length;
            const range = new vscode.Range(
                document.positionAt(startOffset),
                document.positionAt(endOffset),
            );

            const target = resolveAssetPath(assetPath, roots);
            if (!target) continue; // only link when we can actually find the file

            const link = new vscode.DocumentLink(range, target);
            link.tooltip = target.fsPath;
            links.push(link);
        }

        return links;
    }
}

export function registerAssetLinks(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.languages.registerDocumentLinkProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            // plain .j files may be identified as jass or wurst depending on association
            { pattern: '**/*.j' },
        ],
        new WurstAssetLinkProvider(),
    );
}
