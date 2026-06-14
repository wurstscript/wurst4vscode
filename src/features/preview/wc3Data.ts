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
// Reforged splits art into the *Skin.txt files; classic names live in the Func/Strings pairs.
export const UNIT_PROFILE_PATHS = [
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

export const ABILITY_PROFILE_PATHS = [
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

export const UPGRADE_PROFILE_PATHS = [
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

export const ITEM_PROFILE_PATHS = ['Units\\ItemSkin.txt', 'Units\\ItemFunc.txt', 'Units\\ItemStrings.txt'];
export const DESTRUCTABLE_PROFILE_PATHS = ['Units\\DestructableSkin.txt'];
export const DOODAD_PROFILE_PATHS = ['Doodads\\DoodadSkins.txt'];

export async function readGameData(assetPath: string): Promise<Buffer | null> {
    return findGameAsset(assetPath, (msg) => console.log(`[wurst-wc3-data] ${msg}`));
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
        const id = row.ID || row.unitID || row.itemID || row.alias || row.doodID || row.destID || row.upgradeID || row.buffID;
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
    await Promise.all(profilePaths.map(async (profilePath) => {
        const buf = await readGameData(profilePath);
        if (buf) mergeProfile(profile, parseProfile(buf.toString('utf8')));
    }));
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
