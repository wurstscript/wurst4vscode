'use strict';

/** VS Code preview for WC3 Object Modification files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseObjMod, serializeObjMod, ObjModFile, ObjModEntry, ObjModMod, ObjModVarType } from 'casc-ts/formats';
import { ParsedPreviewContext } from './preview/framework';
import { requestPreviewIcon, requestTooltipBackdrop, requestTooltipBorder, getCandidateRoots, resolveAssetPathWithCasc, gatherImportedAssets } from './imageAssetSupport';
import { postModelToWebview, postTexturesToWebview, requestModelThumbnail, cacheModelThumbnail, markModelThumbnailBad } from './preview/modelPreviewHost';
import { isSoundAssetPath } from './soundPreview';
import {
    loadTriggerStringsForUri, resolveTriggerString, TriggerStringTable,
    findWtsUri, nextTriggerStringId, applyWtsEdits,
} from './preview/triggerStrings';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';
import {
    SlkTable, ProfileTable,
    readGameData, parseSlk, loadProfilePaths, stripTxtQuotes,
    loadWorldEditStrings, resolveWorldEditString,
    UNIT_PROFILE_PATHS, ABILITY_PROFILE_PATHS, UPGRADE_PROFILE_PATHS,
    ITEM_PROFILE_PATHS, DESTRUCTABLE_PROFILE_PATHS, DOODAD_PROFILE_PATHS,
} from './preview/wc3Data';
import { getGameAssetCacheDir, listGameAssetPaths } from './preview/cascStorage';
import {
    loadCompilerKnowledgeBase, compilerLowercaseObjectView, compilerProfileView,
    CompilerFieldSchema, CompilerObjectKind, CompilerObjectRecord,
} from './preview/compilerKnowledgeBase';
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

// Object-editor field IDs (one per object type) that hold the display name / button icon override.
const NAME_FIELDS = new Set(['unam', 'inam', 'anam', 'bnam', 'dnam', 'fnam', 'gnam']);
const ICON_FIELDS = new Set(['uico', 'iico', 'aart', 'fart', 'gico']);
const SUMMARY_MODEL_FIELDS = new Set(['umdl', 'amdl', 'ifil', 'bfil', 'dfil']);
// "Categorization - Campaign"/"Categorization - Special" — these decide which Melee|Campaign and
// Units/Buildings/Heroes/Special tree branch a unit falls under (see resolveObjectKind), so an edit
// to either needs to refresh the object summary the same way a name/icon change does.
const CLASSIFICATION_FIELDS = new Set(['ucam', 'uspe']);

// Profile keys holding an object's display name, in priority order. Casing varies across WC3
// profile/skin TXTs; buffs use Bufftip, some doodads use comment — try them all.
const DISPLAY_NAME_FIELDS = ['Name', 'name', 'EditorName', 'Editorname', 'Bufftip', 'BuffTip', 'Tip', 'tip', 'comment', 'comments'];

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
    // World Editor-style unit classification (units file only — see resolveObjectKind): which of the
    // Melee/Campaign x Units/Buildings/Heroes/Special buckets this object's tree row belongs to.
    // Undefined for every other object kind (abilities, items, ...), where that grouping isn't meaningful.
    campaign?: boolean;
    kind?: 'unit' | 'building' | 'hero' | 'special';
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
    displayValue?: string;   // field-aware readable value, e.g. "Human" for "human"
    displayDetail?: string;  // raw value/context shown under displayValue
    displayKind?: 'race' | 'enum' | 'asset' | 'rawcodes';
    assetType?: 'icon' | 'model' | 'sound' | 'pathing';
    assetPath?: string;
    resolvedItems?: ValueOption[];
    editorKind?: 'select' | 'datalist';
    options?: ValueOption[];
}

export interface ValueOption {
    value: string;
    label: string;
    detail?: string;
    iconPath?: string;
    objectKey?: string;
    source?: 'import';
    hash?: string;
}

interface ObjEditorData {
    metadataSource: string;
    worldStrings: Map<string, string>;
    fields: MetaField[];
    fieldsById: Map<string, MetaField>;
    slkTables: Map<string, SlkTable>;
    profile: ProfileTable;
    /** Compiler-owned, already merged SLK/profile/skin records. Present for modern compilers. */
    baseObjects?: Map<string, CompilerObjectRecord>;
    heroBaseIds?: Set<string>;
    buildingBaseIds?: Set<string>;
}

interface ObjSummaryData {
    metadataSource: string;
    worldStrings: Map<string, string>;
    profile: ProfileTable;
    baseObjects?: Map<string, CompilerObjectRecord>;
    heroBaseIds?: Set<string>;
    buildingBaseIds?: Set<string>;
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
    minVal?: string;
    maxVal?: string;
}

const objEditorDataCache = new Map<string, Promise<ObjEditorData | undefined>>();
const objSummaryDataCache = new Map<string, Promise<ObjSummaryData | undefined>>();
const objProfileCache = new Map<string, Promise<ProfileTable>>();
const objCatalogCache = new Map<string, Promise<ObjValueCatalog>>();

/** Live obj-mod editors, keyed by their main file's uri — lets a cross-reference jump (see
 *  locateObjectAcrossSiblings) find an already-open sibling editor and select the target object in
 *  it directly, instead of only being able to affect a freshly-opened one. */
const openObjModDocuments = new Map<string, ObjModDocument>();
/** Object key to select once a given uri's editor finishes loading — set right before
 *  `vscode.openWith` opens (or reveals) that file for a cross-reference jump. */
const pendingObjectSelection = new Map<string, string>();

const CATALOG_EXTS = ['.w3u', '.w3t', '.w3a', '.w3b', '.w3d', '.w3h', '.w3q'];
const RACE_OPTIONS: ValueOption[] = [
    { value: 'human', label: 'Human' },
    { value: 'orc', label: 'Orc' },
    { value: 'undead', label: 'Undead' },
    { value: 'nightelf', label: 'Night Elf' },
    { value: 'neutral', label: 'Neutral' },
    { value: 'naga', label: 'Naga' },
    { value: 'demon', label: 'Demon' },
    { value: 'common', label: 'Common' },
];

const ENUM_OPTIONS: Record<string, ValueOption[]> = {
    bool: [
        { value: '0', label: 'False' },
        { value: '1', label: 'True' },
    ],
    movetype: [
        { value: '', label: 'None' },
        { value: 'foot', label: 'Foot' },
        { value: 'fly', label: 'Fly' },
        { value: 'horse', label: 'Horse' },
        { value: 'hover', label: 'Hover' },
        { value: 'float', label: 'Float' },
        { value: 'amph', label: 'Amphibious' },
    ],
    attacktype: [
        { value: 'normal', label: 'Normal' },
        { value: 'pierce', label: 'Pierce' },
        { value: 'siege', label: 'Siege' },
        { value: 'magic', label: 'Magic' },
        { value: 'chaos', label: 'Chaos' },
        { value: 'hero', label: 'Hero' },
        { value: 'spells', label: 'Spells' },
    ],
    defensetype: [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
        { value: 'fort', label: 'Fortified' },
        { value: 'normal', label: 'Normal' },
        { value: 'hero', label: 'Hero' },
        { value: 'divine', label: 'Divine' },
        { value: 'none', label: 'Unarmored' },
    ],
    defensetypeint: [
        { value: '0', label: 'Small' },
        { value: '1', label: 'Medium' },
        { value: '2', label: 'Large' },
        { value: '3', label: 'Fortified' },
        { value: '4', label: 'Normal' },
        { value: '5', label: 'Hero' },
        { value: '6', label: 'Divine' },
        { value: '7', label: 'Unarmored' },
    ],
    armortype: [
        { value: 'flesh', label: 'Flesh' },
        { value: 'metal', label: 'Metal' },
        { value: 'wood', label: 'Wood' },
        { value: 'ethereal', label: 'Ethereal' },
        { value: 'stone', label: 'Stone' },
    ],
    regentype: [
        { value: 'none', label: 'None' },
        { value: 'always', label: 'Always' },
        { value: 'blight', label: 'Only on Blight' },
        { value: 'day', label: 'Only During Day' },
        { value: 'night', label: 'Only During Night' },
    ],
    teamcolor: [
        { value: '-1', label: 'Default' },
        { value: '0', label: 'Red' },
        { value: '1', label: 'Blue' },
        { value: '2', label: 'Teal' },
        { value: '3', label: 'Purple' },
        { value: '4', label: 'Yellow' },
        { value: '5', label: 'Orange' },
        { value: '6', label: 'Green' },
        { value: '7', label: 'Pink' },
        { value: '8', label: 'Gray' },
        { value: '9', label: 'Light Blue' },
        { value: '10', label: 'Dark Green' },
        { value: '11', label: 'Brown' },
        { value: '12', label: 'Maroon' },
        { value: '13', label: 'Navy' },
        { value: '14', label: 'Turquoise' },
        { value: '15', label: 'Violet' },
        { value: '16', label: 'Wheat' },
        { value: '17', label: 'Peach' },
        { value: '18', label: 'Mint' },
        { value: '19', label: 'Lavender' },
        { value: '20', label: 'Coal' },
        { value: '21', label: 'Snow' },
        { value: '22', label: 'Emerald' },
        { value: '23', label: 'Peanut' },
    ],
    itemclass: [
        { value: 'Permanent', label: 'Permanent' },
        { value: 'Charged', label: 'Charged' },
        { value: 'PowerUp', label: 'Power Up' },
        { value: 'Artifact', label: 'Artifact' },
        { value: 'Purchasable', label: 'Purchasable' },
        { value: 'Campaign', label: 'Campaign' },
        { value: 'Miscellaneous', label: 'Miscellaneous' },
    ],
};

export interface ObjValueCatalog {
    objects: Map<string, ValueOption>;
    icons: ValueOption[];
    models: ValueOption[];
    sounds: ValueOption[];
    pathing: ValueOption[];
}

interface CombinedObjModInfo {
    mainName: string;
    skinName?: string;
}

const MODEL_CATALOG_SLK_SOURCES: Array<{ path: string; modelKeys: string[] }> = [
    { path: 'Doodads\\Doodads.slk', modelKeys: ['file'] },
    { path: 'Units\\DestructableData.slk', modelKeys: ['file'] },
    { path: 'Units\\UnitData.slk', modelKeys: ['file'] },
    { path: 'Units\\ItemData.slk', modelKeys: ['file'] },
];

const MODEL_CATALOG_FALLBACKS: Array<{ path: string; label: string; ownerId: string }> = [
    { path: 'Doodads\\Terrain\\LordaeronTree\\LordaeronTree', label: 'Lordaeron Tree', ownerId: 'FTtw' },
];

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
            ...parsed.origObjs.map((entry, index) => buildObject(entry, 'Original', index, triggerStrings, summaryData, parsed.ext)),
            ...parsed.customObjs.map((entry, index) => buildObject(entry, 'Custom', index, triggerStrings, summaryData, parsed.ext)),
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
    ext: string,
): PreviewObject {
    const resolvedName = resolveObjectNameOverride(entry, triggerStrings);
    const baseName = summaryData ? resolveBaseDisplayName(entry.baseId, summaryData) : undefined;
    const nameOverridden = resolvedName?.value !== undefined && resolvedName.value !== '';
    // The Melee/Campaign x Units/Buildings/Heroes/Special browse grouping (see objectTree.ts on the
    // webview side) only makes sense for units — items/abilities/etc. don't have these Categorization
    // fields at all, so `kind`/`campaign` stay undefined there and the tree falls back to its plain
    // Race grouping.
    const isUnitFile = ext === '.w3u';

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
        campaign: isUnitFile && summaryData ? resolveObjectBoolField(entry, 'ucam', 'campaign', summaryData) : undefined,
        kind: isUnitFile && summaryData ? resolveObjectKind(entry, summaryData) : undefined,
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
        row.editValue = (mod.varType === 'real' || mod.varType === 'unreal') && typeof mod.value === 'number'
            ? formatReal(mod.value)
            : String(mod.value);
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
        const compilerRow = getBaseObjectRecord(baseId, gameData);
        const slkRow = gameData.slkTables.get(SLK_NAME_TO_PATH.AbilityData)?.rows.get(baseId);
        const value = (field: string) => getRecordValue(compilerRow, field) ?? slkRow?.[field];
        const code = value('code') || baseId;
        const isHero = value('hero') === '1';
        const isItem = value('item') === '1';
        const levelCount = Math.max(1, Math.min(20, Number(value('levels')) || 1));
        return {
            applies: (f) => abilityFieldApplies(f, baseId, code, isHero, isItem),
            levelsFor: (f) => (f.repeat > 0 ? Array.from({ length: levelCount }, (_, i) => i + 1) : [undefined]),
        };
    }
    if (ext === '.w3u') {
        const isHero = gameData.heroBaseIds?.has(baseId) ?? /^[A-Z]/.test(baseId);
        const isBuilding = gameData.buildingBaseIds?.has(baseId);
        return {
            applies: (f) => unitFieldApplies(f, baseId, isHero, isBuilding),
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

function unitFieldApplies(f: MetaField, baseId: string, isHero: boolean, isBuilding: boolean | undefined): boolean {
    if (f.useSpecific) return f.useSpecific.includes(baseId);
    if (isHero) return f.useHero;
    if (isBuilding === undefined) return f.useUnit || f.useBuilding;
    if (isBuilding) return f.useBuilding;
    return f.useUnit;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
function buildFieldRows(entry: ObjModEntry, gameData: ObjEditorData, triggerStrings: TriggerStringTable, extended: boolean, ext: string, catalog: ObjValueCatalog): PreviewMod[] {
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
            const dataPt = extended ? field.data : undefined;
            const key = fieldKey(field.id, level, dataPt);
            const override = overrideMods.get(key)?.[0] ?? findOverrideByField(entry.mods, field.id, level, dataPt);
            if (override) usedMods.add(override);
            const baseValue = resolveBaseFieldValue(entry.baseId, field, gameData, level);
            if (!override && !applies) continue;
            const formattedOverride = override ? formatValue(override, triggerStrings) : undefined;
            const formattedBase = formatRawValue(baseValue, triggerStrings);
            const currentValue = formattedOverride ?? formattedBase;
            // Carry the level/dataPt the mod has (or would have) so the host can locate/create it.
            let rowLevel: number | undefined;
            if (override) rowLevel = override.level;
            else if (extended) rowLevel = level ?? 0;
            else rowLevel = level;
            const rowDataPt = override ? override.dataPt : dataPt;
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
            enhancePreviewRow(row, field, catalog);
            rows.push(row);
        }
    }

    for (const mod of entry.mods) {
        if (!usedMods.has(mod)) {
            const row = buildOverrideOnlyMod(mod, triggerStrings, gameData);
            annotateEditable(row, mod, triggerStrings);
            const field = gameData.fieldsById.get(mod.fieldId.toLowerCase());
            if (field) enhancePreviewRow(row, field, catalog);
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

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
function enhancePreviewRow(row: PreviewMod, field: MetaField, catalog: ObjValueCatalog): void {
    const raw = row.currentValue == null ? '' : String(row.currentValue).trim();
    if (isRaceField(field)) {
        const race = normalizeRace(raw);
        const option = RACE_OPTIONS.find((candidate) => candidate.value === race);
        if (option) {
            row.displayKind = 'race';
            row.displayValue = option.label;
            row.displayDetail = raw;
        }
        row.editorKind = 'select';
        row.options = RACE_OPTIONS;
        return;
    }

    const assetType = fieldAssetType(field);
    if (assetType) {
        const assetPath = normalizeAssetValue(raw, assetType);
        if (assetPath) {
            row.displayKind = 'asset';
            row.assetType = assetType;
            row.assetPath = assetPath;
            row.displayValue = assetLabel(assetPath, assetType);
            row.displayDetail = assetPath;
        }
        row.editorKind = 'datalist';
        if (assetType === 'icon') row.options = catalog.icons;
        else if (assetType === 'model') row.options = catalog.models;
        else if (assetType === 'sound') row.options = catalog.sounds;
        else row.options = catalog.pathing;
        return;
    }

    const enumOptions = enumOptionsForField(field, raw);
    if (enumOptions) {
        const option = enumOptions.find((candidate) => candidate.value.toLowerCase() === raw.toLowerCase());
        if (option) {
            row.displayKind = 'enum';
            row.displayValue = option.label;
            row.displayDetail = raw;
        }
        row.editorKind = 'select';
        row.options = enumOptions;
        if (enumOptions.some((candidate) => candidate.value !== '' && !isFinite(Number(candidate.value)))) {
            row.varType = 'string';
        }
        return;
    }

    const items = resolveRawcodeList(raw, catalog);
    if (items?.length) {
        row.displayKind = 'rawcodes';
        row.resolvedItems = items;
        row.displayValue = items.map((item) => item.label).join(', ');
        row.displayDetail = raw;
    }
}

function enumOptionsForField(field: MetaField, raw: string): ValueOption[] | undefined {
    if (raw.includes(',')) return undefined;
    const type = field.type.toLowerCase();
    const id = field.id.toLowerCase();
    const source = field.sourceField.toLowerCase();
    const label = field.label.toLowerCase();
    if (ENUM_OPTIONS[type]) return normalizeEnumOptionsForRaw(ENUM_OPTIONS[type], raw);
    if (type === 'int' && (id.endsWith('tcol') || source.includes('teamcolor') || label.includes('team color'))) {
        return ENUM_OPTIONS.teamcolor;
    }
    if (source === 'movetp' || label === 'movement type' || label === 'movement - type') {
        return ENUM_OPTIONS.movetype;
    }
    return undefined;
}

function normalizeEnumOptionsForRaw(options: ValueOption[], raw: string): ValueOption[] {
    if (raw === '' || options.some((option) => option.value === raw)) return options;
    if (!isFinite(Number(raw))) return options;
    const allNumeric = options.every((option) => option.value === '' || isFinite(Number(option.value)));
    if (allNumeric) return options;
    return options.map((option, index) => ({ ...option, value: String(index) }));
}

function isRaceField(field: MetaField): boolean {
    const id = field.id.toLowerCase();
    const source = field.sourceField.toLowerCase();
    const label = field.label.toLowerCase();
    const type = field.type.toLowerCase();
    return id === 'urac' || id === 'arac' || source === 'race' || type === 'race' || label === 'race';
}

function fieldAssetType(field: MetaField): 'icon' | 'model' | 'sound' | 'pathing' | undefined {
    const id = field.id.toLowerCase();
    const source = field.sourceField.toLowerCase();
    const label = field.label.toLowerCase();
    const type = field.type.toLowerCase();
    const hay = `${id} ${source} ${label} ${type}`;
    if (hay.includes('pathing map') || hay.includes('pathing texture') || source.includes('pathtex') || type.includes('pathing')) {
        return 'pathing';
    }
    if (ICON_FIELDS.has(id) || type.includes('icon') || label.includes('icon') || label.includes('button')) {
        return 'icon';
    }
    if (/\.(mp3|wav|ogg|flac)$/i.test(label) || type.includes('sound') || type.includes('music') ||
        label.includes('sound') || label.includes('music') || source.includes('sound') || source.includes('music')) {
        return 'sound';
    }
    if (['umdl', 'amdl', 'ifil', 'bfil', 'dfil'].includes(id) || type.includes('model') || label.includes('model') ||
        (field.category.toLowerCase() === 'art' && (source === 'file' || source === 'model'))) {
        return 'model';
    }
    return undefined;
}

/** First comma-segment of a profile/objmod value, unquoted; undefined for blanks, '-', or WESTRING_ refs. */
function firstAssetPath(value: string | undefined): string | undefined {
    const first = stripTxtQuotes(String(value ?? '').split(',')[0].trim());
    return (!first || first === '-' || first.startsWith('WESTRING_')) ? undefined : first;
}

function normalizeAssetValue(value: string, assetType: 'icon' | 'model' | 'sound' | 'pathing'): string | undefined {
    if (assetType === 'icon') return normalizeIconPath(value);
    if (assetType === 'model') return normalizeModelPath(value);
    if (assetType === 'sound') {
        const first = firstAssetPath(value);
        if (!first || !/\.(mp3|wav|ogg|flac)$/i.test(first)) return undefined;
        return first.replace(/\//g, '\\');
    }
    const first = firstAssetPath(value);
    if (!first || !/\.(tga|blp|dds)$/i.test(first)) return undefined;
    return first.replace(/\//g, '\\');
}

function assetLabel(assetPath: string, assetType: string): string {
    const file = assetPath.split('\\').pop() || assetPath;
    const clean = file.replace(/\.(blp|dds|tga|png|jpe?g|mdx|mdl|mp3|wav|ogg|flac)$/i, '');
    if (assetType === 'icon') return clean.replace(/^(btn|disbtn|pasbtn|att|upg)/i, '');
    return clean;
}

function resolveRawcodeList(value: string, catalog: ObjValueCatalog): ValueOption[] | undefined {
    if (!value || value.includes('\\') || /\.(blp|dds|tga|mdx|mdl)$/i.test(value)) return undefined;
    const parts = value.split(',').map((part) => stripTxtQuotes(part.trim())).filter(Boolean);
    if (!parts.length || parts.length > 16) return undefined;
    if (!parts.every((part) => /^\w{4}$/.test(part))) return undefined;
    const resolved = parts.map((part) => catalog.objects.get(part.toLowerCase()) ?? { value: part, label: part });
    return resolved.some((item, index) => item.label !== parts[index] || item.objectKey) ? resolved : undefined;
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
    return getAnyProfileIconPath(entry.baseId, summaryData) ?? normalizeIconPath(getAnyProfileValue(entry.baseId, [
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

/**
 * True/false for a bool-typed field (stored as int 0/1) — an override wins over the base profile
 * value. Overrides are keyed by the short field *id* (e.g. "ucam", as used in war3map.w3u), while the
 * base profile row is keyed by the schema's longer field *name* (e.g. "campaign") — these are two
 * different strings for the same field, both needed here.
 */
function resolveObjectBoolField(entry: ObjModEntry, overrideFieldId: string, profileFieldName: string, summaryData: ObjSummaryData): boolean {
    const override = findOverrideByField(entry.mods, overrideFieldId);
    if (override) return String(override.value) === '1';
    return getAnyProfileValue(entry.baseId, [profileFieldName], summaryData) === '1';
}

/** World Editor-style Units/Buildings/Heroes/Special classification for a unit-file object (see the
 *  "ucam"/"campaign" and "uspe"/"special" Categorization fields, and the compiler's hero/building id
 *  sets) — mirrors makeObjectContext's isHero/isBuilding fallback heuristics so tree grouping and field
 *  applicability never disagree about what an object is. */
function resolveObjectKind(entry: ObjModEntry, summaryData: ObjSummaryData): 'unit' | 'building' | 'hero' | 'special' {
    if (resolveObjectBoolField(entry, 'uspe', 'special', summaryData)) return 'special';
    const isHero = summaryData.heroBaseIds?.has(entry.baseId) ?? /^[A-Z]/.test(entry.baseId);
    if (isHero) return 'hero';
    if (summaryData.buildingBaseIds?.has(entry.baseId)) return 'building';
    return 'unit';
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
    const first = firstAssetPath(value);
    if (!first) return undefined;
    const normalized = first.replace(/\//g, '\\');
    if (/\.(blp|dds|tga|png|jpe?g)$/i.test(normalized)) return normalized;
    // eslint-disable-next-line sonarjs/super-linear-regex -- single negated char-class quantifier anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
    return /[\\/]/.test(normalized) && !/\.[^\\/]+$/.test(normalized) ? `${normalized}.blp` : undefined;
}

function normalizeModelPath(value: string | undefined): string | undefined {
    const first = firstAssetPath(value);
    if (!first) return undefined;
    const normalized = first.replace(/\//g, '\\');
    return /\.(mdx|mdl)$/i.test(normalized) ? normalized : `${normalized}.mdl`;
}

/**
 * Render a real (float) without its float32→float64 round-trip noise. WC3 reals are stored as
 * 32-bit floats; read into JS doubles they show spurious tails like 0.30000001192092896.
 * Rounding to 7 significant digits recovers the intended value (e.g. "0.3", "1.8") losslessly
 * for float32, and the parseFloat trims trailing zeros.
 */
function formatReal(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    return String(parseFloat(value.toPrecision(7)));
}

function formatValue(mod: ObjModMod, triggerStrings: TriggerStringTable): { value: string; source?: string; missingSource?: boolean } {
    if (typeof mod.value === 'number') {
        if (mod.varType === 'real' || mod.varType === 'unreal') {
            return { value: formatReal(mod.value) };
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

function findOverrideByField(mods: ObjModMod[], fieldId: string, level?: number, dataPt?: number): ObjModMod | undefined {
    const norm = (v: number | undefined) => (v === undefined ? null : v);
    const exact = mods.find((mod) =>
        mod.fieldId.toLowerCase() === fieldId.toLowerCase() &&
        norm(mod.level) === norm(level) &&
        norm(mod.dataPt) === norm(dataPt));
    if (exact) return exact;
    if (dataPt !== undefined) {
        const legacy = mods.find((mod) =>
            mod.fieldId.toLowerCase() === fieldId.toLowerCase() &&
            norm(mod.level) === norm(level) &&
            mod.dataPt === undefined);
        if (legacy) return legacy;
    }
    return mods.find((mod) =>
        mod.fieldId.toLowerCase() === fieldId.toLowerCase() &&
        (level === undefined || mod.level === level));
}

function getFieldLevels(baseId: string, field: MetaField, gameData: ObjEditorData): Array<number | undefined> {
    const baseRow = getBaseSlkRow(baseId, field, gameData);
    const levelCount = Math.max(1, Math.min(10, Number(baseRow?.levels ?? baseRow?.maxlevel ?? baseRow?.levelCount ?? 1) || 1));
    return Array.from({ length: levelCount }, (_, index) => index + 1);
}

function resolveBaseDisplayName(baseId: string, summaryData: Pick<ObjSummaryData, 'worldStrings' | 'profile'>): string | undefined {
    const value = getAnyProfileValue(baseId, DISPLAY_NAME_FIELDS, summaryData);
    return value ? resolveWorldEditString(value, summaryData.worldStrings) : undefined;
}

function resolveBaseFieldValue(baseId: string, field: MetaField, gameData: ObjEditorData, level?: number): string | undefined {
    const compilerRecord = getBaseObjectRecord(baseId, gameData);
    const isProfileField = field.slkName.toLowerCase() === 'profile';
    let raw: string | undefined;
    if (compilerRecord) {
        raw = firstDefinedRecord(compilerRecord, isProfileField ? resolveProfileFields(field, level) : [resolveSlkField(field, level)]);
    } else if (isProfileField) {
        raw = firstDefined(gameData.profile.get(baseId), resolveProfileFields(field, level));
    } else {
        raw = getBaseSlkRow(baseId, field, gameData)?.[resolveSlkField(field, level)];
    }
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

function getAnyProfileValue(baseId: string, fields: string[], summaryData: Pick<ObjSummaryData, 'profile'>): string | undefined {
    const row = getProfileRow(baseId, summaryData);
    if (!row) return undefined;
    for (const field of fields) {
        const value = row[field];
        if (value !== undefined && value !== '') return value;
    }
    return undefined;
}

function getBaseObjectRecord(baseId: string, gameData: ObjEditorData): CompilerObjectRecord | undefined {
    return gameData.baseObjects?.get(baseId.toLowerCase());
}

function getRecordValue(record: CompilerObjectRecord | undefined, field: string): string | undefined {
    if (!record) return undefined;
    const exact = record[field];
    if (exact !== undefined) return String(exact);
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === field.toLowerCase());
    return key === undefined ? undefined : String(record[key]);
}

function firstDefinedRecord(record: CompilerObjectRecord, fields: string[]): string | undefined {
    for (const field of fields) {
        const value = getRecordValue(record, field);
        if (value !== undefined) return value;
    }
    return undefined;
}

function getProfileRow(baseId: string, summaryData: Pick<ObjSummaryData, 'profile'>): Record<string, string> | undefined {
    return summaryData.profile.get(baseId) ??
        summaryData.profile.get(baseId.toLowerCase()) ??
        [...summaryData.profile.entries()].find(([id]) => id.toLowerCase() === baseId.toLowerCase())?.[1];
}

function getAnyProfileIconPath(baseId: string, summaryData: Pick<ObjSummaryData, 'profile'>): string | undefined {
    const row = getProfileRow(baseId, summaryData);
    if (!row) return undefined;
    for (const [key, value] of Object.entries(row)) {
        if (!/(art|icon|button|research)/i.test(key)) continue;
        const icon = normalizeIconPath(value);
        if (icon) return icon;
    }
    return undefined;
}

function firstDefined(row: Record<string, string> | undefined, fields: string[]): string | undefined {
    if (!row) return undefined;
    for (const field of fields) {
        const value = row[field];
        if (value !== undefined) return value;
    }
    return undefined;
}

function resolveProfileFields(field: MetaField, level?: number): string[] {
    const fields = [appendRepeat(field.sourceField, field.repeat, level, 1)];
    if (field.repeat > 0 && !fields.includes(field.sourceField)) fields.push(field.sourceField);
    return fields;
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

    const compilerData = await loadCompilerObjData(ext);
    if (compilerData) {
        return {
            metadataSource: compilerData.metadataSource,
            worldStrings: compilerData.worldStrings,
            profile: compilerData.profile,
            baseObjects: compilerData.baseObjects,
            heroBaseIds: compilerData.heroBaseIds,
            buildingBaseIds: compilerData.buildingBaseIds,
        };
    }

    const worldStrings = await loadWorldEditStrings();
    const profile = await loadObjProfileData(ext);
    // An empty profile table here means every CASC read for it came back null — i.e. no WC3 install
    // was found at all (not just this one file missing). Naming the file we *tried* without this
    // check made the header claim a metadata source that in fact contributed nothing.
    const gameDataMissing = profile.size === 0;
    return {
        metadataSource: gameDataMissing ? `${config.metaPath} (not found)` : config.metaPath,
        worldStrings,
        profile,
    };
}

async function loadObjEditorDataUncached(ext: string): Promise<ObjEditorData | undefined> {
    const config = OBJ_EDITOR_CONFIG[ext];
    if (!config) return undefined;

    const compilerData = await loadCompilerObjData(ext);
    if (compilerData) return compilerData;

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

export function loadObjValueCatalog(): Promise<ObjValueCatalog> {
    const key = 'all';
    let promise = objCatalogCache.get(key);
    if (!promise) {
        promise = loadObjValueCatalogUncached();
        objCatalogCache.set(key, promise);
    }
    return promise;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
async function loadObjValueCatalogUncached(): Promise<ObjValueCatalog> {
    const worldStrings = await loadWorldEditStrings();
    const kb = await loadCompilerKnowledgeBase();
    const compilerProfiles: ProfileTable[] = kb
        ? Object.values(kb.objects).map(compilerProfileView)
        : [];
    // Doodads are not part of the current compiler knowledge-base contract yet.
    const profiles = compilerProfiles.length
        ? [...compilerProfiles, await loadObjProfileData('.w3d')]
        : await Promise.all(CATALOG_EXTS.map((ext) => loadObjProfileData(ext)));
    const objects = new Map<string, ValueOption>();
    const iconMap = new Map<string, ValueOption>();
    const modelMap = new Map<string, ValueOption>();
    const soundMap = new Map<string, ValueOption>();
    const pathingMap = new Map<string, ValueOption>();

    for (const profile of profiles) {
        for (const [id, row] of profile) {
            const label = resolveProfileDisplayName(row, worldStrings) || id;
            const objectOption = { value: id, label, detail: id };
            if (!objects.has(id.toLowerCase())) objects.set(id.toLowerCase(), objectOption);

            // Models are rendered by the MDX/MDL thumbnail pipeline; do not substitute button art.
            for (const [key, value] of Object.entries(row)) {
                const icon = normalizeProfileIconPath(key, value);
                if (icon) addAssetOption(iconMap, icon, label, id);
                const model = normalizeProfileModelPath(key, value);
                if (model) addAssetOption(modelMap, model, label, id);
                const sound = normalizeProfileSoundPath(key, value);
                if (sound) addAssetOption(soundMap, sound, label, id);
                const pathing = normalizeProfilePathingPath(key, value);
                if (pathing) addAssetOption(pathingMap, pathing, label, id);
            }
        }
    }
    await addSlkModelAssets(modelMap, objects, worldStrings);
    addModelFallbacks(modelMap);
    await addCascSoundAssets(soundMap);

    addPathingFallbacks(pathingMap);
    return {
        objects,
        icons: sortOptions([...iconMap.values()]).slice(0, 700),
        models: sortOptions([...modelMap.values()]),
        sounds: sortOptions([...soundMap.values()]),
        pathing: sortOptions([...pathingMap.values()]).slice(0, 300),
    };
}

function compilerObjectKind(ext: string): Exclude<CompilerObjectKind, 'hero' | 'building'> | undefined {
    return ({
        '.w3u': 'unit', '.w3t': 'item', '.w3a': 'ability', '.w3b': 'destructable',
        '.w3h': 'buff', '.w3q': 'upgrade',
    } as Record<string, Exclude<CompilerObjectKind, 'hero' | 'building'>>)[ext];
}

async function loadCompilerObjData(ext: string): Promise<ObjEditorData | undefined> {
    const kind = compilerObjectKind(ext);
    if (!kind) return undefined;
    const kb = await loadCompilerKnowledgeBase();
    if (!kb) return undefined;

    const schemas = kind === 'unit'
        ? dedupeCompilerSchemas([
            ...(kb.fieldSchemas.unit ?? []), ...(kb.fieldSchemas.hero ?? []), ...(kb.fieldSchemas.building ?? []),
        ])
        : kb.fieldSchemas[kind];
    const records = kb.objects[kind];
    if (!Array.isArray(schemas) || !records || schemas.length === 0) return undefined;

    const worldStrings = await loadWorldEditStrings();
    const fields = schemas.map((schema) => makeCompilerMetaField(schema, worldStrings));
    const fieldsById = new Map(fields.map((field) => [field.id.toLowerCase(), field]));
    const baseObjects = compilerLowercaseObjectView(records);
    const profile = compilerProfileView(records);
    return {
        metadataSource: 'Wurst compiler game-data knowledge base',
        worldStrings,
        fields,
        fieldsById,
        slkTables: new Map(),
        profile,
        baseObjects,
        heroBaseIds: new Set(kb.heroBaseIds ?? []),
        buildingBaseIds: new Set(kb.buildingBaseIds ?? []),
    };
}

function dedupeCompilerSchemas(schemas: CompilerFieldSchema[]): CompilerFieldSchema[] {
    const result = new Map<string, CompilerFieldSchema>();
    for (const schema of schemas) {
        const key = `${schema.id.toLowerCase()}|${schema.data}|${schema.index ?? ''}`;
        if (!result.has(key)) result.set(key, schema);
    }
    return [...result.values()];
}

function makeCompilerMetaField(schema: CompilerFieldSchema, worldStrings: Map<string, string>): MetaField {
    // The knowledge base's displayName is sometimes itself a WESTRING_ reference (e.g. "Abilities ->
    // Skin Normal"/"Skin Hero" report as WESTRING_UEVAL_UABS/UHAS) rather than plain English — resolve
    // it the same way object names are resolved, or the field's row label is just that raw token.
    const displayName = schema.displayName ? resolveWorldEditString(schema.displayName, worldStrings) : undefined;
    return {
        id: schema.id,
        sourceField: schema.field,
        slkName: schema.slk,
        slkPath: SLK_NAME_TO_PATH[schema.slk],
        category: schema.category || 'other',
        label: displayName || FIELD_LABELS[schema.id.toLowerCase()] || schema.id,
        rawLabel: displayName || schema.id,
        type: schema.type || 'string',
        sort: schema.sort || schema.id,
        repeat: schema.repeat || 0,
        data: schema.data || 0,
        index: schema.index ?? undefined,
        useUnit: schema.useUnit,
        useHero: schema.useHero,
        useItem: schema.useItem,
        useBuilding: schema.useBuilding,
        useCreep: schema.useCreep,
        useSpecific: schema.useSpecific?.length ? schema.useSpecific : undefined,
        notSpecific: schema.notSpecific?.length ? schema.notSpecific : undefined,
        minVal: schema.minVal ?? undefined,
        maxVal: schema.maxVal ?? undefined,
    };
}

function addModelFallbacks(modelMap: Map<string, ValueOption>): void {
    for (const fallback of MODEL_CATALOG_FALLBACKS) {
        const model = normalizeModelPath(fallback.path);
        if (model) addAssetOption(modelMap, model, fallback.label, fallback.ownerId);
    }
}

async function addSlkModelAssets(modelMap: Map<string, ValueOption>, objects: Map<string, ValueOption>, worldStrings: Map<string, string>): Promise<void> {
    await Promise.all(MODEL_CATALOG_SLK_SOURCES.map(async (source) => {
        const buf = await readGameData(source.path);
        if (!buf) return;
        const table = parseSlk(buf.toString('utf8'));
        for (const [id, row] of table.rows) {
            const object = objects.get(id.toLowerCase());
            const label = object?.label || resolveProfileDisplayName(row, worldStrings) || id;
            for (const key of source.modelKeys) {
                const model = normalizeProfileModelPath(key, row[key]);
                if (model) addAssetOption(modelMap, model, label, id);
            }
        }
    }));
}

function catalogWithDocumentObjects(
    baseCatalog: ObjValueCatalog,
    parsed: ObjModFile,
    triggerStrings: TriggerStringTable,
    summaryData: Pick<ObjSummaryData, 'worldStrings' | 'profile'>,
): ObjValueCatalog {
    const objects = new Map(baseCatalog.objects);
    const addEntry = (entry: ObjModEntry, group: 'Original' | 'Custom', index: number) => {
        const key = `${group}:${index}`;
        const id = entry.newId || entry.baseId;
        const nameOverride = resolveObjectNameOverride(entry, triggerStrings);
        const baseName = resolveBaseDisplayName(entry.baseId, summaryData);
        const label = nameOverride?.value ? String(nameOverride.value) : (baseName || id);
        objects.set(id.toLowerCase(), {
            value: id,
            label,
            detail: entry.newId ? `${entry.baseId} -> ${entry.newId}` : entry.baseId,
            objectKey: key,
        });
    };
    parsed.origObjs.forEach((entry, index) => addEntry(entry, 'Original', index));
    parsed.customObjs.forEach((entry, index) => addEntry(entry, 'Custom', index));
    return { ...baseCatalog, objects };
}

/**
 * Fills in friendly names for rawcodes that reference custom objects defined in a *different*
 * war3map.<ext> file than the one currently open (e.g. a unit's Abilities list pointing at a custom
 * ability in war3map.w3a while viewing war3map.w3u) — otherwise resolveRawcodeList has no name for
 * them (the base game catalog only knows stock ids) and the field falls back to showing raw codes.
 * These entries never get an `objectKey`: jumping to them goes through the openObjectReference
 * command (see locateObjectAcrossSiblings) rather than the local same-document jump.
 */
async function catalogWithSiblingObjects(
    catalog: ObjValueCatalog,
    mainUri: vscode.Uri,
    currentExt: string,
    triggerStrings: TriggerStringTable,
): Promise<ObjValueCatalog> {
    const dir = vscode.Uri.joinPath(mainUri, '..');
    const objects = new Map(catalog.objects);
    for (const ext of CATALOG_EXTS) {
        if (ext === currentExt) continue;
        const uri = vscode.Uri.joinPath(dir, `war3map${ext}`);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            continue;
        }
        let e: EditableObjMod;
        try {
            e = await loadEditableObjMod(uri);
        } catch {
            continue;
        }
        const summaryData = await loadObjSummaryData(ext);
        if (!summaryData) continue;
        const addEntry = (entry: ObjModEntry) => {
            const id = entry.newId || entry.baseId;
            // A local entry (from catalogWithDocumentObjects) already has a jump-capable objectKey —
            // don't clobber it with a same-named cross-file entry that lacks one.
            if (objects.get(id.toLowerCase())?.objectKey) return;
            const nameOverride = resolveObjectNameOverride(entry, triggerStrings);
            const baseName = resolveBaseDisplayName(entry.baseId, summaryData);
            const label = nameOverride?.value ? String(nameOverride.value) : (baseName || id);
            objects.set(id.toLowerCase(), {
                value: id,
                label,
                detail: entry.newId ? `${entry.baseId} -> ${entry.newId}` : entry.baseId,
            });
        };
        e.displayFile.customObjs.forEach(addEntry);
        e.displayFile.origObjs.filter((entry) => entry.mods.length > 0).forEach(addEntry);
    }
    return { ...catalog, objects };
}

function resolveProfileDisplayName(row: Record<string, string>, worldStrings: Map<string, string>): string | undefined {
    const value = DISPLAY_NAME_FIELDS.map((key) => row[key]).find((candidate) => candidate !== undefined && candidate !== '');
    return value ? resolveWorldEditString(value, worldStrings) : undefined;
}

/** Collapse options whose file basename (sans extension/folder) is identical — e.g. SD/HD/.blp/.dds
 *  variants of the same icon. Keeps the first occurrence (imports are prepended, so they win). */
function dedupeByHashOrBasename(options: ValueOption[]): ValueOption[] {
    const seen = new Set<string>();
    const out: ValueOption[] = [];
    for (const opt of options) {
        const base = (opt.value.split(/[\\/]/).pop() ?? opt.value).replace(/\.[^.]+$/, '').toLowerCase();
        const source = opt.source === 'import' ? 'import' : 'wc3';
        const key = opt.hash ? `${source}:hash:${opt.hash}` : `${source}:base:${base}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(opt);
    }
    return out;
}

function addAssetOption(target: Map<string, ValueOption>, assetPath: string, label: string, ownerId: string): void {
    const normalized = assetPath.replace(/\//g, '\\');
    const key = normalized.toLowerCase();
    if (target.has(key)) return;
    target.set(key, {
        value: normalized,
        label: `${assetLabel(normalized, 'asset')} - ${label}`,
        detail: `${ownerId} - ${normalized}`,
        // Image-like assets are their own thumbnail. Model thumbnails are rendered separately.
        iconPath: normalizeIconPath(normalized),
    });
}

function normalizeProfileIconPath(key: string, value: string): string | undefined {
    const lowerKey = key.toLowerCase();
    if (!/(art|icon|button|research)/.test(lowerKey)) return undefined;
    return normalizeIconPath(value);
}

function normalizeProfileModelPath(key: string, value: string): string | undefined {
    if (!/(file|model)/.test(key.toLowerCase())) return undefined;
    const first = firstAssetPath(value);
    if (!first || (!/[\\/]/.test(first) && !/\.(mdx|mdl)$/i.test(first))) return undefined;
    // A texture/sound/image in a file-keyed field is not a model — don't fabricate "x.blp.mdl".
    if (/\.(blp|dds|tga|png|jpe?g|wav|mp3|ogg|flac|txt|slk|fdf|toc)$/i.test(first)) return undefined;
    return normalizeModelPath(first);
}

function normalizeProfilePathingPath(key: string, value: string): string | undefined {
    if (!key.toLowerCase().includes('path')) return undefined;
    return normalizeAssetValue(value, 'pathing');
}

function normalizeProfileSoundPath(key: string, value: string): string | undefined {
    const lowerKey = key.toLowerCase();
    if (!/(sound|music|audio)/.test(lowerKey) && !/\.(mp3|wav|ogg|flac)$/i.test(value)) return undefined;
    return normalizeAssetValue(value, 'sound');
}

async function addCascSoundAssets(target: Map<string, ValueOption>): Promise<void> {
    const paths = await listGameAssetPaths((assetPath) =>
        /^(sound|music)[\\/]/i.test(assetPath) && /\.(mp3|wav|ogg|flac)$/i.test(assetPath),
        (msg) => console.log(`[wurst-sound-catalog] ${msg}`),
    );
    for (const assetPath of paths) {
        addSoundAssetOption(target, assetPath.replace(/\//g, '\\'), 'WC3 sound', 'casc');
        if (/\.flac$/i.test(assetPath)) {
            addSoundAssetOption(target, assetPath.replace(/\.flac$/i, '.mp3').replace(/\//g, '\\'), 'WC3 sound alias', 'casc');
        }
    }
}

function addSoundAssetOption(target: Map<string, ValueOption>, assetPath: string, label: string, ownerId: string): void {
    const normalized = assetPath.replace(/\//g, '\\');
    const key = normalized.toLowerCase();
    if (target.has(key)) return;
    target.set(key, {
        value: normalized,
        label: `${assetLabel(normalized, 'sound')} - ${label}`,
        detail: `${ownerId} - ${normalized}`,
    });
}

function addPathingFallbacks(target: Map<string, ValueOption>): void {
    [
        'PathTextures\\2x2Default.tga',
        'PathTextures\\2x2SimpleSolid.tga',
        'PathTextures\\4x4Default.tga',
        'PathTextures\\4x4SimpleSolid.tga',
        'PathTextures\\6x6Default.tga',
        'PathTextures\\8x8Default.tga',
        'PathTextures\\LargeBuilding.tga',
        'PathTextures\\GatePath.tga',
    ].forEach((assetPath) => addAssetOption(target, assetPath, 'Common pathing map', 'melee'));
}

function sortOptions(options: ValueOption[]): ValueOption[] {
    return options.sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
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

async function buildHtml(parsed: ObjModFile, fileName: string, context: ParsedPreviewContext, wtsWarning?: string, mdxViewerUri?: string, objModEditorUri?: string, combined?: CombinedObjModInfo): Promise<string> {
    const typeLabel = TYPE_LABELS[parsed.ext.slice(1)] ?? parsed.ext.slice(1).toUpperCase();
    const triggerStrings = loadTriggerStringsForUri(context.uri);
    const { objects, metadataSource } = await buildModel(parsed, triggerStrings);
    // A cross-reference jump (see locateObjectAcrossSiblings) stashes the object to land on here before
    // opening/revealing this file — consumed once so a later plain reopen falls back to the first object.
    // `isPendingJump` tells the webview this really is a deliberate navigation (state.ts uses it to
    // override a restored last-session selection, which should otherwise win over the plain fallback).
    const pendingKey = pendingObjectSelection.get(context.uri.toString());
    if (pendingKey) pendingObjectSelection.delete(context.uri.toString());
    const initialJson = JSON.stringify({
        objects,
        selectedKey: pendingKey ?? objects[0]?.key ?? '',
        isPendingJump: !!pendingKey,
        extended: parsed.extended,
        fileInfo: combined ?? { mainName: fileName },
    })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    const overrides = parsed.origObjs.reduce((sum, entry) => sum + entry.mods.length, 0) +
        parsed.customObjs.reduce((sum, entry) => sum + entry.mods.length, 0);
    const summary = `${objects.length} object${objects.length === 1 ? '' : 's'} - ${overrides} override${overrides === 1 ? '' : 's'}`;
    const combinedMeta = combined?.skinName
        ? ` - combined ${escapeHtml(combined.mainName)} + ${escapeHtml(combined.skinName)}`
        : '';
    const errorBanner = parsed.error
        ? `<div class="error">Parse error: ${escapeHtml(parsed.error)}</div>`
        : '';
    const warningBanner = wtsWarning
        ? `<div class="warning">${escapeHtml(wtsWarning)}</div>`
        : '';
    // metadataSource is tagged "(not found)" by loadObjSummaryDataUncached when the profile/wts
    // lookups behind it came back completely empty — i.e. no WC3 install was found at all, not just
    // this one file. Surface that plainly instead of leaving raw field ids as the only clue.
    const registrySuffix = process.platform === 'win32' ? ' and the Windows registry' : '';
    const gameDataBanner = metadataSource.endsWith('(not found)')
        ? `<div class="warning">Warcraft III game data not found — showing raw field ids only (no icons, categories, or friendly labels). Checked the default install locations${registrySuffix}; if Warcraft III is installed somewhere unusual, set the "wurst.wc3path" setting to its folder and reopen this file. Run "Wurst: Show WC3 Data Log" from the Command Palette to see exactly what was checked.</div>`
        : '';

    return buildPage({
        csp: `default-src 'none'; img-src ${context.webview.cspSource} data:; connect-src ${context.webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${context.webview.cspSource};`,
        title: escapeHtml(fileName),
        extraCss: `
:root {
  /* Single accent used for the editable badge, override markers and selection — was repeated as
     'var(--vscode-textLink-foreground, #4ec9b0)' in half a dozen places. */
  --accent: var(--vscode-textLink-foreground, #4ec9b0);
  /* WC3 tooltips render light-coloured text (white/gold) on a dark in-game backdrop, so the colour
     preview is intentionally dark in every theme — using --input-bg would hide light text in light themes. */
  --wc3-tip-bg: #000;
  --wc3-tip-fg: #fff;
  /* Approximate in-game unit-tooltip width, so text wraps roughly where it would in Warcraft III
     itself instead of stretching to fill whatever the details column happens to be. This is a best
     effort figure (the game's actual wrap width also shifts a little with the player's UI console
     scale) rather than a verified exact pixel match. */
  --wc3-tip-width: 280px;
  /* Rendered size of each gold corner/edge border tile (see the .tt-collapsed-box, .tt-preview rule) —
     the box's own padding is set to clear this, so the frame sits flush at the edge instead of cutting
     across the text. */
  --wc3-tip-border-size: 9px;
  --model-bg: color-mix(in srgb, var(--bg) 72%, var(--fg) 28%);
  /* Sticky category rows sit directly under the sticky table header (th: 5+5px padding + 1px border). */
  --table-header-h: 27px;
  /* Row height for the field table's collapsed/edit cells — kept as a variable (rather than repeating
     the number everywhere) so the whole table's density can be tuned in one place. */
  --cell-h: 21px;
}
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
  padding: 8px 16px 7px;
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
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-radius: 2px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  cursor: pointer;
  transition: color .13s, border-color .13s, background-color .13s;
}
.editable-badge:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.editable-badge:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.editable-badge.dirty {
  border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 60%, transparent);
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.editable-badge.dirty:hover { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent); }
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
/* The in-game tooltip's fill texture + gold corner/edge tiles (see requestTooltipBackdrop/
   requestTooltipBorder in imageAssetSupport.ts and applyTooltipBackdrop/applyTooltipBorder in
   messageHandler.ts), layered as 9 separate background-images: the 4 corners + 4 edges on top
   (each only set once their tile has actually loaded — var(..., none) otherwise), the tiled fill
   texture underneath, and --wc3-tip-bg as the plain-color fallback beneath everything. Shared between
   .tt-collapsed-box and .tt-preview since both are "the tooltip box", just editable vs. read-only —
   .tt-collapsed itself is just a plain row wrapper so the source-pill/edit-hint can sit beside the box
   instead of inside it (see the comment on .tt-collapsed below). */
.tt-collapsed-box,
.tt-preview {
  background-color: var(--wc3-tip-bg);
  background-image:
    var(--wc3-tip-corner-tl, none), var(--wc3-tip-corner-tr, none),
    var(--wc3-tip-corner-bl, none), var(--wc3-tip-corner-br, none),
    var(--wc3-tip-edge-left, none), var(--wc3-tip-edge-right, none),
    var(--wc3-tip-edge-top, none), var(--wc3-tip-edge-bottom, none),
    var(--wc3-tip-bg-image, none);
  background-position:
    top left, top right, bottom left, bottom right,
    left var(--wc3-tip-border-size), right var(--wc3-tip-border-size),
    var(--wc3-tip-border-size) top, var(--wc3-tip-border-size) bottom,
    0 0;
  /* Edges are no-repeat, not repeat-y/repeat-x — see the background-size comment below for why. */
  background-repeat:
    no-repeat, no-repeat, no-repeat, no-repeat,
    no-repeat, no-repeat, no-repeat, no-repeat,
    repeat;
  /* Each border tile is a 16x16px source, but drawn at --wc3-tip-border-size (smaller) so it reads as a
     thin frame instead of a chunky inset block — at full 16px, two opposing corners alone (16+16=32px)
     were taller than a short single-line tooltip box, so they overlapped into a solid gold rectangle
     instead of a border. The box's own padding (below) is sized to clear this same value, so the frame
     sits at the true edge instead of cutting across the text.
     The 4 edges are sized to exactly the strip *between* the two corners on their side (100% minus both
     corners), rather than tiled the full box length — tiling from the same origin as the corners meant
     the corner's rounded/receding art didn't fully cover the straight edge tile underneath it, so the
     edge's straight line poked out past the curve at each corner like a little flag. Since none of
     these tiles vary along their own length (edgeLeft/edgeRight are solid at every row, edgeTop/
     edgeBottom at every column), stretching one copy to fill that exact strip looks identical to tiling
     it, but can no longer overlap the corners at all. */
  background-size:
    var(--wc3-tip-border-size) var(--wc3-tip-border-size), var(--wc3-tip-border-size) var(--wc3-tip-border-size),
    var(--wc3-tip-border-size) var(--wc3-tip-border-size), var(--wc3-tip-border-size) var(--wc3-tip-border-size),
    var(--wc3-tip-border-size) calc(100% - 2 * var(--wc3-tip-border-size)),
    var(--wc3-tip-border-size) calc(100% - 2 * var(--wc3-tip-border-size)),
    calc(100% - 2 * var(--wc3-tip-border-size)) var(--wc3-tip-border-size),
    calc(100% - 2 * var(--wc3-tip-border-size)) var(--wc3-tip-border-size),
    auto;
}
.tt-preview {
  min-width: 0;
  max-width: var(--wc3-tip-width);
  min-height: calc(var(--wc3-tip-border-size) * 2 + 1em);
  border: 1px dashed var(--border);
  border-radius: 2px;
  padding: calc(var(--wc3-tip-border-size) + 2px) calc(var(--wc3-tip-border-size) + 3px);
  color: var(--wc3-tip-fg);
  font-family: var(--vscode-font-family, sans-serif);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
}
.tt-raw-toggle,
.tt-copy-raw {
  margin-left: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--input-bg);
  color: var(--fg);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.tt-raw-toggle.active,
.tt-raw-toggle:hover,
.tt-copy-raw:hover { background: var(--hover); }
/* In-place raw-text view: same box the rich editor occupies (.tt-collapsed-body), just swapped for a
   plain textarea showing the literal WC3 string (color codes, |n line breaks) — so toggling Raw never
   resizes the floating toolbar or shifts anything else on the page. */
.tt-collapsed-raw {
  flex: 1 1 100%; /* same full-row basis as .tt-collapsed-body, for the same reason (see its comment) */
  min-width: 0;
  background: transparent;
  color: inherit;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  padding: 0;
  margin: 0;
  font: inherit;
  font-family: var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
}
/* An explicit display on the base rule above would beat the UA [hidden] default regardless of the
   hidden DOM attribute (author styles win over UA styles even at equal specificity) — this is what
   made both the rich box and the raw textarea show at once after toggling. This rule keeps [hidden]
   authoritative. */
.tt-collapsed-raw[hidden] { display: none; }
.tt-preview.tt-readonly {
  display: inline-block;
  max-width: min(100%, var(--wc3-tip-width));
  vertical-align: top;
}
/* .tt-collapsed is just a plain row now — like the Hotkey/Name rows, the source-pill (e.g.
   "TRIGSTR_2431") and edit-hint pencil sit beside the tooltip box, not inside it. They used to be
   children of the dark box itself, where they either ate into its (now width-capped, see
   --wc3-tip-width) space or, once wrapped onto their own line, still looked like part of the in-game
   tooltip rather than an editor annotation. .tt-collapsed-box carries all the actual box styling
   (background/texture/border/font) so the outer row can stay a plain, unstyled flex container. */
.tt-collapsed {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  min-height: var(--cell-h, 24px);
  cursor: text;
}
.tt-collapsed-box {
  min-width: 0;
  max-width: var(--wc3-tip-width);
  /* At least 2x the border tile size, so top+bottom (or left+right) corner tiles never overlap into a
     solid block on a short single-line tooltip — see the --wc3-tip-border-size comment above. */
  min-height: calc(var(--wc3-tip-border-size) * 2 + 1em);
  box-sizing: border-box;
  /* Padding clears the border tiles so text never sits under the frame art (this was the "inset
     overlapping" bug: at the old 1px/6px padding, both text and border occupied the same pixels). */
  padding: calc(var(--wc3-tip-border-size) + 2px) calc(var(--wc3-tip-border-size) + 3px);
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--wc3-tip-fg);
  cursor: text;
  font-family: var(--vscode-font-family, sans-serif);
  white-space: pre-wrap;
  word-break: break-word;
}
.tt-collapsed:hover .tt-collapsed-box,
.tt-collapsed:focus-visible .tt-collapsed-box { border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
.tt-collapsed:focus-visible { outline: none; }
.tt-collapsed-body { min-width: 0; }
.tt-collapsed-body[contenteditable="true"] { outline: none; cursor: text; }
.tt-empty { color: var(--muted); font-style: italic; }
.tt-edit-hint {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
  opacity: 0.35; /* faintly visible at rest so cells read as editable; brightens on hover/focus */
  transition: opacity .1s;
}
.tt-collapsed:hover .tt-edit-hint,
.tt-collapsed:focus-visible .tt-edit-hint { opacity: 0.9; }
/* Editing indicator: outline only, on the box itself — the tooltip box's own background/text colors
   (--wc3-tip-bg/-fg) are left completely alone, so the preview never loses contrast while being edited. */
.tt-collapsed.tt-editing .tt-collapsed-box {
  outline: 2px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground));
  outline-offset: -1px;
}
/* Floating color-picker/raw-text toolbar for the in-place tooltip editor: JS-positioned (fixed) beside
   the row via positionFloatToolbar. It never touches the preview box itself, so entering/leaving edit
   mode causes zero layout shift and nothing to scroll into view. */
.tt-float-toolbar {
  position: fixed;
  z-index: 60;
  box-sizing: border-box;
  background: var(--vscode-editorWidget-background, var(--sidebar));
  border: 1px solid var(--vscode-editorWidget-border, var(--border));
  border-radius: 4px;
  padding: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.tt-float-toolbar-row { display: flex; align-items: center; gap: 6px; }
.tt-used-colors {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding-left: 6px;
  margin-left: 2px;
  border-left: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
}
.cell-edit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
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
.cell-edit:hover,
.cell-edit:focus-visible {
  background: var(--input-bg);
  border-color: color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-textLink-foreground)) 60%, transparent);
  outline: none;
}
.cell-edit:hover .tt-edit-hint,
.cell-edit:focus-visible .tt-edit-hint { opacity: 0.7; }
.cell-edit-val { flex: 1; min-width: 0; font-family: var(--mono); word-break: break-word; white-space: pre-wrap; }
.value-display {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 7px;
  row-gap: 2px;
  align-items: center;
  min-width: 0;
}
.value-display.rawcodes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.value-main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font);
}
.value-raw {
  grid-column: 2;
  min-width: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resolved-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 1px 5px;
  background: color-mix(in srgb, var(--input-bg) 78%, transparent);
  font-family: var(--font);
  white-space: nowrap;
}
.resolved-chip.linked { cursor: pointer; color: var(--vscode-textLink-foreground, var(--fg)); }
.resolved-chip.linked:hover { border-color: currentColor; background: var(--hover); }
.resolved-chip .raw { color: var(--muted); font-family: var(--mono); font-size: 10px; }
.asset-mini {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--input-bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  overflow: hidden;
}
.asset-mini img { width: 100%; height: 100%; object-fit: cover; display: block; }
.asset-mini.model-thumb {
  display: inline-block;
  padding: 0;
  vertical-align: middle;
}
.asset-open {
  width: auto;
  min-width: 22px;
  padding: 0 5px;
  height: 22px;
  cursor: pointer;
  white-space: nowrap;
}
.asset-open:hover {
  background: var(--btn-hover, var(--hover));
  color: var(--fg);
  border-color: var(--vscode-textLink-foreground, var(--border));
}
.mpv-box {
  position: fixed;
  right: 14px;
  bottom: 14px;
  width: 220px;
  z-index: 50;
  background: var(--sidebar, var(--bg));
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  overflow: hidden;
}
.mpv-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--sidebar));
  cursor: grab;
  user-select: none;
}
.mpv-head.dragging { cursor: grabbing; }
.mpv-ctl {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 2px;
}
.mpv-ctl:hover { background: var(--btn-hover, var(--hover)); color: var(--fg); }
.mpv-help, #mpv-help { cursor: help; }
.mpv-name {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mpv-close {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 2px;
}
.mpv-close:hover { background: var(--btn-hover, var(--hover)); color: var(--fg); }
.mpv-anim {
  flex: 0 1 auto;
  max-width: 110px;
  height: 18px;
  font-size: 10px;
  color: var(--input-fg);
  background: var(--input-bg);
  border: 1px solid var(--input-border, var(--border));
  border-radius: 2px;
  padding: 0 2px;
}
.mpv-viewport { position: relative; width: 220px; height: 220px; background: var(--model-bg); cursor: grab; }
.mpv-viewport:active { cursor: grabbing; }
.mpv-canvas { display: block; width: 100%; height: 100%; }
.mpv-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  text-align: center;
  font-size: 11px;
  color: var(--muted);
  pointer-events: none;
}
.mpv-status.hidden { display: none; }
.picker-row { display: flex; gap: 4px; align-items: center; }
.picker-row .edit-raw { flex: 1; min-width: 0; }
.browse-btn {
  flex: 0 0 auto;
  font: inherit;
  font-size: 11px;
  color: var(--btn-fg, var(--fg));
  background: var(--btn-bg, var(--input-bg));
  border: 1px solid var(--border);
  border-radius: 2px;
  padding: 2px 8px;
  cursor: pointer;
}
.browse-btn:hover { background: var(--btn-hover, var(--hover)); }
.ab-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.5);
}
.ab-overlay[hidden] { display: none; }
.ab-modal {
  display: flex;
  flex-direction: column;
  width: min(820px, 92vw);
  height: min(620px, 88vh);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 5px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  overflow: hidden;
}
.ab-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar, var(--bg));
}
.ab-tabs { display: flex; gap: 2px; flex: 0 0 auto; }
.ab-tab {
  font: inherit;
  font-size: 11px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 3px 9px;
  cursor: pointer;
}
.ab-tab:hover { background: var(--hover); color: var(--fg); }
.ab-tab.active { background: var(--btn-bg, var(--active)); color: var(--active-fg, var(--fg)); border-color: var(--vscode-focusBorder, var(--border)); }
.ab-search {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 3px 8px;
  color: var(--input-fg);
  background: var(--input-bg);
  border: 1px solid var(--input-border, var(--border));
  border-radius: 3px;
  font: inherit;
}
.ab-source {
  flex: 0 0 auto;
  height: 28px;
  color: var(--input-fg);
  background: var(--input-bg);
  border: 1px solid var(--input-border, var(--border));
  border-radius: 3px;
  font: inherit;
  font-size: 11px;
}
.ab-count { color: var(--muted); font-size: 11px; white-space: nowrap; }
.ab-close {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 2px;
}
.ab-close:hover { background: var(--btn-hover, var(--hover)); color: var(--fg); }
.ab-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 6px;
  padding: 8px;
  align-content: start;
}
.ab-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 5px 3px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  text-align: center;
}
.ab-card:hover { border-color: var(--vscode-focusBorder, #007fd4); background: var(--hover); }
.ab-card .object-icon { width: 48px; height: 48px; }
.model-thumb,
.object-icon.model-thumb { background: var(--model-bg); }
.sound-thumb {
  background: var(--input-bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}
.model-thumb img { object-fit: contain; }
.model-thumb.pending {
  position: relative;
  background: var(--model-bg);
}
.model-thumb.pending::after {
  content: "";
  position: absolute;
  left: calc(50% - 8px);
  top: calc(50% - 8px);
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, var(--fg) 22%, transparent);
  border-top-color: var(--fg);
  border-radius: 50%;
  animation: wv-spin 0.8s linear infinite;
}
.thumb-render-canvas {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 96px;
  height: 96px;
  pointer-events: none;
  opacity: 0;
}
.ab-card-label { font-size: 10px; line-height: 1.15; opacity: .75; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ab-empty { color: var(--muted); font-style: italic; padding: 24px; grid-column: 1 / -1; text-align: center; }
.ab-empty.ab-error { font-style: normal; }
.ab-empty.ab-error .details-error-reason { margin-inline: auto; }
.picker-note {
  color: var(--muted);
  font-size: 11px;
  margin-top: 3px;
}
/* Number fields: text input (kept locale-independent, see webview NOTE) + integer/real steppers. */
.num-editor { display: flex; align-items: stretch; max-width: 170px; }
.num-editor .num-input { flex: 1; min-width: 0; border-right: none; border-radius: 2px 0 0 2px; }
.num-steppers {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 0 2px 2px 0;
  overflow: hidden;
}
.num-step {
  flex: 1;
  width: 18px;
  min-height: 0;
  padding: 0;
  line-height: 1;
  font-size: 8px;
  cursor: pointer;
  background: var(--input-bg);
  color: var(--muted);
  border: none;
  border-bottom: 1px solid var(--border);
}
.num-step:last-child { border-bottom: none; }
.num-step:hover { background: var(--btn-hover, var(--hover)); color: var(--fg); }
/* Scannable accent for customized (overridden) fields. */
tr.overridden td.field { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 70%, transparent); }
.cell-edit .tt-edit-hint { flex-shrink: 0; }
.tt-bar { position: relative; display: inline-flex; align-items: center; gap: 4px; }
.tt-color-sq {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--input-border, var(--border));
  border-radius: 3px;
  cursor: pointer;
  background: #fff;
}
.tt-color-sq:hover { border-color: var(--fg); }
.tt-color-sq:focus-visible,
.tt-sw:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}
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
  flex-wrap: wrap;
  row-gap: 4px;
  gap: 8px;
  margin-top: 6px;
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
.cat-filter { position: relative; }
.cat-filter-btn {
  background: none;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 2px 6px;
  font: inherit;
}
.cat-filter-btn:hover,
.cat-filter-btn[aria-expanded="true"] { border-color: var(--border); background: var(--input-bg); }
.cat-filter-badge {
  margin-left: 4px;
  color: var(--accent);
  font-size: 10px;
}
.cat-filter-pop {
  position: absolute;
  top: 26px;
  right: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 150px;
  padding: 7px;
  background: var(--vscode-editorWidget-background, var(--sidebar));
  border: 1px solid var(--vscode-editorWidget-border, var(--border));
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
}
.cat-filter-pop[hidden] { display: none; }
.cat-filter-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.cat-filter-opt input { margin: 0; }
.cat-filter-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}
.cat-filter-actions button {
  flex: 1;
  padding: 2px 0;
  border: 1px solid var(--border);
  border-radius: 2px;
  background: var(--input-bg);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.cat-filter-actions button:hover { background: var(--hover); }
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
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  background: var(--input-bg);
  color: var(--input-fg);
  border: 1px solid var(--input-border);
  border-radius: 2px;
  padding: 3px 7px;
  font: inherit;
}
.search-input:focus { outline: 1px solid var(--vscode-focusBorder, var(--vscode-textLink-foreground)); }
.search-match { flex-shrink: 0; color: var(--muted); font-size: 11px; white-space: nowrap; }
.search-clear {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: none;
  place-items: center;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 3px;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.search-clear.show { display: grid; }
.search-clear:hover { background: var(--hover); color: var(--fg); }
.search-clear:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); }
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
/* World Editor-style Melee/Campaign and Units/Buildings/Heroes/Special sub-folders (units files only —
   see the "kind" field set in buildObject). Condensed: same tight vertical rhythm as race-heading,
   just indented further and a touch smaller/lighter so the hierarchy reads at a glance without eating
   extra height. */
.camp-heading,
.kind-heading {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  background: transparent;
  border: 0;
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.camp-heading { padding: 2px 10px 2px 32px; }
.kind-heading { padding: 2px 10px 2px 42px; font-weight: 500; }
.group-heading:hover,
.race-heading:hover,
.camp-heading:hover,
.kind-heading:hover {
  background: var(--hover);
}
.group-heading:focus-visible,
.race-heading:focus-visible,
.camp-heading:focus-visible,
.kind-heading:focus-visible,
.object-row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
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
/* Nested one level deeper under a kind-heading (Units/Buildings/Heroes/Special) than a plain
   race-heading — matches kind-heading's own indent so rows still read as its children. */
.object-row.nested { padding-left: 46px; }
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
.object-row.active .object-id {
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
.details-title-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}
.details-icon {
  width: 32px;
  height: 32px;
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
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.toggle-chip input { margin: 0; }
.toggle-chip-group {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
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
  padding: 5px 8px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 3px 8px;
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
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.override-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 2px;
  color: var(--accent);
  font-size: 10px;
  font-family: var(--vscode-font-family, sans-serif);
  font-weight: 600;
}
.category-row td {
  position: sticky;
  top: var(--table-header-h);
  z-index: 1;
  padding: 5px 8px 4px;
  background: var(--vscode-editorGroupHeader-tabsBackground, var(--sidebar));
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
  padding: 1px 5px;
  background: color-mix(in srgb, var(--input-bg) 78%, transparent);
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
.details-error { text-align: center; }
.details-error-title { color: var(--fg); margin-bottom: 4px; }
.details-error-reason {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  max-width: 360px;
  margin-bottom: 10px;
  word-break: break-word;
}
.details-error .browse-btn { padding: 4px 14px; }
.object-editor.narrow {
  grid-template-columns: 1fr;
  grid-template-rows: minmax(150px, 34%) minmax(260px, 1fr);
  overflow: auto;
}
.object-editor.narrow .object-list { border-right: 0; border-bottom: 1px solid var(--border); min-height: 150px; }
.object-editor.narrow .details { min-height: 260px; }
.object-editor.narrow table { min-width: 520px; }
.object-editor.narrow .splitter { display: none; }
@media (max-width: 720px) {
  .object-editor {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(150px, 34%) minmax(260px, 1fr);
    overflow: auto;
  }
  .object-list { border-right: 0; border-bottom: 1px solid var(--border); min-height: 150px; }
  .details { min-height: 260px; }
  table { min-width: 520px; }
  .splitter { display: none; }
}
`,
        body: `<div class="content">
<div class="md-header">
  <div class="md-title">${escapeHtml(fileName)}</div>
  <div class="md-meta">WC3 ${escapeHtml(typeLabel)} object data - v${parsed.version} - ${escapeHtml(summary)} - ${escapeHtml(metadataSource)}${parsed.extended ? ' - extended (level/dataPt)' : ''}${combinedMeta}<button type="button" id="editable-badge" class="editable-badge" title="Existing overrides can be edited. Click or Ctrl+S to save.">editable</button></div>
</div>
${errorBanner}
${warningBanner}
${gameDataBanner}
<div class="object-editor" id="object-editor">
  <aside class="object-list">
    <div class="search-wrap">
      <input id="search" class="search-input" placeholder="Search objects or IDs" aria-label="Search objects">
      <span id="search-match" class="search-match" role="status" aria-live="polite"></span>
      <button id="search-clear" class="search-clear" type="button" title="Clear search" aria-label="Clear search">✕</button>
    </div>
    <div id="tree" class="tree"></div>
  </aside>
  <div class="splitter" id="splitter" title="Drag to resize"></div>
  <main id="details" class="details"></main>
</div>
<div id="mpv-box" class="mpv-box" hidden>
  <div class="mpv-head" id="mpv-head">
    <span id="mpv-name" class="mpv-name">Model</span>
    <select id="mpv-anim" class="mpv-anim" title="Animation" hidden></select>
    <button id="mpv-play" class="mpv-ctl" type="button" title="Pause" aria-label="Play/pause">⏸</button>
    <button id="mpv-restart" class="mpv-ctl" type="button" title="Restart animation" aria-label="Restart">⟲</button>
    <button id="mpv-help" class="mpv-ctl" type="button" tabindex="-1" aria-label="Controls help" title="Drag header to move · drag model to orbit · scroll to zoom · dropdown switches animation · ⟲ replays from start">?</button>
    <button id="mpv-close" class="mpv-close" type="button" title="Close preview" aria-label="Close preview">✕</button>
  </div>
  <div id="mpv-viewport" class="mpv-viewport">
    <canvas id="mpv-canvas" class="mpv-canvas"></canvas>
    <canvas id="mpv-gizmo" width="1" height="1" hidden></canvas>
    <div id="mpv-status" class="mpv-status"></div>
  </div>
</div>
<canvas id="model-thumb-canvas" class="thumb-render-canvas" width="96" height="96" aria-hidden="true"></canvas>
<div id="model-thumb-viewport" class="thumb-render-canvas" aria-hidden="true"></div>
<div id="ab-overlay" class="ab-overlay" hidden>
  <div class="ab-modal" role="dialog" aria-label="Asset browser">
    <div class="ab-head">
      <div class="ab-tabs" id="ab-tabs">
        <button class="ab-tab" type="button" data-tab="model">Models</button>
        <button class="ab-tab" type="button" data-tab="icon">Icons</button>
        <button class="ab-tab" type="button" data-tab="sound">Sounds</button>
        <button class="ab-tab" type="button" data-tab="pathing">Pathing</button>
      </div>
      <input id="ab-search" class="ab-search" placeholder="Search game assets…" aria-label="Search assets">
      <select id="ab-source" class="ab-source" title="Filter by source" aria-label="Filter by source">
        <option value="all">All</option>
        <option value="wc3">WC3</option>
        <option value="import">Imports</option>
      </select>
      <span id="ab-count" class="ab-count"></span>
      <button id="ab-close" class="ab-close" type="button" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <div id="ab-grid" class="ab-grid"></div>
  </div>
</div>
${mdxViewerUri ? `<script src="${mdxViewerUri}"></script>` : ''}
<script>
window.__OBJMOD_INITIAL__ = ${initialJson};
</script>
${objModEditorUri ? `<script src="${objModEditorUri}"></script>` : ''}
</div>`,
    });
}

/** Resolve a model/texture path referenced by a field and open it in the appropriate preview. */
async function openObjModAsset(assetPath: string, uri: vscode.Uri): Promise<void> {
    const roots = await getCandidateRoots(uri.fsPath);
    const resolved = await resolveAssetPathWithCasc(assetPath, roots);
    if (!resolved) {
        vscode.window.showWarningMessage(`Could not resolve asset: ${assetPath}`);
        return;
    }
    const target = vscode.Uri.file(resolved);
    const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase();
    if (['.mdx', '.mdl', '.blp', '.dds', '.tga'].includes(ext)) {
        await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.blpPreview');
    } else if (isSoundAssetPath(resolved)) {
        await vscode.commands.executeCommand('vscode.openWith', target, 'wurst.soundPreview');
    } else {
        await vscode.commands.executeCommand('vscode.open', target);
    }
}

async function loadObjectDetails(key: string, webview: vscode.Webview, doc: ObjModDocument): Promise<void> {
    const entry = findEntryByKey(doc.displayFile, key);
    if (!entry) {
        await webview.postMessage({ type: 'objectDetailsFailed', key, reason: 'Object not found' });
        return;
    }
    try {
        const wts = doc.wtsTable;
        const gameData = await loadObjEditorData(doc.displayFile.ext);
        if (gameData && !doc.objectCatalog) {
            const withDocObjects = catalogWithDocumentObjects(await loadObjValueCatalog(), doc.displayFile, wts, gameData);
            doc.objectCatalog = await catalogWithSiblingObjects(withDocObjects, doc.mainUri, doc.displayFile.ext, wts);
        }
        const mods = gameData && doc.objectCatalog
            ? buildFieldRows(
                entry,
                gameData,
                wts,
                doc.displayFile.extended,
                doc.displayFile.ext,
                doc.objectCatalog,
            )
            : entry.mods.map((mod) => {
                const row = buildOverrideOnlyMod(mod, wts, gameData);
                annotateEditable(row, mod, wts);
                return row;
            });
        await webview.postMessage({ type: 'objectDetailsLoaded', key, mods });
    } catch (err) {
        // Game-data/CASC lookups can throw (missing install, bad metadata); without this the webview
        // was left stuck on its "Loading fields..." spinner forever with no way out but reopening.
        console.error('[wurst-objmod] failed to build field rows for', key, err);
        await webview.postMessage({ type: 'objectDetailsFailed', key, reason: err instanceof Error ? err.message : String(err) });
    }
}

function findEntryByKey(parsed: ObjModFile, key: string): ObjModEntry | undefined {
    const [group, rawIndex] = key.split(':');
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return undefined;
    if (group === 'Custom') return parsed.customObjs[index];
    if (group === 'Original') return parsed.origObjs[index];
    return undefined;
}

function objectKeyParts(key: string): { group: 'Original' | 'Custom'; index: number } | undefined {
    const [group, rawIndex] = key.split(':');
    const index = Number(rawIndex);
    if ((group !== 'Original' && group !== 'Custom') || !Number.isInteger(index) || index < 0) return undefined;
    return { group, index };
}

async function buildObjectForKey(doc: ObjModDocument, key: string): Promise<PreviewObject | undefined> {
    const parts = objectKeyParts(key);
    if (!parts) return undefined;
    const entry = findEntryByKey(doc.displayFile, key);
    if (!entry) return undefined;
    return buildObject(entry, parts.group, parts.index, doc.wtsTable, await loadObjSummaryData(doc.displayFile.ext), doc.displayFile.ext);
}

function isSummaryField(fieldId: string): boolean {
    const id = fieldId.toLowerCase();
    return NAME_FIELDS.has(id) || ICON_FIELDS.has(id) || SUMMARY_MODEL_FIELDS.has(id) || CLASSIFICATION_FIELDS.has(id);
}

async function postObjectSummary(webview: vscode.Webview, doc: ObjModDocument, key: string): Promise<void> {
    const object = await buildObjectForKey(doc, key);
    if (object) await webview.postMessage({ type: 'objectUpdated', object });
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

/**
 * Parse a numeric field edit without destroying data: empty clears to 0, a valid number is used
 * (truncated for ints), and unparseable input keeps the previous numeric value rather than silently
 * collapsing to 0 — `Number('1.2.3') || 0` would have lost the original value.
 */
function parseNumericEdit(raw: string, prev: number | string, truncate: boolean): number {
    if (raw.trim() === '') return 0;
    const n = Number(raw);
    if (!isFinite(n)) return typeof prev === 'number' ? prev : 0;
    return truncate ? Math.trunc(n) : n;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
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
        nextValue = parseNumericEdit(p.value, prevValue, false);
    } else {
        nextValue = parseNumericEdit(p.value, prevValue, true);
    }

    const id = wtsId;
    const newMod = mod;
    // A name override changes the labels the value catalog hands out for rawcode cross-references.
    const affectsCatalog = NAME_FIELDS.has(p.fieldId.toLowerCase());
    const addMod = (arr: ObjModMod[]) => { if (arr.indexOf(newMod) < 0) arr.push(newMod); };
    const removeMod = (arr: ObjModMod[]) => { const i = arr.indexOf(newMod); if (i >= 0) arr.splice(i, 1); };
    const apply = () => {
        if (created && fileEntry) { addMod(entry.mods); addMod(fileEntry.mods); }
        newMod.value = nextValue;
        if (id !== undefined) { doc.wtsTable.set(id, wtsAfter ?? ''); doc.wtsEdits.set(id, wtsAfter ?? ''); }
        if (affectsCatalog) doc.objectCatalog = undefined;
    };
    const revert = () => {
        if (created && fileEntry) { removeMod(entry.mods); removeMod(fileEntry.mods); }
        else { newMod.value = prevValue; }
        if (id !== undefined) {
            if (wtsBefore === undefined) { doc.wtsTable.delete(id); doc.wtsEdits.delete(id); }
            else { doc.wtsTable.set(id, wtsBefore); doc.wtsEdits.set(id, wtsBefore); }
        }
        if (affectsCatalog) doc.objectCatalog = undefined;
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
    if ((mod.varType === 'real' || mod.varType === 'unreal') && typeof mod.value === 'number') {
        return formatReal(mod.value);
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

/**
 * Cross-file rawcode lookup for object-reference chips (e.g. a unit's Abilities list pointing at a
 * custom ability that lives in this map's own war3map.w3a, not the currently open file). Object files
 * for a single map all sit beside each other as war3map.<ext> (see getObjModSiblingFileName), so this
 * just tries each known kind's file in the same folder as `sourceUri` and searches its merged object
 * list for a customized entry with a matching id. Returns undefined for stock (never-customized)
 * rawcodes — there's no file to jump to for those.
 */
async function locateObjectAcrossSiblings(sourceUri: vscode.Uri, rawcode: string): Promise<{ uri: vscode.Uri; key: string } | undefined> {
    const dir = vscode.Uri.joinPath(sourceUri, '..');
    const needle = rawcode.toLowerCase();
    for (const ext of CATALOG_EXTS) {
        const uri = vscode.Uri.joinPath(dir, `war3map${ext}`);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            continue;
        }
        let e: EditableObjMod;
        try {
            e = await loadEditableObjMod(uri);
        } catch {
            continue;
        }
        const customIdx = e.displayFile.customObjs.findIndex((entry) => (entry.newId || entry.baseId).toLowerCase() === needle);
        if (customIdx >= 0) return { uri, key: `Custom:${customIdx}` };
        const origIdx = e.displayFile.origObjs.findIndex((entry) => entry.mods.length > 0 && entry.baseId.toLowerCase() === needle);
        if (origIdx >= 0) return { uri, key: `Original:${origIdx}` };
    }
    return undefined;
}

class ObjModDocument implements vscode.CustomDocument {
    wtsEdits = new Map<number, string>();
    reload: (() => Promise<void>) | undefined;
    /** Merged value catalog (base game data + this document's objects). Built once per open, reused for
        every object's field rows; invalidated when a name override changes so cross-refs stay current. */
    objectCatalog: ObjValueCatalog | undefined;
    /** The live webview, so save/edit can push dirty-state updates to the header badge. */
    panelWebview: vscode.Webview | undefined;
    /** The owning panel, so an external-change prompt can bring this editor to the front before asking
        VS Code to revert/save it (both of those act on the active editor). */
    panel: vscode.WebviewPanel | undefined;
    /** Identity of the current history state and the last-saved state. Unlike a numeric stack depth,
        revisions remain distinct when the user undoes and then creates a new edit branch. */
    currentRevision = 0;
    savedRevision = 0;
    nextRevision = 1;
    /** Bytes we last read or wrote for each watched file (mainUri/skinUri/wtsUri), keyed by uri string.
        Lets an external-change check tell a real edit from another app apart from the echo of our own
        write — see ObjModEditorProvider.snapshotKnownBytes/checkExternalChange. */
    knownBytes = new Map<string, Buffer>();
    /** Disposed on panel close — see ObjModEditorProvider.watchExternalChanges. */
    watcherDisposables: vscode.Disposable[] = [];
    /** Coalesces bursts of fs-watcher events (e.g. a `git pull` touching main+skin+wts together) into
        one combined check instead of one prompt per file. */
    externalChangeDebounce: ReturnType<typeof setTimeout> | undefined;

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

    get combinedInfo(): CombinedObjModInfo {
        return {
            mainName: uriBaseName(this.mainUri),
            skinName: this.skinUri ? uriBaseName(this.skinUri) : undefined,
        };
    }

    /** Stops the external-change file watchers — called both when the panel closes (they'd otherwise
     *  keep firing against a document nothing is displaying) and when the document itself is disposed. */
    disposeWatchers(): void {
        for (const d of this.watcherDisposables) d.dispose();
        this.watcherDisposables = [];
    }

    dispose(): void {
        openObjModDocuments.delete(this.mainUri.toString());
        if (this.externalChangeDebounce) clearTimeout(this.externalChangeDebounce);
        this.disposeWatchers();
    }
}

function uriBaseName(uri: vscode.Uri): string {
    const path = uri.path;
    return path.slice(path.lastIndexOf('/') + 1);
}

function fileExtOf(uri: vscode.Uri): string {
    const name = uri.path;
    return name.slice(name.lastIndexOf('.'));
}

interface ObjModBackupData {
    version: 1;
    mainUri: string;
    skinUri?: string;
    mainBase64: string;
    skinBase64?: string;
    wtsUri?: string;
    wtsExists: boolean;
    wtsWarning?: string;
    wtsTable: Array<[number, string]>;
    wtsEdits: Array<[number, string]>;
    currentRevision: number;
    savedRevision: number;
    nextRevision: number;
}

async function openObjModBackup(uri: vscode.Uri, backupId: string): Promise<ObjModDocument> {
    const backupUri = vscode.Uri.parse(backupId);
    const raw = Buffer.from(await vscode.workspace.fs.readFile(backupUri)).toString('utf8');
    const backup = JSON.parse(raw) as ObjModBackupData;
    if (backup.version !== 1 || !backup.mainBase64 || !backup.mainUri || !Array.isArray(backup.wtsTable)) {
        throw new Error('Unsupported or malformed object-editor backup.');
    }
    const ext = fileExtOf(uri);
    const mainFile = parseObjMod(Buffer.from(backup.mainBase64, 'base64'), ext);
    const skinFile = backup.skinBase64
        ? parseObjMod(Buffer.from(backup.skinBase64, 'base64'), ext)
        : undefined;
    const mainUri = vscode.Uri.parse(backup.mainUri);
    const skinUri = backup.skinUri ? vscode.Uri.parse(backup.skinUri) : undefined;
    const displayFile = skinFile ? mergeObjModFiles(mainFile, skinFile) : mainFile;
    const doc = new ObjModDocument(
        uri,
        mainFile,
        mainUri,
        skinFile,
        skinUri,
        displayFile,
        new Map(backup.wtsTable),
        backup.wtsUri ? vscode.Uri.parse(backup.wtsUri) : undefined,
        backup.wtsExists,
        backup.wtsWarning,
    );
    doc.wtsEdits = new Map(backup.wtsEdits);
    doc.currentRevision = backup.currentRevision;
    doc.savedRevision = backup.savedRevision;
    doc.nextRevision = Math.max(backup.nextRevision, backup.currentRevision + 1, backup.savedRevision + 1);
    return doc;
}

class ObjModEditorProvider implements vscode.CustomEditorProvider<ObjModDocument> {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ObjModDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChange.event;

    constructor(private readonly extensionUri: vscode.Uri) {}

    async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<ObjModDocument> {
        if (openContext.backupId) {
            const restored = await openObjModBackup(uri, openContext.backupId);
            await this.snapshotKnownBytes(restored);
            return restored;
        }
        const e = await loadEditableObjMod(uri);
        const wtsTable = loadTriggerStringsForUri(uri);
        const { uri: wtsUri, exists } = findWtsUri(uri);
        const wtsWarning = computeWtsWarning(e.displayFile, exists);
        const doc = new ObjModDocument(uri, e.mainFile, e.mainUri, e.skinFile, e.skinUri, e.displayFile, wtsTable, wtsUri, exists, wtsWarning);
        await this.snapshotKnownBytes(doc);
        return doc;
    }

    async resolveCustomEditor(doc: ObjModDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
                vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
                vscode.Uri.file(getGameAssetCacheDir()),
            ],
        };
        const fileName = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
        const ctx: ParsedPreviewContext = { uri: doc.uri, webview: panel.webview };
        doc.panelWebview = panel.webview;
        doc.panel = panel;
        openObjModDocuments.set(doc.mainUri.toString(), doc);
        this.watchExternalChanges(doc, panel);
        const mdxViewerUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'mdxViewer.js'),
        ).toString();
        const objModEditorUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'objModEditorWebview.js'),
        ).toString();
        // Show a spinner immediately — buildHtml awaits CASC game-data and can exceed 200ms.
        panel.webview.html = buildObjLoadingHtml(fileName);
        doc.reload = async () => { panel.webview.html = await buildHtml(doc.displayFile, fileName, ctx, doc.wtsWarning, mdxViewerUri, objModEditorUri, doc.combinedInfo); };

        panel.webview.onDidReceiveMessage((message) => { void this.handleMessage(message, panel.webview, doc); });
        await doc.reload();
    }

    // Thin safety net around the real handler: an uncaught throw here previously vanished into an
    // unhandled promise rejection (the caller does `void this.handleMessage(...)`), leaving whatever
    // the webview was waiting on — a save, an edit, a thumbnail — stuck with no feedback at all.
    private async handleMessage(message: unknown, webview: vscode.Webview, doc: ObjModDocument): Promise<void> {
        try {
            await this.handleMessageUnsafe(message, webview, doc);
        } catch (err) {
            console.error('[wurst-objmod] unhandled webview message error', err);
            void vscode.window.showErrorMessage(`Wurst object editor: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
    private async handleMessageUnsafe(message: unknown, webview: vscode.Webview, doc: ObjModDocument): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const msg = message as {
            type?: string; key?: string; iconPath?: string; path?: string;
            cacheKey?: string; aliasKey?: string; webpBase64?: string; thumbKey?: string; phase?: string; elapsedMs?: number; deltaMs?: number; detail?: string;
            fieldId?: string; varType?: string; level?: number | null; dataPt?: number | null; value?: string;
            rawcode?: string; label?: string;
        };
        if (msg.type === 'loadObjectDetails' && msg.key) {
            await loadObjectDetails(msg.key, webview, doc);
            return;
        }
        if (msg.type === 'openObjectReference' && msg.rawcode) {
            await this.openObjectReference(doc, msg.rawcode, msg.label);
            return;
        }
        if (msg.type === 'loadObjectIcon' && msg.key && msg.iconPath) {
            await requestPreviewIcon(msg.iconPath, msg.key, webview, doc.uri);
            return;
        }
        if (msg.type === 'requestTooltipBackdrop') {
            await requestTooltipBackdrop(webview, doc.uri);
            return;
        }
        if (msg.type === 'requestTooltipBorder') {
            await requestTooltipBorder(webview, doc.uri);
            return;
        }
        if (msg.type === 'loadModelThumb' && msg.key && msg.path) {
            await requestModelThumbnail(msg.path, msg.key, doc.uri, webview);
            return;
        }
        if (msg.type === 'modelThumbRendered' && msg.key && msg.cacheKey && msg.webpBase64) {
            await cacheModelThumbnail(msg.key, msg.cacheKey, msg.webpBase64, webview, msg.aliasKey);
            return;
        }
        if (msg.type === 'modelThumbFailed' && msg.key) {
            const failed = msg as typeof msg & { reason?: string };
            markModelThumbnailBad(msg.key, msg.cacheKey, msg.aliasKey, failed.reason);
            return;
        }
        if (msg.type === 'openAsset' && msg.path) {
            await openObjModAsset(msg.path, doc.uri);
            return;
        }
        if (msg.type === 'loadModel' && msg.path) {
            await postModelToWebview(msg.path, doc.uri, webview);
            return;
        }
        if (msg.type === 'requestTextures' && Array.isArray((msg as { paths?: unknown }).paths)) {
            const paths = (msg as { paths: unknown[] }).paths.filter((p): p is string => typeof p === 'string');
            void postTexturesToWebview(paths, doc.uri, webview, msg.thumbKey).catch((err) => {
                console.error(`[wurst-model-thumb] texture request failed: ${err instanceof Error ? err.message : String(err)}`);
            });
            return;
        }
        if (msg.type === 'modelThumbProfile' && msg.key && msg.phase) {
            const detailSuffix = msg.detail ? ' ' + msg.detail : '';
            console.log(`[wurst-model-thumb] ${msg.key} webview ${msg.phase} +${msg.deltaMs ?? '?'}ms elapsed=${msg.elapsedMs ?? '?'}ms${detailSuffix}`);
            return;
        }
        if (msg.type === 'requestAssetCatalog') {
            try {
                const [cat, imp] = await Promise.all([
                    loadObjValueCatalog(),
                    gatherImportedAssets(doc.uri.fsPath),
                ]);
                void webview.postMessage({
                    type: 'assetCatalog',
                    models: dedupeByHashOrBasename([...cat.models, ...imp.model]),
                    // Icons repeat across SD/HD and .blp/.dds/.tga variants — collapse same-named ones.
                    icons: dedupeByHashOrBasename([...cat.icons, ...imp.icon]),
                    sounds: dedupeByHashOrBasename([...cat.sounds, ...imp.sound]),
                    pathing: cat.pathing,
                });
            } catch (err) {
                // Without this, a CASC/game-data failure left the asset browser stuck on
                // "Loading game assets…" forever — the only way out was closing the whole editor.
                console.error('[wurst-objmod] failed to load asset catalog', err);
                void webview.postMessage({ type: 'assetCatalogFailed', reason: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        if (msg.type === 'undo') { void vscode.commands.executeCommand('undo'); return; }
        if (msg.type === 'redo') { void vscode.commands.executeCommand('redo'); return; }
        if (msg.type === 'save') { void vscode.commands.executeCommand('workbench.action.files.save'); return; }
        if (msg.type === 'editField' && msg.key && msg.fieldId && msg.varType) {
            const beforeRevision = doc.currentRevision;
            const afterRevision = doc.nextRevision++;
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
                if (isSummaryField(fieldId)) void postObjectSummary(webview, doc, key);
            };
            this._onDidChange.fire({
                document: doc,
                label: `Edit ${msg.fieldId}`,
                undo: () => { edit.revert(); doc.currentRevision = beforeRevision; post(); this.postDirtyState(doc); },
                redo: () => { edit.apply(); doc.currentRevision = afterRevision; post(); this.postDirtyState(doc); },
            });
            doc.currentRevision = afterRevision;
            this.postDirtyState(doc);
            if (isSummaryField(fieldId)) void postObjectSummary(webview, doc, key);
        }
    }

    private postDirtyState(doc: ObjModDocument): void {
        void doc.panelWebview?.postMessage({ type: 'dirtyStateChanged', isDirty: doc.currentRevision !== doc.savedRevision });
    }

    /** A rawcode chip (e.g. an ability on a unit) that isn't overridden in the currently open file —
     *  try to find which sibling war3map.* file actually customizes it and jump there. Stock/never-
     *  customized rawcodes have nothing to open, so that's reported back as a plain info message. */
    private async openObjectReference(doc: ObjModDocument, rawcode: string, label?: string): Promise<void> {
        const found = await locateObjectAcrossSiblings(doc.mainUri, rawcode);
        if (!found) {
            const displayLabel = label ? `${label} (${rawcode})` : rawcode;
            void vscode.window.showInformationMessage(
                `${displayLabel} is a stock Warcraft III object — it isn't customized anywhere in this map, so there's nothing to open.`,
            );
            return;
        }
        const alreadyOpen = openObjModDocuments.get(found.uri.toString());
        if (alreadyOpen?.panelWebview) {
            void alreadyOpen.panelWebview.postMessage({ type: 'selectObject', key: found.key });
        } else {
            pendingObjectSelection.set(found.uri.toString(), found.key);
        }
        await vscode.commands.executeCommand('vscode.openWith', found.uri, 'wurst.objModPreview');
    }

    async saveCustomDocument(doc: ObjModDocument): Promise<void> {
        try {
            // Preflight every serialization and the WTS merge before the first write. This prevents a
            // validation/read failure in a later sibling from leaving an earlier file partially saved.
            const mainBytes = serializeValidated(doc.mainFile, doc.mainUri.path);
            const skinBytes = doc.skinFile && doc.skinUri
                ? serializeValidated(doc.skinFile, doc.skinUri.path)
                : undefined;
            const wtsBytes = await this.prepareWts(doc, doc.wtsUri, doc.wtsExists);
            // writeBytesIfChanged hands back the bytes now on disk (written, or found unchanged) —
            // record those directly instead of re-reading every file back with
            // snapshotKnownBytes, so the file watcher doesn't mistake this save's own fs events for an
            // external change (see checkExternalChange).
            doc.knownBytes.set(doc.mainUri.toString(), await writeBytesIfChanged(mainBytes, doc.mainUri));
            if (skinBytes && doc.skinUri) {
                doc.knownBytes.set(doc.skinUri.toString(), await writeBytesIfChanged(skinBytes, doc.skinUri));
            }
            if (wtsBytes && doc.wtsUri) {
                await vscode.workspace.fs.writeFile(doc.wtsUri, wtsBytes);
                doc.wtsExists = true;
                doc.knownBytes.set(doc.wtsUri.toString(), wtsBytes);
                doc.wtsEdits.clear();
            }
            doc.savedRevision = doc.currentRevision;
            this.postDirtyState(doc);
        } catch (err) {
            // Surface the failure and rethrow so VS Code keeps the document dirty. Preflight failures happen
            // before any write; an actual filesystem failure may still have written an earlier sibling.
            void vscode.window.showErrorMessage(`Object data not saved: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }

    async saveCustomDocumentAs(doc: ObjModDocument, targetResource: vscode.Uri): Promise<void> {
        const objModBytes = serializeValidated(doc.openedFile, targetResource.path);
        const { uri: wtsUri, exists } = findWtsUri(targetResource);
        const wtsBytes = await this.prepareWts(doc, wtsUri, exists);
        await vscode.workspace.fs.writeFile(targetResource, objModBytes);
        if (wtsBytes && wtsUri) {
            await vscode.workspace.fs.writeFile(wtsUri, wtsBytes);
            doc.wtsEdits.clear();
        }
    }

    /** Builds the final WTS bytes without writing, so callers can finish all fallible preflight work
     *  before they modify any of the document's sibling files. */
    private async prepareWts(doc: ObjModDocument, wtsUri: vscode.Uri | undefined, wtsExists: boolean): Promise<Buffer | undefined> {
        if (!doc.wtsEdits.size || !wtsUri) return undefined;
        let original = '';
        if (wtsExists) {
            try { original = Buffer.from(await vscode.workspace.fs.readFile(wtsUri)).toString('utf8'); } catch { /* create fresh */ }
        }
        const text = applyWtsEdits(original, doc.wtsEdits);
        return Buffer.from(text, 'utf8');
    }

    async revertCustomDocument(doc: ObjModDocument): Promise<void> {
        await this.reloadDocFromDisk(doc);
    }

    async backupCustomDocument(doc: ObjModDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        const backup: ObjModBackupData = {
            version: 1,
            mainUri: doc.mainUri.toString(),
            skinUri: doc.skinUri?.toString(),
            mainBase64: serializeValidated(doc.mainFile, doc.mainUri.path).toString('base64'),
            skinBase64: doc.skinFile && doc.skinUri
                ? serializeValidated(doc.skinFile, doc.skinUri.path).toString('base64')
                : undefined,
            wtsUri: doc.wtsUri?.toString(),
            wtsExists: doc.wtsExists,
            wtsWarning: doc.wtsWarning,
            wtsTable: Array.from(doc.wtsTable),
            wtsEdits: Array.from(doc.wtsEdits),
            currentRevision: doc.currentRevision,
            savedRevision: doc.savedRevision,
            nextRevision: doc.nextRevision,
        };
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(context.destination, '..'));
        await vscode.workspace.fs.writeFile(context.destination, Buffer.from(JSON.stringify(backup), 'utf8'));
        return { id: context.destination.toString(), delete: () => vscode.workspace.fs.delete(context.destination).then(() => undefined, () => undefined) };
    }

    /** Re-parses main/skin/wts from disk and rebuilds the webview — the shared body behind both VS
     *  Code's own revert (revertCustomDocument) and the "no local edits at risk" branch of an external
     *  change (checkExternalChange). */
    private async reloadDocFromDisk(doc: ObjModDocument): Promise<void> {
        const e = await loadEditableObjMod(doc.uri);
        doc.mainFile = e.mainFile;
        doc.mainUri = e.mainUri;
        doc.skinFile = e.skinFile;
        doc.skinUri = e.skinUri;
        doc.displayFile = e.displayFile;
        doc.objectCatalog = undefined;
        doc.currentRevision = 0;
        doc.savedRevision = 0;
        doc.nextRevision = 1;
        doc.wtsTable = loadTriggerStringsForUri(doc.uri);
        doc.wtsEdits.clear();
        const { exists } = findWtsUri(doc.uri);
        doc.wtsExists = exists;
        doc.wtsWarning = computeWtsWarning(doc.displayFile, exists);
        if (doc.reload) await doc.reload();
        await this.snapshotKnownBytes(doc);
    }

    /** Records the bytes currently on disk for every file this document watches, so a later fs-watcher
     *  event can tell a genuine external edit apart from the echo of our own read/write. The files are
     *  independent, so they're read in parallel rather than one after another. */
    private async snapshotKnownBytes(doc: ObjModDocument): Promise<void> {
        await Promise.all(watchedUris(doc).map(async (uri) => {
            const key = uri.toString();
            try {
                doc.knownBytes.set(key, Buffer.from(await vscode.workspace.fs.readFile(uri)));
            } catch {
                doc.knownBytes.delete(key); // file doesn't exist (yet) — nothing to compare against
            }
        }));
    }

    /** Watches this document's main/skin/wts files for changes made outside this editor (another
     *  editor, `git pull`, a teammate's overwrite) and reacts once bytes on disk actually differ from
     *  what we last read/wrote — see checkExternalChange for what happens once one is confirmed. */
    private watchExternalChanges(doc: ObjModDocument, panel: vscode.WebviewPanel): void {
        for (const uri of watchedUris(doc)) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uriBaseName(uri)),
            );
            const onEvent = () => this.scheduleExternalChangeCheck(doc);
            watcher.onDidChange(onEvent);
            watcher.onDidCreate(onEvent); // war3map.wts may not have existed yet when this document opened
            doc.watcherDisposables.push(watcher);
        }
        panel.onDidDispose(() => doc.disposeWatchers());
    }

    // Coalesces a burst of fs events (main+skin+wts all touched by the same `git pull`) into one check.
    private scheduleExternalChangeCheck(doc: ObjModDocument): void {
        if (doc.externalChangeDebounce) clearTimeout(doc.externalChangeDebounce);
        doc.externalChangeDebounce = setTimeout(() => { void this.checkExternalChange(doc); }, 400);
    }

    private async checkExternalChange(doc: ObjModDocument): Promise<void> {
        doc.externalChangeDebounce = undefined;
        // Independent files — read them in parallel rather than one after another before comparing.
        const uris = watchedUris(doc);
        const current = await Promise.all(uris.map(async (uri) => {
            try { return Buffer.from(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
        }));
        const changed = current.some((bytes, i) => {
            const known = doc.knownBytes.get(uris[i].toString());
            return bytes && known ? !bytes.equals(known) : bytes !== known; // both missing = unchanged
        });
        if (!changed) return;

        const label = uriBaseName(doc.mainUri);
        if (doc.currentRevision === doc.savedRevision) {
            // Nothing of yours is at risk — just pick up the new content and say so, no prompt needed.
            await this.reloadDocFromDisk(doc);
            vscode.window.setStatusBarMessage(`$(sync) ${label} changed on disk — reloaded.`, 4000);
            return;
        }

        // Dirty: reloading would silently discard in-progress edits, so ask. No field-level merge — WC3
        // object files carry no diff/patch metadata to merge against, so the only two data-safe options
        // are "take theirs" or "take mine."
        const choice = await vscode.window.showWarningMessage(
            `${label} changed on disk, and this editor has unsaved changes. Reloading will discard your edits.`,
            'Reload from Disk',
            'Keep Mine (Overwrite Disk)',
        );
        if (choice === 'Reload from Disk') {
            // Goes through VS Code's own revert command (rather than reloadDocFromDisk directly) so the
            // tab's dirty flag and undo stack — which we don't own — get cleared correctly too.
            doc.panel?.reveal();
            await vscode.commands.executeCommand('workbench.action.files.revert');
        } else if (choice === 'Keep Mine (Overwrite Disk)') {
            // Same reasoning: go through the real save command, not saveCustomDocument() directly.
            doc.panel?.reveal();
            await vscode.commands.executeCommand('workbench.action.files.save');
        }
        // Dismissed without a choice: leave both sides as-is. The next external edit (or a save) re-checks.
    }
}

/** The set of files this document should watch for external changes: the main objmod file, its
 *  war3mapSkin sibling (if this map has one), and war3map.wts (source of TRIGSTR_ strings). */
function watchedUris(doc: ObjModDocument): vscode.Uri[] {
    const uris = [doc.mainUri, doc.skinUri, doc.wtsUri];
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const uri of uris) {
        if (!uri || uri.scheme !== 'file') continue;
        const key = uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(uri);
    }
    return out;
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

/** Write prevalidated objmod bytes only when they differ from disk. Returns the bytes now on disk either
 *  way, so callers can update watcher bookkeeping without reading the file right back. */
async function writeBytesIfChanged(bytes: Buffer, uri: vscode.Uri): Promise<Buffer> {
    try {
        const existing = Buffer.from(await vscode.workspace.fs.readFile(uri));
        if (existing.equals(bytes)) return existing;
    } catch { /* file missing → write it */ }
    await vscode.workspace.fs.writeFile(uri, bytes);
    return bytes;
}

export function registerObjModPreview(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        'wurst.objModPreview',
        new ObjModEditorProvider(context.extensionUri),
        {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        },
    );
}
