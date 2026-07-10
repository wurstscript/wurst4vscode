'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

const ISSUE_URL = 'https://github.com/wurstscript/wurst4vscode/issues/new';
const seenFailures = new Set<string>();
let promptActive = false;

export interface ExtensionIssue {
    area: string;
    message: string;
    resource?: vscode.Uri;
    details?: string;
}

function extensionVersion(): string {
    return String(vscode.extensions.getExtension('peterzeller.wurst')?.packageJSON?.version ?? 'development');
}

function resourceName(resource?: vscode.Uri): string {
    if (!resource) return '(not provided)';
    return path.basename(resource.fsPath || resource.path) || '(unknown)';
}

function diagnostics(issue: ExtensionIssue): string {
    return [
        `Wurst extension: ${extensionVersion()}`,
        `VS Code: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Area: ${issue.area}`,
        `Resource: ${resourceName(issue.resource)}`,
        `Error: ${issue.message}`,
        issue.details ? `Details:\n${issue.details}` : '',
    ].filter(Boolean).join('\n');
}

function publicMessage(issue: ExtensionIssue): string {
    let message = issue.message;
    for (const localPath of [issue.resource?.fsPath, issue.resource?.path]) {
        if (!localPath) continue;
        message = message.split(localPath).join(resourceName(issue.resource));
    }
    return message.slice(0, 1500);
}

function issueUrl(issue?: ExtensionIssue): vscode.Uri {
    const safeMessage = issue ? publicMessage(issue) : '';
    const title = issue ? `[Extension] ${issue.area}: ${safeMessage}`.slice(0, 120) : '[Extension] ';
    const body = issue ? [
        '### What happened?',
        '',
        '<!-- Please add the steps that triggered the problem. -->',
        '',
        '### Diagnostics',
        '',
        '```text',
        diagnostics({ ...issue, message: safeMessage, details: undefined }),
        '```',
        '',
        '### Additional context',
        '',
        '- Does this file work in Warcraft III or another tool?',
        '- Can you attach a small reproducing file if its contents are safe to share?',
    ].join('\n') : [
        '### What happened?',
        '',
        '<!-- Please describe the problem and how to reproduce it. -->',
        '',
        '### Environment',
        '',
        '```text',
        `Wurst extension: ${extensionVersion()}`,
        `VS Code: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        '```',
    ].join('\n');
    return vscode.Uri.parse(`${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
}

export async function openIssueReport(issue?: ExtensionIssue): Promise<void> {
    await vscode.env.openExternal(issueUrl(issue));
}

function failureKey(issue: ExtensionIssue): string {
    return `${issue.area}\n${issue.message}`
        .toLowerCase()
        .replace(/[a-f0-9]{7,40}/g, '<hash>')
        .replace(/\d+/g, '<n>')
        .slice(0, 500);
}

/** Offer a non-modal, privacy-preserving report action once per failure shape and session. */
export function offerIssueReport(issue: ExtensionIssue): void {
    const enabled = vscode.workspace.getConfiguration('wurst').get<boolean>('issueReportingHints', true);
    const key = failureKey(issue);
    if (!enabled || promptActive || seenFailures.has(key)) return;
    seenFailures.add(key);
    promptActive = true;

    void (async () => {
        try {
            const choice = await vscode.window.showInformationMessage(
                `The ${issue.area} failed. If this file works in Warcraft III, this may be an extension compatibility issue.`,
                'Report Issue',
                'Copy Diagnostics',
                "Don't Show Again",
            );
            if (choice === 'Report Issue') {
                await openIssueReport(issue);
            } else if (choice === 'Copy Diagnostics') {
                await vscode.env.clipboard.writeText(diagnostics(issue));
                void vscode.window.showInformationMessage('Wurst extension diagnostics copied to the clipboard.');
            } else if (choice === "Don't Show Again") {
                await vscode.workspace.getConfiguration('wurst').update(
                    'issueReportingHints', false, vscode.ConfigurationTarget.Global,
                );
            }
        } finally {
            promptActive = false;
        }
    })();
}
