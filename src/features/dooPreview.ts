'use strict';

/** VS Code preview for WC3 .doo files. Parser lives in `casc-ts/formats`. */

import * as path from 'path';
import * as vscode from 'vscode';
import {
    parseDoo,
    DooFile, DooDoodad, DooSpecialDoodad, DooUnit, DooDropSet,
} from 'casc-ts/formats';

export {
    DooFile, DooDoodad, DooSpecialDoodad, DooUnit, DooDropSet,
    DooItemDrop, DooInvItem, DooAbility, DooRandType, DooFileKind,
} from 'casc-ts/formats';

// ── HTML rendering ────────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt1(n: number): string {
    const s = n.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function fmt3(n: number): string {
    return n.toFixed(3).replace(/\.?0+$/, '');
}

function playerLabel(p: number): string {
    if (p === 12) return 'Neutral Hostile';
    if (p === 13) return 'Neutral Passive';
    if (p === 15) return 'None';
    return `Player ${p + 1}`;
}

function renderDropSetsHtml(drops: DooDropSet[]): string {
    if (drops.length === 0) return '—';
    return drops.map(ds => {
        if (ds.items.length === 0) return '∅';
        return ds.items.map(it => `${escHtml(it.itemId)}(${it.chance}%)`).join(', ');
    }).join(' | ');
}

// ── Doodad table ──────────────────────────────────────────────────────────────

function renderDoodadTable(doodads: DooDoodad[]): string {
    if (doodads.length === 0) return '<p class="empty">No doodads</p>';

    const rows = doodads.map(d => {
        const visible = (d.flags & 1) ? 'V' : '—';
        const solid   = (d.flags & 2) ? 'S' : '—';

        return `<tr>
  <td class="id">${escHtml(d.typeId)}</td>
  <td class="id">${d.skinId ? escHtml(d.skinId) : '—'}</td>
  <td class="num">${d.variation}</td>
  <td class="num">${fmt1(d.x)}</td><td class="num">${fmt1(d.y)}</td><td class="num">${fmt1(d.z)}</td>
  <td class="num">${fmt3(d.angle)}</td>
  <td class="num">${fmt1(d.scaleX)}×${fmt1(d.scaleY)}×${fmt1(d.scaleZ)}</td>
  <td class="num">${visible}${solid}</td>
  <td class="num">${d.lifePerc}%</td>
  <td class="drops">${renderDropSetsHtml(d.drops)}</td>
</tr>`;
    }).join('\n');

    return `<table>
<thead><tr>
  <th>Type</th><th>Skin</th><th>Var</th>
  <th>X</th><th>Y</th><th>Z</th>
  <th>Angle</th><th>Scale</th><th>Flags</th><th>Life</th><th>Drops</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function renderSpecialDoodadTable(specials: DooSpecialDoodad[]): string {
    if (specials.length === 0) return '';

    const rows = specials.map(s =>
        `<tr>
  <td class="id">${escHtml(s.typeId)}</td>
  <td class="num">${s.x}</td><td class="num">${s.y}</td><td class="num">${s.z}</td>
</tr>`
    ).join('\n');

    return `<section>
<h2>Special Doodads (terrain-baked) <span class="count">(${specials.length})</span></h2>
<table>
<thead><tr><th>Type</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>`;
}

// ── Unit table ────────────────────────────────────────────────────────────────

function renderUnitTable(units: DooUnit[], hasSubV11: boolean): string {
    if (units.length === 0) return '<p class="empty">No units</p>';

    const heroHeaders = hasSubV11 ? '<th>STR</th><th>AGI</th><th>INT</th>' : '';

    const rows = units.map(u => {
        const isSloc   = u.typeId === 'sloc';
        const heroCols = hasSubV11
            ? `<td class="num">${u.heroStr ?? '—'}</td><td class="num">${u.heroAgi ?? '—'}</td><td class="num">${u.heroInt ?? '—'}</td>`
            : '';
        const hpStr   = u.lifePerc === -1 ? 'default' : `${u.lifePerc}%`;
        const mpStr   = u.manaPerc === -1 ? 'default' : `${u.manaPerc}%`;
        const drops   = renderDropSetsHtml(u.drops);
        const abils   = u.abilities.length
            ? u.abilities.map(a => `${escHtml(a.abilityId)} L${a.level}${a.autoCast ? '✓' : ''}`).join(', ')
            : '—';

        return `<tr${isSloc ? ' class="sloc"' : ''}>
  <td class="id">${escHtml(u.typeId)}</td>
  <td class="id">${u.skinId ? escHtml(u.skinId) : '—'}</td>
  <td class="num">${u.variation}</td>
  <td class="num">${playerLabel(u.ownerIndex)}</td>
  <td class="num">${fmt1(u.x)}</td><td class="num">${fmt1(u.y)}</td><td class="num">${fmt1(u.z)}</td>
  <td class="num">${fmt3(u.angle)}</td>
  <td class="num">${hpStr}</td><td class="num">${mpStr}</td>
  <td class="num">${u.heroLevel > 1 ? u.heroLevel : '—'}</td>
  ${heroCols}
  <td class="num">${u.resourcesAmount > 0 ? u.resourcesAmount : '—'}</td>
  <td class="drops">${drops}</td>
  <td class="drops">${abils}</td>
</tr>`;
    }).join('\n');

    return `<table>
<thead><tr>
  <th>Type</th><th>Skin</th><th>Var</th><th>Player</th>
  <th>X</th><th>Y</th><th>Z</th><th>Angle</th>
  <th>HP</th><th>MP</th><th>Lvl</th>${heroHeaders}
  <th>Gold</th><th>Drops</th><th>Abilities</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

// ── Full HTML page ────────────────────────────────────────────────────────────

function buildHtml(parsed: DooFile, fileName: string): string {
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escHtml(parsed.error)}</div>`
        : '';

    const isDoodads = parsed.kind === 'doodads';
    const hasSubV11 = parsed.subVersion >= 11;

    let mainSection = '';
    if (isDoodads && parsed.doodads) {
        const count = parsed.doodads.length;
        mainSection = `<section>
<h2>Doodads / Destructables <span class="count">(${count})</span></h2>
${renderDoodadTable(parsed.doodads)}
</section>
${renderSpecialDoodadTable(parsed.specialDoodads ?? [])}`;
    } else if (!isDoodads && parsed.units) {
        const count  = parsed.units.length;
        const slocs  = parsed.units.filter(u => u.typeId === 'sloc').length;
        const sub2   = slocs > 0 ? ` — ${slocs} start location${slocs !== 1 ? 's' : ''}` : '';

        mainSection = `<section>
<h2>Units &amp; Items <span class="count">(${count}${sub2})</span></h2>
${renderUnitTable(parsed.units, hasSubV11)}
</section>`;
    }

    const kindLabel = isDoodads ? 'Doodad Placement' : 'Unit Placement';

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
    --sloc-bg: color-mix(in srgb, var(--vscode-textLink-foreground, #4ec9b0) 8%, transparent);
    font-size: 13px;
    font-family: var(--vscode-font-family, sans-serif);
  }
  body { background: var(--bg); color: var(--fg); margin: 0; padding: 12px 16px; overflow-x: auto; }
  h1 { font-size: 1.1em; margin: 0 0 4px; color: var(--accent); }
  .subtitle { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; margin-bottom: 16px; }
  h2 { font-size: 0.95em; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  .count { font-weight: normal; opacity: .6; }
  .error { color: var(--error); border: 1px solid var(--error); padding: 6px 10px; border-radius: 3px; margin-bottom: 12px; }
  .empty { opacity: .5; font-style: italic; padding: 4px 0; }
  table { border-collapse: collapse; font-size: .85em; white-space: nowrap; }
  th { background: var(--th-bg); text-align: left; padding: 4px 8px; font-weight: 600; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
  td { padding: 2px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); }
  tr:nth-child(even) td { background: var(--row-alt); }
  tr.sloc td { background: var(--sloc-bg); font-style: italic; opacity: .8; }
  td.id   { font-family: monospace; color: var(--accent); }
  td.num  { font-family: monospace; text-align: right; opacity: .85; }
  td.drops { font-family: monospace; font-size: .8em; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 ${escHtml(kindLabel)} &nbsp;·&nbsp; v${parsed.version} (sub ${parsed.subVersion})</p>
${errorBanner}
${mainSection}
</body>
</html>`;
}

// ── VSCode custom editor ──────────────────────────────────────────────────────

class DooDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        readonly parsed: DooFile,
    ) {}

    dispose(): void {}
}

class DooEditorProvider implements vscode.CustomReadonlyEditorProvider<DooDocument> {
    static readonly VIEW_TYPE = 'wurst.dooPreview';

    async openCustomDocument(uri: vscode.Uri): Promise<DooDocument> {
        const data   = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const parsed = parseDoo(data, path.basename(uri.fsPath));
        return new DooDocument(uri, parsed);
    }

    resolveCustomEditor(
        document: DooDocument,
        webviewPanel: vscode.WebviewPanel,
    ): void {
        webviewPanel.webview.options = { enableScripts: false };
        const fileName = path.basename(document.uri.fsPath);
        webviewPanel.webview.html = buildHtml(document.parsed, fileName);
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerDooPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        DooEditorProvider.VIEW_TYPE,
        new DooEditorProvider(),
        { supportsMultipleEditorsPerDocument: true },
    );
}
