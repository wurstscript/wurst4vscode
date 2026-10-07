'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { gatherImportedAssets, getCandidateRoots, resolveAssetPath as resolveAssetPathString, resolveAssetPathWithCasc } from './imageAssetSupport';
import { loadObjValueCatalog, type ValueOption } from './objModPreview';
import { handleModelThumbMessage } from './preview/modelPreviewHost';
import { getGameAssetCacheDir, getModelThumbCacheDir } from './preview/cascStorage';
import { isSoundAssetPath, playSoundInline } from './soundPreview';
import { buildPage, ICON_INLINE_CSS, scriptSafeJson } from './webviewShared';
import { escapeHtml, makeNonce } from './webviewUtils';
import { showWarningWithLogs } from './diagnostics';
import ASSET_CARD_CSS from '../webview/assetBrowserCards.css';

// Asset file extensions we want to linkify inside string literals
const ASSET_EXTS = new Set([
    'blp', 'dds', 'tga', 'png', 'jpg', 'jpeg',
    'mdx', 'mdl',
    'mp3', 'wav', 'ogg', 'flac',
    'slk', 'txt', 'fdf', 'toc',
    'w3i', 'w3u', 'w3t', 'w3a', 'w3b', 'w3d', 'w3h', 'w3q', 'w3o', 'w3e',
    'w3r', 'w3c', 'w3s', 'w3l', 'imp', 'wtg', 'wct', 'wts',
    'wpm', 'shd', 'mmp', 'doo',
]);

// Matches string literals: "some\\path\\file.ext"
const STRING_LITERAL_RE = /"([^"\r\n]+\.([a-zA-Z0-9]+))"/g;

// Matches bare FDF paths in .toc files (each non-empty, non-comment line)
const TOC_LINE_RE = /^[ \t]*([^\s/][^\r\n]*\.fdf)[ \t]*$/gim;

function isAssetExt(ext: string): boolean {
    return ASSET_EXTS.has(ext.toLowerCase());
}

function isModelExt(ext: string): boolean {
    const lower = ext.toLowerCase();
    return lower === 'mdx' || lower === 'mdl';
}

function isSoundExt(ext: string): boolean {
    const lower = ext.toLowerCase();
    return lower === 'mp3' || lower === 'wav' || lower === 'ogg' || lower === 'flac';
}

type BrowseAssetKind = 'icon' | 'model' | 'sound';

interface BrowseAssetTarget {
    uri: vscode.Uri;
    range: vscode.Range;
    kind: BrowseAssetKind;
    currentValue: string;
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

function findAssetStringAt(document: vscode.TextDocument, range: vscode.Range): BrowseAssetTarget | undefined {
    const offset = document.offsetAt(range.start);
    for (const target of findAssetStrings(document)) {
        const start = document.offsetAt(target.range.start) - 1;
        const end = document.offsetAt(target.range.end) + 1;
        if (offset >= start && offset <= end) return target;
    }
    return undefined;
}

function* findAssetStrings(document: vscode.TextDocument): Generator<BrowseAssetTarget> {
    const text = document.getText();
    const regex = new RegExp(STRING_LITERAL_RE);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const assetPath = match[1];
        const ext = match[2].toLowerCase();
        const innerStart = match.index + 1;
        const innerEnd = innerStart + assetPath.length;
        if (!isAssetExt(ext)) continue;
        let kind: BrowseAssetKind;
        if (isModelExt(ext)) kind = 'model';
        else if (isSoundExt(ext)) kind = 'sound';
        else kind = 'icon';
        yield {
            uri: document.uri,
            range: new vscode.Range(document.positionAt(innerStart), document.positionAt(innerEnd)),
            kind,
            currentValue: assetPath,
        };
    }
}

function escapeWurstStringAssetPath(assetPath: string): string {
    return assetPath
        .replace(/\//g, '\\')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

function assetBrowserItems(options: readonly ValueOption[]): Array<{ value: string; label: string; detail: string; iconPath?: string }> {
    return options.map((option) => ({
        value: option.value,
        label: option.label || option.value,
        detail: option.detail || option.value,
        iconPath: option.iconPath,
    }));
}

async function replaceAssetString(target: BrowseAssetTarget, assetPath: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(target.uri);
    if (doc.getText(target.range) !== target.currentValue) {
        void showWarningWithLogs('The original asset text changed. Reopen its asset picker before using an asset.', new Error('Asset replacement target is stale.'));
        return false;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target.uri, target.range, escapeWurstStringAssetPath(assetPath));
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        void showWarningWithLogs(`Could not replace asset path: ${assetPath}`, new Error('VS Code rejected the workspace edit.'));
        return false;
    }
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    return true;
}

export async function openAssetBrowser(context: vscode.ExtensionContext, resource?: vscode.Uri): Promise<void> {
    await openCodeAssetBrowser(context, undefined, resource);
}

async function openCodeAssetBrowser(context: vscode.ExtensionContext, target?: BrowseAssetTarget, resource?: vscode.Uri, restoredPanel?: vscode.WebviewPanel): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file' || folder.uri.scheme === 'vscode-remote');
    const source = [target?.uri, resource, vscode.window.activeTextEditor?.document.uri,
        workspace && vscode.Uri.joinPath(workspace.uri, 'asset-browser')].find((uri) => uri?.scheme === 'file' || uri?.scheme === 'vscode-remote');
    const documentUri = source || vscode.Uri.file(path.join(getGameAssetCacheDir(), 'asset-browser'));
    const currentValue = target?.currentValue || '';
    const browseOnly = !target;
    const [catalog, imported, assetRoots] = await Promise.all([
        loadObjValueCatalog(),
        source ? gatherImportedAssets(source.fsPath) : Promise.resolve({ icon: [], model: [], sound: [] }),
        getCandidateRoots(documentUri.fsPath),
    ]);
    const panel = restoredPanel || vscode.window.createWebviewPanel(
        'wurst.assetBrowser',
        browseOnly ? 'Warcraft III Asset Browser' : 'Choose Warcraft III Asset',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Asset roots + caches are admitted so models and cached thumbnails can be fetched by URI
            // instead of travelling through postMessage as base64.
            localResourceRoots: [
                context.extensionUri,
                vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
                ...assetRoots.map((root) => vscode.Uri.file(root)),
                vscode.Uri.file(getGameAssetCacheDir()),
                vscode.Uri.file(getModelThumbCacheDir()),
            ],
        },
    );
    panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri, ...assetRoots.map(root => vscode.Uri.file(root)),
            vscode.Uri.file(getGameAssetCacheDir()), vscode.Uri.file(getModelThumbCacheDir())],
    };
    const assetBrowserUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'assetBrowserWebview.js')).toString();
    const thumbnailWorkerUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'mdxThumbnailWorker.js')).toString();
    const initial = {
        thumbnailWorkerUri,
        browserContext: {
            documentUri: documentUri.toString(),
            target: target && { uri: target.uri.toString(), kind: target.kind, currentValue: target.currentValue,
                range: [target.range.start.line, target.range.start.character, target.range.end.line, target.range.end.character] },
        },
        activeTab: target?.kind || 'model',
        currentValue,
        browseOnly,
        tabs: {
            icon: assetBrowserItems(dedupeAssetOptions([...imported.icon, ...catalog.icons])),
            model: assetBrowserItems(dedupeAssetOptions([...imported.model, ...catalog.models])),
            sound: assetBrowserItems(dedupeAssetOptions([...imported.sound, ...catalog.sounds])),
        },
    };
    const initialJson = scriptSafeJson(initial);
    panel.webview.html = buildAssetBrowserHtml(initialJson, currentValue, panel.webview.cspSource, assetBrowserUri, browseOnly);
    panel.webview.onDidReceiveMessage((message) => {
        const msg = message || {};
        if (msg.type === 'selectAsset' && typeof msg.value === 'string') {
            if (target) void replaceAssetString(target, msg.value).then(used => { if (used) panel.dispose(); });
            else void vscode.commands.executeCommand('wurst.openAssetFromString', msg.value, documentUri);
        } else if (msg.type === 'openAsset' && typeof msg.value === 'string') {
            void vscode.commands.executeCommand('wurst.openAssetFromString', msg.value, documentUri);
        } else if (msg.type === 'copyAssetPath' && typeof msg.value === 'string') {
            const value = target ? escapeWurstStringAssetPath(msg.value) : msg.value.replace(/\//g, '\\');
            void vscode.env.clipboard.writeText(value);
        } else {
            void handleModelThumbMessage(msg, panel.webview, documentUri, true);
        }
    });
}

export async function restoreAssetBrowser(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = (state && typeof state === 'object' ? state : {}) as { browserContext?: { documentUri?: string; target?: { uri?: string; kind?: BrowseAssetKind; currentValue?: string; range?: number[] } } };
    const source = saved.browserContext;
    const parseUri = (value: unknown) => {
        if (typeof value !== 'string') return undefined;
        const uri = vscode.Uri.parse(value);
        return uri.scheme === 'file' || uri.scheme === 'vscode-remote' ? uri : undefined;
    };
    const uri = parseUri(source?.target?.uri);
    const range = source?.target?.range;
    const kind = source?.target?.kind;
    const currentValue = source?.target?.currentValue;
    const target = uri && range?.length === 4 && range.every(n => Number.isSafeInteger(n) && n >= 0) &&
        kind && ['icon', 'model', 'sound'].includes(kind) && typeof currentValue === 'string'
        ? { uri, range: new vscode.Range(range[0], range[1], range[2], range[3]), kind, currentValue } : undefined;
    await openCodeAssetBrowser(context, target, parseUri(source?.documentUri), panel);
}

function dedupeAssetOptions(options: readonly ValueOption[]): ValueOption[] {
    const seen = new Set<string>();
    const out: ValueOption[] = [];
    for (const option of options) {
        const key = option.value.replace(/\//g, '\\').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(option);
    }
    return out;
}

function buildAssetBrowserHtml(initialJson: string, currentValue: string, cspSource: string, assetBrowserUri: string, browseOnly = false): string {
    const nonce = makeNonce();
    return buildPage({
        // Models and cached thumbnails are fetched/displayed as webview resource URIs (see
        // requestModelThumbnail with useModelUri), so the extension's cspSource must be admitted for
        // connect-src and img-src, not only script-src.
        csp: `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${cspSource}; img-src data: ${cspSource}; connect-src ${cspSource}; worker-src blob:;`,
        title: browseOnly ? 'Warcraft III Asset Browser' : 'Choose Warcraft III Asset',
        extraCss: `
${ICON_INLINE_CSS}
${ASSET_CARD_CSS}
:root { --obj-icon-size: 42px; }
.browser { height: calc(100% - 24px); max-width: 1100px; margin: 12px auto; display: grid; grid-template-rows: auto auto 1fr; min-height: 0; border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 24px var(--shadow); overflow: hidden; }
.toolbar { gap: 6px; padding: 8px 10px; }
.tab { min-width: 78px; justify-content: center; }
.search { flex: 1; min-width: 120px; }
.meta { padding: 6px 10px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.grid { overflow: auto; padding: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 6px; align-content: start; }
.card { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 6px; border: 1px solid transparent; background: transparent; color: var(--fg); border-radius: 5px; text-align: center; font-family: var(--font); }
.card:hover, .card:focus-visible { background: var(--hover); border-color: var(--focus); outline: none; }
.card-name { display: block; width: 100%; font-size: 11px; line-height: 1.3; height: 2.6em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.asset-preview { display: grid; place-items: center; width: 72px; height: 72px; padding: 0; border: 0; border-radius: 4px; background: transparent; cursor: pointer; }
.asset-preview:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
.asset-preview .object-icon { width: 72px; height: 72px; }
.model-thumb { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 3px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; color: var(--muted); font-size: 13px; font-weight: 700; }
.model-thumb::before { content: '3D'; }
.model-thumb.pending::before { content: ''; width: 16px; height: 16px; border: 2px solid color-mix(in srgb, var(--fg) 18%, transparent); border-top-color: var(--fg); border-radius: 50%; animation: wv-spin .8s linear infinite; }
.model-thumb.missing::before { content: '?'; }
.model-thumb.loaded::before { content: none; }
.model-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sound-thumb { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--muted); font-family: var(--mono); font-size: 11px; font-weight: 700; }
.empty { color: var(--muted); padding: 24px; text-align: center; }
`,
        body: `<div class="browser">
  <div class="wv-toolbar toolbar">
    <button id="tab-icon" class="wv-btn tab" type="button" data-tab="icon">Icons</button>
    <button id="tab-model" class="wv-btn tab" type="button" data-tab="model">Models</button>
    <button id="tab-sound" class="wv-btn tab" type="button" data-tab="sound">Sounds</button>
    <input id="search" class="wv-input search" type="search" placeholder="Search assets..." aria-label="Search assets">
  </div>
  <div class="meta">${browseOnly ? 'Click an asset to open its preview.' : 'Replacing ' + escapeHtml(currentValue)}</div>
  <div id="grid" class="grid"></div>
</div>
<script nonce="${nonce}">window.__WURST_ASSET_BROWSER_INITIAL__ = ${initialJson};</script>
<script nonce="${nonce}" src="${escapeHtml(assetBrowserUri)}"></script>`,
    });
}

class WurstAssetCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const target = findAssetStringAt(document, range);
        if (!target) return [];
        const action = new vscode.CodeAction('Browse Warcraft III assets...', vscode.CodeActionKind.RefactorRewrite);
        action.command = {
            command: 'wurst.browseAssetForString',
            title: 'Browse Warcraft III assets...',
            arguments: [target],
        };
        return [action];
    }
}

class WurstAssetCodeLensProvider implements vscode.CodeLensProvider {
    readonly changes = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changes.event;
    private readonly targets = new WeakMap<vscode.CodeLens, { document: vscode.TextDocument; version: number; play: boolean }>();

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested || document.isClosed || vscode.workspace.getConfiguration('wurst', document.uri).get<boolean>('leanEditor', false)) return [];
        const version = document.version;
        const lenses: vscode.CodeLens[] = [];
        let count = 0;
        for (const target of findAssetStrings(document)) {
            if (token.isCancellationRequested || document.isClosed || document.version !== version) return [];
            const browse = new vscode.CodeLens(target.range);
            this.targets.set(browse, { document, version, play: false });
            if (target.kind === 'sound') {
                const play = new vscode.CodeLens(target.range);
                this.targets.set(play, { document, version, play: true });
                lenses.push(play);
            }
            lenses.push(browse);
            if (++count % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (token.isCancellationRequested || document.isClosed || document.version !== version) return [];
        return lenses;
    }

    resolveCodeLens(lens: vscode.CodeLens, token: vscode.CancellationToken): vscode.CodeLens {
        const source = this.targets.get(lens);
        // Returning an unresolved lens here makes VS Code log an invalid-provider error.
        // Obsolete work is cancellation, including edits or a lean-mode switch mid-request.
        if (!source || token.isCancellationRequested || source.document.isClosed || source.document.version !== source.version) throw new vscode.CancellationError();
        if (vscode.workspace.getConfiguration('wurst', source.document.uri).get<boolean>('leanEditor', false)) throw new vscode.CancellationError();
        const currentValue = source.document.getText(lens.range);
        const ext = path.extname(currentValue).slice(1);
        let kind: BrowseAssetKind = 'icon';
        if (isModelExt(ext)) kind = 'model';
        else if (isSoundExt(ext)) kind = 'sound';
        const title = kind === 'icon' ? 'Browse asset...' : `Browse ${kind}...`;
        lens.command = source.play
            ? { command: 'wurst.openAssetFromString', title: '▶ Play sound', arguments: [currentValue] }
            : { command: 'wurst.browseAssetForString', title, arguments: [{ uri: source.document.uri, range: lens.range, kind, currentValue } satisfies BrowseAssetTarget] };
        return lens;
    }
}

// ── Wurst / JASS: string literals containing asset paths ─────────────────────

class WurstAssetLinkProvider implements vscode.DocumentLinkProvider {
    private readonly targets = new WeakMap<vscode.DocumentLink, { document: vscode.TextDocument; version: number; assetPath: string }>();

    constructor(private readonly pattern: RegExp = STRING_LITERAL_RE) {}

    async provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.DocumentLink[]> {
        if (token.isCancellationRequested || document.isClosed) return [];
        const text = document.getText();
        const version = document.version;
        const links: vscode.DocumentLink[] = [];
        const regex = new RegExp(this.pattern);
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
            if (token.isCancellationRequested || document.isClosed || document.version !== version) return [];
            const assetPath = m[1];
            if (!isAssetExt(path.extname(assetPath).slice(1))) continue;
            const offset = m.index + m[0].indexOf(assetPath);
            const link = new vscode.DocumentLink(new vscode.Range(document.positionAt(offset), document.positionAt(offset + assetPath.length)));
            link.tooltip = `Open ${assetPath}`;
            this.targets.set(link, { document, version, assetPath });
            links.push(link);
            if (links.length % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (token.isCancellationRequested || document.isClosed || document.version !== version) return [];
        return links;
    }

    async resolveDocumentLink(link: vscode.DocumentLink, token: vscode.CancellationToken): Promise<vscode.DocumentLink | undefined> {
        const source = this.targets.get(link);
        if (!source) return undefined;
        const stale = () => token.isCancellationRequested || source.document.isClosed || source.document.version !== source.version;
        if (stale()) return undefined;
        const ext = path.extname(source.assetPath).slice(1);
        // Sound links always use the inline player, including locally imported sounds.
        if (isSoundExt(ext)) {
            link.target = vscode.Uri.parse(`command:wurst.openAssetFromString?${encodeURIComponent(JSON.stringify([source.assetPath]))}`);
            return link;
        }
        const roots = await candidateRoots(source.document);
        if (stale()) return undefined;
        const target = await resolveAssetPath(source.assetPath, roots);
        if (stale()) return undefined;
        if (target) {
            link.target = target;
            link.tooltip = target.fsPath;
        } else if (isModelExt(ext)) {
            link.target = vscode.Uri.parse(`command:wurst.openAssetFromString?${encodeURIComponent(JSON.stringify([source.assetPath]))}`);
        } else {
            return undefined;
        }
        return link;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerAssetLinks(context: vscode.ExtensionContext): vscode.Disposable {
    const serializer = vscode.window.registerWebviewPanelSerializer('wurst.assetBrowser', {
        deserializeWebviewPanel: (panel, state) => restoreAssetBrowser(context, panel, state),
    });
    const openAsset = vscode.commands.registerCommand('wurst.openAssetFromString', async (assetPath: string, resource?: vscode.Uri) => {
        if (!assetPath) return;
        const ext = path.extname(assetPath).slice(1).toLowerCase();
        let kind: 'model' | 'sound' | 'any';
        if (isModelExt(ext)) kind = 'model';
        else if (isSoundExt(ext)) kind = 'sound';
        else kind = 'any';
        const resolved = await resolveAssetPathWithCasc(
            assetPath,
            await candidateRootsForFsPath(resource?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath),
            kind,
        );
        const target = resolved ? vscode.Uri.file(resolved) : undefined;
        if (!target) {
            void showWarningWithLogs(`Could not resolve asset: ${assetPath}`, new Error(`Asset resolution failed for ${assetPath}`));
            return;
        }
        const resolvedExt = path.extname(target.fsPath).toLowerCase();
        if (resolvedExt === '.mdx' || resolvedExt === '.mdl') {
            await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.blpPreview');
            return;
        }
        if (isSoundAssetPath(target.fsPath)) {
            await playSoundInline(target);
            return;
        }
        await vscode.commands.executeCommand('vscode.open', target);
    });

    const browseAsset = vscode.commands.registerCommand('wurst.browseAssetForString', async (target: BrowseAssetTarget) => {
        if (!target?.uri || !target.range) return;
        await openCodeAssetBrowser(context, target);
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
        new WurstAssetLinkProvider(),
    );

    const toc = vscode.languages.registerDocumentLinkProvider(
        [{ language: 'wc3-toc' }, { pattern: '**/*.toc' }],
        new WurstAssetLinkProvider(TOC_LINE_RE),
    );

    const codeActions = vscode.languages.registerCodeActionsProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        new WurstAssetCodeActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
    );

    const lensProvider = new WurstAssetCodeLensProvider();
    const lensSettings = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('wurst.leanEditor')) lensProvider.changes.fire();
    });
    const codeLens = vscode.languages.registerCodeLensProvider(
        [
            { language: 'wurst' },
            { language: 'jass' },
            { pattern: '**/*.j' },
        ],
        lensProvider,
    );

    return vscode.Disposable.from(serializer, openAsset, browseAsset, wurst, fdf, toc, codeActions, codeLens, lensSettings, lensProvider.changes);
}
