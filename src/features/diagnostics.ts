'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export const MAX_DIAGNOSTIC_LINES = 100;
export const MAX_DIAGNOSTIC_LINE_LENGTH = 1024;
export const MAX_DIAGNOSTIC_REPORT_LENGTH = 24 * 1024;

export type DiagnosticSource = 'WC3 data' | 'MPQ' | 'Inline icons' | 'VS Code extension';

const recentLines = new Map<DiagnosticSource, string[]>();
const lastMessages = new Map<DiagnosticSource, { message: string; repeats: number }>();
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = getVsCode().window.createOutputChannel('WurstScript Extension');
        for (const [source, lines] of recentLines) {
            for (const line of lines) outputChannel.appendLine(`[${source}] ${line}`);
        }
    }
    return outputChannel;
}

function getVsCode(): typeof vscode {
    return require('vscode') as typeof vscode;
}

/** Local wall-clock time, so entries line up with languageServer.log. */
export function diagnosticTimestamp(date: Date = new Date()): string {
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Keep extension-side diagnostics available even though VS Code output channels are write-only. */
export function appendDiagnostic(source: DiagnosticSource, message: string): void {
    const lines = recentLines.get(source) ?? [];
    const timestamp = diagnosticTimestamp();
    const bounded = truncate(String(message), 4096);
    const previous = lastMessages.get(source);
    if (previous?.message === bounded) {
        previous.repeats++;
        const summary = `[${timestamp}] [occurrences: ${previous.repeats}]`;
        if (previous.repeats === 2) lines.push(summary);
        else lines[lines.length - 1] = summary;
        if (lines.length > MAX_DIAGNOSTIC_LINES) lines.shift();
        if (previous.repeats === 2 || previous.repeats % 100 === 0) outputChannel?.appendLine(`[${source}] ${summary}`);
        return;
    }
    lastMessages.set(source, { message: bounded, repeats: 1 });
    bounded.split(/\r?\n/).forEach((text, index) => {
        // Continuation lines (stack frames) keep their own indentation.
        const line = truncate(index === 0 ? `[${timestamp}] ${text}` : text, MAX_DIAGNOSTIC_LINE_LENGTH);
        lines.push(line);
        outputChannel?.appendLine(`[${source}] ${line}`);
    });
    if (lines.length > MAX_DIAGNOSTIC_LINES) {
        lines.splice(0, lines.length - MAX_DIAGNOSTIC_LINES);
    }
    recentLines.set(source, lines);
}

function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 14)} [truncated]`;
}

export function showDiagnosticOutput(): void {
    getOutputChannel().show(true);
}

export async function showErrorWithLogs(
    message: string,
    error: unknown,
    source: DiagnosticSource = 'VS Code extension',
): Promise<void> {
    appendDiagnostic(source, `${message}\n${formatDiagnosticError(error)}`);
    const choice = await getVsCode().window.showErrorMessage(message, 'View Logs');
    if (choice === 'View Logs') showDiagnosticOutput();
}

export async function showWarningWithLogs(
    message: string,
    error: unknown,
    source: DiagnosticSource = 'VS Code extension',
): Promise<void> {
    appendDiagnostic(source, `${message}\n${formatDiagnosticError(error)}`);
    const choice = await getVsCode().window.showWarningMessage(message, 'View Logs');
    if (choice === 'View Logs') showDiagnosticOutput();
}

export function formatDiagnosticError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    return String(error);
}

function readTail(filePath: string): string[] {
    try {
        const stat = fs.statSync(filePath);
        const bytesPerLine = 256;
        const maxBytes = MAX_DIAGNOSTIC_LINES * bytesPerLine;
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buffer, 0, buffer.length, start);
            const lines = buffer.toString('utf8').split(/\r?\n/);
            while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            if (start > 0 && lines.length > 0) lines.shift();
            return lines.slice(-MAX_DIAGNOSTIC_LINES);
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        return [`[unavailable: ${formatDiagnosticError(error)}]`];
    }
}

function section(title: string, lines: string[]): string[] {
    const bounded = lines.map((line) => truncate(line, MAX_DIAGNOSTIC_LINE_LENGTH)).join('\n');
    // Independent source budgets keep noisy subsystems from hiding server failures.
    const tail = bounded.length > 4096 ? `[older entries omitted]\n${bounded.slice(-4096)}` : bounded;
    return [`--- ${title} (last ${MAX_DIAGNOSTIC_LINES} lines) ---`, tail || '[no entries recorded]'];
}

/** A directory that is replaced by a short label wherever it starts a path in the report. */
export interface PathAlias {
    dir: string;
    label: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimTrailingSeparators(dir: string): string {
    let end = dir.length;
    while (end > 0 && (dir[end - 1] === '\\' || dir[end - 1] === '/')) end--;
    return dir.slice(0, end);
}

/**
 * Shortens absolute paths under the given directories. Longer directories win, separators match
 * either slash, and on Windows the match ignores case because drive letters are logged both ways.
 */
export function compactPaths(text: string, aliases: readonly PathAlias[], ignoreCase = process.platform === 'win32'): string {
    const sorted = aliases
        .map((alias) => ({ dir: trimTrailingSeparators(alias.dir), label: alias.label }))
        .filter((alias) => alias.dir.length > 1)
        .sort((a, b) => b.dir.length - a.dir.length);
    let result = text;
    for (const { dir, label } of sorted) {
        const pattern = dir.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
        // Whole path segments only: C:\Users\bob must not shorten C:\Users\bobby.
        result = result.replace(new RegExp(`${pattern}(?![\\w.-])`, ignoreCase ? 'gi' : 'g'), label);
    }
    return result;
}

function utcOffset(date: Date): string {
    const minutes = -date.getTimezoneOffset();
    const abs = Math.abs(minutes);
    return `UTC${minutes >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export interface DiagnosticsReportOptions {
    /** Environment lines shown under the title. */
    header?: string[];
    pathAliases?: readonly PathAlias[];
}

/** Build a compact, copy/paste-friendly report for remote diagnostics. */
export function buildDiagnosticsText(wurstHome: string, options: DiagnosticsReportOptions = {}): string {
    const now = new Date();
    const lines: string[] = [
        'WurstScript diagnostics',
        `Generated: ${now.toISOString()} (local ${diagnosticTimestamp(now)}, ${utcOffset(now)})`,
        `Wurst home: ${wurstHome}`,
        ...(options.header ?? []),
        '',
    ];
    lines.push(...section('WC3 data / CASC', recentLines.get('WC3 data') ?? []), '');
    lines.push(...section('MPQ archive viewer', recentLines.get('MPQ') ?? []), '');
    lines.push(...section('Inline icons', recentLines.get('Inline icons') ?? []), '');
    lines.push(...section('Wurst VS Code extension output', recentLines.get('VS Code extension') ?? []), '');
    lines.push(...section('languageServer.log', readTail(path.join(wurstHome, 'logs', 'languageServer.log'))));
    return truncate(compactPaths(lines.join('\n'), options.pathAliases ?? []), MAX_DIAGNOSTIC_REPORT_LENGTH);
}
