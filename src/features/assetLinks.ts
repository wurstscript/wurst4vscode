'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCascAssetCached, getCascCacheDir } from './blpPreview';

// Asset file extensions we want to linkify inside string literals
const ASSET_EXTS = new Set([
    'blp', 'dds', 'tga', 'png', 'jpg', 'jpeg',
    'mdx', 'mdl',
    'mp3', 'wav', 'ogg', 'flac',
    'slk', 'txt', 'fdf', 'toc',
    'w3i', 'w3u', 'w3t', 'w3a', 'w3b', 'w3d', 'w3h', 'w3q', 'w3o', 'w3e',
    'w3r', 'w3c', 'w3s', 'w3l', 'wtg', 'wct', 'wts',
    'wpm', 'shd', 'mmp', 'doo',
]);

// Matches string literals: "some\\path\\file.ext"
const STRING_LITERAL_RE = /"([^"\r\n]+\.([a-zA-Z0-9]+))"/g;

// Matches bare FDF paths in .toc files (each non-empty, non-comment line)
const TOC_LINE_RE = /^[ \t]*([^\s/][^\r\n]*\.fdf)[ \t]*$/gim;

// Matches IncludeFile paths in .fdf files: IncludeFile "path\to\file.fdf",
const FDF_INCLUDE_RE = /\bIncludeFile\s+"([^"\r\n]+\.fdf)"/g;

function isAssetExt(ext: string): boolean {
    return ASSET_EXTS.has(ext.toLowerCase());
}

function isModelExt(ext: string): boolean {
    const lower = ext.toLowerCase();
    return lower === 'mdx' || lower === 'mdl';
}

/** Same logic as getCacheDir() in blpPreview.ts — CASC-extracted game files. */
function cascCacheDir(): string {
    return getCascCacheDir();
}

/** Normalise a WC3 asset path string to OS separators.
 *  Handles both single-backslash (FDF/TOC source) and double-backslash (JASS/Wurst string escapes). */
function normaliseSeparators(assetPath: string): string {
    // Double-backslash escape sequences in JASS/Wurst strings appear as \\ in raw document text
    return assetPath.replace(/\\\\/g, '\\').replace(/[/\\]/g, path.sep);
}

/** Candidate roots to search for an asset path, in priority order. */
function candidateRoots(document: vscode.TextDocument): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];

    const add = (p: string) => {
        if (!seen.has(p)) { seen.add(p); roots.push(p); }
    };

    // 1. Document's own directory
    add(path.dirname(document.uri.fsPath));

    for (const wsf of vscode.workspace.workspaceFolders ?? []) {
        const root = wsf.uri.fsPath;

        // 2. Workspace root itself (handles paths like "war3mapImported\file.mp3")
        add(root);

        // 3. Common asset subdirs directly under workspace root
        for (const sub of ['imports', 'war3mapImported', 'war3map', 'assets', 'UI']) {
            add(path.join(root, sub));
        }

        // 4. Folder-mode map dirs (*.w3x / *.w3m) — the map root IS the archive root,
        //    so asset paths like "war3mapImported\file" resolve from there directly.
        //    Do NOT add war3mapImported as a separate root here — that would double-resolve
        //    paths that already start with "war3mapImported\".
        try {
            for (const entry of fs.readdirSync(root)) {
                const lower = entry.toLowerCase();
                if (lower.endsWith('.w3x') || lower.endsWith('.w3m')) {
                    const full = path.join(root, entry);
                    try {
                        if (fs.statSync(full).isDirectory()) add(full);
                    } catch { /* skip */ }
                }
            }
        } catch { /* skip */ }
    }

    // 5. CASC cache — game-internal paths (e.g. "UI\FrameDef\UI\*.fdf", "Textures\*.blp")
    //    are stored here if the user has ever triggered a CASC extraction.
    add(cascCacheDir());

    return roots;
}

function candidateRootsForFsPath(fsPath?: string): string[] {
    const fakeDocument = { uri: vscode.Uri.file(fsPath || path.join(process.cwd(), 'dummy')) } as vscode.TextDocument;
    return candidateRoots(fakeDocument);
}

function resolveAssetPath(assetPath: string, roots: string[]): vscode.Uri | undefined {
    const normalised = normaliseSeparators(assetPath);
    const lower = normaliseSeparators(assetPath.toLowerCase());
    const lowerDds = lower.replace(/\.blp$/, '.dds');
    for (const root of roots) {
        // Exact case first
        const candidate = path.join(root, normalised);
        if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
        // CASC cache stores everything lowercase — try that too
        if (lower !== normalised) {
            const candidateLower = path.join(root, lower);
            if (fs.existsSync(candidateLower)) return vscode.Uri.file(candidateLower);
        }
        // CASC cache may convert BLP → DDS
        if (lowerDds !== lower) {
            const candidateDds = path.join(root, lowerDds);
            if (fs.existsSync(candidateDds)) return vscode.Uri.file(candidateDds);
        }
    }

    const fileName = path.basename(normalised);
    for (const root of roots) {
        const candidate = path.join(root, fileName);
        if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
    return undefined;
}

function addLink(
    links: vscode.DocumentLink[],
    document: vscode.TextDocument,
    _text: string,
    startOffset: number,
    length: number,
    target: vscode.Uri,
): void {
    const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(startOffset + length),
    );
    const link = new vscode.DocumentLink(range, target);
    link.tooltip = target.fsPath;
    links.push(link);
}

function addLazyCascLink(
    links: vscode.DocumentLink[],
    document: vscode.TextDocument,
    startOffset: number,
    length: number,
    assetPath: string,
): void {
    const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(startOffset + length),
    );
    const args = encodeURIComponent(JSON.stringify([assetPath]));
    const target = vscode.Uri.parse(`command:wurst.openAssetFromString?${args}`);
    const link = new vscode.DocumentLink(range, target);
    link.tooltip = `Extract and open ${assetPath}`;
    links.push(link);
}

// ── Wurst / JASS: string literals containing asset paths ─────────────────────

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
            const target = resolveAssetPath(assetPath, roots);
            if (target) {
                addLink(links, document, text, m.index + 1, assetPath.length, target);
                continue;
            }
            if (isModelExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
            }
        }

        return links;
    }
}

// ── FDF: IncludeFile paths ────────────────────────────────────────────────────

class FdfLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const text = document.getText();
        const roots = candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        // IncludeFile links
        FDF_INCLUDE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FDF_INCLUDE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = resolveAssetPath(assetPath, roots);
            if (!target) continue;
            // point at the path inside the quotes
            const startOffset = m.index + m[0].indexOf('"') + 1;
            addLink(links, document, text, startOffset, assetPath.length, target);
        }

        // Also linkify any other quoted asset paths in the file
        STRING_LITERAL_RE.lastIndex = 0;
        while ((m = STRING_LITERAL_RE.exec(text)) !== null) {
            const [, assetPath, ext] = m;
            if (!isAssetExt(ext)) continue;
            const target = resolveAssetPath(assetPath, roots);
            if (target) {
                addLink(links, document, text, m.index + 1, assetPath.length, target);
                continue;
            }
            if (isModelExt(ext)) {
                addLazyCascLink(links, document, m.index + 1, assetPath.length, assetPath);
            }
        }

        return links;
    }
}

// ── TOC: bare path lines ──────────────────────────────────────────────────────

class TocLinkProvider implements vscode.DocumentLinkProvider {
    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const text = document.getText();
        const roots = candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        TOC_LINE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOC_LINE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = resolveAssetPath(assetPath, roots);
            if (!target) continue;
            // Offset of the captured path within the full match
            const startOffset = m.index + m[0].indexOf(m[1]);
            addLink(links, document, text, startOffset, assetPath.length, target);
        }

        return links;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAssetLinks(_context: vscode.ExtensionContext): vscode.Disposable {
    const openAsset = vscode.commands.registerCommand('wurst.openAssetFromString', async (assetPath: string) => {
        if (!assetPath) return;
        let target = resolveAssetPath(assetPath, candidateRootsForFsPath(vscode.window.activeTextEditor?.document.uri.fsPath));
        if (!target) {
            const cached = await ensureCascAssetCached(assetPath);
            if (cached) target = vscode.Uri.file(cached);
        }
        if (!target) {
            vscode.window.showWarningMessage(`Could not resolve asset: ${assetPath}`);
            return;
        }
        if (target.fsPath.toLowerCase().endsWith('.mdx')) {
            await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.blpPreview');
            return;
        }
        await vscode.commands.executeCommand('vscode.open', target);
    });

    const wurst = vscode.languages.registerDocumentLinkProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        new WurstAssetLinkProvider(),
    );

    const fdf = vscode.languages.registerDocumentLinkProvider(
        [{ language: 'wc3-fdf' }, { pattern: '**/*.fdf' }],
        new FdfLinkProvider(),
    );

    const toc = vscode.languages.registerDocumentLinkProvider(
        [{ language: 'wc3-toc' }, { pattern: '**/*.toc' }],
        new TocLinkProvider(),
    );

    return vscode.Disposable.from(openAsset, wurst, fdf, toc);
}
