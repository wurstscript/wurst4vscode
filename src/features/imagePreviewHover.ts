'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

import { ensureGameTextureCached } from './preview/cascStorage';
import {
    ensurePreview,
    getCandidateRoots,
    getTempPreviewDir,
    PreviewCacheEntry,
    resolveAssetPath,
} from './imageAssetSupport';

const MAX_PREVIEW_DIM = 128;
const IMAGE_STRING_RE = /"([^"\r\n]+\.(blp|dds|tga|png|jpg|jpeg))"/gi;

const previewCache = new Map<string, PreviewCacheEntry>();
const hoverCacheDir = getTempPreviewDir('wurst_hover_preview');

class ImagePreviewHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        const version = document.version;
        const stale = () => token.isCancellationRequested || document.version !== version;
        if (stale()) return undefined;
        const line = document.lineAt(position).text;
        const column = position.character;

        IMAGE_STRING_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMAGE_STRING_RE.exec(line)) !== null) {
            const start = match.index + 1;
            const end = start + match[1].length;
            if (column < start || column > end) {
                continue;
            }
            return this.previewAsset(document, position, match[1], start, end, stale);
        }
        return undefined;
    }

    private async previewAsset(document: vscode.TextDocument, position: vscode.Position, asset: string, start: number, end: number, stale: () => boolean): Promise<vscode.Hover | undefined> {
        const roots = await getCandidateRoots(document.uri.fsPath);
        if (stale()) return undefined;
        let fsPath = await resolveAssetPath(asset, roots);
        if (stale()) return undefined;
        if (!fsPath) {
            fsPath = await ensureGameTextureCached(asset) ?? undefined;
            if (stale()) return undefined;
        }
        if (!fsPath) {
            return undefined;
        }

        const entry = await ensurePreview(fsPath, hoverCacheDir, MAX_PREVIEW_DIM, previewCache);
        if (stale()) return undefined;
        if (!entry) {
            return undefined;
        }

        const label = entry.origW > 0
            ? `${entry.description} — ${entry.origW}×${entry.origH}`
            : path.basename(fsPath);
        const imgUri = vscode.Uri.file(entry.previewPath).toString();
        const markdown = new vscode.MarkdownString(`![${label}](${imgUri})\n\n*${label}*`);
        markdown.isTrusted = true;
        markdown.supportHtml = true;

        return new vscode.Hover(markdown, new vscode.Range(position.line, start, position.line, end));
    }
}

export function registerImagePreviewHover(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.languages.registerHoverProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { language: 'wc3-fdf' },
            { pattern: '**/*.j' },
        ],
        new ImagePreviewHoverProvider(),
    );
}
