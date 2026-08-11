'use strict';

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

export const MAX_DIAGNOSTIC_LINES = 100;

export type DiagnosticSource = 'WC3 data' | 'MPQ' | 'Inline icons' | 'VS Code extension';

const recentLines = new Map<DiagnosticSource, string[]>();
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

/** Keep extension-side diagnostics available even though VS Code output channels are write-only. */
export function appendDiagnostic(source: DiagnosticSource, message: string): void {
    const lines = recentLines.get(source) ?? [];
    for (const line of String(message).split(/\r?\n/)) {
        lines.push(line);
        outputChannel?.appendLine(`[${source}] ${line}`);
    }
    if (lines.length > MAX_DIAGNOSTIC_LINES) {
        lines.splice(0, lines.length - MAX_DIAGNOSTIC_LINES);
    }
    recentLines.set(source, lines);
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
    return [`--- ${title} (last ${MAX_DIAGNOSTIC_LINES} lines) ---`, ...(lines.length ? lines : ['[no entries recorded]'])];
}

/** Build a compact, copy/paste-friendly report for remote diagnostics. */
export function buildDiagnosticsText(wurstHome: string): string {
    const lines: string[] = [
        'WurstScript diagnostics',
        `Generated: ${new Date().toISOString()}`,
        `Wurst home: ${wurstHome}`,
        '',
    ];
    lines.push(...section('WC3 data / CASC', recentLines.get('WC3 data') ?? []), '');
    lines.push(...section('MPQ archive viewer', recentLines.get('MPQ') ?? []), '');
    lines.push(...section('Inline icons', recentLines.get('Inline icons') ?? []), '');
    lines.push(...section('Wurst VS Code extension output', recentLines.get('VS Code extension') ?? []), '');
    lines.push(...section('languageServer.log', readTail(path.join(wurstHome, 'logs', 'languageServer.log'))));
    return lines.join('\n');
}
