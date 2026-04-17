'use strict';

/**
 * WC3 trigger file parsers and previews.
 *
 * war3map.wct  – Custom text triggers (WCT.java in wc3libs)
 *   Stores the JASS/Lua source for every trigger marked "custom text".
 *   Three binary versions:
 *     v0          : i32 0, i32 count, count × (i32 size + bytes)
 *     v1          : i32 1, string headComment, headTrig(i32+bytes),
 *                   i32 count, count × (i32 size + bytes)
 *     v0x80000004 : i32 0x80000004, i32 useHeader,
 *                   [useHeader≠0: string headComment, (i32+bytes)],
 *                   triggers until EOF
 *
 * war3map.wtg  – GUI trigger editor (WTG.java in wc3libs)
 *   Magic "WTG!", i32 version (4=RoC, 7=TFT).
 *   Contains: categories, variables, and triggers.
 *   Trigger ECAs require TriggerData.txt (not shipped in the extension) to
 *   parse, so only trigger metadata is extracted here.
 *   Triggers with customTxt=true have 0 ECAs, so maps produced by Wurst
 *   (all-custom-text) will have their full trigger list shown.
 *
 *   WTG v4 trigger header:
 *     string name, string description, i32 enabled, i32 customTxt,
 *     i32 initiallyOn (0=on), i32 unknown, i32 catIndex, i32 ECAsCount
 *
 *   WTG v7 trigger header:
 *     string name, string description, i32 type, i32 enabled, i32 customTxt,
 *     i32 initiallyOn (0=on), i32 runOnMapInit, i32 catIndex, i32 ECAsCount
 */

import * as path from 'path';
import * as vscode from 'vscode';

// ── Low-level reader ──────────────────────────────────────────────────────────

class BinReader {
    private pos = 0;
    constructor(private readonly buf: Buffer) {}

    get offset(): number { return this.pos; }
    get remaining(): number { return this.buf.length - this.pos; }
    get eof(): boolean { return this.pos >= this.buf.length; }

    readI32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need i32`);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readBytes(count: number): Buffer {
        if (this.remaining < count) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need ${count} bytes`);
        const slice = this.buf.slice(this.pos, this.pos + count);
        this.pos += count;
        return slice;
    }

    /** Read a null-terminated UTF-8 string. */
    readString(): string {
        const start = this.pos;
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
        const s = this.buf.slice(start, this.pos).toString('utf8');
        if (this.pos < this.buf.length) this.pos++; // consume null
        return s;
    }

    readId(): string {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need id`);
        const b = this.buf.slice(this.pos, this.pos + 4);
        this.pos += 4;
        return String.fromCharCode(b[0], b[1], b[2], b[3]);
    }
}

// ── WCT types & parser ────────────────────────────────────────────────────────

export interface WctTrig {
    index: number;   // 0-based; -1 for head trigger
    text: string;
}

export interface WctFile {
    version: number;
    headComment?: string;
    headTrig?: WctTrig;
    trigs: WctTrig[];
    error?: string;
}

function readWctTrig(r: BinReader, index: number): WctTrig {
    const size = r.readI32();
    const text = size > 0 ? r.readBytes(size).toString('utf8') : '';
    return { index, text };
}

export function parseWct(data: Buffer): WctFile {
    const r = new BinReader(data);
    try {
        const version = r.readI32();

        if (version === 0) {
            const count = r.readI32();
            const trigs: WctTrig[] = [];
            for (let i = 0; i < count; i++) trigs.push(readWctTrig(r, i));
            return { version, trigs };
        }

        if (version === 1) {
            const headComment = r.readString();
            const headTrig    = readWctTrig(r, -1);
            const count       = r.readI32();
            const trigs: WctTrig[] = [];
            for (let i = 0; i < count; i++) trigs.push(readWctTrig(r, i));
            return { version, headComment, headTrig, trigs };
        }

        if (version === -2147483644) { // 0x80000004 as signed i32
            const useHeader = r.readI32();
            let headComment: string | undefined;
            let headTrig: WctTrig | undefined;
            if (useHeader !== 0) {
                headComment = r.readString();
                headTrig    = readWctTrig(r, -1);
            }
            const trigs: WctTrig[] = [];
            let i = 0;
            while (!r.eof) trigs.push(readWctTrig(r, i++));
            return { version, headComment, headTrig, trigs };
        }

        return { version, trigs: [], error: `Unknown WCT version: 0x${(version >>> 0).toString(16)}` };
    } catch (e) {
        return { version: 0, trigs: [], error: e instanceof Error ? e.message : String(e) };
    }
}

// ── WTG types & parser ────────────────────────────────────────────────────────

export interface WtgCategory {
    index: number;
    name: string;
    isComment: boolean;
}

export interface WtgVar {
    name: string;
    type: string;
    isArray: boolean;
    arraySize?: number;
    hasInitVal: boolean;
    initVal: string;
}

export interface WtgTrig {
    name: string;
    description: string;
    type: number;       // 0=normal, 1=comment
    enabled: boolean;
    customTxt: boolean;
    initiallyOn: boolean;
    runOnMapInit?: boolean;
    catIndex: number;
    ecaCount: number;
}

export interface WtgFile {
    version: number;
    categories: WtgCategory[];
    vars: WtgVar[];
    trigCount: number;
    trigs: WtgTrig[];          // only triggers we could read before hitting ECAs
    trigsPartial: boolean;     // true if we stopped early (ECAs present)
    error?: string;
}

export function parseWtg(data: Buffer): WtgFile {
    const r = new BinReader(data);
    const result: WtgFile = {
        version: 0,
        categories: [],
        vars: [],
        trigCount: 0,
        trigs: [],
        trigsPartial: false,
    };

    try {
        const magic = r.readId();
        if (magic !== 'WTG!') {
            result.error = `Unexpected magic "${magic}", expected "WTG!"`;
            return result;
        }

        const version = r.readI32();
        result.version = version;

        // 0x80000004 (= -2147483644 signed) is the Reforged WTG version;
        // structurally compatible with v7 for the parts we parse.
        const effectiveVersion = (version === -2147483644) ? 7 : version;
        result.version = version; // keep raw for display

        if (effectiveVersion !== 4 && effectiveVersion !== 7) {
            result.error = `Unsupported WTG version: ${version}`;
            return result;
        }

        // ── Categories ──────────────────────────────────────────────────────
        const catCount = r.readI32();
        for (let i = 0; i < catCount; i++) {
            const index     = r.readI32();
            const name      = r.readString();
            const isComment = effectiveVersion >= 7 ? r.readI32() !== 0 : false;
            result.categories.push({ index, name, isComment });
        }

        r.readI32(); // unknownNumB

        // ── Variables ────────────────────────────────────────────────────────
        const varCount = r.readI32();
        for (let i = 0; i < varCount; i++) {
            const name      = r.readString();
            const type      = r.readString();
            r.readI32();     // unknownNumE
            const isArray   = r.readI32() !== 0;
            const arraySize = effectiveVersion >= 7 ? r.readI32() : undefined;
            const hasInitVal = r.readI32() !== 0;
            const initVal   = r.readString();
            result.vars.push({ name, type, isArray, arraySize, hasInitVal, initVal });
        }

        // ── Triggers (best-effort — stops on first trigger with ECAs) ────────
        const trigCount = r.readI32();
        result.trigCount = trigCount;

        for (let i = 0; i < trigCount; i++) {
            const name        = r.readString();
            const description = r.readString();
            const type        = effectiveVersion >= 7 ? r.readI32() : 0;
            const enabled     = r.readI32() !== 0;
            const customTxt   = r.readI32() !== 0;
            const initiallyOn = r.readI32() === 0; // stored inverted
            const runOnMapInit = effectiveVersion >= 7 ? r.readI32() !== 0 : undefined;
            if (effectiveVersion < 7) r.readI32(); // v4 only: unknown (placeholder for type field)
            const catIndex  = r.readI32();
            const ecaCount  = r.readI32();

            result.trigs.push({ name, description, type, enabled, customTxt, initiallyOn, runOnMapInit, catIndex, ecaCount });

            if (ecaCount > 0) {
                // Cannot safely skip ECAs without TriggerData.txt
                result.trigsPartial = true;
                break;
            }
        }

    } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
    }

    return result;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const COMMON_CSS = `
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-panel-border, #444);
    --th-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    --row-alt: var(--vscode-list-hoverBackground, #2a2d2e);
    --accent: var(--vscode-textLink-foreground, #4ec9b0);
    --error: var(--vscode-errorForeground, #f44747);
    --warn: var(--vscode-editorWarning-foreground, #cca700);
    --code-bg: var(--vscode-textCodeBlock-background, #1a1a1a);
    font-size: 13px;
    font-family: var(--vscode-font-family, sans-serif);
  }
  body { background: var(--bg); color: var(--fg); margin: 0; padding: 12px 16px; }
  h1 { font-size: 1.1em; margin: 0 0 4px; color: var(--accent); }
  .subtitle { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; margin-bottom: 16px; }
  h2 { font-size: 0.95em; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .count { font-weight: normal; opacity: .6; }
  .error { color: var(--error); border: 1px solid var(--error); padding: 6px 10px; border-radius: 3px; margin-bottom: 12px; }
  .warn  { color: var(--warn);  border: 1px solid var(--warn);  padding: 6px 10px; border-radius: 3px; margin-bottom: 12px; }
  .empty { opacity: .5; font-style: italic; }
  table { border-collapse: collapse; font-size: .88em; width: 100%; }
  th { background: var(--th-bg); text-align: left; padding: 4px 10px; font-weight: 600; border-bottom: 1px solid var(--border); }
  td { padding: 3px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); }
  tr:nth-child(even) td { background: var(--row-alt); }
  td.mono { font-family: monospace; color: var(--accent); }
  td.dim  { opacity: .6; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: .78em; font-weight: 600; }
  .pill.on  { background: color-mix(in srgb, #4ec9b0 20%, transparent); color: #4ec9b0; }
  .pill.off { background: color-mix(in srgb, #888 20%, transparent);    color: #888; }
  .pill.custom { background: color-mix(in srgb, #ce9178 20%, transparent); color: #ce9178; }
`;

// ── WCT HTML rendering ────────────────────────────────────────────────────────

function buildWctHtml(parsed: WctFile, fileName: string): string {
    const versionLabel = parsed.version === -2147483644 ? '0x80000004 (Reforged)' :
                         parsed.version === 1            ? '1 (TFT)'              :
                         parsed.version === 0            ? '0 (RoC)'              :
                         String(parsed.version);

    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escHtml(parsed.error)}</div>`
        : '';

    const sections: string[] = [];

    const renderTrig = (t: WctTrig, label: string): string => {
        const code = t.text.trim();
        if (!code) {
            return `<section>
<h2>${escHtml(label)} <span class="count">(empty)</span></h2>
<p class="empty">no code</p>
</section>`;
        }
        const lineCount = (code.match(/\n/g)?.length ?? 0) + 1;
        return `<section>
<h2>${escHtml(label)} <span class="count">(${lineCount} line${lineCount !== 1 ? 's' : ''})</span></h2>
<pre>${escHtml(code)}</pre>
</section>`;
    };

    if (parsed.headTrig) {
        const headerLabel = parsed.headComment
            ? `Header — ${parsed.headComment}`
            : 'Header (global init script)';
        sections.push(renderTrig(parsed.headTrig, headerLabel));
    }

    if (parsed.trigs.length === 0 && !parsed.headTrig) {
        sections.push('<p class="empty">No custom-text triggers</p>');
    } else {
        parsed.trigs.forEach((t, i) => {
            sections.push(renderTrig(t, `Trigger ${i}`));
        });
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escHtml(fileName)}</title>
<style>
${COMMON_CSS}
  pre {
    background: var(--code-bg);
    padding: 10px 12px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    white-space: pre;
    overflow-x: auto;
    margin: 0;
  }
  section { margin-bottom: 20px; }
</style>
</head>
<body>
<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 Custom Text Triggers &nbsp;·&nbsp; v${versionLabel} &nbsp;·&nbsp; ${parsed.trigs.length} trigger${parsed.trigs.length !== 1 ? 's' : ''}</p>
${errorBanner}
${sections.join('\n')}
</body>
</html>`;
}

// ── WTG HTML rendering ────────────────────────────────────────────────────────

function buildWtgHtml(parsed: WtgFile, fileName: string): string {
    const versionLabel = parsed.version === 4           ? '4 (RoC)'      :
                         parsed.version === 7           ? '7 (TFT)'      :
                         parsed.version === -2147483644 ? '0x80000004 (Reforged)' :
                         String(parsed.version);

    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escHtml(parsed.error)}</div>`
        : '';

    const warnBanner = parsed.trigsPartial
        ? `<div class="warn">Trigger list is partial — ECA bodies require TriggerData.txt to parse.` +
          ` Shown ${parsed.trigs.length} of ${parsed.trigCount} triggers.</div>`
        : '';

    // Categories
    let catsSection: string;
    if (parsed.categories.length === 0) {
        catsSection = `<section><h2>Categories <span class="count">(0)</span></h2><p class="empty">none</p></section>`;
    } else {
        const rows = parsed.categories.map(c => `<tr>
  <td class="mono">${c.index}</td>
  <td>${escHtml(c.name)}</td>
  <td class="dim">${c.isComment ? 'comment' : 'normal'}</td>
</tr>`).join('\n');
        catsSection = `<section>
<h2>Categories <span class="count">(${parsed.categories.length})</span></h2>
<table><thead><tr><th>#</th><th>Name</th><th>Type</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
    }

    // Variables
    let varsSection: string;
    if (parsed.vars.length === 0) {
        varsSection = `<section><h2>Variables <span class="count">(0)</span></h2><p class="empty">none</p></section>`;
    } else {
        const rows = parsed.vars.map(v => {
            const typeStr = v.isArray
                ? `${escHtml(v.type)}[${v.arraySize !== undefined ? v.arraySize : ''}]`
                : escHtml(v.type);
            const initStr = v.hasInitVal && v.initVal ? escHtml(v.initVal) : '<span class="dim">—</span>';
            return `<tr>
  <td class="mono">${escHtml(v.name)}</td>
  <td class="dim">${typeStr}</td>
  <td>${initStr}</td>
</tr>`;
        }).join('\n');
        varsSection = `<section>
<h2>Variables <span class="count">(${parsed.vars.length})</span></h2>
<table><thead><tr><th>Name</th><th>Type</th><th>Initial Value</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
    }

    // Triggers
    let trigsSection: string;
    const catNameMap = new Map(parsed.categories.map(c => [c.index, c.name]));

    if (parsed.trigCount === 0) {
        trigsSection = `<section><h2>Triggers <span class="count">(0)</span></h2><p class="empty">none</p></section>`;
    } else if (parsed.trigs.length === 0) {
        trigsSection = `<section><h2>Triggers <span class="count">(${parsed.trigCount})</span></h2>
<p class="empty">Cannot display — ECA bodies require TriggerData.txt.</p></section>`;
    } else {
        const rows = parsed.trigs.map(t => {
            const catName = catNameMap.get(t.catIndex) ?? `cat ${t.catIndex}`;
            const badges: string[] = [];
            if (!t.enabled)   badges.push('<span class="pill off">disabled</span>');
            if (!t.initiallyOn) badges.push('<span class="pill off">initially off</span>');
            if (t.customTxt)  badges.push('<span class="pill custom">custom text</span>');
            if (t.type === 1) badges.push('<span class="pill off">comment</span>');

            return `<tr>
  <td>${escHtml(t.name)}${badges.length ? ' ' + badges.join(' ') : ''}</td>
  <td class="dim">${escHtml(catName)}</td>
  <td class="dim">${escHtml(t.description)}</td>
</tr>`;
        }).join('\n');

        const partial = parsed.trigsPartial
            ? ` — ${parsed.trigs.length} shown, ${parsed.trigCount - parsed.trigs.length} hidden`
            : '';

        trigsSection = `<section>
<h2>Triggers <span class="count">(${parsed.trigCount}${partial})</span></h2>
<table><thead><tr><th>Name</th><th>Category</th><th>Description</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>${escHtml(fileName)}</title>
<style>
${COMMON_CSS}
  section { margin-bottom: 20px; }
</style>
</head>
<body>
<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 GUI Trigger Editor &nbsp;·&nbsp; v${versionLabel}</p>
${errorBanner}
${warnBanner}
${catsSection}
${varsSection}
${trigsSection}
</body>
</html>`;
}

// ── VSCode custom editors ─────────────────────────────────────────────────────

class TriggerDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        readonly html: string,
    ) {}
    dispose(): void {}
}

class WctEditorProvider implements vscode.CustomReadonlyEditorProvider<TriggerDocument> {
    static readonly VIEW_TYPE = 'wurst.wctPreview';

    async openCustomDocument(uri: vscode.Uri): Promise<TriggerDocument> {
        const data   = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const parsed = parseWct(data);
        const html   = buildWctHtml(parsed, path.basename(uri.fsPath));
        return new TriggerDocument(uri, html);
    }

    resolveCustomEditor(doc: TriggerDocument, panel: vscode.WebviewPanel): void {
        panel.webview.options = { enableScripts: false };
        panel.webview.html = doc.html;
    }
}

class WtgEditorProvider implements vscode.CustomReadonlyEditorProvider<TriggerDocument> {
    static readonly VIEW_TYPE = 'wurst.wtgPreview';

    async openCustomDocument(uri: vscode.Uri): Promise<TriggerDocument> {
        const data   = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const parsed = parseWtg(data);
        const html   = buildWtgHtml(parsed, path.basename(uri.fsPath));
        return new TriggerDocument(uri, html);
    }

    resolveCustomEditor(doc: TriggerDocument, panel: vscode.WebviewPanel): void {
        panel.webview.options = { enableScripts: false };
        panel.webview.html = doc.html;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerTriggerPreview(_context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.window.registerCustomEditorProvider(
            WctEditorProvider.VIEW_TYPE,
            new WctEditorProvider(),
            { supportsMultipleEditorsPerDocument: true },
        ),
        vscode.window.registerCustomEditorProvider(
            WtgEditorProvider.VIEW_TYPE,
            new WtgEditorProvider(),
            { supportsMultipleEditorsPerDocument: true },
        ),
    ];
}
