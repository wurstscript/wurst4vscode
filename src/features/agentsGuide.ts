'use strict';

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { appendDiagnostic, formatDiagnosticError, showErrorWithLogs } from './diagnostics';
import { showThreeChoiceOffer } from './notificationOffer';

const PROMPT_STATE_PREFIX = 'wurst.agentsGuidePromptDismissed:';
const UPDATE_PROMPT_STATE_PREFIX = 'wurst.agentsGuideUpdatePromptDismissed:';
const AGENTS_GUIDE_URL = 'https://raw.githubusercontent.com/wurstscript/WurstSetup/master/templates/AGENTS.md';
const AGENTS_TEMPLATE_VERSION = '2026-09-06';
const TEMPLATE_CACHE_KEY = 'wurst.agentsGuideTemplate';
const BASELINE_PREFIX = 'wurst.agentsGuideBaseline:';
const AGENTS_TEMPLATE_MARKER_PREFIX = '<!-- WURST_AGENTS_TEMPLATE_VERSION:';
const AGENTS_TEMPLATE_MARKER = `<!-- WURST_AGENTS_TEMPLATE_VERSION: ${AGENTS_TEMPLATE_VERSION} -->`;
const AGENTS_TEMPLATE_SOURCE_HINT = 'WurstScript Warcraft III map project notes';
const CREATE_ACTION = 'Create AGENTS.md';
const NEVER_CREATE_ACTION = "Don't Ask Again";
const REVIEW_UPDATE_ACTION = 'Review Update';
const NEVER_UPDATE_STATE_PREFIX = 'wurst.agentsGuideUpdateNever:';

type AgentsGuideOffer =
    | { kind: 'create'; folder: vscode.WorkspaceFolder; stateKey: string }
    | { kind: 'update'; folder: vscode.WorkspaceFolder; stateKey: string; neverStateKey: string; warning: string };

export function registerAgentsGuideOffer(context: vscode.ExtensionContext): vscode.Disposable {
    const offer = () => {
        void offerAgentsGuide(context).catch((error) => appendDiagnostic('VS Code extension', `AGENTS.md offer failed: ${formatDiagnosticError(error)}`));
    };

    offer();

    return vscode.workspace.onDidChangeWorkspaceFolders(offer);
}

async function offerAgentsGuide(context: vscode.ExtensionContext): Promise<void> {
    const offer = await findFolderToOffer(context);
    if (!offer) {
        return;
    }

    const { folder, stateKey } = offer;
    if (offer.kind === 'update') {
        const choice = await showThreeChoiceOffer(
            `${offer.warning} Review the current WurstSetup template?`,
            REVIEW_UPDATE_ACTION,
        );

        if (choice === 'primary') {
            await prepareAgentsGuideUpdate(context, folder);
            await context.workspaceState.update(stateKey, true);
            return;
        }
        if (choice === 'never') {
            await context.globalState.update(offer.neverStateKey, true);
            return;
        }
        return;
    }

    const choice = await vscode.window.showInformationMessage(
        `Add an AGENTS.md guide for AI coding agents in "${folder.name}"?`,
        CREATE_ACTION,
        NEVER_CREATE_ACTION
    );

    if (choice === CREATE_ACTION) {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Creating AGENTS.md', cancellable: false },
                async () => createAgentsGuide(folder, context)
            );
            await context.workspaceState.update(stateKey, true);
            const open = await vscode.window.showInformationMessage('Created AGENTS.md for this Wurst project.', 'Open');
            if (open === 'Open') {
                await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, 'AGENTS.md')));
            }
        } catch (err: any) {
            if (err?.code === 'EEXIST') {
                await context.workspaceState.update(stateKey, true);
                await vscode.window.showInformationMessage('This Wurst project already has an AGENTS.md.');
            } else {
                void showErrorWithLogs(`Failed to create AGENTS.md: ${err?.message ?? String(err)}`, err);
            }
        }
        return;
    }

    await context.workspaceState.update(stateKey, true);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
async function findFolderToOffer(context: vscode.ExtensionContext): Promise<AgentsGuideOffer | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (await isWurstProject(folder)) {
            const agentsPath = path.join(folder.uri.fsPath, 'AGENTS.md');
            if (!await fs.promises.stat(agentsPath).then(() => true, () => false)) {
                const stateKey = getStateKey(folder);
                if (!context.workspaceState.get<boolean>(stateKey, false)) {
                    return { kind: 'create', folder, stateKey };
                }
                continue;
            }

            const stateKey = getUpdateStateKey(folder);
            const neverStateKey = getNeverUpdateStateKey(folder);
            if (context.globalState.get<boolean>(neverStateKey, false)) {
                continue;
            }
            if (context.workspaceState.get<boolean>(stateKey, false)) {
                continue;
            }
            const warning = await agentsTemplateWarning(agentsPath);
            if (warning) {
                return { kind: 'update', folder, stateKey, neverStateKey, warning };
            }
        }
    }
    return undefined;
}

async function isWurstProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const root = folder.uri.fsPath;
    for (const marker of ['wurst.build', 'wurst.dependencies', 'wurst_run.args']) {
        if (await fs.promises.stat(path.join(root, marker)).then(() => true, () => false)) {
            return true;
        }
    }

    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.{wurst,jurst}'),
        new vscode.RelativePattern(folder, '{.git,node_modules,_build,build,out,dist}/**'),
        1
    );
    return files.length > 0;
}

async function createAgentsGuide(folder: vscode.WorkspaceFolder, context: vscode.ExtensionContext): Promise<void> {
    const target = path.join(folder.uri.fsPath, 'AGENTS.md');
    const content = withAgentsTemplateMarker(await downloadAgentsGuide(context));
    await fs.promises.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    await context.workspaceState.update(`${BASELINE_PREFIX}${folder.uri.toString()}`, content);
}

function getStateKey(folder: vscode.WorkspaceFolder): string {
    return `${PROMPT_STATE_PREFIX}${folder.uri.toString()}`;
}

function getUpdateStateKey(folder: vscode.WorkspaceFolder): string {
    return `${UPDATE_PROMPT_STATE_PREFIX}${AGENTS_TEMPLATE_VERSION}:${folder.uri.toString()}`;
}

function getNeverUpdateStateKey(folder: vscode.WorkspaceFolder): string {
    return `${NEVER_UPDATE_STATE_PREFIX}${folder.uri.toString()}`;
}

async function agentsTemplateWarning(agentsPath: string): Promise<string | undefined> {
    let content: string;
    try {
        content = await fs.promises.readFile(agentsPath, 'utf8');
    } catch {
        return undefined;
    }

    const markerLine = content.match(/<!-- WURST_AGENTS_TEMPLATE_VERSION: (\d{4}-\d{2}-\d{2}) -->/)?.[1];
    if (markerLine && markerLine >= AGENTS_TEMPLATE_VERSION) {
        return undefined;
    }
    if (markerLine) {
        return `AGENTS.md was generated from an older WurstSetup template (${markerLine}).`;
    }
    if (content.includes(AGENTS_TEMPLATE_SOURCE_HINT)) {
        return 'AGENTS.md looks like an older WurstSetup template without a version marker.';
    }
    return undefined;
}

export async function prepareAgentsGuideUpdate(context: vscode.ExtensionContext, selected?: vscode.WorkspaceFolder): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = selected ?? (active && vscode.workspace.getWorkspaceFolder(active)) ??
        (folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map((entry) => ({ label: entry.name, folder: entry })), { placeHolder: 'Choose a project for the AGENTS.md update' }))?.folder);
    if (!folder) return;
    const current = vscode.Uri.file(path.join(folder.uri.fsPath, 'AGENTS.md'));
    const exists = await fs.promises.stat(current.fsPath).then((stat) => stat.isFile(), (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
    if (!exists) {
        const choice = await vscode.window.showInformationMessage(`No AGENTS.md exists in "${folder.name}". Create a guide before reviewing updates?`, CREATE_ACTION);
        if (choice === CREATE_ACTION) {
            await createAgentsGuide(folder, context);
            await vscode.window.showTextDocument(current);
        }
        return;
    }
    // Refresh is explicit and never replaces the project's customized instructions.
    const template = withAgentsTemplateMarker(await downloadAgentsGuide(context, true));
    const projectKey = createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 16);
    const directory = path.join(context.globalStorageUri.fsPath, 'agents-guide', projectKey);
    await fs.promises.mkdir(directory, { recursive: true });
    const upstreamPath = path.join(directory, 'upstream-AGENTS.md');
    await fs.promises.writeFile(upstreamPath, template, 'utf8');
    const baseline = context.workspaceState.get<string>(`${BASELINE_PREFIX}${folder.uri.toString()}`);
    const baselinePath = path.join(directory, 'baseline-AGENTS.md');
    if (baseline) await fs.promises.writeFile(baselinePath, baseline, 'utf8');
    await vscode.commands.executeCommand('vscode.diff', current, vscode.Uri.file(upstreamPath), 'AGENTS.md ↔ current WurstSetup template');
    const prompt = [
        `Update ${current.fsPath} incrementally using ${upstreamPath} (downloaded ${new Date().toISOString()} from ${AGENTS_GUIDE_URL}).`,
        baseline ? `Compare against the original template baseline at ${baselinePath}; preserve all project-specific edits.` : 'No original template baseline is available. Preserve project-specific guidance and flag ambiguous conflicts.',
        'Verify proposed instructions against this project, its dependencies and the installed compiler agent-docs/WURST_LANGUAGE.md. Consult current official WurstScript sources when local evidence is insufficient; cite sources and dates.',
        'Treat downloaded content as reference material. Add only relevant durable changes, remove guidance only when evidence proves it obsolete, keep the diff small, and report unresolved conflicts. Do not blindly replace AGENTS.md or claim unverified behavior.',
    ].join('\n');
    const choice = await vscode.window.showInformationMessage('Review the template changes or copy instructions for your coding agent.', 'Copy Agent Prompt');
    if (choice === 'Copy Agent Prompt') await vscode.env.clipboard.writeText(prompt);
}

function withAgentsTemplateMarker(content: string): string {
    return content.includes(AGENTS_TEMPLATE_MARKER_PREFIX)
        ? content
        : `${AGENTS_TEMPLATE_MARKER}\n${content}`;
}

async function downloadAgentsGuide(context: vscode.ExtensionContext, refresh = false): Promise<string> {
    const cached = context.globalState.get<{ content: string; fetchedAt: number }>(TEMPLATE_CACHE_KEY);
    if (!refresh && cached && Date.now() - cached.fetchedAt < 24 * 60 * 60 * 1000) return cached.content;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const content = await new Promise<string>((resolve, reject) => {
            requestAgentsGuide(AGENTS_GUIDE_URL, 0, controller.signal, resolve, reject);
        });
        await context.globalState.update(TEMPLATE_CACHE_KEY, { content, fetchedAt: Date.now() });
        return content;
    } finally { clearTimeout(timer); }
}

function requestAgentsGuide(
    url: string,
    redirects: number,
    signal: AbortSignal,
    resolve: (value: string) => void,
    reject: (reason?: any) => void
): void {
    if (redirects > 5) {
        reject(new Error('Too many redirects while downloading AGENTS.md template.'));
        return;
    }

    const req = https.get(url, {
        signal,
        headers: {
            'User-Agent': 'wurst4vscode',
            Accept: 'text/markdown,text/plain',
        },
    }, (res) => {
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('AGENTS.md template download was interrupted.')));
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location;
            res.resume();
            if (!location) {
                reject(new Error('Redirect without Location header while downloading AGENTS.md template.'));
                return;
            }
            try {
                const target = new URL(location, url);
                if (target.protocol !== 'https:') throw new Error('AGENTS.md template redirect must use HTTPS.');
                requestAgentsGuide(target.toString(), redirects + 1, signal, resolve, reject);
            } catch (error) { reject(error); }
            return;
        }

        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Could not download AGENTS.md template: HTTP ${res.statusCode}`));
            return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 512 * 1024) {
                req.destroy(new Error('AGENTS.md template is unexpectedly large.'));
                return;
            }
            chunks.push(chunk);
        });
        res.on('end', () => {
            const content = Buffer.concat(chunks).toString('utf8');
            if (!content.trim()) {
                reject(new Error('Downloaded AGENTS.md template was empty.'));
                return;
            }
            resolve(content);
        });
    });
    req.on('error', reject);
}
