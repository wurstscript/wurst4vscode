'use strict';

/** VS Code preview for WC3 Object Modification files. Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseObjMod, ObjModFile, ObjModEntry, ObjModMod } from 'casc-ts/formats';
import { ParsedPreviewContext, registerParsedPreviewer } from './preview/framework';
import { findGameAsset } from './preview/cascStorage';
import { ensureGameTextureCached } from './blpPreview';
import { ensurePreview, getCandidateRoots, getTempPreviewDir, PreviewCacheEntry, resolveAssetPath } from './imageAssetSupport';
import { loadTriggerStringsForUri, resolveTriggerString, TriggerStringTable } from './preview/triggerStrings';
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

const NAME_FIELDS = new Set(['unam', 'inam', 'anam', 'bnam', 'dnam', 'fnam', 'gnam']);
const ICON_FIELDS = new Set(['uico', 'iico', 'aart', 'fart', 'gico']);
const OBJ_ICON_DIR = getTempPreviewDir('wurst_obj_icons');
const iconPreviewCache = new Map<string, PreviewCacheEntry>();

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
}

interface SlkTable {
    rows: Map<string, Record<string, string>>;
}

type ProfileTable = Map<string, Record<string, string>>;

const objEditorDataCache = new Map<string, Promise<ObjEditorData | undefined>>();
const objSummaryDataCache = new Map<string, Promise<ObjSummaryData | undefined>>();
const objProfileCache = new Map<string, Promise<ProfileTable>>();
let worldEditStringsPromise: Promise<Map<string, string>> | undefined;

async function parseObjModWithSibling(data: Buffer, fileName: string, context: ParsedPreviewContext): Promise<ObjModFile> {
    const parsed = parseObjMod(data, fileName.slice(fileName.lastIndexOf('.')));
    const siblingName = getObjModSiblingFileName(fileName);
    if (!siblingName) return parsed;

    try {
        const siblingUri = vscode.Uri.joinPath(context.uri, '..', siblingName);
        const siblingData = Buffer.from(await vscode.workspace.fs.readFile(siblingUri));
        const sibling = parseObjMod(siblingData, siblingName.slice(siblingName.lastIndexOf('.')));
        return fileName.toLowerCase().startsWith('war3mapskin.')
            ? mergeObjModFiles(sibling, parsed)
            : mergeObjModFiles(parsed, sibling);
    } catch {
        return parsed;
    }
}

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

function buildFieldRows(entry: ObjModEntry, gameData: ObjEditorData, triggerStrings: TriggerStringTable): PreviewMod[] {
    const overrideMods = new Map<string, ObjModMod[]>();
    for (const mod of entry.mods) {
        const key = modKey(mod);
        const list = overrideMods.get(key) ?? [];
        list.push(mod);
        overrideMods.set(key, list);
    }

    const rows: PreviewMod[] = [];
    const usedMods = new Set<ObjModMod>();
    for (const field of gameData.fields) {
        const levels = field.repeat > 0 ? getFieldLevels(entry.baseId, field, gameData) : [undefined];
        for (const level of levels) {
            const key = fieldKey(field.id, level, undefined);
            const override = overrideMods.get(key)?.[0] ?? findOverrideByField(entry.mods, field.id, level);
            if (override) usedMods.add(override);
            const baseValue = resolveBaseFieldValue(entry.baseId, field, gameData, level);
            if (!override && (baseValue === undefined || baseValue === '')) continue;
            const formattedOverride = override ? formatValue(override, triggerStrings) : undefined;
            const formattedBase = formatRawValue(baseValue, triggerStrings);
            const currentValue = formattedOverride ?? formattedBase;
            rows.push({
                key,
                fieldId: field.id,
                label: field.label,
                category: field.category || '-',
                type: field.type,
                level,
                dataPt: override?.dataPt,
                baseValue: formattedBase.value,
                overrideValue: formattedOverride?.value ?? '',
                currentValue: currentValue.value,
                overridden: Boolean(override),
                source: currentValue.source,
                missingSource: currentValue.missingSource,
            });
        }
    }

    for (const mod of entry.mods) {
        if (!usedMods.has(mod)) rows.push(buildOverrideOnlyMod(mod, triggerStrings, gameData));
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
    if (field.slkName.toLowerCase() === 'profile') {
        return gameData.profile.get(baseId)?.[resolveProfileField(field, level)];
    }
    const row = getBaseSlkRow(baseId, field, gameData);
    return row?.[resolveSlkField(field, level)];
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
    };
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

async function buildHtml(parsed: ObjModFile, fileName: string, context: ParsedPreviewContext): Promise<string> {
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
.error {
  color: var(--vscode-errorForeground, #f14c4c);
  border-bottom: 1px solid color-mix(in srgb, currentColor 65%, transparent);
  padding: 7px 16px;
  flex-shrink: 0;
}
.object-editor {
  flex: 1;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(230px, 30%) minmax(0, 1fr);
  overflow: hidden;
}
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
  padding: 6px 10px 4px;
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
  padding: 5px 10px 5px 22px;
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
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: center;
  padding: 5px 10px 5px 38px;
  color: var(--fg);
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  text-align: left;
  font: inherit;
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
  margin-top: 1px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
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
}
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
  .object-editor { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 34%) minmax(0, 1fr); }
  .object-list { border-right: 0; border-bottom: 1px solid var(--border); }
}
`,
        body: `<div class="content">
<div class="md-header">
  <div class="md-title">${escapeHtml(fileName)}</div>
  <div class="md-meta">WC3 ${escapeHtml(typeLabel)} object data - v${parsed.version} - ${escapeHtml(summary)} - ${escapeHtml(metadataSource)}${parsed.extended ? ' - extended (level/dataPt)' : ''}<span class="readonly-badge">read-only</span></div>
</div>
${errorBanner}
<div class="object-editor">
  <aside class="object-list">
    <div class="search-wrap"><input id="search" class="search-input" placeholder="Search objects or IDs" aria-label="Search objects"></div>
    <div id="tree" class="tree"></div>
  </aside>
  <main id="details" class="details"></main>
</div>
<script>
const objects = ${safeJson};
let selectedKey = ${JSON.stringify(firstKey)};
let query = '';
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
          '<span class="mod-count">' + obj.overridesCount + '</span>' +
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
    loadedIcons.set(msg.key, msg.uri);
    updateIconElements(msg.key, el => setIconLoaded(el, msg.uri));
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
  }
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
  const rows = (mods || []).map(mod => {
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
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '">' +
      fieldCell +
      '<td class="value current">' + esc(mod.currentValue) + (mod.overridden ? '<span class="override-badge">modified</span>' : '') + sourcePill(mod) + '</td>' +
    '</tr>';
  }).join('');

  details.innerHTML = '<div class="details-head">' +
    '<div class="details-title">' + esc(obj.displayName) + (obj.displaySource ? sourcePill({ source: obj.displaySource }) : '') + '</div>' +
    '<div class="details-meta">' +
      '<span class="chip">' + esc(obj.group) + '</span>' +
      '<span class="chip">base rawcode ' + esc(obj.baseId) + '</span>' +
      (obj.newId ? '<span class="chip">mod rawcode ' + esc(obj.newId) + '</span>' : '') +
      '<span class="chip">' + esc(raceLabel(obj.race)) + '</span>' +
      '<span class="chip">' + obj.overridesCount + ' override' + (obj.overridesCount === 1 ? '' : 's') + '</span>' +
      (mods ? '<span class="chip">' + mods.length + ' shown field' + (mods.length === 1 ? '' : 's') + '</span>' : '<span class="chip">loading fields</span>') +
      '<label class="chip toggle-chip"><input id="technical-toggle" type="checkbox" ' + (showTechnical ? 'checked' : '') + '> technical</label>' +
    '</div>' +
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

render();
</script>
</div>`,
    });
}

async function handleObjModMessage(message: unknown, webview: vscode.Webview, _parsed: ObjModFile, context: ParsedPreviewContext): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; key?: string; iconPath?: string };
    if (msg.type === 'loadObjectDetails' && msg.key) {
        await loadObjectDetails(msg.key, webview, _parsed, context);
        return;
    }
    if (msg.type !== 'loadObjectIcon' || !msg.key || !msg.iconPath) return;

    const roots = await getCandidateRoots(context.uri.fsPath);
    const fsPath = await resolveAssetPath(msg.iconPath, roots) ?? await ensureGameTextureCached(msg.iconPath);
    if (!fsPath) {
        await webview.postMessage({ type: 'objectIconMissing', key: msg.key });
        return;
    }

    const preview = await ensurePreview(fsPath, OBJ_ICON_DIR, 32, iconPreviewCache);
    if (!preview) {
        await webview.postMessage({ type: 'objectIconMissing', key: msg.key });
        return;
    }

    await webview.postMessage({
        type: 'objectIconLoaded',
        key: msg.key,
        uri: webview.asWebviewUri(vscode.Uri.file(preview.previewPath)).toString(),
    });
}

async function loadObjectDetails(key: string, webview: vscode.Webview, parsed: ObjModFile, context: ParsedPreviewContext): Promise<void> {
    const entry = findEntryByKey(parsed, key);
    if (!entry) {
        await webview.postMessage({ type: 'objectDetailsFailed', key });
        return;
    }

    const triggerStrings = loadTriggerStringsForUri(context.uri);
    const gameData = await loadObjEditorData(parsed.ext);
    const mods = gameData
        ? buildFieldRows(entry, gameData, triggerStrings)
        : entry.mods.map((mod) => buildOverrideOnlyMod(mod, triggerStrings, gameData));
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

export function registerObjModPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return registerParsedPreviewer<ObjModFile>({
        viewType: 'wurst.objModPreview',
        parse:  (data, fileName, context) => parseObjModWithSibling(data, fileName, context),
        render: (parsed, fileName, context) => buildHtml(parsed, fileName, context),
        onMessage: handleObjModMessage,
        webviewOptions: {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(OBJ_ICON_DIR),
                ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
            ],
        },
        panelOptions: { retainContextWhenHidden: true },
    });
}
