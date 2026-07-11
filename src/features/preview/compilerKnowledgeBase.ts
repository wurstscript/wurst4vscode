'use strict';

import * as fs from 'fs';
import * as path from 'path';
import StreamZip = require('node-stream-zip');
import { COMPILER_JAR } from '../../paths';

const RESOURCE_NAME = 'wc3-knowledge-base.json';
const SUPPORTED_SCHEMA_VERSION = 1;
const BUNDLED_RESOURCE = path.join(__dirname, '..', 'resources', RESOURCE_NAME);

export interface CompilerFieldSchema {
    id: string;
    field: string;
    slk: string;
    index: number | null;
    repeat: number;
    data: number;
    category: string;
    displayName: string;
    sort: string;
    type: string;
    minVal: string | null;
    maxVal: string | null;
    useHero: boolean;
    useUnit: boolean;
    useBuilding: boolean;
    useItem: boolean;
    useCreep: boolean;
    useSpecific: string[];
    notSpecific: string[];
    canBeEmpty: boolean;
    forceNonNeg: boolean;
    section: string | null;
}

export type CompilerObjectRecord = Record<string, string | number>;
export type CompilerObjectRecords = Record<string, CompilerObjectRecord>;
export type CompilerObjectKind = 'unit' | 'hero' | 'building' | 'item' | 'ability' | 'buff' | 'destructable' | 'upgrade';

export interface CompilerKnowledgeBase {
    schemaVersion: number;
    buildingBaseIds: string[];
    heroBaseIds: string[];
    fieldSchemas: Record<CompilerObjectKind, CompilerFieldSchema[]>;
    objects: Record<Exclude<CompilerObjectKind, 'hero' | 'building'>, CompilerObjectRecords>;
}

const profileViews = new WeakMap<CompilerObjectRecords, Map<string, Record<string, string>>>();
const lowercaseViews = new WeakMap<CompilerObjectRecords, Map<string, CompilerObjectRecord>>();

/** Reuses one string/profile view per compiler record set instead of copying the 9 MB data per consumer. */
export function compilerProfileView(records: CompilerObjectRecords): Map<string, Record<string, string>> {
    let view = profileViews.get(records);
    if (!view) {
        view = new Map(Object.entries(records).map(([id, record]) => [
            id, Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)])),
        ]));
        profileViews.set(records, view);
    }
    return view;
}

export function compilerLowercaseObjectView(records: CompilerObjectRecords): Map<string, CompilerObjectRecord> {
    let view = lowercaseViews.get(records);
    if (!view) {
        view = new Map(Object.entries(records).map(([id, record]) => [id.toLowerCase(), record]));
        lowercaseViews.set(records, view);
    }
    return view;
}

let cachedStamp = '';
let cachedPromise: Promise<CompilerKnowledgeBase | undefined> | undefined;

/** Reads the version-matched game-data knowledge base bundled in the installed compiler JAR. */
export function loadCompilerKnowledgeBase(): Promise<CompilerKnowledgeBase | undefined> {
    const stamp = [COMPILER_JAR, BUNDLED_RESOURCE].map((file) => {
        try {
            const stat = fs.statSync(file);
            return `${file}:${stat.size}:${stat.mtimeMs}`;
        } catch { return `${file}:missing`; }
    }).join('|');
    if (!cachedPromise || cachedStamp !== stamp) {
        cachedStamp = stamp;
        cachedPromise = readKnowledgeBase();
    }
    return cachedPromise;
}

async function readKnowledgeBase(): Promise<CompilerKnowledgeBase | undefined> {
    if (fs.existsSync(COMPILER_JAR)) {
        const zip = new StreamZip.async({ file: COMPILER_JAR });
        try {
            const entry = await zip.entry(RESOURCE_NAME);
            if (entry) {
                const parsed = parseKnowledgeBase((await zip.entryData(entry)).toString('utf8'));
                if (parsed) return parsed;
            }
        } catch {
            // A missing/old/busy compiler must not prevent the standalone editor from working.
        } finally {
            await zip.close().catch(() => undefined);
        }
    }
    try {
        return parseKnowledgeBase(await fs.promises.readFile(BUNDLED_RESOURCE, 'utf8'));
    } catch { return undefined; }
}

function parseKnowledgeBase(text: string): CompilerKnowledgeBase | undefined {
    const parsed = JSON.parse(text) as CompilerKnowledgeBase;
    return parsed.schemaVersion === SUPPORTED_SCHEMA_VERSION && parsed.fieldSchemas && parsed.objects
        ? parsed
        : undefined;
}
