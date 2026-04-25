'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { getCandidateRoots, resolveAssetPath as resolveAssetPathString, resolveAssetPathWithCasc } from './imageAssetSupport';

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

async function candidateRoots(document: vscode.TextDocument): Promise<string[]> {
    return getCandidateRoots(document.uri.fsPath);
}

async function candidateRootsForFsPath(fsPath?: string): Promise<string[]> {
    return getCandidateRoots(fsPath || path.join(process.cwd(), 'dummy'));
}

async function resolveAssetPath(assetPath: string, roots: string[]): Promise<vscode.Uri | undefined> {
    const resolved = await resolveAssetPathString(assetPath, roots);
    return resolved ? vscode.Uri.file(resolved) : undefined;
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
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        STRING_LITERAL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = STRING_LITERAL_RE.exec(text)) !== null) {
            const [, assetPath, ext] = m;
            if (!isAssetExt(ext)) continue;
            const target = await resolveAssetPath(assetPath, roots);
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
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        // IncludeFile links
        FDF_INCLUDE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FDF_INCLUDE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = await resolveAssetPath(assetPath, roots);
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
            const target = await resolveAssetPath(assetPath, roots);
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
    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        const text = document.getText();
        const roots = await candidateRoots(document);
        const links: vscode.DocumentLink[] = [];

        TOC_LINE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOC_LINE_RE.exec(text)) !== null) {
            const assetPath = m[1];
            const target = await resolveAssetPath(assetPath, roots);
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
        const resolved = await resolveAssetPathWithCasc(
            assetPath,
            await candidateRootsForFsPath(vscode.window.activeTextEditor?.document.uri.fsPath)
        );
        const target = resolved ? vscode.Uri.file(resolved) : undefined;
        if (!target) {
            vscode.window.showWarningMessage(`Could not resolve asset: ${assetPath}`);
            return;
        }
        if (path.extname(target.fsPath).toLowerCase() === '.mdx') {
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
