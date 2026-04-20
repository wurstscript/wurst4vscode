'use strict';

/** VS Code preview for WC3 .wct / .wtg trigger files. Parsers live in `casc-ts/formats`. */

import * as vscode from 'vscode';
import {
    parseWct, parseWtg,
    WctFile, WctTrig, WtgFile,
} from 'casc-ts/formats';
import { registerParsedPreviewer } from './preview/framework';
export { WctFile, WctTrig, WtgFile, WtgCategory, WtgVar, WtgTrig } from 'casc-ts/formats';

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

// ── Registration ──────────────────────────────────────────────────────────────

export function registerTriggerPreview(_context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        registerParsedPreviewer<WctFile>({
            viewType: 'wurst.wctPreview',
            parse:  (data) => parseWct(data),
            render: (parsed, fileName) => buildWctHtml(parsed, fileName),
        }),
        registerParsedPreviewer<WtgFile>({
            viewType: 'wurst.wtgPreview',
            parse:  (data) => parseWtg(data),
            render: (parsed, fileName) => buildWtgHtml(parsed, fileName),
        }),
    ];
}
