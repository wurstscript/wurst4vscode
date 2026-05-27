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

function parseWts(text: string): TriggerStringTable {
    const table: TriggerStringTable = new Map();
    const re = /STRING\s+(\d+)\s*\{([\s\S]*?)\}/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        table.set(Number(match[1]), normalizeWtsValue(match[2]));
    }
    return table;
}

function normalizeWtsValue(value: string): string {
    return value
        .replace(/^\s*\r?\n/, '')
        .replace(/\r?\n\s*$/, '')
        .replace(/\r\n/g, '\n');
}
