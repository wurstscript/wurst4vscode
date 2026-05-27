'use strict';

/** VS Code preview for WC3 Object Modification files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseObjMod, ObjModFile, ObjModEntry, ObjModMod } from 'casc-ts/formats';
import { ParsedPreviewContext, registerParsedPreviewer } from './preview/framework';
import { loadTriggerStringsForUri, resolveTriggerString, ResolvedText, TriggerStringTable } from './preview/triggerStrings';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';
export { ObjModFile, ObjModEntry, ObjModMod, ObjModVarType } from 'casc-ts/formats';

const TYPE_LABELS: Record<string, string> = {
    w3u: 'Unit',
    w3t: 'Item',
    w3a: 'Ability',
    w3b: 'Destructable',
    w3d: 'Doodad',
    w3h: 'Buff',
    w3q: 'Upgrade',
};

function formatValue(mod: ObjModMod, triggerStrings: TriggerStringTable): string {
    if (typeof mod.value === 'number') {
        if (mod.varType === 'real' || mod.varType === 'unreal') {
            return mod.value.toPrecision(6).replace(/\.?0+$/, '');
        }
        return String(mod.value);
    }
    return renderResolvedInline(resolveTriggerString(mod.value, triggerStrings));
}

function renderModRows(mods: ObjModMod[], extended: boolean, triggerStrings: TriggerStringTable): string {
    if (mods.length === 0) return `<tr><td colspan="${extended ? 5 : 3}" class="empty">no modifications</td></tr>`;
    return mods.map(m => {
        const levelCols = extended
            ? `<td class="num">${m.level ?? ''}</td><td class="num">${m.dataPt ?? ''}</td>`
            : '';
        return `<tr>
  <td class="id">${escapeHtml(m.fieldId)}</td>
  <td class="type ${m.varType}">${m.varType}</td>
  ${levelCols}
  <td class="value">${formatValue(m, triggerStrings)}</td>
</tr>`;
    }).join('\n');
}

function renderSection(title: string, entries: ObjModEntry[], extended: boolean, triggerStrings: TriggerStringTable): string {
    if (entries.length === 0) {
        return `<section class="section"><h2>${escapeHtml(title)} <span class="count">(0)</span></h2><p class="empty">none</p></section>`;
    }

    const extraHeaders = extended ? '<th>Level</th><th>DataPt</th>' : '';
    const parts = entries.map(e => {
        const idLine = e.newId
            ? `<span class="base-id">${escapeHtml(e.baseId)}</span><span class="arrow">-&gt;</span><span class="new-id">${escapeHtml(e.newId)}</span>`
            : `<span class="base-id">${escapeHtml(e.baseId)}</span>`;
        return `<details open>
  <summary>${idLine}<span class="mod-count">${e.mods.length} mod${e.mods.length !== 1 ? 's' : ''}</span></summary>
  <div class="table-wrap"><table>
    <thead><tr><th>Field</th><th>Type</th>${extraHeaders}<th>Value</th></tr></thead>
    <tbody>${renderModRows(e.mods, extended, triggerStrings)}</tbody>
  </table></div>
</details>`;
    }).join('\n');

    return `<section class="section">
<h2>${escapeHtml(title)} <span class="count">(${entries.length})</span></h2>
${parts}
</section>`;
}

function buildHtml(parsed: ObjModFile, fileName: string, context: ParsedPreviewContext): string {
    const typeLabel = TYPE_LABELS[parsed.ext.slice(1)] ?? parsed.ext.slice(1).toUpperCase();
    const triggerStrings = loadTriggerStringsForUri(context.uri);
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escapeHtml(parsed.error)}</div>`
        : '';

    const origSection = renderSection('Original Object Modifications', parsed.origObjs, parsed.extended, triggerStrings);
    const customSection = renderSection('Custom Objects', parsed.customObjs, parsed.extended, triggerStrings);

    return buildPage({
        csp: "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(fileName),
        extraCss: `
.content { flex: 1; overflow: auto; }
.md-header {
  padding: 10px 16px 9px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
}
.md-title {
  color: var(--vscode-textLink-foreground, var(--fg));
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.md-meta { color: var(--muted); font-size: 12px; margin-top: 1px; }
.readonly-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.dialog { max-width: 1120px; padding: 14px 16px 22px; }
.section {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 14px;
}
.section:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
h2 { font-size: 12px; margin: 0 0 9px; font-weight: 600; color: var(--fg); }
.count { font-weight: normal; opacity: .6; }
.error {
  color: var(--vscode-errorForeground, #f14c4c);
  border: 1px solid color-mix(in srgb, currentColor 65%, transparent);
  padding: 7px 9px;
  margin-bottom: 12px;
  border-radius: 2px;
}
.empty { color: var(--muted); font-style: italic; padding: 4px 0; }
details { margin-bottom: 7px; }
summary {
  cursor: pointer;
  padding: 6px 8px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 2px 2px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  user-select: none;
}
summary::-webkit-details-marker { display: none; }
summary::before { content: '>'; font-size: 10px; transition: transform .15s; opacity: .65; }
details[open] > summary::before { transform: rotate(90deg); }
.base-id { font-family: var(--mono); font-weight: 600; color: var(--vscode-textLink-foreground, var(--fg)); }
.new-id { font-family: var(--mono); font-weight: 600; }
.arrow { opacity: .5; }
.mod-count { margin-left: auto; color: var(--muted); font-size: 12px; }
.table-wrap { overflow: auto; border: 1px solid var(--border); border-top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 12px; min-width: 560px; }
th {
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--sidebar));
  text-align: left;
  padding: 6px 8px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); }
tbody tr:last-child td { border-bottom: 0; }
tr:nth-child(even) td { background: color-mix(in srgb, var(--hover) 55%, transparent); }
td.id { font-family: var(--mono); color: var(--vscode-textLink-foreground, var(--fg)); }
td.num { font-family: var(--mono); text-align: center; color: var(--muted); }
td.value { font-family: var(--mono); word-break: break-all; }
td.type { font-size: 11px; color: var(--muted); }
td.type.int { color: #9cdcfe; }
td.type.real { color: #b5cea8; }
td.type.unreal { color: #ce9178; }
td.type.string { color: #d7ba7d; }
.source-pill {
  display: inline-block;
  max-width: 170px;
  margin-left: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: -2px;
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 0 4px;
  color: var(--vscode-textLink-foreground, var(--muted));
  font-family: var(--mono);
  font-size: 10px;
}
.source-pill.missing {
  color: var(--vscode-errorForeground, #f14c4c);
}
`,
        body: `<div class="content">
<div class="md-header">
  <div class="md-title">${escapeHtml(fileName)}</div>
  <div class="md-meta">WC3 ${escapeHtml(typeLabel)} object modifications - v${parsed.version}${parsed.extended ? ' - extended (level/dataPt)' : ''}<span class="readonly-badge">read-only</span></div>
</div>
<div class="dialog">
${errorBanner}
${origSection}
${customSection}
</div>
</div>`,
    });
}

function renderResolvedInline(value: ResolvedText): string {
    const source = value.source
        ? ` <span class="source-pill${value.missing ? ' missing' : ''}" title="${escapeHtml(value.missing ? `${value.source} not found in war3map.wts` : `Resolved from ${value.source}`)}">${escapeHtml(value.source)}</span>`
        : '';
    return `${escapeHtml(value.value === undefined ? '' : String(value.value))}${source}`;
}

export function registerObjModPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return registerParsedPreviewer<ObjModFile>({
        viewType: 'wurst.objModPreview',
        parse:  (data, fileName) => parseObjMod(data, fileName.slice(fileName.lastIndexOf('.'))),
        render: (parsed, fileName, context) => buildHtml(parsed, fileName, context),
    });
}
