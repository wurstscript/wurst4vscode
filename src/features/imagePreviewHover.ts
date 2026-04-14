'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

import { ensureCascCached } from './blpPreview';
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
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
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

            const roots = await getCandidateRoots(document.uri.fsPath);
            let fsPath = await resolveAssetPath(match[1], roots);
            if (!fsPath) {
                fsPath = await ensureCascCached(match[1]) ?? undefined;
            }
            if (!fsPath) {
                return undefined;
            }

            const entry = await ensurePreview(fsPath, hoverCacheDir, MAX_PREVIEW_DIM, previewCache);
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

        return undefined;
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
