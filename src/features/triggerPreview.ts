'use strict';

/** VS Code preview for WC3 .wct / .wtg trigger files. Parsers live in `casc-ts/formats`. */

import * as vscode from 'vscode';
import {
    parseWct, parseWtg,
    WctFile, WctTrig, WtgFile,
} from 'casc-ts/formats';
import { registerParsedPreviewer } from './preview/framework';
import { buildPage, DATA_PAGE_CSS, STATIC_CSP } from './webviewShared';
import { getObjectCatalog, ObjectRef } from './preview/objectCatalog';
export { WctFile, WctTrig, WtgFile, WtgCategory, WtgVar, WtgTrig } from 'casc-ts/formats';

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Annotate FourCC rawcode literals (e.g. `'hfoo'`) in already-HTML-escaped JASS with the
 * resolved object name as a hover tooltip — turning opaque codes into readable references.
 * Single-quoted alphanumerics aren't escaped by escHtml, so matching the escaped text is safe.
 */
function annotateJassRawcodes(escapedCode: string, catalog: Map<string, ObjectRef>): string {
    return escapedCode.replace(/'([A-Za-z0-9]{4})'/g, (whole, code: string) => {
        const name = catalog.get(code.toLowerCase())?.name;
        return name ? `<span class="rawref" title="${escHtml(name)}">${whole}</span>` : whole;
    });
}

// Page-specific rules on top of the shared data-page look (webview/dataPage.css).
const TRIGGER_CSS = `
  .content { padding: 12px 16px; }
  h2 { font-size: .95em; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
  section { margin-bottom: 20px; }
  table { width: 100%; }
  tr:nth-child(even) td { background: var(--hover); }
  td.mono { color: var(--accent); }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: .78em; font-weight: 600; }
  .pill.off { background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--muted); }
  .pill.custom { background: color-mix(in srgb, var(--chart-orange) 20%, transparent); color: var(--chart-orange); }
  .rawref { border-bottom: 1px dotted var(--accent); cursor: help; }
`;

function triggerPage(fileName: string, extraCss: string, body: string): string {
    return buildPage({
        csp: STATIC_CSP,
        title: escHtml(fileName),
        extraCss: DATA_PAGE_CSS + TRIGGER_CSS + extraCss,
        body: `<div class="content">
${body}
</div>`,
    });
}

// ── WCT HTML rendering ────────────────────────────────────────────────────────

function buildWctHtml(parsed: WctFile, fileName: string, catalog: Map<string, ObjectRef>): string {
    let versionLabel: string;
    if (parsed.version === -2147483644) versionLabel = '0x80000004 (Reforged)';
    else if (parsed.version === 1) versionLabel = '1 (TFT)';
    else if (parsed.version === 0) versionLabel = '0 (RoC)';
    else versionLabel = String(parsed.version);

    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escHtml(parsed.error)}</div>`
        : '';

    const sections: string[] = [];

    const renderTrig = (t: WctTrig, label: string, note?: string): string => {
        const code = t.text.trim();
        const noteHtml = note ? `<p class="note">${escHtml(note)}</p>` : '';
        if (!code) {
            return `<section>
<h2>${escHtml(label)} <span class="count">(empty)</span></h2>
${noteHtml}
<p class="empty">no code</p>
</section>`;
        }
        const lineCount = (code.match(/\n/g)?.length ?? 0) + 1;
        return `<section>
<h2>${escHtml(label)} <span class="count">(${lineCount} line${lineCount !== 1 ? 's' : ''})</span></h2>
${noteHtml}
<pre>${annotateJassRawcodes(escHtml(code), catalog)}</pre>
</section>`;
    };

    if (parsed.headTrig) {
        sections.push(renderTrig(parsed.headTrig, 'Header', parsed.headComment || 'Global init script'));
    }

    if (parsed.trigs.length === 0 && !parsed.headTrig) {
        sections.push('<p class="empty">No custom-text triggers</p>');
    } else {
        parsed.trigs.forEach((t, i) => {
            sections.push(renderTrig(t, `Trigger ${i}`));
        });
    }

    return triggerPage(fileName, `
  pre {
    background: var(--code-bg);
    padding: 10px 12px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: var(--mono-size);
    white-space: pre;
    overflow-x: auto;
    margin: 0;
  }
  .note { color: var(--muted); font-size: .85em; line-height: 1.4; margin: -2px 0 8px; max-width: 900px; }
`, `<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 Custom Text Triggers &nbsp;·&nbsp; v${versionLabel} &nbsp;·&nbsp; ${parsed.trigs.length} trigger${parsed.trigs.length !== 1 ? 's' : ''}</p>
${errorBanner}
${sections.join('\n')}`);
}

// ── WTG HTML rendering ────────────────────────────────────────────────────────

function buildWtgHtml(parsed: WtgFile, fileName: string): string {
    let versionLabel: string;
    if (parsed.version === 4) versionLabel = '4 (RoC)';
    else if (parsed.version === 7) versionLabel = '7 (TFT)';
    else if (parsed.version === -2147483644) versionLabel = '0x80000004 (Reforged)';
    else versionLabel = String(parsed.version);

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
            const arraySize = v.arraySize !== undefined ? v.arraySize : '';
            const typeStr = v.isArray
                ? `${escHtml(v.type)}[${arraySize}]`
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

    return triggerPage(fileName, '', `<h1>${escHtml(fileName)}</h1>
<p class="subtitle">WC3 GUI Trigger Editor &nbsp;·&nbsp; v${versionLabel}</p>
${errorBanner}
${warnBanner}
${catsSection}
${varsSection}
${trigsSection}`);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerTriggerPreview(_context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        registerParsedPreviewer<WctFile>({
            viewType: 'wurst.wctPreview',
            parse:  (data) => parseWct(data),
            render: async (parsed, fileName) => buildWctHtml(parsed, fileName, await getObjectCatalog()),
        }),
        registerParsedPreviewer<WtgFile>({
            viewType: 'wurst.wtgPreview',
            parse:  (data) => parseWtg(data),
            render: (parsed, fileName) => buildWtgHtml(parsed, fileName),
        }),
    ];
}
