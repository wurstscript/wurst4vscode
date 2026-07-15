'use strict';

/**
 * Shared rawcode → display-info catalog for the WC3 binary previewers.
 *
 * Resolves a 4-char object rawcode (unit/item/ability/doodad/destructable/upgrade)
 * to a human-readable name plus icon/model asset paths, built from the game's
 * profile/skin TXT files and a few SLK tables, resolved through WorldEditStrings.
 *
 * Used by the doo, map-data and trigger previewers to turn raw ids into the
 * named, icon-decorated rows that beat the World Editor's bare-rawcode display.
 * The objMod editor keeps its own richer catalog (it also needs editable value
 * options); this is the lighter, read-only superset keyed per rawcode.
 */

import {
    loadProfilePaths, loadWorldEditStrings, resolveWorldEditString,
    readGameData, parseSlk, ProfileTable,
    UNIT_PROFILE_PATHS, ABILITY_PROFILE_PATHS, UPGRADE_PROFILE_PATHS,
    ITEM_PROFILE_PATHS, DESTRUCTABLE_PROFILE_PATHS, DOODAD_PROFILE_PATHS,
} from './wc3Data';
import { compilerProfileView, loadCompilerKnowledgeBase } from './compilerKnowledgeBase';

export interface ObjectRef {
    name?: string;
    iconPath?: string;
    modelPath?: string;
}

const ALL_PROFILE_PATHS = [
    ...UNIT_PROFILE_PATHS,
    ...ABILITY_PROFILE_PATHS,
    ...UPGRADE_PROFILE_PATHS,
    ...ITEM_PROFILE_PATHS,
    ...DESTRUCTABLE_PROFILE_PATHS,
    ...DOODAD_PROFILE_PATHS,
];

// SLK name/model sources for objects whose names/models live in tables, not profiles
// (doodads & destructables in particular). value = [slkPath, modelColumns].
const SLK_NAME_SOURCES: Array<{ path: string; modelKeys: string[] }> = [
    { path: 'Doodads\\Doodads.slk', modelKeys: ['file'] },
    { path: 'Units\\DestructableData.slk', modelKeys: ['file'] },
    { path: 'Units\\UnitData.slk', modelKeys: ['file'] },
    { path: 'Units\\ItemData.slk', modelKeys: ['file'] },
];

const DISPLAY_NAME_FIELDS = ['Name', 'name', 'EditorName', 'Editorname', 'Bufftip', 'BuffTip', 'Tip', 'tip', 'comment', 'comments'];

let catalogPromise: Promise<Map<string, ObjectRef>> | undefined;

/** Cached rawcode → {name, iconPath, modelPath}, keyed by lowercased rawcode. */
export function getObjectCatalog(): Promise<Map<string, ObjectRef>> {
    if (!catalogPromise) catalogPromise = buildCatalog();
    return catalogPromise;
}

/** Reset the cache (e.g. when the game install / CASC source changes). */
export function resetObjectCatalog(): void {
    catalogPromise = undefined;
}

async function buildCatalog(): Promise<Map<string, ObjectRef>> {
    const worldStrings = await loadWorldEditStrings();
    const catalog = new Map<string, ObjectRef>();

    const kb = await loadCompilerKnowledgeBase();
    if (kb) {
        for (const records of Object.values(kb.objects)) {
            addProfileEntries(catalog, compilerProfileView(records), worldStrings);
        }
        // Doodads are not included in knowledge-base schema v1.
        addProfileEntries(catalog, await loadProfilePaths(DOODAD_PROFILE_PATHS), worldStrings);
    } else {
        addProfileEntries(catalog, await loadProfilePaths(ALL_PROFILE_PATHS), worldStrings);
    }

    await Promise.all(SLK_NAME_SOURCES.map(async (src) => {
        const buf = await readGameData(src.path);
        if (!buf) return;
        addSlkEntries(catalog, parseSlk(buf.toString('utf8')).rows, src.modelKeys, worldStrings);
    }));

    return catalog;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
function addProfileEntries(catalog: Map<string, ObjectRef>, profile: ProfileTable, worldStrings: Map<string, string>): void {
    for (const [id, row] of profile) {
        const ref = ensureRef(catalog, id);
        if (!ref.name) {
            const raw = pickFirst(row, DISPLAY_NAME_FIELDS);
            const name = raw ? resolveWorldEditString(raw, worldStrings) : undefined;
            if (name && name !== '-') ref.name = name;
        }
        for (const [key, value] of Object.entries(row)) {
            if (!ref.iconPath) {
                const icon = profileIconPath(key, value);
                if (icon) ref.iconPath = icon;
            }
            if (!ref.modelPath) {
                const model = profileModelPath(key, value);
                if (model) ref.modelPath = model;
            }
        }
    }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
function addSlkEntries(
    catalog: Map<string, ObjectRef>,
    rows: Map<string, Record<string, string>>,
    modelKeys: string[],
    worldStrings: Map<string, string>,
): void {
    for (const [id, row] of rows) {
        const ref = ensureRef(catalog, id);
        if (!ref.name) {
            const raw = pickFirst(row, DISPLAY_NAME_FIELDS);
            const name = raw ? resolveWorldEditString(raw, worldStrings) : undefined;
            if (name && name !== '-') ref.name = name;
        }
        if (!ref.modelPath) {
            for (const key of modelKeys) {
                const model = normalizeModelPath(row[key]);
                if (model) { ref.modelPath = model; break; }
            }
        }
    }
}

function ensureRef(catalog: Map<string, ObjectRef>, id: string): ObjectRef {
    const key = id.toLowerCase();
    let ref = catalog.get(key);
    if (!ref) { ref = {}; catalog.set(key, ref); }
    return ref;
}

function pickFirst(row: Record<string, string>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = row[key];
        if (value !== undefined && value !== '') return value;
    }
    return undefined;
}

// ── asset-path heuristics (mirrors objModPreview's profile normalizers) ──────────

/** First comma-segment of a value, unquoted; undefined for blanks, '-', or WESTRING_ refs. */
function firstAssetPath(value: string | undefined): string | undefined {
    const first = String(value ?? '').split(',')[0].trim().replace(/^"|"$/g, '');
    return (!first || first === '-' || first.startsWith('WESTRING_')) ? undefined : first;
}

function profileIconPath(key: string, value: string): string | undefined {
    if (!/(art|icon|button|research)/i.test(key)) return undefined;
    const first = firstAssetPath(value);
    if (!first || !/\.(blp|dds|tga|png|jpe?g)$/i.test(first)) return undefined;
    return first.replace(/\//g, '\\');
}

function profileModelPath(key: string, value: string): string | undefined {
    if (!/(file|model)/i.test(key)) return undefined;
    const first = firstAssetPath(value);
    if (!first || (!/[\\/]/.test(first) && !/\.(mdx|mdl)$/i.test(first))) return undefined;
    return normalizeModelPath(first);
}

function normalizeModelPath(value: string | undefined): string | undefined {
    const first = firstAssetPath(value);
    if (!first) return undefined;
    const normalized = first.replace(/\//g, '\\');
    return /\.(mdx|mdl)$/i.test(normalized) ? normalized : `${normalized}.mdl`;
}
