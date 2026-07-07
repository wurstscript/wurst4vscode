'use strict';

/**
 * Generic WC3 game-data loaders shared across the binary previewers
 * (objMod, doo, map-data, triggers). No VS Code imports, no objmod-specific logic.
 *
 * Reads game files out of CASC via `findGameAsset` and parses the common WC3
 * text formats: SLK tables, profile/skin TXT (INI-like), and flat key=value
 * string tables (WorldEditStrings etc.).
 */

import { findGameAsset } from './cascStorage';

export interface SlkTable {
    rows: Map<string, Record<string, string>>;
}

export type ProfileTable = Map<string, Record<string, string>>;

// Profile/skin TXT files that hold object display names + art, per object kind.
// Reforged splits art into the *Skin.txt files; load them after the classic
// Func/Strings files so skin art overlays base metadata deterministically.
export const UNIT_PROFILE_PATHS = [
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
    'Units\\UnitSkin.txt',
];

export const ABILITY_PROFILE_PATHS = [
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
    'Units\\AbilitySkin.txt',
];

export const UPGRADE_PROFILE_PATHS = [
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
    'Units\\UpgradeSkin.txt',
];

export const ITEM_PROFILE_PATHS = ['Units\\ItemFunc.txt', 'Units\\ItemStrings.txt', 'Units\\ItemSkin.txt'];
export const DESTRUCTABLE_PROFILE_PATHS = ['Units\\DestructableSkin.txt'];
export const DOODAD_PROFILE_PATHS = ['Doodads\\DoodadSkins.txt'];

export async function readGameData(assetPath: string): Promise<Buffer | null> {
    return findGameAsset(assetPath, (msg) => console.log(`[wurst-wc3-data] ${msg}`));
}

const DEFAULT_WATER_LEVEL_UNITS = 89.6;
let terrainWaterLevelsPromise: Promise<Map<string, number>> | undefined;
let tilesetBlightTexturesPromise: Promise<Map<string, string>> | undefined;

export async function loadTerrainWaterLevel(tileset: string): Promise<number> {
    if (!terrainWaterLevelsPromise) terrainWaterLevelsPromise = loadTerrainWaterLevelsUncached();
    const levels = await terrainWaterLevelsPromise;
    return levels.get(`${tileset}Sha`) ?? DEFAULT_WATER_LEVEL_UNITS;
}

async function loadTerrainWaterLevelsUncached(): Promise<Map<string, number>> {
    const levels = new Map<string, number>();
    const buf = await readGameData('TerrainArt\\Water.slk');
    if (!buf) return levels;
    for (const [id, row] of parseSlk(buf.toString('utf8')).rows) {
        const raw = slkFieldCI(row, ['waterlevel', 'height']);
        if (raw === undefined) continue;
        const value = Number(raw);
        if (Number.isFinite(value)) levels.set(id, value * 128);
    }
    return levels;
}

export async function loadTilesetBlightTexture(tileset: string): Promise<string | undefined> {
    if (!tilesetBlightTexturesPromise) tilesetBlightTexturesPromise = loadTilesetBlightTexturesUncached();
    const textures = await tilesetBlightTexturesPromise;
    return textures.get(tileset);
}

async function loadTilesetBlightTexturesUncached(): Promise<Map<string, string>> {
    const textures = new Map<string, string>();
    const buf = await readGameData('UI\\WorldEditData.txt');
    if (!buf) return textures;
    const data = parseProfile(buf.toString('utf8'));
    const tilesets = data.get('TileSets');
    if (!tilesets) return textures;
    for (const [key, value] of Object.entries(tilesets)) {
        if (!key) continue;
        const fields = value.split(',').map((part) => stripTxtQuotes(part.trim())).filter(Boolean);
        if (fields.length > 1) textures.set(key[0], fields[1].toLowerCase().endsWith('.dds') ? fields[1] : `${fields[1]}.dds`);
    }
    return textures;
}

function slkFieldCI(row: Record<string, string>, names: string[]): string | undefined {
    const entries = Object.entries(row);
    for (const name of names) {
        const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
        if (found && found[1] !== '') return found[1];
    }
    return undefined;
}

export function parseSlk(text: string): SlkTable {
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
        const id = row.ID || row.tileID || row.cliffID || row.unitID || row.itemID || row.alias || row.doodID || row.destID || row.upgradeID || row.buffID;
        if (id) rows.set(id, row);
    }
    return { rows };
}

export function parseSlkValue(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed;
}

export function parseProfile(text: string): ProfileTable {
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

export function parseKeyValues(text: string): Array<[string, string]> {
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

export function mergeProfile(target: ProfileTable, source: ProfileTable): void {
    for (const [section, fields] of source) {
        const merged = { ...(target.get(section) ?? {}) };
        for (const [key, value] of Object.entries(fields)) {
            if (value !== '') merged[key] = value;
        }
        target.set(section, merged);
    }
}

export function stripTxtQuotes(value: string): string {
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export async function loadProfilePaths(profilePaths: string[]): Promise<ProfileTable> {
    const profile = new Map<string, Record<string, string>>();
    for (const profilePath of profilePaths) {
        const buf = await readGameData(profilePath);
        if (buf) mergeProfile(profile, parseProfile(buf.toString('utf8')));
    }
    return profile;
}

let worldEditStringsPromise: Promise<Map<string, string>> | undefined;

export async function loadWorldEditStrings(): Promise<Map<string, string>> {
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

/** Resolve a possibly-WESTRING_ reference to its localized value (follows chained refs). */
export function resolveWorldEditString(value: string, strings: Map<string, string>): string | undefined {
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
