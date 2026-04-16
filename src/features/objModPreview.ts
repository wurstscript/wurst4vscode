'use strict';

/**
 * Binary WC3 Object Modification file parser and preview.
 *
 * Handles: .w3u (units), .w3t (items), .w3a (abilities),
 *          .w3b (buffs), .w3d (destructables), .w3h (effects),
 *          .w3q (upgrades)
 *
 * Format (derived from wc3libs ObjMod.java / Warcraft III community docs):
 *
 *   u32 LE version  (1, 2, or 3)
 *   u32 LE origObjsCount
 *   [origObjsCount entries]
 *   u32 LE customObjsCount
 *   [customObjsCount entries]
 *
 * Entry:
 *   char[4] baseId
 *   char[4] newId   (all-zero → original object, not a custom one)
 *   [v3 only: u32 LE unknownCount, u32[unknownCount] unknown]
 *   u32 LE modsCount
 *   [modsCount mods]
 *
 * Mod (non-extended — .w3u .w3t .w3b .w3h):
 *   char[4] fieldId
 *   u32 LE varType  (0=int  1=real  2=unreal  3=string)
 *   value           (u32 / f32 / nul-terminated string)
 *   char[4] endToken
 *
 * Mod (extended — .w3a .w3d .w3q — adds level + dataPt before the value):
 *   char[4] fieldId
 *   u32 LE varType
 *   u32 LE level
 *   u32 LE dataPt
 *   value
 *   char[4] endToken
 */

import * as path from 'path';
import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ObjModVarType = 'int' | 'real' | 'unreal' | 'string';

export interface ObjModMod {
    fieldId: string;
    varType: ObjModVarType;
    level?: number;   // extended only
    dataPt?: number;  // extended only
    value: number | string;
    endToken: string;
}

export interface ObjModEntry {
    baseId: string;
    newId: string | null;  // null = original modification (not a custom object)
    mods: ObjModMod[];
}

export interface ObjModFile {
    version: number;
    ext: string;
    extended: boolean;  // true for .w3a, .w3d, .w3q
    origObjs: ObjModEntry[];
    customObjs: ObjModEntry[];
    error?: string;
}

// ── Extended-type detection ───────────────────────────────────────────────────

const EXTENDED_EXTS = new Set(['.w3a', '.w3d', '.w3q']);

function isExtended(ext: string): boolean {
    return EXTENDED_EXTS.has(ext.toLowerCase());
}

// ── Low-level reader ──────────────────────────────────────────────────────────

class BinReader {
    private pos = 0;
    constructor(private readonly buf: Buffer) {}

    get offset(): number { return this.pos; }
    get remaining(): number { return this.buf.length - this.pos; }

    readU32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need u32`);
        const v = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readF32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need f32`);
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    /** Read a 4-byte ID as printable ASCII (e.g. "hfoo"). */
    readId(): string {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need id`);
        const b = this.buf.slice(this.pos, this.pos + 4);
        this.pos += 4;
        return String.fromCharCode(b[0], b[1], b[2], b[3]);
    }

    /** Read a null-terminated UTF-8 string. */
    readString(): string {
        const start = this.pos;
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
        const s = this.buf.slice(start, this.pos).toString('utf8');
        if (this.pos < this.buf.length) this.pos++; // consume the null byte
        return s;
    }
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseEntry(r: BinReader, version: number, extended: boolean): ObjModEntry {
    const baseId = r.readId();
    const rawNewId = r.readId();
    const newId = rawNewId === '\0\0\0\0' ? null : rawNewId;

    if (version === 3) {
        const unknownCount = r.readU32();
        for (let i = 0; i < unknownCount; i++) r.readU32();
    }

    const modsCount = r.readU32();
    const mods: ObjModMod[] = [];

    for (let i = 0; i < modsCount; i++) {
        const fieldId = r.readId();
        const varTypeI = r.readU32();

        const varTypeMap: ObjModVarType[] = ['int', 'real', 'unreal', 'string'];
        const varType: ObjModVarType = varTypeMap[varTypeI] ?? 'string';

        let level: number | undefined;
        let dataPt: number | undefined;

        if (extended) {
            level = r.readU32();
            dataPt = r.readU32();
        }

        let value: number | string;
        switch (varType) {
            case 'int':    value = r.readU32(); break;
            case 'real':
            case 'unreal': value = r.readF32(); break;
            default:       value = r.readString(); break;
        }

        const endToken = r.readId();

        mods.push({ fieldId, varType, level, dataPt, value, endToken });
    }

    return { baseId, newId, mods };
}

export function parseObjMod(data: Buffer, fileExt: string): ObjModFile {
    const ext = fileExt.toLowerCase();
    const extended = isExtended(ext);
    const r = new BinReader(data);

    try {
        const version = r.readU32();
        if (version < 1 || version > 3) {
            return { version, ext, extended, origObjs: [], customObjs: [], error: `Unknown version: ${version}` };
        }

        const origCount = r.readU32();
        const origObjs: ObjModEntry[] = [];
        for (let i = 0; i < origCount; i++) {
            origObjs.push(parseEntry(r, version, extended));
        }

        const customCount = r.readU32();
        const customObjs: ObjModEntry[] = [];
        for (let i = 0; i < customCount; i++) {
            customObjs.push(parseEntry(r, version, extended));
        }

        return { version, ext, extended, origObjs, customObjs };
    } catch (e) {
        return {
            version: 0, ext, extended,
            origObjs: [], customObjs: [],
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
    w3u: 'Unit',
    w3t: 'Item',
    w3a: 'Ability',
    w3b: 'Buff',
    w3d: 'Destructable',
    w3h: 'Effect',
    w3q: 'Upgrade',
};

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatValue(mod: ObjModMod): string {
    if (typeof mod.value === 'number') {
        if (mod.varType === 'real' || mod.varType === 'unreal') {
            return mod.value.toPrecision(6).replace(/\.?0+$/, '');
        }
        return String(mod.value);
    }
    return escHtml(mod.value);
}

function renderModRows(mods: ObjModMod[], extended: boolean): string {
    if (mods.length === 0) return `<tr><td colspan="${extended ? 5 : 3}" class="empty">no modifications</td></tr>`;
    return mods.map(m => {
        const levelCols = extended
            ? `<td class="num">${m.level ?? ''}</td><td class="num">${m.dataPt ?? ''}</td>`
            : '';
        return `<tr>
  <td class="id">${escHtml(m.fieldId)}</td>
  <td class="type ${m.varType}">${m.varType}</td>
  ${levelCols}
  <td class="value">${formatValue(m)}</td>
</tr>`;
    }).join('\n');
}

function renderSection(title: string, entries: ObjModEntry[], extended: boolean): string {
    if (entries.length === 0) {
        return `<section><h2>${escHtml(title)} <span class="count">(0)</span></h2><p class="empty">none</p></section>`;
    }

    const extraHeaders = extended ? '<th>Level</th><th>DataPt</th>' : '';
    const parts = entries.map(e => {
        const idLine = e.newId
            ? `<span class="base-id">${escHtml(e.baseId)}</span><span class="arrow">→</span><span class="new-id">${escHtml(e.newId)}</span>`
            : `<span class="base-id">${escHtml(e.baseId)}</span>`;
        return `<details open>
  <summary>${idLine}<span class="mod-count">${e.mods.length} mod${e.mods.length !== 1 ? 's' : ''}</span></summary>
  <table>
    <thead><tr><th>Field</th><th>Type</th>${extraHeaders}<th>Value</th></tr></thead>
    <tbody>${renderModRows(e.mods, extended)}</tbody>
  </table>
</details>`;
    }).join('\n');

    return `<section>
<h2>${escHtml(title)} <span class="count">(${entries.length})</span></h2>
${parts}
</section>`;
}

function buildHtml(parsed: ObjModFile, fileName: string): string {
    const typeLabel = TYPE_LABELS[parsed.ext.slice(1)] ?? parsed.ext.slice(1).toUpperCase();
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escHtml(parsed.error)}</div>`
        : '';

    const origSection = renderSection('Original Object Modifications', parsed.origObjs, parsed.extended);
    const customSection = renderSection('Custom Objects', parsed.customObjs, parsed.extended);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escHtml(fileName)}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-panel-border, #444);
    --th-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    --row-alt: var(--vscode-list-hoverBackground, #2a2d2e);
    --accent: var(--vscode-textLink-foreground, #4ec9b0);
    --error: var(--vscode-errorForeground, #f44747);
    --summary-bg: var(--vscode-sideBarSectionHeader-background, #383838);
    font-size: 13px;
    font-family: var(--vscode-font-family, sans-serif);
  }
  body { background: var(--bg); color: var(--fg); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; margin: 0 0 4px; color: var(--accent); }
  .subtitle { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; margin-bottom: 16px; }
  h2 { font-size: 0.95em; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .count { font-weight: normal; opacity: .6; }
  .error { color: var(--error); border: 1px solid var(--error); padding: 6px 10px; border-radius: 3px; margin-bottom: 12px; }
  .empty { opacity: .5; font-style: italic; padding: 4px 0; }
  details { margin-bottom: 6px; }
  details[open] > table { margin-top: 0; }
  summary {
    cursor: pointer;
    padding: 5px 8px;
    background: var(--summary-bg);
    border-radius: 3px;
    display: flex;
    align-items: center;
    gap: 8px;
    list-style: none;
    user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▶'; font-size: .7em; transition: transform .15s; opacity: .6; }
  details[open] > summary::before { transform: rotate(90deg); }
  .base-id { font-family: monospace; font-weight: bold; color: var(--accent); }
  .new-id  { font-family: monospace; font-weight: bold; }
  .arrow   { opacity: .5; }
  .mod-count { margin-left: auto; opacity: .5; font-size: .85em; }
  table { border-collapse: collapse; width: 100%; font-size: .9em; }
  th { background: var(--th-bg); text-align: left; padding: 4px 10px; font-weight: 600; border-bottom: 1px solid var(--border); }
  td { padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); }
  tr:nth-child(even) td { background: var(--row-alt); }
  td.id    { font-family: monospace; color: var(--accent); }
  td.num   { font-family: monospace; text-align: center; opacity: .7; }
  td.value { font-family: monospace; word-break: break-all; }
  td.type  { font-size: .8em; opacity: .7; }
  td.type.int    { color: #9cdcfe; }
  td.type.real   { color: #b5cea8; }
  td.type.unreal { color: #ce9178; }
  td.type.string { color: #d7ba7d; }
</style>
</head>
<body>
<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 ${escHtml(typeLabel)} Object Modifications &nbsp;·&nbsp; v${parsed.version}${parsed.extended ? ' &nbsp;·&nbsp; extended (level/dataPt)' : ''}</p>
${errorBanner}
${origSection}
${customSection}
</body>
</html>`;
}

// ── VSCode custom editor ──────────────────────────────────────────────────────

class ObjModDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        readonly parsed: ObjModFile,
    ) {}

    dispose(): void {}
}

class ObjModEditorProvider implements vscode.CustomReadonlyEditorProvider<ObjModDocument> {
    static readonly VIEW_TYPE = 'wurst.objModPreview';

    async openCustomDocument(uri: vscode.Uri): Promise<ObjModDocument> {
        const data = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const ext = path.extname(uri.fsPath);
        const parsed = parseObjMod(data, ext);
        return new ObjModDocument(uri, parsed);
    }

    resolveCustomEditor(
        document: ObjModDocument,
        webviewPanel: vscode.WebviewPanel,
    ): void {
        webviewPanel.webview.options = { enableScripts: false };
        const fileName = path.basename(document.uri.fsPath);
        webviewPanel.webview.html = buildHtml(document.parsed, fileName);
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerObjModPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        ObjModEditorProvider.VIEW_TYPE,
        new ObjModEditorProvider(),
        { supportsMultipleEditorsPerDocument: true },
    );
}
