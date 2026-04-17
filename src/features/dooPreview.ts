'use strict';

/**
 * Binary WC3 .doo file parser and preview.
 *
 * Two file types share the .doo extension:
 *   war3map.doo      – doodad/destructable placement (DOO.java in wc3libs)
 *   war3mapUnits.doo – unit & item placement        (DOO_UNITS.java in wc3libs)
 *
 * Both begin with the magic "W3do" followed by a u32 version (always 8 for TFT)
 * and a u32 subVersion (typically 0xB = 11, but can be 9 for older maps).
 * The filename is used to distinguish the two types.
 *
 * SkinId detection (both file types):
 *   Peek at the next byte after scale. Flags can only be 0x00–0x07 (3 bits),
 *   so if the byte value > 7 it must be the first byte of a 4-byte skinId.
 *   Rewind and read the 4 bytes; otherwise read flags directly.
 *
 * Doodad entry (war3map.doo), format 0x8:
 *   char[4]  typeId
 *   i32      variation
 *   f32      x, y, z
 *   f32      angle (radians)
 *   f32      scaleX, scaleY, scaleZ
 *   [skinId detection] char[4] skinId  (optional, see above)
 *   u8       flags
 *   u8       lifePerc
 *   i32      itemTablePtr  (always present)
 *   i32      itemSetsDroppedCount  (always present)
 *   itemSets[count]:
 *     i32    itemsCount
 *     items[itemsCount]: char[4] itemId, i32 chance
 *   i32      editorId
 * Followed by special-doodads section:
 *   i32  specialVersion (must be 0)
 *   i32  count
 *   entries[count]: char[4] typeId, i32 z, i32 x, i32 y
 *
 * Unit entry (war3mapUnits.doo), format 0x8:
 *   char[4]  typeId   ("sloc" = start location)
 *   i32      variation
 *   f32      x, y, z
 *   f32      angle
 *   f32      scaleX, scaleY, scaleZ
 *   [skinId detection] char[4] skinId  (optional, see above)
 *   u8       flags
 *   i32      ownerIndex
 *   u8       unknownA
 *   u8       unknownB
 *   i32      lifePerc   (percent, -1 = default)
 *   i32      manaPerc   (percent, -1 = default)
 *   [subVersion >= 11] i32  itemTablePtr
 *   i32      lootsCount
 *   lootSets[count]:
 *     i32    itemsCount
 *     items[itemsCount]: char[4] itemId, i32 chance
 *   i32      resourcesAmount
 *   f32      targetAcquisition (-1 = normal, -2 = camp)
 *   i32      heroLevel
 *   [subVersion >= 11] i32 heroStr, i32 heroAgi, i32 heroInt
 *   i32      invItemsCount
 *   invItems[count]: i32 slot, char[4] itemId
 *   i32      abilModsCount
 *   abilMods[count]: char[4] abilityId, i32 autoCast, i32 level
 *   i32      randFlag  (0=any, 1=randGroup, 2=randCustom)
 *   randFlag==0: 3 bytes randLevel (LE) + 1 byte randClass
 *   randFlag==1: i32 groupIndex, i32 groupPos
 *   randFlag==2: i32 count, [count] char[4] typeId + i32 chance
 *   i32      customColor
 *   i32      waygateTargetRectIndex
 *   i32      editorId
 */

import * as path from 'path';
import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DooItemDrop {
    itemId: string;
    chance: number;
}

export interface DooDropSet {
    items: DooItemDrop[];
}

export interface DooInvItem {
    slot: number;
    itemId: string;
}

export interface DooDoodad {
    typeId: string;
    variation: number;
    x: number;
    y: number;
    z: number;
    angle: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    skinId?: string;
    flags: number;
    lifePerc: number;
    itemTablePtr: number;
    drops: DooDropSet[];
    editorId: number;
}

export interface DooSpecialDoodad {
    typeId: string;
    z: number;
    x: number;
    y: number;
}

export interface DooAbility {
    abilityId: string;
    autoCast: boolean;
    level: number;
}

export type DooRandType = 'any' | 'group' | 'custom';

export interface DooUnit {
    typeId: string;
    variation: number;
    x: number;
    y: number;
    z: number;
    angle: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
    skinId?: string;
    flags: number;
    ownerIndex: number;
    lifePerc: number;
    manaPerc: number;
    itemTablePtr?: number;
    drops: DooDropSet[];
    resourcesAmount: number;
    targetAcquisition: number;
    heroLevel: number;
    heroStr?: number;
    heroAgi?: number;
    heroInt?: number;
    invItems: DooInvItem[];
    abilities: DooAbility[];
    randType: DooRandType;
    randLevel?: number;
    randClass?: number;
    randGroupIndex?: number;
    randGroupPos?: number;
    randCustom?: DooItemDrop[];
    customColor: number;
    waygateTargetRectIndex: number;
    editorId: number;
}

export type DooFileKind = 'doodads' | 'units';

export interface DooFile {
    kind: DooFileKind;
    version: number;
    subVersion: number;
    doodads?: DooDoodad[];
    specialDoodads?: DooSpecialDoodad[];
    units?: DooUnit[];
    error?: string;
}

// ── Low-level reader ──────────────────────────────────────────────────────────

class BinReader {
    private pos = 0;
    constructor(private readonly buf: Buffer) {}

    get offset(): number { return this.pos; }
    get remaining(): number { return this.buf.length - this.pos; }

    peekU8(): number {
        if (this.remaining < 1) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need u8`);
        return this.buf[this.pos];
    }

    readU8(): number {
        if (this.remaining < 1) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need u8`);
        return this.buf[this.pos++];
    }

    readI32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need i32`);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readF32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need f32`);
        const v = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return v;
    }

    readId(): string {
        if (this.remaining < 4) throw new Error(`Buffer underflow at 0x${this.pos.toString(16)}: need id`);
        const b = this.buf.slice(this.pos, this.pos + 4);
        this.pos += 4;
        return String.fromCharCode(b[0], b[1], b[2], b[3]);
    }
}

// ── SkinId discriminator (shared by both file types) ──────────────────────────
// Flags occupy at most 3 bits (0x00–0x07). If the next byte is > 7, the next
// 4 bytes are a skinId and flags follow after; otherwise the byte IS the flags.

function readOptionalSkinId(r: BinReader): string | undefined {
    if (r.peekU8() > 7) {
        return r.readId();
    }
    return undefined;
}

// ── Shared sub-parsers ────────────────────────────────────────────────────────

function readDropSets(r: BinReader): DooDropSet[] {
    const count = r.readI32();
    const sets: DooDropSet[] = [];
    for (let d = 0; d < count; d++) {
        const itemsCount = r.readI32();
        const items: DooItemDrop[] = [];
        for (let i = 0; i < itemsCount; i++) {
            items.push({ itemId: r.readId(), chance: r.readI32() });
        }
        sets.push({ items });
    }
    return sets;
}

// ── Doodad parser ─────────────────────────────────────────────────────────────

function parseDoodad(r: BinReader): DooDoodad {
    const typeId    = r.readId();
    const variation = r.readI32();
    const x = r.readF32(), y = r.readF32(), z = r.readF32();
    const angle  = r.readF32();
    const scaleX = r.readF32(), scaleY = r.readF32(), scaleZ = r.readF32();

    const skinId = readOptionalSkinId(r);
    const flags    = r.readU8();
    const lifePerc = r.readU8();

    // itemTablePtr and drops are always present in format 0x8
    const itemTablePtr = r.readI32();
    const drops        = readDropSets(r);
    const editorId     = r.readI32();

    return { typeId, variation, x, y, z, angle, scaleX, scaleY, scaleZ, skinId, flags, lifePerc, itemTablePtr, drops, editorId };
}

function parseDoodadFile(r: BinReader, version: number, subVersion: number): DooFile {
    const count = r.readI32();
    const doodads: DooDoodad[] = [];
    for (let i = 0; i < count; i++) {
        doodads.push(parseDoodad(r));
    }

    // Special doodads section (terrain-baked objects like bridges)
    const specialDoodads: DooSpecialDoodad[] = [];
    if (r.remaining >= 8) {
        const specialVersion = r.readI32();
        if (specialVersion !== 0) {
            return { kind: 'doodads', version, subVersion, doodads, specialDoodads,
                error: `Unknown special doodads version: ${specialVersion}` };
        }
        const specialCount = r.readI32();
        for (let i = 0; i < specialCount; i++) {
            const typeId = r.readId();
            const z = r.readI32(), x = r.readI32(), y = r.readI32();
            specialDoodads.push({ typeId, z, x, y });
        }
    }

    return { kind: 'doodads', version, subVersion, doodads, specialDoodads };
}

// ── Unit parser ───────────────────────────────────────────────────────────────

function parseUnit(r: BinReader, subVersion: number): DooUnit {
    const typeId    = r.readId();
    const variation = r.readI32();
    const x = r.readF32(), y = r.readF32(), z = r.readF32();
    const angle  = r.readF32();
    const scaleX = r.readF32(), scaleY = r.readF32(), scaleZ = r.readF32();

    const skinId     = readOptionalSkinId(r);
    const flags      = r.readU8();
    const ownerIndex = r.readI32();
    r.readU8(); // unknownA
    r.readU8(); // unknownB

    const lifePerc = r.readI32();
    const manaPerc = r.readI32();

    // itemTablePtr only present in subVersion >= 11
    let itemTablePtr: number | undefined;
    if (subVersion >= 11) {
        itemTablePtr = r.readI32();
    }

    const drops = readDropSets(r);

    const resourcesAmount    = r.readI32();
    const targetAcquisition  = r.readF32();
    const heroLevel          = r.readI32();

    // hero attributes only present in subVersion >= 11
    let heroStr: number | undefined, heroAgi: number | undefined, heroInt: number | undefined;
    if (subVersion >= 11) {
        heroStr = r.readI32();
        heroAgi = r.readI32();
        heroInt = r.readI32();
    }

    // inventory items
    const invItemsCount = r.readI32();
    const invItems: DooInvItem[] = [];
    for (let i = 0; i < invItemsCount; i++) {
        const slot   = r.readI32();
        const itemId = r.readId();
        invItems.push({ slot, itemId });
    }

    // ability modifications
    const abilCount  = r.readI32();
    const abilities: DooAbility[] = [];
    for (let i = 0; i < abilCount; i++) {
        const abilityId = r.readId();
        const autoCast  = r.readI32() !== 0;
        const level     = r.readI32();
        abilities.push({ abilityId, autoCast, level });
    }

    // random unit type
    const randTypeRaw = r.readI32();
    let randType: DooRandType = 'any';
    let randLevel: number | undefined, randClass: number | undefined;
    let randGroupIndex: number | undefined, randGroupPos: number | undefined;
    let randCustom: DooItemDrop[] | undefined;

    if (randTypeRaw === 0) {
        // 3-byte little-endian level + 1-byte class
        const b0 = r.readU8(), b1 = r.readU8(), b2 = r.readU8();
        randLevel = b2 * 65536 + b1 * 256 + b0;
        randClass = r.readU8();
        randType  = 'any';
    } else if (randTypeRaw === 1) {
        randGroupIndex = r.readI32();
        randGroupPos   = r.readI32();
        randType       = 'group';
    } else if (randTypeRaw === 2) {
        const randCount = r.readI32();
        randCustom = [];
        for (let i = 0; i < randCount; i++) {
            randCustom.push({ itemId: r.readId(), chance: r.readI32() });
        }
        randType = 'custom';
    }

    const customColor             = r.readI32();
    const waygateTargetRectIndex  = r.readI32();
    const editorId                = r.readI32();

    return {
        typeId, variation, x, y, z, angle, scaleX, scaleY, scaleZ, skinId,
        flags, ownerIndex, lifePerc, manaPerc, itemTablePtr, drops,
        resourcesAmount, targetAcquisition, heroLevel,
        heroStr, heroAgi, heroInt,
        invItems, abilities,
        randType, randLevel, randClass, randGroupIndex, randGroupPos, randCustom,
        customColor, waygateTargetRectIndex, editorId,
    };
}

function parseUnitFile(r: BinReader, version: number, subVersion: number): DooFile {
    const count = r.readI32();
    const units: DooUnit[] = [];
    for (let i = 0; i < count; i++) {
        units.push(parseUnit(r, subVersion));
    }
    return { kind: 'units', version, subVersion, units };
}

// ── Top-level parser ──────────────────────────────────────────────────────────

export function parseDoo(data: Buffer, fileName: string): DooFile {
    const kind: DooFileKind = fileName.toLowerCase().includes('units') ? 'units' : 'doodads';
    const r = new BinReader(data);

    try {
        const magic = r.readId();
        if (magic !== 'W3do') {
            return { kind, version: 0, subVersion: 0, error: `Unexpected magic "${magic}", expected "W3do"` };
        }

        const version    = r.readI32();
        const subVersion = r.readI32();

        if (version !== 8) {
            return { kind, version, subVersion, error: `Unsupported version: ${version} (expected 8)` };
        }

        return kind === 'units'
            ? parseUnitFile(r, version, subVersion)
            : parseDoodadFile(r, version, subVersion);

    } catch (e) {
        return {
            kind, version: 0, subVersion: 0,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

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
