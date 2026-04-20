'use strict';

/** VS Code preview for WC3 Object Modification files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseObjMod, ObjModFile, ObjModEntry, ObjModMod } from 'casc-ts/formats';
import { registerParsedPreviewer } from './preview/framework';
export { ObjModFile, ObjModEntry, ObjModMod, ObjModVarType } from 'casc-ts/formats';

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

// ── Registration ──────────────────────────────────────────────────────────────

export function registerObjModPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return registerParsedPreviewer<ObjModFile>({
        viewType: 'wurst.objModPreview',
        parse:  (data, fileName) => parseObjMod(data, fileName.slice(fileName.lastIndexOf('.'))),
        render: (parsed, fileName) => buildHtml(parsed, fileName),
    });
}
