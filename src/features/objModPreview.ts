'use strict';

/** VS Code preview for WC3 Object Modification files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseObjMod, serializeObjMod, ObjModFile, ObjModEntry, ObjModMod, ObjModVarType } from 'casc-ts/formats';
import { ParsedPreviewContext } from './preview/framework';
import { findGameAsset } from './preview/cascStorage';
import { ensureGameTextureCached, decodeRasterPreview } from './blpPreview';
import { getCandidateRoots, resolveAssetPath } from './imageAssetSupport';
import {
    loadTriggerStringsForUri, resolveTriggerString, TriggerStringTable,
    findWtsUri, nextTriggerStringId, applyWtsEdits,
} from './preview/triggerStrings';
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

// Inline string fields in objmod files are length-capped by the World Editor; longer
// values must be externalized into war3map.wts as a TRIGSTR_ reference. The exact cap
// isn't authoritatively documented (community reports ~512–1024 bytes); 1024 is a safe
// upper bound that avoids needless externalization of normal-length names/tooltips.
// Tune here if WE rejects a value as too long.
const INLINE_STRING_LIMIT_BYTES = 1024;

// WC3 object-editor metadata 'type' values that are stored as a 32-bit int in objmod files
// (enums, flags, bools). Everything not listed here (text, codes, models, icons, lists) → string;
// 'real'/'unreal' handled explicitly. Used to type NEW mods created when editing a base field.
const META_INT_TYPES = new Set([
    'int', 'bool', 'armortype', 'attacktype', 'attributetype', 'deathtype', 'defensetype', 'regentype',
    'teamcolor', 'movetype', 'itemclass', 'unitclass', 'weapontype', 'attackbits', 'channeltype',
    'channelflags', 'defensetypeint', 'detectiontype', 'fullflags', 'interactionflags', 'morphflags',
    'pickflags', 'silenceflags', 'stackflags', 'versionflags',
]);

function metaVarType(type: string): ObjModVarType {
    const t = (type || '').toLowerCase();
    if (t === 'real') return 'real';
    if (t === 'unreal') return 'unreal';
    if (META_INT_TYPES.has(t)) return 'int';
    return 'string';
}

const NAME_FIELDS = new Set(['unam', 'inam', 'anam', 'bnam', 'dnam', 'fnam', 'gnam']);
const ICON_FIELDS = new Set(['uico', 'iico', 'aart', 'fart', 'gico']);

const FIELD_LABELS: Record<string, string> = {
    unam: 'Name',
    inam: 'Name',
    anam: 'Name',
    bnam: 'Name',
    dnam: 'Name',
    fnam: 'Name',
    gnam: 'Name',
    utip: 'Tooltip',
    atp1: 'Tooltip',
    itip: 'Tooltip',
    uhot: 'Hotkey',
    ahky: 'Hotkey',
    uico: 'Icon',
    aart: 'Icon',
    iico: 'Icon',
    umdl: 'Model',
    amdl: 'Model',
    ifil: 'Model',
    usca: 'Scale',
    ucol: 'Selection Scale',
    unsf: 'Editor Suffix',
    ureq: 'Requirements',
    uabi: 'Abilities',
};

const SLK_NAME_TO_PATH: Record<string, string> = {
    AbilityData: 'Units\\AbilityData.slk',
    AbilityBuffData: 'Units\\AbilityBuffData.slk',
    DestructableData: 'Units\\DestructableData.slk',
    DoodadData: 'Doodads\\Doodads.slk',
    ItemData: 'Units\\ItemData.slk',
    UnitAbilities: 'Units\\UnitAbilities.slk',
    UnitBalance: 'Units\\UnitBalance.slk',
    UnitData: 'Units\\UnitData.slk',
    UnitUI: 'Units\\unitUI.slk',
    UnitWeapons: 'Units\\UnitWeapons.slk',
    UpgradeData: 'Units\\UpgradeData.slk',
};

const UNIT_PROFILE_PATHS = [
    'Units\\UnitSkin.txt',
    'Units\\CampaignUnitFunc.txt',
    'Units\\CampaignUnitStrings.txt',
    'Units\\HumanUnitFunc.txt',
    'Units\\HumanUnitStrings.txt',
    'Units\\OrcUnitFunc.txt',
    'Units\\OrcUnitStrings.txt',
    'Units\\NightElfUnitFunc.txt',
    'Units\\NightElfUnitStrings.txt',
    'Units\\UndeadUnitFunc.txt',
    'Units\\UndeadUnitStrings.txt',
    'Units\\NeutralUnitFunc.txt',
    'Units\\NeutralUnitStrings.txt',
];

const ABILITY_PROFILE_PATHS = [
    'Units\\AbilitySkin.txt',
    'Units\\CampaignAbilityFunc.txt',
    'Units\\CampaignAbilityStrings.txt',
    'Units\\CommonAbilityFunc.txt',
    'Units\\CommonAbilityStrings.txt',
    'Units\\HumanAbilityFunc.txt',
    'Units\\HumanAbilityStrings.txt',
    'Units\\OrcAbilityFunc.txt',
    'Units\\OrcAbilityStrings.txt',
    'Units\\NightElfAbilityFunc.txt',
    'Units\\NightElfAbilityStrings.txt',
    'Units\\UndeadAbilityFunc.txt',
    'Units\\UndeadAbilityStrings.txt',
    'Units\\NeutralAbilityFunc.txt',
    'Units\\NeutralAbilityStrings.txt',
    'Units\\ItemAbilityFunc.txt',
    'Units\\ItemAbilityStrings.txt',
];

const UPGRADE_PROFILE_PATHS = [
    'Units\\UpgradeSkin.txt',
    'Units\\CampaignUpgradeFunc.txt',
    'Units\\CampaignUpgradeStrings.txt',
    'Units\\HumanUpgradeFunc.txt',
    'Units\\HumanUpgradeStrings.txt',
    'Units\\OrcUpgradeFunc.txt',
    'Units\\OrcUpgradeStrings.txt',
    'Units\\NightElfUpgradeFunc.txt',
    'Units\\NightElfUpgradeStrings.txt',
    'Units\\UndeadUpgradeFunc.txt',
    'Units\\UndeadUpgradeStrings.txt',
    'Units\\NeutralUpgradeFunc.txt',
    'Units\\NeutralUpgradeStrings.txt',
];

const ITEM_PROFILE_PATHS = ['Units\\ItemSkin.txt', 'Units\\ItemFunc.txt', 'Units\\ItemStrings.txt'];
const DESTRUCTABLE_PROFILE_PATHS = ['Units\\DestructableSkin.txt'];
const DOODAD_PROFILE_PATHS = ['Doodads\\DoodadSkins.txt'];

const OBJ_EDITOR_CONFIG: Record<string, { metaPath: string; profilePaths: string[] }> = {
    '.w3u': { metaPath: 'Units\\UnitMetaData.slk', profilePaths: UNIT_PROFILE_PATHS },
    '.w3t': { metaPath: 'Units\\UnitMetaData.slk', profilePaths: ITEM_PROFILE_PATHS },
    '.w3a': { metaPath: 'Units\\AbilityMetaData.slk', profilePaths: ABILITY_PROFILE_PATHS },
    '.w3b': { metaPath: 'Units\\DestructableMetaData.slk', profilePaths: DESTRUCTABLE_PROFILE_PATHS },
    '.w3d': { metaPath: 'Doodads\\DoodadMetaData.slk', profilePaths: DOODAD_PROFILE_PATHS },
    '.w3h': { metaPath: 'Units\\AbilityBuffMetaData.slk', profilePaths: ABILITY_PROFILE_PATHS },
    '.w3q': { metaPath: 'Units\\UpgradeMetaData.slk', profilePaths: UPGRADE_PROFILE_PATHS },
};

interface PreviewObject {
    key: string;
    group: 'Original' | 'Custom';
    baseId: string;
    newId: string | null;
    displayName: string;
    displaySource?: string;
    nameOverridden: boolean;
    race: string;
    overridesCount: number;
    iconPath?: string;
    modelPath?: string;
}

interface PreviewMod {
    key: string;
    fieldId: string;
    label: string;
    category: string;
    type: string;
    level?: number;
    dataPt?: number;
    baseValue: string;
    overrideValue: string;
    currentValue: string;
    overridden: boolean;
    source?: string;
    missingSource?: boolean;
    // Editing (set only for overrides that live in the opened file).
    editable?: boolean;
    varType?: string;        // 'int' | 'real' | 'unreal' | 'string'
    editValue?: string;      // raw editable text (string fields: resolved wts/inline text)
    missingWts?: boolean;    // TRIGSTR_ reference with no war3map.wts → not editable
}

interface ObjEditorData {
    metadataSource: string;
    worldStrings: Map<string, string>;
    fields: MetaField[];
    fieldsById: Map<string, MetaField>;
    slkTables: Map<string, SlkTable>;
    profile: ProfileTable;
}

interface ObjSummaryData {
    metadataSource: string;
    worldStrings: Map<string, string>;
    profile: ProfileTable;
}

interface MetaField {
    id: string;
    sourceField: string;
    slkName: string;
    slkPath?: string;
    category: string;
    label: string;
    rawLabel: string;
    type: string;
    sort: string;
    repeat: number;
    data: number;
    index?: number; // for fields packed into a comma-list cell (e.g. Buttonpos "x,y": ubpx=0, ubpy=1)
    // Per-object applicability (parity with the World Editor — which fields a given object shows).
    useSpecific?: string[]; // ability codes/aliases this field applies to (empty = common)
    notSpecific?: string[];
    useUnit: boolean;
    useHero: boolean;
    useItem: boolean;
    useBuilding: boolean;
    useCreep: boolean;
}

interface SlkTable {
    rows: Map<string, Record<string, string>>;
}

type ProfileTable = Map<string, Record<string, string>>;

const objEditorDataCache = new Map<string, Promise<ObjEditorData | undefined>>();
const objSummaryDataCache = new Map<string, Promise<ObjSummaryData | undefined>>();
const objProfileCache = new Map<string, Promise<ProfileTable>>();
let worldEditStringsPromise: Promise<Map<string, string>> | undefined;

function getObjModSiblingFileName(fileName: string): string | undefined {
    const lower = fileName.toLowerCase();
    const ext = fileName.slice(fileName.lastIndexOf('.'));
    if (lower === `war3map${ext}`.toLowerCase()) return `war3mapSkin${ext}`;
    if (lower === `war3mapskin${ext}`.toLowerCase()) return `war3map${ext}`;
    return undefined;
}

function mergeObjModFiles(base: ObjModFile, skin: ObjModFile): ObjModFile {
    return {
        version: Math.max(base.version, skin.version),
        ext: base.ext,
        extended: base.extended,
        origObjs: mergeObjModEntries(base.origObjs, skin.origObjs),
        customObjs: mergeObjModEntries(base.customObjs, skin.customObjs),
        error: [base.error, skin.error].filter(Boolean).join('; ') || undefined,
    };
}

function mergeObjModEntries(baseEntries: ObjModEntry[], skinEntries: ObjModEntry[]): ObjModEntry[] {
    const merged = new Map<string, ObjModEntry>();
    for (const entry of baseEntries) {
        merged.set(entryKey(entry), { ...entry, mods: [...entry.mods] });
    }
    for (const entry of skinEntries) {
        const existing = merged.get(entryKey(entry));
        if (!existing) {
            merged.set(entryKey(entry), { ...entry, mods: [...entry.mods] });
            continue;
        }
        existing.mods = mergeMods(existing.mods, entry.mods);
    }
    return [...merged.values()];
}

function mergeMods(baseMods: ObjModMod[], skinMods: ObjModMod[]): ObjModMod[] {
    const mods = new Map<string, ObjModMod>();
    for (const mod of baseMods) mods.set(modKey(mod), mod);
    for (const mod of skinMods) mods.set(modKey(mod), mod);
    return [...mods.values()];
}

function entryKey(entry: ObjModEntry): string {
    return `${entry.baseId}|${entry.newId ?? ''}`;
}

async function buildModel(parsed: ObjModFile, triggerStrings: TriggerStringTable): Promise<{ objects: PreviewObject[]; metadataSource: string }> {
    const summaryData = await loadObjSummaryData(parsed.ext);
    return {
        objects: [
            ...parsed.origObjs.map((entry, index) => buildObject(entry, 'Original', index, triggerStrings, summaryData)),
            ...parsed.customObjs.map((entry, index) => buildObject(entry, 'Custom', index, triggerStrings, summaryData)),
        ],
        metadataSource: summaryData?.metadataSource ?? 'override file only',
    };
}

function buildObject(
    entry: ObjModEntry,
    group: 'Original' | 'Custom',
    index: number,
    triggerStrings: TriggerStringTable,
    summaryData: ObjSummaryData | undefined,
): PreviewObject {
    const resolvedName = resolveObjectNameOverride(entry, triggerStrings);
    const baseName = summaryData ? resolveBaseDisplayName(entry.baseId, summaryData) : undefined;
    const nameOverridden = resolvedName?.value !== undefined && resolvedName.value !== '';

    return {
        key: `${group}:${index}`,
        group,
        baseId: entry.baseId,
        newId: entry.newId,
        displayName: nameOverridden ? String(resolvedName.value) : (baseName || entry.newId || entry.baseId),
        displaySource: resolvedName?.source,
        nameOverridden,
        race: summaryData ? resolveObjectRace(entry, summaryData) : raceFromRawcode(entry.baseId),
        overridesCount: entry.mods.length,
        iconPath: summaryData ? resolveObjectIconPath(entry, summaryData) : undefined,
        modelPath: summaryData ? resolveObjectModelPath(entry, summaryData) : undefined,
    };
}

/** Find a mod by exact (fieldId, level, dataPt) — the editing identity shared by render and the host. */
function locateMod(entry: ObjModEntry | undefined, fieldId: string, level?: number, dataPt?: number): ObjModMod | undefined {
    if (!entry) return undefined;
    const norm = (v: number | undefined) => (v === undefined ? null : v);
    return entry.mods.find((m) =>
        m.fieldId.toLowerCase() === fieldId.toLowerCase() &&
        norm(m.level) === norm(level) &&
        norm(m.dataPt) === norm(dataPt));
}

/**
 * Mark an override row editable. The merged-model mod objects are live references into the
 * underlying war3map.* / war3mapSkin.* files, so any existing override is editable regardless of
 * which sibling it came from (the host writes both files back on save).
 */
function annotateEditable(row: PreviewMod, mod: ObjModMod | undefined, wts: TriggerStringTable): void {
    if (!mod) return; // base-only row → read-only
    row.varType = mod.varType;
    if (mod.varType === 'string') {
        const raw = typeof mod.value === 'string' ? mod.value : String(mod.value);
        const resolved = resolveTriggerString(raw, wts);
        if (resolved.missing) { row.missingWts = true; return; } // TRIGSTR_ with no wts → can't edit safely
        row.editable = true;
        row.editValue = resolved.value === undefined ? '' : String(resolved.value);
    } else {
        row.editable = true;
        row.editValue = String(mod.value);
    }
}

/**
 * Per-object field applicability + level count — parity with the World Editor, which only shows the
 * fields a given object actually uses (abilities filter by useSpecific/code; units by hero/building).
 */
interface ObjectContext {
    applies(field: MetaField): boolean;
    levelsFor(field: MetaField): Array<number | undefined>;
}

function makeObjectContext(entry: ObjModEntry, gameData: ObjEditorData, ext: string): ObjectContext {
    const baseId = entry.baseId;
    if (ext === '.w3a') {
        const row = gameData.slkTables.get(SLK_NAME_TO_PATH.AbilityData)?.rows.get(baseId);
        const code = row?.code || baseId;
        const isHero = row?.hero === '1';
        const isItem = row?.item === '1';
        const levelCount = Math.max(1, Math.min(20, Number(row?.levels) || 1));
        return {
            applies: (f) => abilityFieldApplies(f, baseId, code, isHero, isItem),
            levelsFor: (f) => (f.repeat > 0 ? Array.from({ length: levelCount }, (_, i) => i + 1) : [undefined]),
        };
    }
    if (ext === '.w3u') {
        const isHero = /^[A-Z]/.test(baseId); // hero unit rawcodes start with a capital letter
        return {
            applies: (f) => unitFieldApplies(f, baseId, isHero),
            levelsFor: (f) => (f.repeat > 0 ? getFieldLevels(baseId, f, gameData) : [undefined]),
        };
    }
    return {
        applies: () => true,
        levelsFor: (f) => (f.repeat > 0 ? getFieldLevels(baseId, f, gameData) : [undefined]),
    };
}

function abilityFieldApplies(f: MetaField, baseId: string, code: string, isHero: boolean, isItem: boolean): boolean {
    if (f.useSpecific) return f.useSpecific.includes(baseId) || f.useSpecific.includes(code);
    if (f.notSpecific && (f.notSpecific.includes(baseId) || f.notSpecific.includes(code))) return false;
    if (isHero) return f.useHero;
    if (isItem) return f.useItem;
    return f.useUnit || f.useCreep;
}

function unitFieldApplies(f: MetaField, baseId: string, isHero: boolean): boolean {
    if (f.useSpecific) return f.useSpecific.includes(baseId);
    if (isHero) return f.useHero;
    return f.useUnit || f.useBuilding;
}

function buildFieldRows(entry: ObjModEntry, gameData: ObjEditorData, triggerStrings: TriggerStringTable, extended: boolean, ext: string): PreviewMod[] {
    const overrideMods = new Map<string, ObjModMod[]>();
    for (const mod of entry.mods) {
        const key = modKey(mod);
        const list = overrideMods.get(key) ?? [];
        list.push(mod);
        overrideMods.set(key, list);
    }

    const ctx = makeObjectContext(entry, gameData, ext);
    const rows: PreviewMod[] = [];
    const usedMods = new Set<ObjModMod>();
    for (const field of gameData.fields) {
        const applies = ctx.applies(field);
        const levels = ctx.levelsFor(field);
        for (const level of levels) {
            const key = fieldKey(field.id, level, undefined);
            const override = overrideMods.get(key)?.[0] ?? findOverrideByField(entry.mods, field.id, level);
            if (override) usedMods.add(override);
            const baseValue = resolveBaseFieldValue(entry.baseId, field, gameData, level);
            if (!override && (!applies || baseValue === undefined || baseValue === '')) continue;
            const formattedOverride = override ? formatValue(override, triggerStrings) : undefined;
            const formattedBase = formatRawValue(baseValue, triggerStrings);
            const currentValue = formattedOverride ?? formattedBase;
            // Carry the level/dataPt the mod has (or would have) so the host can locate/create it.
            const rowLevel = override ? override.level : (extended ? (level ?? 0) : level);
            const rowDataPt = override ? override.dataPt : (extended ? field.data : undefined);
            const row: PreviewMod = {
                key,
                fieldId: field.id,
                label: field.label,
                category: field.category || '-',
                type: field.type,
                level: rowLevel,
                dataPt: rowDataPt,
                baseValue: formattedBase.value,
                overrideValue: formattedOverride?.value ?? '',
                currentValue: currentValue.value,
                overridden: Boolean(override),
                source: currentValue.source,
                missingSource: currentValue.missingSource,
            };
            if (override) {
                annotateEditable(row, override, triggerStrings);
            } else {
                // Base value with no override yet → editable; editing adds a new mod.
                row.varType = metaVarType(field.type);
                row.editable = true;
                row.editValue = formattedBase.value;
            }
            rows.push(row);
        }
    }

    for (const mod of entry.mods) {
        if (!usedMods.has(mod)) {
            const row = buildOverrideOnlyMod(mod, triggerStrings, gameData);
            annotateEditable(row, mod, triggerStrings);
            rows.push(row);
        }
    }

    return rows.sort((a, b) => {
        return categorySortRank(a.category) - categorySortRank(b.category) ||
            a.category.localeCompare(b.category) ||
            a.label.localeCompare(b.label) ||
            a.fieldId.localeCompare(b.fieldId);
    });
}

function categorySortRank(category: string): number {
    const order = ['text', 'art', 'stats', 'combat', 'move', 'abil', 'tech', 'data'];
    const index = order.indexOf(category.toLowerCase());
    return index < 0 ? order.length : index;
}

function buildOverrideOnlyMod(mod: ObjModMod, triggerStrings: TriggerStringTable, gameData: ObjEditorData | undefined): PreviewMod {
    const field = gameData?.fieldsById.get(mod.fieldId.toLowerCase());
    const value = formatValue(mod, triggerStrings);
    return {
        key: modKey(mod),
        fieldId: mod.fieldId,
        label: field?.label || FIELD_LABELS[mod.fieldId.toLowerCase()] || '',
        category: field?.category || '-',
        type: mod.varType,
        level: mod.level,
        dataPt: mod.dataPt,
        baseValue: '',
        overrideValue: value.value,
        currentValue: value.value,
        overridden: true,
        source: value.source,
        missingSource: value.missingSource,
    };
}

function resolveObjectNameOverride(
    entry: ObjModEntry,
    triggerStrings: TriggerStringTable,
): { value?: string | number; source?: string; missing?: boolean } | undefined {
    const nameMod = findStringOverride(entry, NAME_FIELDS);
    if (!nameMod || typeof nameMod.value !== 'string') return undefined;
    return resolveTriggerString(nameMod.value, triggerStrings);
}

function resolveObjectIconPath(entry: ObjModEntry, summaryData: ObjSummaryData): string | undefined {
    const override = findStringOverride(entry, ICON_FIELDS);
    if (override && typeof override.value === 'string') {
        const iconPath = normalizeIconPath(override.value);
        if (iconPath) return iconPath;
    }
    return normalizeIconPath(getAnyProfileValue(entry.baseId, [
        'Art',
        'art',
        'ButtonArt',
        'Icon',
        'icon',
        'Buffart',
        'BuffArt',
        'Researchart',
        'ResearchArt',
        'Unart',
        'UnArt',
    ], summaryData));
}

function resolveObjectModelPath(entry: ObjModEntry, summaryData: ObjSummaryData): string | undefined {
    const modelPath = resolveObjectStringField(entry, new Set(['umdl', 'ifil', 'bfil', 'dfil']), [
        'file',
        'File',
        'Model',
        'model',
    ], summaryData);
    return normalizeModelPath(modelPath);
}

function resolveObjectRace(entry: ObjModEntry, summaryData: ObjSummaryData): string {
    return normalizeRace(resolveObjectStringField(entry, new Set(['urac', 'arac']), ['race', 'Race'], summaryData)) ||
        raceFromRawcode(entry.baseId);
}

function resolveObjectStringField(
    entry: ObjModEntry,
    overrideFields: Set<string>,
    baseProfileFields: string[],
    summaryData: ObjSummaryData,
): string | undefined {
    const override = findStringOverride(entry, overrideFields);
    if (override && typeof override.value === 'string') return override.value;
    return getAnyProfileValue(entry.baseId, baseProfileFields, summaryData);
}

function findStringOverride(entry: ObjModEntry, fields: Set<string>): ObjModMod | undefined {
    return entry.mods.find((mod) => fields.has(mod.fieldId.toLowerCase()) && typeof mod.value === 'string');
}

function normalizeRace(value: string | undefined): string {
    const race = (value ?? '').trim().toLowerCase();
    if (!race || race === '-') return '';
    if (race === 'nightelf' || race === 'night elf') return 'nightelf';
    if (race === 'creeps' || race === 'creep' || race === 'critters' || race === 'other') return 'neutral';
    if (['human', 'orc', 'undead', 'naga', 'demon', 'neutral'].includes(race)) return race;
    return race;
}

function raceFromRawcode(rawcode: string): string {
    const first = rawcode.charAt(0);
    if (first === 'h' || first === 'H') return 'human';
    if (first === 'o' || first === 'O') return 'orc';
    if (first === 'e' || first === 'E') return 'nightelf';
    if (first === 'u' || first === 'U') return 'undead';
    if (first === 'n' || first === 'N') return 'neutral';
    const second = rawcode.charAt(1);
    if (second === 'H') return 'human';
    if (second === 'O') return 'orc';
    if (second === 'E') return 'nightelf';
    if (second === 'U') return 'undead';
    if (second === 'N' || second === 'C') return 'neutral';
    return 'other';
}

function normalizeIconPath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const first = stripTxtQuotes(String(value).split(',')[0].trim());
    if (!first || first === '-' || first.startsWith('WESTRING_')) return undefined;
    if (!/\.(blp|dds|tga|png|jpe?g)$/i.test(first)) return undefined;
    return first.replace(/\//g, '\\');
}

function normalizeModelPath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const first = stripTxtQuotes(String(value).split(',')[0].trim());
    if (!first || first === '-' || first.startsWith('WESTRING_')) return undefined;
    const normalized = first.replace(/\//g, '\\');
    if (/\.(mdx|mdl)$/i.test(normalized)) return normalized;
    return `${normalized}.mdl`;
}

function formatValue(mod: ObjModMod, triggerStrings: TriggerStringTable): { value: string; source?: string; missingSource?: boolean } {
    if (typeof mod.value === 'number') {
        if (mod.varType === 'real' || mod.varType === 'unreal') {
            return { value: mod.value.toPrecision(6).replace(/\.?0+$/, '') };
        }
        return { value: String(mod.value) };
    }

    const resolved = resolveTriggerString(mod.value, triggerStrings);
    return {
        value: resolved.value === undefined ? '' : String(resolved.value),
        source: resolved.source,
        missingSource: resolved.missing,
    };
}

function formatRawValue(value: string | undefined, triggerStrings: TriggerStringTable): { value: string; source?: string; missingSource?: boolean } {
    if (value === undefined) return { value: '' };
    const resolved = resolveTriggerString(value, triggerStrings);
    return {
        value: resolved.value === undefined ? '' : String(resolved.value),
        source: resolved.source,
        missingSource: resolved.missing,
    };
}

function modKey(mod: ObjModMod): string {
    return fieldKey(mod.fieldId, mod.level, mod.dataPt);
}

function fieldKey(fieldId: string, level?: number, dataPt?: number): string {
    return `${fieldId.toLowerCase()}|${level ?? ''}|${dataPt ?? ''}`;
}

function findOverrideByField(mods: ObjModMod[], fieldId: string, level?: number): ObjModMod | undefined {
    return mods.find((mod) =>
        mod.fieldId.toLowerCase() === fieldId.toLowerCase() &&
        (level === undefined || mod.level === level));
}

function getFieldLevels(baseId: string, field: MetaField, gameData: ObjEditorData): Array<number | undefined> {
    const baseRow = getBaseSlkRow(baseId, field, gameData);
    const levelCount = Math.max(1, Math.min(10, Number(baseRow?.levels ?? baseRow?.maxlevel ?? baseRow?.levelCount ?? 1) || 1));
    return Array.from({ length: levelCount }, (_, index) => index + 1);
}

function resolveBaseDisplayName(baseId: string, summaryData: ObjSummaryData): string | undefined {
    const value = getAnyProfileValue(baseId, [
        'Name',
        'name',
        'EditorName',
        'Editorname',
        'Bufftip',
        'BuffTip',
        'Tip',
        'tip',
        'comment',
        'comments',
    ], summaryData);
    return value ? resolveWorldEditString(value, summaryData.worldStrings) : undefined;
}

function resolveBaseFieldValue(baseId: string, field: MetaField, gameData: ObjEditorData, level?: number): string | undefined {
    const raw = field.slkName.toLowerCase() === 'profile'
        ? gameData.profile.get(baseId)?.[resolveProfileField(field, level)]
        : getBaseSlkRow(baseId, field, gameData)?.[resolveSlkField(field, level)];
    // Fields packed into one comma-list cell (e.g. Buttonpos "x,y") select their part via index.
    if (raw !== undefined && field.index !== undefined && raw.indexOf(',') !== -1) {
        return (raw.split(',')[field.index] ?? '').trim();
    }
    return raw;
}

function getBaseSlkRow(baseId: string, field: MetaField, gameData: ObjEditorData): Record<string, string> | undefined {
    if (!field.slkPath) return undefined;
    return gameData.slkTables.get(field.slkPath)?.rows.get(baseId);
}

function getAnyProfileValue(baseId: string, fields: string[], summaryData: ObjSummaryData): string | undefined {
    const row = summaryData.profile.get(baseId);
    if (!row) return undefined;
    for (const field of fields) {
        const value = row[field];
        if (value !== undefined && value !== '') return value;
    }
    return undefined;
}

function resolveProfileField(field: MetaField, level?: number): string {
    return appendRepeat(field.sourceField, field.repeat, level, 1);
}

function resolveSlkField(field: MetaField, level?: number): string {
    const base = field.sourceField === 'Data' && field.data > 0
        ? `Data${String.fromCharCode('A'.charCodeAt(0) + field.data - 1)}`
        : field.sourceField;
    return appendRepeat(base, field.repeat, level, field.slkPath?.toLowerCase().includes('doodads\\doodads.slk') ? 2 : 1);
}

function appendRepeat(field: string, repeat: number, level: number | undefined, places: number): string {
    if (repeat <= 0 || level === undefined) return field;
    return `${field}${String(level).padStart(places, '0')}`;
}

function loadObjEditorData(ext: string): Promise<ObjEditorData | undefined> {
    const key = ext.toLowerCase();
    let promise = objEditorDataCache.get(key);
    if (!promise) {
        promise = loadObjEditorDataUncached(key);
        objEditorDataCache.set(key, promise);
    }
    return promise;
}

function loadObjSummaryData(ext: string): Promise<ObjSummaryData | undefined> {
    const key = ext.toLowerCase();
    let promise = objSummaryDataCache.get(key);
    if (!promise) {
        promise = loadObjSummaryDataUncached(key);
        objSummaryDataCache.set(key, promise);
    }
    return promise;
}

async function loadObjSummaryDataUncached(ext: string): Promise<ObjSummaryData | undefined> {
    const config = OBJ_EDITOR_CONFIG[ext];
    if (!config) return undefined;

    const worldStrings = await loadWorldEditStrings();
    const profile = await loadObjProfileData(ext);
    return {
        metadataSource: config.metaPath,
        worldStrings,
        profile,
    };
}

async function loadObjEditorDataUncached(ext: string): Promise<ObjEditorData | undefined> {
    const config = OBJ_EDITOR_CONFIG[ext];
    if (!config) return undefined;

    const metaBuf = await readGameData(config.metaPath);
    if (!metaBuf) return undefined;

    const worldStrings = await loadWorldEditStrings();
    const metaRows = parseSlk(metaBuf.toString('utf8')).rows;
    const fields = Array.from(metaRows.values())
        .filter((row) => isMetaRowRelevant(row, ext))
        .map((row) => makeMetaField(row, worldStrings))
        .filter((field): field is MetaField => Boolean(field));
    const fieldsById = new Map(fields.map((field) => [field.id.toLowerCase(), field]));

    const slkPaths = Array.from(new Set(fields.map((field) => field.slkPath).filter((value): value is string => Boolean(value))));
    const slkTables = new Map<string, SlkTable>();
    await Promise.all(slkPaths.map(async (slkPath) => {
        const buf = await readGameData(slkPath);
        if (buf) slkTables.set(slkPath, parseSlk(buf.toString('utf8')));
    }));

    const profile = await loadObjProfileData(ext);

    return {
        metadataSource: `${config.metaPath}${fields.length ? '' : ' (empty)'}`,
        worldStrings,
        fields,
        fieldsById,
        slkTables,
        profile,
    };
}

function loadObjProfileData(ext: string): Promise<ProfileTable> {
    const key = ext.toLowerCase();
    let promise = objProfileCache.get(key);
    if (!promise) {
        const config = OBJ_EDITOR_CONFIG[key];
        promise = loadProfilePaths(config?.profilePaths ?? []);
        objProfileCache.set(key, promise);
    }
    return promise;
}

async function loadProfilePaths(profilePaths: string[]): Promise<ProfileTable> {
    const profile = new Map<string, Record<string, string>>();
    await Promise.all(profilePaths.map(async (profilePath) => {
        const buf = await readGameData(profilePath);
        if (buf) mergeProfile(profile, parseProfile(buf.toString('utf8')));
    }));
    return profile;
}

function isMetaRowRelevant(row: Record<string, string>, ext: string): boolean {
    if (ext === '.w3t') return row.useItem === '1';
    if (ext === '.w3u') return row.useUnit === '1' || row.useHero === '1' || row.useBuilding === '1';
    return true;
}

function makeMetaField(row: Record<string, string>, worldStrings: Map<string, string>): MetaField | undefined {
    const id = row.ID;
    const sourceField = row.field;
    const slkName = row.slk;
    if (!id || !sourceField || !slkName) return undefined;
    const rawLabel = row.displayName || FIELD_LABELS[id.toLowerCase()] || sourceField;
    const label = resolveWorldEditString(rawLabel, worldStrings) || FIELD_LABELS[id.toLowerCase()] || sourceField;
    return {
        id,
        sourceField,
        slkName,
        slkPath: convertSlkName(slkName),
        category: row.category || '',
        label,
        rawLabel,
        type: row.type || '',
        sort: row.sort || '',
        repeat: Number(row.repeat ?? 0) || 0,
        data: Number(row.data ?? 0) || 0,
        index: row.index !== undefined && row.index !== '' ? Number(row.index) : undefined,
        useSpecific: splitCodes(row.useSpecific),
        notSpecific: splitCodes(row.notSpecific),
        useUnit: row.useUnit === '1',
        useHero: row.useHero === '1',
        useItem: row.useItem === '1',
        useBuilding: row.useBuilding === '1',
        useCreep: row.useCreep === '1',
    };
}

function splitCodes(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const codes = value.split(',').map((s) => s.trim()).filter(Boolean);
    return codes.length ? codes : undefined;
}

async function loadWorldEditStrings(): Promise<Map<string, string>> {
    if (worldEditStringsPromise) return worldEditStringsPromise;
    worldEditStringsPromise = loadWorldEditStringsUncached();
    return worldEditStringsPromise;
}

async function loadWorldEditStringsUncached(): Promise<Map<string, string>> {
    const strings = new Map<string, string>();
    await Promise.all(['UI\\WorldEditStrings.txt', 'UI\\WorldEditGameStrings.txt'].map(async (assetPath) => {
        const buf = await readGameData(assetPath);
        if (buf) {
            for (const [key, value] of parseKeyValues(buf.toString('utf8'))) strings.set(key, value);
        }
    }));
    return strings;
}

function resolveWorldEditString(value: string, strings: Map<string, string>): string | undefined {
    if (!value.startsWith('WESTRING_')) return value;
    const seen = new Set<string>();
    let current = value;
    while (current.startsWith('WESTRING_') && !seen.has(current)) {
        seen.add(current);
        const next = strings.get(current);
        if (!next) break;
        current = next;
    }
    return current;
}

async function readGameData(assetPath: string): Promise<Buffer | null> {
    return findGameAsset(assetPath, (msg) => console.log(`[wurst-obj-editor] ${msg}`));
}

function parseSlk(text: string): SlkTable {
    const headers = new Map<number, string>();
    const rowsByY = new Map<number, Record<string, string>>();
    let currentY = 0;
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('C;')) continue;
        const x = Number(/(?:^|;)X(-?\d+)/.exec(line)?.[1]);
        const yMatch = /(?:^|;)Y(-?\d+)/.exec(line);
        if (yMatch) currentY = Number(yMatch[1]);
        if (!Number.isFinite(x) || currentY <= 0) continue;
        const rawValue = /(?:^|;)K([\s\S]*)$/.exec(line)?.[1];
        if (rawValue === undefined) continue;
        const value = parseSlkValue(rawValue);
        if (currentY === 1) {
            headers.set(x, value);
        } else {
            const header = headers.get(x) ?? String(x);
            const row = rowsByY.get(currentY) ?? {};
            row[header] = value;
            rowsByY.set(currentY, row);
        }
    }

    const rows = new Map<string, Record<string, string>>();
    for (const row of rowsByY.values()) {
        const id = row.ID || row.unitID || row.itemID || row.alias || row.doodID || row.destID || row.upgradeID || row.buffID;
        if (id) rows.set(id, row);
    }
    return { rows };
}

function parseSlkValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
}

function parseProfile(text: string): ProfileTable {
    const profile = new Map<string, Record<string, string>>();
    let current: Record<string, string> | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^\uFEFF/, '').trim();
        if (!line || line.startsWith('//')) continue;
        const section = /^\[([^\]]+)\]$/.exec(line)?.[1];
        if (section) {
            current = profile.get(section) ?? {};
            profile.set(section, current);
            continue;
        }
        const eq = line.indexOf('=');
        if (!current || eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = stripTxtQuotes(line.slice(eq + 1).trim());
        current[key] = value;
    }
    return profile;
}

function parseKeyValues(text: string): Array<[string, string]> {
    const entries: Array<[string, string]> = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('[')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        entries.push([line.slice(0, eq).trim(), stripTxtQuotes(line.slice(eq + 1).trim())]);
    }
    return entries;
}

function mergeProfile(target: ProfileTable, source: ProfileTable): void {
    for (const [section, fields] of source) {
        const merged = { ...(target.get(section) ?? {}) };
        for (const [key, value] of Object.entries(fields)) {
            if (value !== '') merged[key] = value;
        }
        target.set(section, merged);
    }
}

function stripTxtQuotes(value: string): string {
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function convertSlkName(slkName: string): string | undefined {
    return SLK_NAME_TO_PATH[slkName];
}

function buildObjLoadingHtml(fileName: string): string {
    return buildPage({
        csp: "default-src 'none'; style-src 'unsafe-inline';",
        title: escapeHtml(fileName),
        body: `<div class="wv-state"><div class="wv-spinner"></div><div class="wv-loading-text">Loading ${escapeHtml(fileName)}…</div></div>`,
    });
}

async function buildHtml(parsed: ObjModFile, fileName: string, context: ParsedPreviewContext, wtsWarning?: string): Promise<string> {
    const typeLabel = TYPE_LABELS[parsed.ext.slice(1)] ?? parsed.ext.slice(1).toUpperCase();
    const triggerStrings = loadTriggerStringsForUri(context.uri);
    const { objects, metadataSource } = await buildModel(parsed, triggerStrings);
    const safeJson = JSON.stringify(objects)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    const firstKey = objects[0]?.key ?? '';
    const overrides = parsed.origObjs.reduce((sum, entry) => sum + entry.mods.length, 0) +
        parsed.customObjs.reduce((sum, entry) => sum + entry.mods.length, 0);
    const summary = `${objects.length} object${objects.length === 1 ? '' : 's'} - ${overrides} override${overrides === 1 ? '' : 's'}`;
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escapeHtml(parsed.error)}</div>`
        : '';
    const warningBanner = wtsWarning
        ? `<div class="warning">${escapeHtml(wtsWarning)}</div>`
        : '';

    return buildPage({
        csp: `default-src 'none'; img-src ${context.webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';`,
        title: escapeHtml(fileName),
        extraCss: `
.content {
  flex: 1;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.md-header {
  padding: 10px 16px 9px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
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
.editable-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground, #4ec9b0) 55%, transparent);
  border-radius: 2px;
  color: var(--vscode-textLink-foreground, #4ec9b0);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}
.error {
  color: var(--vscode-errorForeground, #f14c4c);
  border-bottom: 1px solid color-mix(in srgb, currentColor 65%, transparent);
  padding: 7px 16px;
  flex-shrink: 0;
}
.warning {
  color: var(--vscode-editorWarning-foreground, #cca700);
  border-bottom: 1px solid color-mix(in srgb, currentColor 50%, transparent);
  padding: 7px 16px;
  font-size: 12px;
  flex-shrink: 0;
}
.value-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
}
.value-editor.single { grid-template-columns: minmax(0, 1fr); }
.edit-raw {
  width: 100%;
  box-sizing: border-box;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--input-border);
  border-radius: 2px;
  padding: 2px 6px;
  font: inherit;
  font-family: var(--mono);
}
/* Single-line inputs match the collapsed cell height exactly, so toggling edit never resizes the row. */
input.edit-raw { height: var(--cell-h, 24px); }
textarea.edit-raw { min-height: 48px; line-height: 1.4; padding: 4px 6px; resize: vertical; }
.edit-raw:focus { outline: 1px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
.tt-preview {
  min-width: 0;
  border: 1px dashed var(--border);
  border-radius: 2px;
  padding: 4px 6px;
  background: #000;
  color: #fff;
  font-family: var(--vscode-font-family, sans-serif);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
}
.tt-preview-label {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.tt-preview.tt-readonly {
  display: inline-block;
  max-width: 100%;
  vertical-align: top;
}
.tt-collapsed {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: var(--cell-h, 24px);
  box-sizing: border-box;
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: #000;
  color: #fff;
  cursor: text;
  font-family: var(--vscode-font-family, sans-serif);
  white-space: pre-wrap;
  word-break: break-word;
}
.tt-collapsed:hover { border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
.tt-collapsed-body { flex: 1; min-width: 0; }
.tt-empty { color: var(--muted); font-style: italic; }
.tt-edit-hint {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
  opacity: 0;
  transition: opacity .1s;
}
.tt-collapsed:hover .tt-edit-hint { opacity: 0.9; }
.tt-collapsed .tt-edit-hint { color: rgba(255, 255, 255, 0.6); } /* visible on the dark tooltip box */
.cell-edit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: var(--cell-h, 24px); /* same height as the single-line editor → no row resize on edit */
  box-sizing: border-box;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: text;
  transition: background .08s, border-color .08s;
}
.cell-edit:hover {
  background: var(--input-bg);
  border-color: color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-textLink-foreground)) 60%, transparent);
}
.cell-edit:hover .tt-edit-hint { opacity: 0.7; }
.cell-edit-val { flex: 1; min-width: 0; font-family: var(--mono); word-break: break-word; white-space: pre-wrap; }
/* Number values are short — don't stretch the input across the whole column. */
.value-editor.single input[type="number"] { max-width: 150px; }
/* Scannable accent for customized (overridden) fields. */
tr.overridden td.field { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-textLink-foreground, #4ec9b0) 70%, transparent); }
.cell-edit .tt-edit-hint { flex-shrink: 0; }
.tt-edit { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.tt-bar { position: relative; display: inline-flex; align-items: center; gap: 4px; }
.tt-color-sq {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--input-border, var(--border));
  border-radius: 3px;
  cursor: pointer;
  background:
    linear-gradient(135deg, #ff0303 0%, #fe8a0e 20%, #fffc01 40%, #20c000 60%, #54a4ff 80%, #e55bb0 100%);
}
.tt-color-sq:hover { border-color: var(--fg); }
.tt-btn-sm {
  height: 20px;
  min-width: 22px;
  padding: 0 5px;
  border: 1px solid var(--input-border, var(--border));
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.tt-btn-sm:hover { background: var(--hover); }
.tt-pop {
  position: absolute;
  top: 24px;
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 7px;
  background: var(--vscode-editorWidget-background, var(--sidebar));
  border: 1px solid var(--vscode-editorWidget-border, var(--border));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
.tt-pop[hidden] { display: none; }
.tt-swatches { display: grid; grid-template-columns: repeat(6, 18px); gap: 4px; }
.tt-sw {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--fg) 35%, transparent);
  border-radius: 3px;
  cursor: pointer;
}
.tt-sw:hover { transform: scale(1.15); border-color: var(--fg); }
.tt-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg);
  cursor: pointer;
}
.tt-color { width: 22px; height: 18px; padding: 0; border: 0; background: none; cursor: pointer; }
.tt-color::-webkit-color-swatch-wrapper { padding: 0; }
.tt-color::-webkit-color-swatch { border: 1px solid var(--border); border-radius: 2px; }
.readonly-trigstr { color: var(--muted); font-style: italic; }
.field-search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.field-search {
  flex: 1;
  min-width: 0;
  max-width: 320px;
  height: 24px;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--input-border);
  border-radius: 2px;
  padding: 2px 7px;
  font: inherit;
}
.field-search:focus { outline: 1px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
.field-match { color: var(--muted); font-size: 11px; white-space: nowrap; }
tr.hidden { display: none; }
.object-editor {
  flex: 1;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: var(--list-w, 260px) 5px minmax(0, 1fr);
  overflow: hidden;
}
.splitter {
  cursor: col-resize;
  background: var(--border);
  opacity: 0.5;
  transition: opacity .12s, background .12s;
}
.splitter:hover,
.splitter.dragging { opacity: 1; background: var(--vscode-textLink-foreground, var(--fg)); }
.object-list {
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--sidebar);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.search-wrap {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.search-input {
  width: 100%;
  height: 26px;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--input-border);
  border-radius: 2px;
  padding: 3px 7px;
  font: inherit;
}
.tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0 8px;
}
.group-heading {
  position: sticky;
  top: 0;
  z-index: 1;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px 3px;
  color: var(--muted);
  background: var(--sidebar);
  border: 0;
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.race-heading {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 22px;
  color: var(--fg);
  background: transparent;
  border: 0;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.group-heading:hover,
.race-heading:hover {
  background: var(--hover);
}
.twisty {
  width: 10px;
  display: inline-block;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
}
.folder-count {
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
  font-weight: 400;
}
.object-row {
  width: 100%;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 7px;
  align-items: center;
  padding: 2px 10px 2px 34px;
  color: var(--fg);
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  text-align: left;
  font: inherit;
  line-height: 1.25;
  cursor: pointer;
}
.object-row:hover { background: var(--hover); }
.object-row.active {
  background: var(--active);
  color: var(--active-fg);
  border-left-color: var(--vscode-textLink-foreground, var(--fg));
}
.object-name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.object-id {
  display: block;
  margin-top: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
}
.object-row.active .object-id,
.object-row.active .mod-count {
  color: var(--active-fg);
  opacity: .75;
}
.object-icon {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--input-bg);
  overflow: hidden;
}
.object-icon img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.icon-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--muted) 28%, transparent);
  border-top-color: var(--muted);
  border-radius: 50%;
  animation: icon-spin .8s linear infinite;
}
.object-icon.missing .icon-spinner {
  display: none;
}
.object-icon.missing::before {
  content: '?';
  color: var(--muted);
  font-size: 11px;
}
.object-icon.model::before {
  content: '3D';
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
}
@keyframes icon-spin {
  to { transform: rotate(360deg); }
}
.object-main {
  min-width: 0;
}
.mod-count {
  color: var(--muted);
  font-size: 11px;
  align-self: center;
}
.details {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.details-head {
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.details-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  overflow-wrap: anywhere;
}
.details-rawcode {
  margin-left: 10px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 400;
}
.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.toggle-chip input { margin: 0; }
.details-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.chip {
  border: 1px solid var(--border);
  background: var(--input-bg);
  border-radius: 2px;
  padding: 2px 6px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  user-select: none;
}
.toggle-chip input {
  margin: 0;
}
.table-wrap {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
}
table {
  border-collapse: collapse;
  width: 100%;
  min-width: 620px;
  font-size: 12px;
  table-layout: fixed; /* stable column widths so expanding an editor never reflows the table */
}
thead th:first-child { width: 34%; }
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--sidebar));
  text-align: left;
  padding: 7px 8px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 6px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  vertical-align: top;
}
tbody tr:hover td { background: color-mix(in srgb, var(--hover) 55%, transparent); }
td.id,
td.num,
td.value {
  font-family: var(--mono);
}
td.label { color: var(--fg); }
td.type { color: var(--muted); font-size: 11px; }
td.num { text-align: right; color: var(--muted); }
td.value { word-break: break-word; white-space: pre-wrap; }
td.field {
  min-width: 180px;
  color: var(--fg);
}
td.override,
tr.overridden td.override,
tr.overridden td.current {
  font-family: var(--mono);
}
tr.overridden td {
  background: color-mix(in srgb, var(--vscode-textLink-foreground, #4ec9b0) 7%, transparent);
}
.override-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground, #4ec9b0) 45%, transparent);
  border-radius: 2px;
  color: var(--vscode-textLink-foreground, #4ec9b0);
  font-size: 10px;
  font-family: var(--vscode-font-family, sans-serif);
  font-weight: 600;
}
.category-row td {
  position: sticky;
  top: 31px;
  z-index: 1;
  padding: 7px 8px 5px;
  background: var(--sidebar);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
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
.empty-state {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
  padding: 24px;
  text-align: center;
}
.details-loading {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--muted);
}
@media (max-width: 720px) {
  .object-editor { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 34%) 0 minmax(0, 1fr); }
  .object-list { border-right: 0; border-bottom: 1px solid var(--border); }
  .splitter { display: none; }
}
`,
        body: `<div class="content">
<div class="md-header">
  <div class="md-title">${escapeHtml(fileName)}</div>
  <div class="md-meta">WC3 ${escapeHtml(typeLabel)} object data - v${parsed.version} - ${escapeHtml(summary)} - ${escapeHtml(metadataSource)}${parsed.extended ? ' - extended (level/dataPt)' : ''}<span class="editable-badge" title="Existing overrides can be edited. Ctrl+S to save.">editable</span></div>
</div>
${errorBanner}
${warningBanner}
<div class="object-editor" id="object-editor">
  <aside class="object-list">
    <div class="search-wrap"><input id="search" class="search-input" placeholder="Search objects or IDs" aria-label="Search objects"></div>
    <div id="tree" class="tree"></div>
  </aside>
  <div class="splitter" id="splitter" title="Drag to resize"></div>
  <main id="details" class="details"></main>
</div>
<script>
const objects = ${safeJson};
let selectedKey = ${JSON.stringify(firstKey)};
let query = '';
let fieldQuery = '';
let showTechnical = false;
const vscodeApi = acquireVsCodeApi();
const pendingIcons = new Set();
const loadedIcons = new Map();
const missingIcons = new Set();
const detailCache = new Map();
const pendingDetails = new Set();
const collapsedGroups = new Set();
const collapsedRaces = new Set();
let iconObserver;

const tree = document.getElementById('tree');
const details = document.getElementById('details');
const search = document.getElementById('search');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function sourcePill(mod) {
  if (!mod.source) return '';
  const cls = mod.missingSource ? 'source-pill missing' : 'source-pill';
  const title = mod.missingSource ? mod.source + ' not found in war3map.wts' : 'Resolved from ' + mod.source;
  return ' <span class="' + cls + '" title="' + esc(title) + '">' + esc(mod.source) + '</span>';
}

// Render WC3 inline color codes (|cAARRGGBB ... |r, nestable; |n newline) to safe HTML.
function renderWc3Colors(text) {
  const s = String(text == null ? '' : text);
  let html = '';
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '|') {
      const next = s[i + 1];
      if (next === 'c' || next === 'C') {
        const hex = s.substr(i + 2, 8);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          html += '<span style="color:#' + hex.substr(2) + '">';
          depth++;
          i += 10;
          continue;
        }
      } else if (next === 'r' || next === 'R') {
        if (depth > 0) { html += '</span>'; depth--; }
        i += 2;
        continue;
      } else if (next === 'n') { html += '<br>'; i += 2; continue; }
      else if (next === '|') { html += '|'; i += 2; continue; }
    }
    html += esc(ch);
    i++;
  }
  while (depth > 0) { html += '</span>'; depth--; }
  return html;
}

// NOTE: this whole script lives in a TS template literal — avoid backslash escapes here, they
// are consumed by TS before reaching the browser (e.g. '\\n' became a raw newline → syntax error).
function hasColorMarkup(v) {
  var s = String(v == null ? '' : v).toLowerCase();
  return s.indexOf('|c') !== -1 || s.indexOf('|n') !== -1 || s.indexOf('|r') !== -1 || s.indexOf(String.fromCharCode(10)) !== -1;
}

// Only genuine display-text fields get the color tools: tooltips/descriptions/tips, or any value
// that already uses WC3 color codes / newlines. Short codes (hotkeys), names, comma rawcode lists
// etc. get a plain input — no color bloat.
function needsColorEditor(mod) {
  if (!mod.editable || mod.varType !== 'string') return false;
  const v = mod.editValue == null ? '' : String(mod.editValue);
  if (hasColorMarkup(v)) return true;
  const label = String(mod.label || '').toLowerCase();
  return label.indexOf('tooltip') !== -1 || label.indexOf('description') !== -1 || label.indexOf('tip') !== -1;
}

// WC3 palette (RRGGBB) for the quick swatches inside the color popup.
var PRESET_COLORS = [
  ['ffcc00', 'Gold'], ['ffffff', 'White'], ['c3c3c3', 'Grey'], ['ff0303', 'Red'],
  ['1ce6b9', 'Teal'], ['54a4ff', 'Blue'], ['20c000', 'Green'], ['fe8a0e', 'Orange'],
  ['e55bb0', 'Pink'], ['959697', 'Dark Grey'], ['0042ff', 'Player Blue'], ['fffc01', 'Yellow'],
];

function swatchesHtml() {
  return PRESET_COLORS.map(c =>
    '<button type="button" class="tt-sw" data-color="' + c[0] + '" style="background:#' + c[0] + '" title="' + esc(c[1]) + ' (#' + c[0] + ')"></button>'
  ).join('');
}

// Compact color bar: one small square that opens a popup (swatches + custom picker), plus |n / |r.
function colorBarHtml(mi) {
  return '<div class="tt-bar" data-mi="' + mi + '">' +
    '<button type="button" class="tt-color-sq" title="Color selected text"></button>' +
    '<button type="button" class="tt-btn-sm" data-act="newline" title="Line break (|n)">|n</button>' +
    '<button type="button" class="tt-btn-sm" data-act="reset" title="End color (|r)">|r</button>' +
    '<div class="tt-pop" hidden>' +
      '<div class="tt-swatches">' + swatchesHtml() + '</div>' +
      '<label class="tt-pick"><input type="color" class="tt-color" value="#ffcc00"><span>Custom…</span></label>' +
    '</div>' +
  '</div>';
}

function colorEditorHtml(mod, mi) {
  const v = mod.editValue == null ? '' : String(mod.editValue);
  return '<div class="value-editor">' +
    '<div class="tt-edit">' + colorBarHtml(mi) +
      '<textarea class="edit-raw" data-mi="' + mi + '" rows="3" spellcheck="false">' + esc(v) + '</textarea>' +
    '</div>' +
    '<div><div class="tt-preview-label">preview' + (mod.source ? ' · ' + esc(mod.source) : '') + '</div>' +
      '<div class="tt-preview" data-preview-for="' + mi + '">' + renderWc3Colors(v) + '</div></div>' +
    '</div>';
}

// Editor shown on click. Color/text fields get textarea + color bar + preview; everything else a plain input.
function editorHtml(mod, mi) {
  if (needsColorEditor(mod)) return colorEditorHtml(mod, mi);
  const v = mod.editValue == null ? '' : String(mod.editValue);
  const numType = mod.varType === 'int' || mod.varType === 'real' || mod.varType === 'unreal';
  // Use a number input only when the value is actually numeric — otherwise a number input renders
  // blank (e.g. a stray comma value). Fall back to text so it stays visible/editable.
  if (numType && (v === '' || isFinite(Number(v)))) {
    return '<div class="value-editor single"><input class="edit-raw" type="number" step="' + (mod.varType === 'int' ? '1' : 'any') + '" data-mi="' + mi + '" value="' + esc(v) + '"></div>';
  }
  return '<div class="value-editor single"><input class="edit-raw" type="text" data-mi="' + mi + '" spellcheck="false" value="' + esc(v) + '"></div>';
}

// Compact, click-to-edit view shown by default for every editable cell (keeps the 700-row table light).
function collapsedView(mod, mi) {
  const dv = mod.editValue == null ? (mod.currentValue == null ? '' : String(mod.currentValue)) : String(mod.editValue);
  if (hasColorMarkup(dv)) {
    return '<div class="tt-collapsed" data-mi="' + mi + '" title="Click to edit">' +
      '<span class="tt-collapsed-body">' + renderWc3Colors(dv) + '</span><span class="tt-edit-hint">✎</span></div>';
  }
  const badge = mod.overridden ? '<span class="override-badge">modified</span>' : '';
  const disp = dv === '' ? '<span class="tt-empty">(empty)</span>' : esc(dv);
  return '<span class="cell-edit" data-mi="' + mi + '" title="Click to edit">' +
    '<span class="cell-edit-val">' + disp + '</span>' + badge + (mod.source ? sourcePill(mod) : '') +
    '<span class="tt-edit-hint">✎</span></span>';
}

function valueCell(mod, mi) {
  if (mod.editable) return collapsedView(mod, mi);
  // Read-only (non-editable, e.g. TRIGSTR with missing wts): still render WC3 color codes when present.
  let extra = (mod.overridden ? '<span class="override-badge">modified</span>' : '') + sourcePill(mod);
  if (mod.missingWts) extra += ' <span class="readonly-trigstr">(externalized – war3map.wts missing)</span>';
  const ro = mod.currentValue == null ? '' : String(mod.currentValue);
  if (hasColorMarkup(ro)) {
    return '<div class="tt-preview tt-readonly">' + renderWc3Colors(ro) + '</div>' + extra;
  }
  return esc(ro) + extra;
}

function postEdit(mod) {
  vscodeApi.postMessage({
    type: 'editField',
    key: selectedKey,
    fieldId: mod.fieldId,
    level: mod.level == null ? null : mod.level,
    dataPt: mod.dataPt == null ? null : mod.dataPt,
    varType: mod.varType,
    value: mod.editValue == null ? '' : String(mod.editValue),
  });
}

// Current selection range for a textarea (kept fresh even after blur, so toolbar/color-picker work).
function taRange(ta) {
  const ss = ta._ss != null ? ta._ss : (ta.selectionStart || 0);
  const se = ta._se != null ? ta._se : (ta.selectionEnd || 0);
  return ss <= se ? [ss, se] : [se, ss];
}

function applyToTextarea(ta, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  ta._ss = selStart; ta._se = selEnd;
  ta.dispatchEvent(new Event('input'));
}

// Wrap the current selection in |cffRRGGBB ... |r (hex = 6 chars, no '#').
function wrapColor(ta, hex) {
  const r = taRange(ta);
  const val = ta.value;
  const open = '|cff' + String(hex).replace('#', '').toLowerCase();
  const selected = val.slice(r[0], r[1]) || 'text';
  ta.value = val.slice(0, r[0]) + open + selected + '|r' + val.slice(r[1]);
  const a = r[0] + open.length;
  applyToTextarea(ta, a, a + selected.length);
}

function insertText(ta, text) {
  const r = taRange(ta);
  const val = ta.value;
  ta.value = val.slice(0, r[0]) + text + val.slice(r[1]);
  const c = r[0] + text.length;
  applyToTextarea(ta, c, c);
}

function categoryLabel(category) {
  const raw = String(category || 'Other');
  const labels = {
    abil: 'Abilities',
    art: 'Art',
    combat: 'Combat',
    data: 'Data',
    move: 'Movement',
    stats: 'Stats',
    tech: 'Techtree',
    text: 'Text',
    '-': 'Other'
  };
  return labels[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

function raceLabel(race) {
  const labels = {
    human: 'Human',
    orc: 'Orc',
    nightelf: 'Night Elf',
    undead: 'Undead',
    neutral: 'Neutral',
    naga: 'Naga',
    demon: 'Demon',
    other: 'Other'
  };
  return labels[String(race || 'other').toLowerCase()] || String(race || 'Other');
}

function raceRank(race) {
  const order = ['human', 'orc', 'nightelf', 'undead', 'neutral', 'naga', 'demon', 'other'];
  const index = order.indexOf(String(race || 'other').toLowerCase());
  return index < 0 ? order.length : index;
}

function idLine(obj) {
  return obj.newId
    ? esc(obj.baseId) + ' -> ' + esc(obj.newId)
    : esc(obj.baseId);
}

function matches(obj) {
  if (!query) return true;
  const haystack = [obj.displayName, obj.baseId, obj.newId, obj.displaySource, obj.group].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function renderTree() {
  const groups = ['Original', 'Custom'];
  let html = '';
  const allowCollapse = !query;
  for (const group of groups) {
    const groupObjects = objects.filter(obj => obj.group === group && matches(obj));
    if (!groupObjects.length) continue;
    const groupClosed = allowCollapse && collapsedGroups.has(group);
    html += '<button class="group-heading" data-group="' + esc(group) + '">' +
      '<span class="twisty">' + (groupClosed ? '>' : 'v') + '</span>' +
      '<span>' + group + ' Objects</span><span class="folder-count">' + groupObjects.length + '</span></button>';
    if (groupClosed) continue;
    const races = Array.from(new Set(groupObjects.map(obj => obj.race || 'other')))
      .sort((a, b) => raceRank(a) - raceRank(b) || raceLabel(a).localeCompare(raceLabel(b)));
    for (const race of races) {
      const raceObjects = groupObjects.filter(obj => (obj.race || 'other') === race);
      const raceKey = group + ':' + race;
      const raceClosed = allowCollapse && collapsedRaces.has(raceKey);
      html += '<button class="race-heading" data-race="' + esc(raceKey) + '">' +
        '<span class="twisty">' + (raceClosed ? '>' : 'v') + '</span>' +
        '<span>' + esc(raceLabel(race)) + '</span><span class="folder-count">' + raceObjects.length + '</span></button>';
      if (raceClosed) continue;
      for (const obj of raceObjects) {
        const active = obj.key === selectedKey ? ' active' : '';
        const source = obj.displaySource ? ' <span class="source-pill">' + esc(obj.displaySource) + '</span>' : '';
        const icon = obj.iconPath
          ? '<span class="object-icon loading" data-key="' + esc(obj.key) + '" data-icon="' + esc(obj.iconPath) + '" title="' + esc(obj.iconPath) + '"><span class="icon-spinner"></span></span>'
          : obj.modelPath
            ? '<span class="object-icon model" title="' + esc(obj.modelPath) + '"></span>'
          : '<span class="object-icon missing" title="No icon field"></span>';
        html += '<button class="object-row' + active + '" data-key="' + esc(obj.key) + '">' +
          icon +
          '<span class="object-main"><span class="object-name">' + esc(obj.displayName) + source + '</span>' +
          '<span class="object-id">' + idLine(obj) + '</span></span>' +
          '</button>';
      }
    }
  }
  tree.innerHTML = html || '<div class="empty-state">No matching objects</div>';
  for (const heading of tree.querySelectorAll('.group-heading')) {
    heading.addEventListener('click', () => {
      const group = heading.getAttribute('data-group') || '';
      if (!group) return;
      if (collapsedGroups.has(group)) collapsedGroups.delete(group);
      else collapsedGroups.add(group);
      renderTree();
    });
  }
  for (const heading of tree.querySelectorAll('.race-heading')) {
    heading.addEventListener('click', () => {
      const race = heading.getAttribute('data-race') || '';
      if (!race) return;
      if (collapsedRaces.has(race)) collapsedRaces.delete(race);
      else collapsedRaces.add(race);
      renderTree();
    });
  }
  for (const row of tree.querySelectorAll('.object-row')) {
    row.addEventListener('click', () => {
      selectedKey = row.getAttribute('data-key') || selectedKey;
      render();
    });
  }
  observeIcons();
}

function observeIcons() {
  if (!iconObserver) {
    iconObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        iconObserver.unobserve(entry.target);
        requestIcon(entry.target);
      }
    }, { root: tree, rootMargin: '80px' });
  }

  for (const el of tree.querySelectorAll('.object-icon[data-icon]')) {
    const key = el.getAttribute('data-key') || '';
    if (loadedIcons.has(key)) {
      setIconLoaded(el, loadedIcons.get(key));
    } else if (missingIcons.has(key)) {
      setIconMissing(el);
    } else {
      iconObserver.observe(el);
    }
  }
}

function requestIcon(el) {
  const key = el.getAttribute('data-key') || '';
  const iconPath = el.getAttribute('data-icon') || '';
  if (!key || !iconPath || pendingIcons.has(key) || loadedIcons.has(key) || missingIcons.has(key)) return;
  pendingIcons.add(key);
  vscodeApi.postMessage({ type: 'loadObjectIcon', key, iconPath });
}

function setIconLoaded(el, uri) {
  el.classList.remove('loading', 'missing');
  el.innerHTML = '<img loading="lazy" src="' + esc(uri) + '" alt="">';
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Decode an icon to a data URL using the browser — same pipeline as the BLP viewer (handles BGR
// jpeg-content BLPs by swapping R/B after decode, plus 4-component jpegs the browser supports).
async function renderIconDataUrl(data) {
  try {
    const w = data.width, h = data.height;
    const full = document.createElement('canvas');
    full.width = w; full.height = h;
    const fctx = full.getContext('2d');
    if (data.mode === 'rgba') {
      const rgba = base64ToBytes(data.rgbaBase64);
      fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
    } else {
      const bmp = await createImageBitmap(new Blob([base64ToBytes(data.jpegBase64)], { type: 'image/jpeg' }));
      fctx.drawImage(bmp, 0, 0, w, h);
      const id = fctx.getImageData(0, 0, w, h);
      const px = id.data;
      for (let i = 0; i < px.length; i += 4) { const r = px[i]; px[i] = px[i + 2]; px[i + 2] = r; }
      fctx.putImageData(id, 0, 0);
    }
    const out = document.createElement('canvas');
    out.width = 48; out.height = 48;
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(full, 0, 0, 48, 48);
    return out.toDataURL('image/png');
  } catch (e) {
    return null;
  }
}

function setIconMissing(el) {
  el.classList.remove('loading');
  el.classList.add('missing');
  el.innerHTML = '';
}

function updateIconElements(key, updater) {
  for (const el of tree.querySelectorAll('.object-icon')) {
    if ((el.getAttribute('data-key') || '') === key) updater(el);
  }
}

window.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'objectIconLoaded') {
    pendingIcons.delete(msg.key);
    renderIconDataUrl(msg).then(url => {
      if (!url) { missingIcons.add(msg.key); updateIconElements(msg.key, setIconMissing); return; }
      loadedIcons.set(msg.key, url);
      updateIconElements(msg.key, el => setIconLoaded(el, url));
    });
  } else if (msg.type === 'objectIconMissing') {
    pendingIcons.delete(msg.key);
    missingIcons.add(msg.key);
    updateIconElements(msg.key, setIconMissing);
  } else if (msg.type === 'objectDetailsLoaded') {
    pendingDetails.delete(msg.key);
    detailCache.set(msg.key, msg.mods || []);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'objectDetailsFailed') {
    pendingDetails.delete(msg.key);
    detailCache.set(msg.key, []);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'invalidateDetails') {
    detailCache.delete(msg.key);
    pendingDetails.delete(msg.key);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'fieldUpdated') {
    const mods = detailCache.get(msg.key);
    if (!mods) return;
    const norm = v => (v == null ? null : v);
    const mod = mods.find(m => m.fieldId && m.fieldId.toLowerCase() === String(msg.fieldId).toLowerCase() &&
      norm(m.level) === norm(msg.level) && norm(m.dataPt) === norm(msg.dataPt));
    if (!mod) return;
    mod.editValue = msg.editValue;
    mod.currentValue = msg.currentValue;
    if (msg.overridden != null) mod.overridden = msg.overridden;
    if (msg.key === selectedKey) {
      const mi = mods.indexOf(mod);
      const anchor = details.querySelector('[data-mi="' + mi + '"]');
      const tr = anchor && anchor.closest('tr');
      if (tr) tr.classList.toggle('overridden', !!mod.overridden);
      updateFieldCell(mods, mod);
    }
  }
});

// Forward undo/redo to the host (so the custom-document edit stack drives them) — except while a
// text field is focused, where the browser's native text undo should win.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('edit-raw')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); vscodeApi.postMessage({ type: 'undo' }); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); vscodeApi.postMessage({ type: 'redo' }); }
});

function requestDetails(obj) {
  if (!obj || detailCache.has(obj.key) || pendingDetails.has(obj.key)) return;
  pendingDetails.add(obj.key);
  vscodeApi.postMessage({ type: 'loadObjectDetails', key: obj.key });
}

function renderDetails() {
  const obj = objects.find(candidate => candidate.key === selectedKey) || objects.find(matches) || objects[0];
  if (!obj) {
    details.innerHTML = '<div class="empty-state">No object modifications</div>';
    return;
  }
  selectedKey = obj.key;
  const headers = showTechnical
    ? ${parsed.extended ? "['Field', 'Label', 'Group', 'Type', 'Level', 'Data', 'Value']" : "['Field', 'Label', 'Group', 'Type', 'Value']"}
    : ['Field', 'Value'];
  const mods = detailCache.get(obj.key);
  if (!mods) requestDetails(obj);
  let lastCategory = '';
  const rows = (mods || []).map((mod, mi) => {
    const category = categoryLabel(mod.category);
    const groupRow = category !== lastCategory
      ? '<tr class="category-row"><td colspan="' + headers.length + '">' + esc(category) + '</td></tr>'
      : '';
    lastCategory = category;
    const fieldCell = showTechnical
      ? '<td class="id">' + esc(mod.fieldId) + '</td><td class="label">' + esc(mod.label || '-') + '</td><td class="type">' + esc(category) + '</td><td class="type">' + esc(mod.type) + '</td>' +
        ${parsed.extended ? "'<td class=\"num\">' + esc(mod.level ?? '') + '</td>' + '<td class=\"num\">' + esc(mod.dataPt ?? '') + '</td>' +" : "'' +"}
        ''
      : '<td class="field">' + esc(mod.label || mod.fieldId) + '</td>';
    const fsearch = esc(((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.currentValue || '') + ' ' + (mod.editValue || '')).toLowerCase());
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '" data-fsearch="' + fsearch + '">' +
      fieldCell +
      '<td class="value current">' + valueCell(mod, mi) + '</td>' +
    '</tr>';
  }).join('');

  const rawcode = obj.newId ? esc(obj.baseId) + ' → ' + esc(obj.newId) : esc(obj.baseId);
  details.innerHTML = '<div class="details-head">' +
    '<div class="details-title">' + esc(obj.displayName) +
      '<span class="details-rawcode">' + rawcode + '</span>' +
      (obj.displaySource ? sourcePill({ source: obj.displaySource }) : '') + '</div>' +
    (mods ? '<div class="field-search-wrap">' +
      '<input id="field-search" class="field-search" type="text" placeholder="Search fields…" spellcheck="false" value="' + esc(fieldQuery) + '">' +
      '<span id="field-match" class="field-match"></span>' +
      '<label class="toggle-chip"><input id="technical-toggle" type="checkbox" ' + (showTechnical ? 'checked' : '') + '> technical</label>' +
    '</div>' : '') +
  '</div>' +
  (mods
    ? '<div class="table-wrap"><table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + headers.length + '" class="empty">no modifications</td></tr>') + '</tbody></table></div>'
    : '<div class="details-loading"><div><div class="wv-spinner"></div><div class="wv-loading-text">Loading fields...</div></div></div>');

  const technicalToggle = document.getElementById('technical-toggle');
  if (technicalToggle) {
    technicalToggle.addEventListener('change', () => {
      showTechnical = technicalToggle.checked;
      renderDetails();
    });
  }

  const fieldSearch = document.getElementById('field-search');
  if (fieldSearch) {
    fieldSearch.addEventListener('input', () => { fieldQuery = fieldSearch.value; filterFields(fieldQuery); });
  }
  filterFields(fieldQuery);

  for (const c of details.querySelectorAll('.tt-collapsed, .cell-edit')) wireCollapsed(c);
}

function wireCollapsed(c) {
  if (!c) return;
  c.addEventListener('click', () => expandEditor(c));
}

function markModified(el, mod) {
  if (!mod.overridden) {
    mod.overridden = true;
    const tr = el.closest('tr');
    if (tr) tr.classList.add('overridden');
  }
}

function wireEditRaw(el) {
  const mi = Number(el.getAttribute('data-mi'));
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!mod) return;
  const startVal = mod.editValue == null ? '' : String(mod.editValue);
  let timer;
  let posted = false;
  const commit = () => { markModified(el, mod); postEdit(mod); posted = true; };
  el.addEventListener('input', () => {
    mod.editValue = el.value;
    mod.currentValue = el.value;
    const preview = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (preview) preview.innerHTML = renderWc3Colors(el.value);
    clearTimeout(timer);
    // Only create/update a mod once the value actually changes (clicking a field to view it shouldn't modify it).
    if (el.value !== startVal || posted) timer = setTimeout(commit, 250);
  });
  el.addEventListener('blur', () => { clearTimeout(timer); if (el.value !== startVal || posted) commit(); });
  // Track selection so the toolbar / color picker act on it even after the textarea blurs.
  const saveSel = () => { el._ss = el.selectionStart; el._se = el.selectionEnd; };
  ['keyup', 'mouseup', 'select', 'blur', 'click'].forEach(ev => el.addEventListener(ev, saveSel));
}

function wireColorBar(bar) {
  const mi = bar.getAttribute('data-mi');
  const ta = details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (!ta) return;
  const pop = bar.querySelector('.tt-pop');
  const sq = bar.querySelector('.tt-color-sq');
  if (sq) {
    sq.addEventListener('mousedown', e => e.preventDefault()); // keep textarea selection
    sq.addEventListener('click', () => { if (pop) pop.hidden = !pop.hidden; });
  }
  if (pop) {
    for (const sw of pop.querySelectorAll('.tt-sw')) {
      sw.addEventListener('mousedown', e => e.preventDefault());
      sw.addEventListener('click', () => { wrapColor(ta, sw.getAttribute('data-color')); pop.hidden = true; });
    }
    const colorInput = pop.querySelector('.tt-color');
    if (colorInput) colorInput.addEventListener('change', () => { wrapColor(ta, colorInput.value); pop.hidden = true; });
  }
  for (const b of bar.querySelectorAll('.tt-btn-sm')) {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      if (act === 'newline') insertText(ta, '|n');
      else if (act === 'reset') insertText(ta, '|r');
    });
  }
}

// Swap a collapsed cell for its editor on demand. The editor collapses back when focus leaves it.
function expandEditor(c) {
  const mi = Number(c.getAttribute('data-mi'));
  const cell = c.parentElement;
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  cell.innerHTML = editorHtml(mod, mi);
  const ta = cell.querySelector('.edit-raw');
  if (ta) {
    wireEditRaw(ta);
    ta.focus();
    if (ta.type !== 'number' && ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);
    // Keyboard: Esc reverts and closes; Enter commits+closes (Ctrl/Cmd+Enter in the textarea).
    const original = mod.editValue == null ? '' : String(mod.editValue);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (ta.value !== original) { ta.value = original; ta.dispatchEvent(new Event('input')); }
        ta.blur();
      } else if (e.key === 'Enter' && (ta.tagName === 'INPUT' || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ta.blur();
      }
    });
  }
  const bar = cell.querySelector('.tt-bar');
  if (bar) wireColorBar(bar);
  // Collapse back to the compact view once focus truly leaves this editor (not when clicking its
  // own color bar / popup / picker, which keep focus inside the cell).
  cell.addEventListener('focusout', () => {
    setTimeout(() => {
      if (cell.isConnected && !cell.contains(document.activeElement)) collapseCell(cell, mi);
    }, 120);
  });
}

function collapseCell(cell, mi) {
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  cell.innerHTML = collapsedView(mod, mi);
  wireCollapsed(cell.querySelector('.tt-collapsed') || cell.querySelector('.cell-edit'));
}

// Update a single field's cell in place (used by undo/redo — avoids rebuilding the whole table).
function updateFieldCell(mods, mod) {
  const mi = mods.indexOf(mod);
  if (mi < 0) return;
  const el = details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (el) {
    el.value = mod.editValue == null ? '' : String(mod.editValue);
    const pv = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (pv) pv.innerHTML = renderWc3Colors(el.value);
    return;
  }
  const col = details.querySelector('.tt-collapsed[data-mi="' + mi + '"], .cell-edit[data-mi="' + mi + '"]');
  if (col && col.parentElement) collapseCell(col.parentElement, mi);
}

// Filter the details table rows by field id / label / value without rebuilding (keeps focus while typing).
function filterFields(q) {
  const query = String(q || '').trim().toLowerCase();
  const table = details.querySelector('table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  let shown = 0;
  rows.forEach(tr => {
    if (tr.classList.contains('category-row')) return;
    const hay = tr.getAttribute('data-fsearch') || '';
    const vis = !query || hay.indexOf(query) !== -1;
    tr.classList.toggle('hidden', !vis);
    if (vis) shown++;
  });
  let cat = null, catHasVisible = false;
  const flush = () => { if (cat) cat.classList.toggle('hidden', !catHasVisible); };
  rows.forEach(tr => {
    if (tr.classList.contains('category-row')) { flush(); cat = tr; catHasVisible = false; }
    else if (!tr.classList.contains('hidden')) catHasVisible = true;
  });
  flush();
  const fm = document.getElementById('field-match');
  if (fm) fm.textContent = query ? (shown + ' match' + (shown === 1 ? '' : 'es')) : '';
}

function render() {
  renderTree();
  renderDetails();
}

search.addEventListener('input', () => {
  query = search.value.trim().toLowerCase();
  const selected = objects.find(obj => obj.key === selectedKey);
  if (selected && !matches(selected)) {
    selectedKey = (objects.find(matches) || objects[0] || {}).key || '';
  }
  render();
});

(function setupSplitter() {
  const editor = document.getElementById('object-editor');
  const splitter = document.getElementById('splitter');
  if (!editor || !splitter) return;
  const saved = vscodeApi.getState() || {};
  if (saved.listW) editor.style.setProperty('--list-w', saved.listW + 'px');
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = editor.getBoundingClientRect();
    const w = Math.max(170, Math.min(rect.width - 260, e.clientX - rect.left));
    editor.style.setProperty('--list-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const cur = parseInt(editor.style.getPropertyValue('--list-w'), 10) || 260;
    vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { listW: cur }));
  });
})();

// Close any open color popup when clicking outside its bar.
document.addEventListener('mousedown', e => {
  for (const pop of details.querySelectorAll('.tt-pop')) {
    if (pop.hidden) continue;
    const bar = pop.closest('.tt-bar');
    if (!bar || !bar.contains(e.target)) pop.hidden = true;
  }
});

render();
</script>
</div>`,
    });
}

async function handleObjModIcon(msg: { key: string; iconPath: string }, webview: vscode.Webview, uri: vscode.Uri): Promise<void> {
    const roots = await getCandidateRoots(uri.fsPath);
    const fsPath = await resolveAssetPath(msg.iconPath, roots) ?? await ensureGameTextureCached(msg.iconPath);
    if (!fsPath) {
        await webview.postMessage({ type: 'objectIconMissing', key: msg.key });
        return;
    }
    try {
        // Send the decoded raster to the webview and let the browser render it — the same central
        // pipeline the BLP viewer uses (it correctly handles BGR jpeg-content BLPs, 4-component, etc.).
        const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
        const bytes = new Uint8Array(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
        const decoded = decodeRasterPreview(bytes, ext);
        await webview.postMessage(decoded.mode === 'jpeg'
            ? { type: 'objectIconLoaded', key: msg.key, mode: 'jpeg', jpegBase64: decoded.jpegBase64, width: decoded.width, height: decoded.height }
            : { type: 'objectIconLoaded', key: msg.key, mode: 'rgba', rgbaBase64: decoded.rgbaBase64, width: decoded.width, height: decoded.height });
    } catch {
        await webview.postMessage({ type: 'objectIconMissing', key: msg.key });
    }
}

async function loadObjectDetails(key: string, webview: vscode.Webview, doc: ObjModDocument): Promise<void> {
    const entry = findEntryByKey(doc.displayFile, key);
    if (!entry) {
        await webview.postMessage({ type: 'objectDetailsFailed', key });
        return;
    }
    const wts = doc.wtsTable;
    const gameData = await loadObjEditorData(doc.displayFile.ext);
    const mods = gameData
        ? buildFieldRows(entry, gameData, wts, doc.displayFile.extended, doc.displayFile.ext)
        : entry.mods.map((mod) => {
            const row = buildOverrideOnlyMod(mod, wts, gameData);
            annotateEditable(row, mod, wts);
            return row;
        });
    await webview.postMessage({ type: 'objectDetailsLoaded', key, mods });
}

function findEntryByKey(parsed: ObjModFile, key: string): ObjModEntry | undefined {
    const [group, rawIndex] = key.split(':');
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return undefined;
    if (group === 'Custom') return parsed.customObjs[index];
    if (group === 'Original') return parsed.origObjs[index];
    return undefined;
}

interface EditFieldMessage {
    type: 'editField';
    key: string;
    fieldId: string;
    level: number | null;
    dataPt: number | null;
    varType: string;
    value: string;
}

interface ModEditUndo {
    apply(): void;
    revert(): void;
    mod: ObjModMod;
}

/**
 * Apply an edit to the merged editable model + in-memory wts; return undo/redo closures.
 * The merged mod object is a live reference into the underlying war3map.* / war3mapSkin.* file,
 * so mutating it here changes the file that will be serialized on save.
 */
/** The underlying war3map.* / war3mapSkin.* entry that owns a merged display object (prefers main). */
function findFileEntryForKey(doc: ObjModDocument, key: string): { entry: ObjModEntry; file: ObjModFile } | undefined {
    const merged = findEntryByKey(doc.displayFile, key);
    if (!merged) return undefined;
    const group = key.split(':')[0];
    const wanted = entryKey(merged);
    const search = (file: ObjModFile | undefined): ObjModEntry | undefined => {
        if (!file) return undefined;
        const list = group === 'Custom' ? file.customObjs : file.origObjs;
        return list.find((e) => entryKey(e) === wanted);
    };
    const mainEntry = search(doc.mainFile);
    if (mainEntry) return { entry: mainEntry, file: doc.mainFile };
    const skinEntry = search(doc.skinFile);
    if (skinEntry && doc.skinFile) return { entry: skinEntry, file: doc.skinFile };
    return undefined;
}

function applyFieldEdit(doc: ObjModDocument, p: EditFieldMessage): ModEditUndo | undefined {
    const entry = findEntryByKey(doc.displayFile, p.key);
    if (!entry) return undefined;

    // Locate the existing mod, or prepare to create one (editing a base field with no override yet).
    let mod = locateMod(entry, p.fieldId, p.level ?? undefined, p.dataPt ?? undefined);
    let fileEntry: ObjModEntry | undefined;
    const created = !mod;
    if (!mod) {
        const target = findFileEntryForKey(doc, p.key);
        if (!target) return undefined;
        fileEntry = target.entry;
        const varType = (['int', 'real', 'unreal', 'string'].includes(p.varType) ? p.varType : 'string') as ObjModVarType;
        mod = { fieldId: p.fieldId, varType, value: '', endToken: '\0\0\0\0' };
        if (doc.displayFile.extended) { mod.level = p.level ?? 0; mod.dataPt = p.dataPt ?? 0; }
    }

    const prevValue = mod.value;
    let nextValue: number | string;
    let wtsId: number | undefined;
    let wtsBefore: string | undefined;
    let wtsAfter: string | undefined;

    if (mod.varType === 'string') {
        const existing = typeof mod.value === 'string' ? /^TRIGSTR_(\d+)$/i.exec(mod.value) : null;
        const bytes = Buffer.byteLength(p.value, 'utf8');
        if (existing) {
            wtsId = Number(existing[1]);
        } else if (bytes > INLINE_STRING_LIMIT_BYTES) {
            wtsId = nextTriggerStringId(doc.wtsTable);
            while (doc.wtsTable.has(wtsId) || doc.wtsEdits.has(wtsId)) wtsId++;
        }
        if (wtsId !== undefined) {
            wtsBefore = doc.wtsTable.get(wtsId);
            wtsAfter = p.value;
            nextValue = `TRIGSTR_${wtsId}`;
        } else {
            nextValue = p.value;
        }
    } else if (mod.varType === 'real' || mod.varType === 'unreal') {
        nextValue = Number(p.value) || 0;
    } else {
        nextValue = Math.trunc(Number(p.value) || 0);
    }

    const id = wtsId;
    const newMod = mod;
    const addMod = (arr: ObjModMod[]) => { if (arr.indexOf(newMod) < 0) arr.push(newMod); };
    const removeMod = (arr: ObjModMod[]) => { const i = arr.indexOf(newMod); if (i >= 0) arr.splice(i, 1); };
    const apply = () => {
        if (created && fileEntry) { addMod(entry.mods); addMod(fileEntry.mods); }
        newMod.value = nextValue;
        if (id !== undefined) { doc.wtsTable.set(id, wtsAfter ?? ''); doc.wtsEdits.set(id, wtsAfter ?? ''); }
    };
    const revert = () => {
        if (created && fileEntry) { removeMod(entry.mods); removeMod(fileEntry.mods); }
        else { newMod.value = prevValue; }
        if (id !== undefined) {
            if (wtsBefore === undefined) { doc.wtsTable.delete(id); doc.wtsEdits.delete(id); }
            else { doc.wtsTable.set(id, wtsBefore); doc.wtsEdits.set(id, wtsBefore); }
        }
    };
    apply();
    return { apply, revert, mod };
}

/** Display value (resolved string / numeric text) of a mod for in-place webview updates. */
function modDisplayValue(mod: ObjModMod, wts: TriggerStringTable): string {
    if (mod.varType === 'string') {
        const resolved = resolveTriggerString(typeof mod.value === 'string' ? mod.value : String(mod.value), wts);
        return resolved.value === undefined ? '' : String(resolved.value);
    }
    return String(mod.value);
}

function computeWtsWarning(model: ObjModFile, wtsExists: boolean): string | undefined {
    if (wtsExists) return undefined;
    const hasTrig = [...model.origObjs, ...model.customObjs].some((entry) =>
        entry.mods.some((mod) => typeof mod.value === 'string' && /^TRIGSTR_\d+$/i.test(mod.value)));
    return hasTrig
        ? 'war3map.wts was not found next to this file — externalized (TRIGSTR_) strings cannot be resolved or edited. Other fields remain editable.'
        : undefined;
}

interface EditableObjMod {
    mainFile: ObjModFile;
    mainUri: vscode.Uri;
    skinFile?: ObjModFile;
    skinUri?: vscode.Uri;
    /** Merged editable model. Its mod objects are live references into mainFile/skinFile. */
    displayFile: ObjModFile;
}

/**
 * Parse the opened objmod plus its war3map/war3mapSkin sibling. The returned `displayFile` is the
 * merge used for both display AND editing — its mods alias the per-file mod objects, so an edit to
 * a merged mod mutates whichever sibling owns it. Both files are written back on save.
 */
async function loadEditableObjMod(uri: vscode.Uri): Promise<EditableObjMod> {
    const ext = fileExtOf(uri);
    const fileName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    const data = Buffer.from(await vscode.workspace.fs.readFile(uri));
    const openedParse = parseObjMod(data, ext);

    const siblingName = getObjModSiblingFileName(fileName);
    if (!siblingName) {
        return { mainFile: openedParse, mainUri: uri, displayFile: openedParse };
    }

    const siblingUri = vscode.Uri.joinPath(uri, '..', siblingName);
    let siblingParse: ObjModFile | undefined;
    try {
        const siblingData = Buffer.from(await vscode.workspace.fs.readFile(siblingUri));
        siblingParse = parseObjMod(siblingData, ext);
    } catch { siblingParse = undefined; }

    const openedIsSkin = fileName.toLowerCase().startsWith('war3mapskin.');
    const mainFile = openedIsSkin ? siblingParse : openedParse;
    const mainUri = openedIsSkin ? siblingUri : uri;
    const skinFile = openedIsSkin ? openedParse : siblingParse;
    const skinUri = openedIsSkin ? uri : siblingUri;

    if (mainFile && skinFile) {
        return { mainFile, mainUri, skinFile, skinUri, displayFile: mergeObjModFiles(mainFile, skinFile) };
    }
    // Only one sibling present → edit just the opened file.
    return { mainFile: openedParse, mainUri: uri, displayFile: openedParse };
}

class ObjModDocument implements vscode.CustomDocument {
    wtsEdits = new Map<number, string>();
    reload: (() => Promise<void>) | undefined;

    constructor(
        readonly uri: vscode.Uri,
        public mainFile: ObjModFile,
        public mainUri: vscode.Uri,
        public skinFile: ObjModFile | undefined,
        public skinUri: vscode.Uri | undefined,
        public displayFile: ObjModFile,
        public wtsTable: TriggerStringTable,
        public wtsUri: vscode.Uri | undefined,
        public wtsExists: boolean,
        public wtsWarning: string | undefined,
    ) {}

    /** The parsed file backing the opened uri (main or skin), used for save-as / backup snapshots. */
    get openedFile(): ObjModFile {
        return this.skinUri && this.uri.toString() === this.skinUri.toString() && this.skinFile
            ? this.skinFile
            : this.mainFile;
    }

    dispose(): void {}
}

function fileExtOf(uri: vscode.Uri): string {
    const name = uri.path;
    return name.slice(name.lastIndexOf('.'));
}

class ObjModEditorProvider implements vscode.CustomEditorProvider<ObjModDocument> {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ObjModDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChange.event;

    async openCustomDocument(uri: vscode.Uri): Promise<ObjModDocument> {
        const e = await loadEditableObjMod(uri);
        const wtsTable = loadTriggerStringsForUri(uri);
        const { uri: wtsUri, exists } = findWtsUri(uri);
        const wtsWarning = computeWtsWarning(e.displayFile, exists);
        return new ObjModDocument(uri, e.mainFile, e.mainUri, e.skinFile, e.skinUri, e.displayFile, wtsTable, wtsUri, exists, wtsWarning);
    }

    async resolveCustomEditor(doc: ObjModDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
        };
        const fileName = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
        const ctx: ParsedPreviewContext = { uri: doc.uri, webview: panel.webview };
        // Show a spinner immediately — buildHtml awaits CASC game-data and can exceed 200ms.
        panel.webview.html = buildObjLoadingHtml(fileName);
        doc.reload = async () => { panel.webview.html = await buildHtml(doc.displayFile, fileName, ctx, doc.wtsWarning); };

        panel.webview.onDidReceiveMessage((message) => { void this.handleMessage(message, panel.webview, doc); });
        await doc.reload();
    }

    private async handleMessage(message: unknown, webview: vscode.Webview, doc: ObjModDocument): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const msg = message as {
            type?: string; key?: string; iconPath?: string;
            fieldId?: string; varType?: string; level?: number | null; dataPt?: number | null; value?: string;
        };
        if (msg.type === 'loadObjectDetails' && msg.key) {
            await loadObjectDetails(msg.key, webview, doc);
            return;
        }
        if (msg.type === 'loadObjectIcon' && msg.key && msg.iconPath) {
            await handleObjModIcon({ key: msg.key, iconPath: msg.iconPath }, webview, doc.uri);
            return;
        }
        if (msg.type === 'undo') { void vscode.commands.executeCommand('undo'); return; }
        if (msg.type === 'redo') { void vscode.commands.executeCommand('redo'); return; }
        if (msg.type === 'editField' && msg.key && msg.fieldId && msg.varType) {
            const edit = applyFieldEdit(doc, {
                type: 'editField',
                key: msg.key,
                fieldId: msg.fieldId,
                level: msg.level ?? null,
                dataPt: msg.dataPt ?? null,
                varType: msg.varType,
                value: msg.value ?? '',
            });
            if (!edit) return;
            const key = msg.key;
            const fieldId = msg.fieldId;
            const level = msg.level ?? null;
            const dataPt = msg.dataPt ?? null;
            // Targeted in-place update on undo/redo — avoids rebuilding the whole (700+ row) table.
            const post = () => {
                const display = modDisplayValue(edit.mod, doc.wtsTable);
                const overridden = !!locateMod(findEntryByKey(doc.displayFile, key), fieldId, level ?? undefined, dataPt ?? undefined);
                void webview.postMessage({ type: 'fieldUpdated', key, fieldId, level, dataPt, editValue: display, currentValue: display, overridden });
            };
            this._onDidChange.fire({
                document: doc,
                label: `Edit ${msg.fieldId}`,
                undo: () => { edit.revert(); post(); },
                redo: () => { edit.apply(); post(); },
            });
        }
    }

    async saveCustomDocument(doc: ObjModDocument): Promise<void> {
        try {
            await writeObjModIfChanged(doc.mainFile, doc.mainUri);
            if (doc.skinFile && doc.skinUri) await writeObjModIfChanged(doc.skinFile, doc.skinUri);
            await this.writeWts(doc, doc.wtsUri, doc.wtsExists);
            if (doc.wtsUri) doc.wtsExists = true;
        } catch (err) {
            // Validation failed — surface it and rethrow so VS Code keeps the document dirty (nothing written).
            void vscode.window.showErrorMessage(`Object data not saved: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }

    async saveCustomDocumentAs(doc: ObjModDocument, targetResource: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.writeFile(targetResource, serializeValidated(doc.openedFile, targetResource.path));
        const { uri: wtsUri, exists } = findWtsUri(targetResource);
        await this.writeWts(doc, wtsUri, exists);
    }

    private async writeWts(doc: ObjModDocument, wtsUri: vscode.Uri | undefined, wtsExists: boolean): Promise<void> {
        if (!doc.wtsEdits.size || !wtsUri) return;
        let original = '';
        if (wtsExists) {
            try { original = Buffer.from(await vscode.workspace.fs.readFile(wtsUri)).toString('utf8'); } catch { /* create fresh */ }
        }
        const text = applyWtsEdits(original, doc.wtsEdits);
        await vscode.workspace.fs.writeFile(wtsUri, Buffer.from(text, 'utf8'));
    }

    async revertCustomDocument(doc: ObjModDocument): Promise<void> {
        const e = await loadEditableObjMod(doc.uri);
        doc.mainFile = e.mainFile;
        doc.mainUri = e.mainUri;
        doc.skinFile = e.skinFile;
        doc.skinUri = e.skinUri;
        doc.displayFile = e.displayFile;
        doc.wtsTable = loadTriggerStringsForUri(doc.uri);
        doc.wtsEdits.clear();
        const { exists } = findWtsUri(doc.uri);
        doc.wtsExists = exists;
        doc.wtsWarning = computeWtsWarning(doc.displayFile, exists);
        if (doc.reload) await doc.reload();
    }

    async backupCustomDocument(doc: ObjModDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, serializeValidated(doc.openedFile, doc.uri.path));
        return { id: context.destination.toString(), delete: () => vscode.workspace.fs.delete(context.destination).then(() => undefined, () => undefined) };
    }
}

function countMods(file: ObjModFile): number {
    return [...file.origObjs, ...file.customObjs].reduce((sum, entry) => sum + entry.mods.length, 0);
}

/**
 * Safety gate: never write an objmod we can't read back. Serializes, re-parses, and verifies the
 * round-trip preserves version, object counts and mod counts. Throws (aborting the save) otherwise,
 * so a bad edit can never corrupt the file on disk.
 */
function serializeValidated(file: ObjModFile, name: string): Buffer {
    const bytes = serializeObjMod(file);
    const reparsed = parseObjMod(bytes, file.ext);
    if (reparsed.error) {
        throw new Error(`Refusing to save ${name}: serialized data did not re-parse (${reparsed.error}).`);
    }
    if (reparsed.origObjs.length !== file.origObjs.length ||
        reparsed.customObjs.length !== file.customObjs.length ||
        countMods(reparsed) !== countMods(file)) {
        throw new Error(`Refusing to save ${name}: round-trip object/mod count mismatch.`);
    }
    return bytes;
}

/** Serialize (validated) and write an objmod file only when its bytes differ from disk. */
async function writeObjModIfChanged(file: ObjModFile, uri: vscode.Uri): Promise<void> {
    const bytes = serializeValidated(file, uri.path.slice(uri.path.lastIndexOf('/') + 1));
    try {
        const existing = Buffer.from(await vscode.workspace.fs.readFile(uri));
        if (existing.equals(bytes)) return;
    } catch { /* file missing → write it */ }
    await vscode.workspace.fs.writeFile(uri, bytes);
}

export function registerObjModPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        'wurst.objModPreview',
        new ObjModEditorProvider(),
        {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        },
    );
}
