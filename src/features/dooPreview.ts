'use strict';

/** VS Code preview for WC3 .doo files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import {
    parseDoo,
    DooFile, DooDoodad, DooSpecialDoodad, DooUnit, DooDropSet,
} from 'casc-ts/formats';
import { registerParsedPreviewer, ParsedPreviewContext } from './preview/framework';
import { getObjectCatalog, ObjectRef } from './preview/objectCatalog';
import { requestPreviewIcon } from './imageAssetSupport';
import {
    buildPage, DATA_PAGE_CSS, ICON_INLINE_CSS, ICON_LAZYLOAD_SCRIPT, PREVIEW_ICON_CSP,
} from './webviewShared';
import { escapeHtml } from './webviewUtils';

export {
    DooFile, DooDoodad, DooSpecialDoodad, DooUnit, DooDropSet,
    DooItemDrop, DooInvItem, DooAbility, DooRandType, DooFileKind,
} from 'casc-ts/formats';

type Catalog = Map<string, ObjectRef>;

// ── HTML helpers ────────────────────────────────────────────────────────────


function fmt1(n: number): string {
    const s = n.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function fmt3(n: number): string {
    // eslint-disable-next-line sonarjs/super-linear-regex -- single quantified group anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
    return n.toFixed(3).replace(/\.?0+$/, '');
}

function playerLabel(p: number): string {
    if (p === 12) return 'Neutral Hostile';
    if (p === 13) return 'Neutral Passive';
    if (p === 15) return 'None';
    return `Player ${p + 1}`;
}

/** Object reference cell: lazy icon + resolved name + dim rawcode. */
function objCell(id: string, catalog: Catalog, fallbackName?: string): string {
    const ref = catalog.get(id.toLowerCase());
    const name = ref?.name || fallbackName || id;
    const icon = ref?.iconPath
        ? `<span class="object-icon" data-key="${escapeHtml(id)}" data-icon="${escapeHtml(ref.iconPath)}"></span>`
        : `<span class="object-icon missing"></span>`;
    const sameAsId = name === id;
    const idSpan = sameAsId ? '' : `<span class="obj-id">${escapeHtml(id)}</span>`;
    return `<div class="obj-cell">${icon}<span class="obj-text"><span class="obj-name">${escapeHtml(name)}</span>${idSpan}</span></div>`;
}

/** Inline resolved name with rawcode tooltip (for compact drop/ability lists). */
function refName(id: string, catalog: Catalog): string {
    const name = catalog.get(id.toLowerCase())?.name;
    return name ? `<span title="${escapeHtml(id)}">${escapeHtml(name)}</span>` : `<span class="mono">${escapeHtml(id)}</span>`;
}

function renderDropSetsHtml(drops: DooDropSet[], catalog: Catalog): string {
    if (drops.length === 0) return '—';
    return drops.map(ds => {
        if (ds.items.length === 0) return '∅';
        return ds.items.map(it => `${refName(it.itemId, catalog)} <span class="dim">(${it.chance}%)</span>`).join(', ');
    }).join(' <span class="dim">|</span> ');
}

// ── Doodad table ──────────────────────────────────────────────────────────────

function renderDoodadTable(doodads: DooDoodad[], catalog: Catalog): string {
    if (doodads.length === 0) return '<p class="empty">No doodads</p>';

    const rows = doodads.map(d => {
        const visible = (d.flags & 1) ? 'V' : '—';
        const solid   = (d.flags & 2) ? 'S' : '—';

        return `<tr>
  <td class="obj">${objCell(d.typeId, catalog)}</td>
  <td class="id">${d.skinId && d.skinId !== d.typeId ? escapeHtml(d.skinId) : '—'}</td>
  <td class="num">${d.variation}</td>
  <td class="num">${fmt1(d.x)}</td><td class="num">${fmt1(d.y)}</td><td class="num">${fmt1(d.z)}</td>
  <td class="num">${fmt3(d.angle)}</td>
  <td class="num">${fmt1(d.scaleX)}×${fmt1(d.scaleY)}×${fmt1(d.scaleZ)}</td>
  <td class="num">${visible}${solid}</td>
  <td class="num">${d.lifePerc}%</td>
  <td class="drops">${renderDropSetsHtml(d.drops, catalog)}</td>
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

function renderSpecialDoodadTable(specials: DooSpecialDoodad[], catalog: Catalog): string {
    if (specials.length === 0) return '';

    const rows = specials.map(s =>
        `<tr>
  <td class="obj">${objCell(s.typeId, catalog)}</td>
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

function renderUnitTable(units: DooUnit[], hasSubV11: boolean, catalog: Catalog): string {
    if (units.length === 0) return '<p class="empty">No units</p>';

    const heroHeaders = hasSubV11 ? '<th>STR</th><th>AGI</th><th>INT</th>' : '';

    const rows = units.map(u => {
        const isSloc   = u.typeId === 'sloc';
        const heroCols = hasSubV11
            ? `<td class="num">${u.heroStr ?? '—'}</td><td class="num">${u.heroAgi ?? '—'}</td><td class="num">${u.heroInt ?? '—'}</td>`
            : '';
        const hpStr   = u.lifePerc === -1 ? 'default' : `${u.lifePerc}%`;
        const mpStr   = u.manaPerc === -1 ? 'default' : `${u.manaPerc}%`;
        const drops   = renderDropSetsHtml(u.drops, catalog);
        const abils   = u.abilities.length
            ? u.abilities.map(a => `${refName(a.abilityId, catalog)} <span class="dim">L${a.level}${a.autoCast ? ' ✓' : ''}</span>`).join(', ')
            : '—';
        const objHtml = isSloc ? objCell(u.typeId, catalog, 'Start Location') : objCell(u.typeId, catalog);

        return `<tr${isSloc ? ' class="sloc"' : ''}>
  <td class="obj">${objHtml}</td>
  <td class="id">${u.skinId && u.skinId !== u.typeId ? escapeHtml(u.skinId) : '—'}</td>
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

// Page-specific rules on top of the shared data-page look (webview/dataPage.css).
const DOO_CSS = `
${DATA_PAGE_CSS}
${ICON_INLINE_CSS}
.content { padding: 12px 16px; }
h2 { font-size: .9em; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.empty { padding: 4px 0; }
table { white-space: nowrap; }
th { position: sticky; top: 0; }
td { padding: 2px 8px; }
tr:nth-child(even) td { background: var(--hover); }
tr.sloc td { background: color-mix(in srgb, var(--accent) 8%, transparent); font-style: italic; opacity: .85; }
td.obj { --obj-icon-size: 20px; }
.obj-cell { display: flex; align-items: center; gap: 7px; }
.obj-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
.obj-name { font-weight: 500; }
.obj-id { font-family: var(--mono); font-size: .82em; opacity: .5; }
td.id { font-family: var(--mono); color: var(--accent); }
td.num { opacity: .85; }
td.drops { font-size: .92em; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.dim { opacity: .5; }
`;

function buildHtml(parsed: DooFile, fileName: string, catalog: Catalog): string {
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escapeHtml(parsed.error)}</div>`
        : '';

    const isDoodads = parsed.kind === 'doodads';
    const hasSubV11 = parsed.subVersion >= 11;

    let mainSection = '';
    if (isDoodads && parsed.doodads) {
        const count = parsed.doodads.length;
        mainSection = `<section>
<h2>Doodads / Destructables <span class="count">(${count})</span></h2>
${renderDoodadTable(parsed.doodads, catalog)}
</section>
${renderSpecialDoodadTable(parsed.specialDoodads ?? [], catalog)}`;
    } else if (!isDoodads && parsed.units) {
        const count  = parsed.units.length;
        const slocs  = parsed.units.filter(u => u.typeId === 'sloc').length;
        const slocPlural = slocs !== 1 ? 's' : '';
        const sub2   = slocs > 0 ? ` — ${slocs} start location${slocPlural}` : '';

        mainSection = `<section>
<h2>Units &amp; Items <span class="count">(${count}${sub2})</span></h2>
${renderUnitTable(parsed.units, hasSubV11, catalog)}
</section>`;
    }

    const kindLabel = isDoodads ? 'Doodad Placement' : 'Unit Placement';

    return buildPage({
        csp: PREVIEW_ICON_CSP,
        title: escapeHtml(fileName),
        extraCss: DOO_CSS,
        body: `<div class="content">
<h1>${escapeHtml(fileName)}</h1>
<p class="subtitle">WC3 ${escapeHtml(kindLabel)} &nbsp;·&nbsp; v${parsed.version} (sub ${parsed.subVersion})</p>
${errorBanner}
${mainSection}
</div>
${ICON_LAZYLOAD_SCRIPT}`,
    });
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerDooPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return registerParsedPreviewer<DooFile>({
        viewType: 'wurst.dooPreview',
        parse:  (data, fileName) => parseDoo(data, fileName),
        render: async (parsed, fileName) => buildHtml(parsed, fileName, await getObjectCatalog()),
        webviewOptions: { enableScripts: true, localResourceRoots: [] },
        panelOptions:   { retainContextWhenHidden: true },
        onMessage: (message, webview, _data, context: ParsedPreviewContext) => {
            const msg = message as { type?: string; key?: string; iconPath?: string };
            if (msg.type === 'loadObjectIcon' && msg.key && msg.iconPath) {
                void requestPreviewIcon(msg.iconPath, msg.key, webview, context.uri);
            }
        },
    });
}
