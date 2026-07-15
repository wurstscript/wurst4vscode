'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type TriggerStringTable = Map<number, string>;

export type ResolvedText = {
    value: string | number | undefined;
    source?: string;
    missing?: boolean;
};

export function resolveTriggerString(value: string | undefined, triggerStrings: TriggerStringTable): ResolvedText {
    if (!value) return { value };
    const match = /^TRIGSTR_(\d+)$/i.exec(value.trim());
    if (!match) return { value };

    const source = value.trim();
    const resolved = triggerStrings.get(Number(match[1]));
    if (resolved === undefined) {
        return { value, source, missing: true };
    }
    return { value: resolved, source };
}

export function loadTriggerStringsForUri(uri: vscode.Uri): TriggerStringTable {
    const table: TriggerStringTable = new Map();
    if (uri.scheme !== 'file' || !uri.fsPath) return table;

    const dir = path.dirname(uri.fsPath);
    let wtsPath: string | undefined;
    try {
        wtsPath = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === 'war3map.wts');
    } catch {
        return table;
    }
    if (!wtsPath) return table;

    try {
        return parseWts(fs.readFileSync(path.join(dir, wtsPath), 'utf8'));
    } catch {
        return table;
    }
}

/** Locate the war3map.wts beside a data file. Returns its uri (existing or the default target) and whether it exists. */
export function findWtsUri(uri: vscode.Uri): { uri: vscode.Uri | undefined; exists: boolean } {
    if (uri.scheme !== 'file' || !uri.fsPath) return { uri: undefined, exists: false };
    const dir = path.dirname(uri.fsPath);
    try {
        const existing = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === 'war3map.wts');
        if (existing) return { uri: vscode.Uri.file(path.join(dir, existing)), exists: true };
    } catch {
        return { uri: undefined, exists: false };
    }
    return { uri: vscode.Uri.file(path.join(dir, 'war3map.wts')), exists: false };
}

/** Next free trigger-string id (max existing + 1, floored at 1). */
export function nextTriggerStringId(table: TriggerStringTable): number {
    let max = 0;
    for (const id of table.keys()) if (id > max) max = id;
    return max + 1;
}

/**
 * Surgically upsert the given trigger strings into an existing war3map.wts text,
 * preserving everything else (comments, untouched entries, ordering). Appends new
 * blocks for ids not already present. Pass '' as originalText to create a new file.
 */
export function applyWtsEdits(originalText: string, edits: Map<number, string>): string {
    let text = originalText;
    for (const [id, value] of edits) {
        const body = value.replace(/\r?\n/g, '\r\n');
        const block = `STRING ${id}\r\n{\r\n${body}\r\n}`;
        const re = new RegExp(`STRING\\s+${id}\\b[\\s\\S]*?\\{[\\s\\S]*?\\}`);
        if (re.test(text)) {
            text = text.replace(re, block);
        } else {
            // eslint-disable-next-line sonarjs/super-linear-regex -- literal char + single char-class quantifier anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
            if (text.length && !/\n\s*$/.test(text)) text += '\r\n';
            text += `\r\n${block}\r\n`;
        }
    }
    return text;
}

function parseWts(text: string): TriggerStringTable {
    const table: TriggerStringTable = new Map();
    const re = /STRING\s+(\d+)(?:\s|\/\/[^\r\n]*(?:\r?\n|$))*\{([\s\S]*?)\}/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        table.set(Number(match[1]), normalizeWtsValue(match[2]));
    }
    return table;
}

function normalizeWtsValue(value: string): string {
    return value
        .replace(/^\s*\r?\n/, '')
        // eslint-disable-next-line sonarjs/super-linear-regex -- optional literal + single char-class quantifier anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
        .replace(/\r?\n\s*$/, '')
        .replace(/\r\n/g, '\n');
}
