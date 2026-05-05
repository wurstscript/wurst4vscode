'use strict';

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';

const PROMPT_STATE_PREFIX = 'wurst.agentsGuidePromptDismissed:';
const AGENTS_GUIDE_URL = 'https://raw.githubusercontent.com/wurstscript/WurstSetup/master/templates/AGENTS.md';
const CREATE_ACTION = 'Create AGENTS.md';
const NEVER_ACTION = "Don't Ask Again";

export function registerAgentsGuideOffer(context: vscode.ExtensionContext): vscode.Disposable {
    const offer = () => {
        void offerAgentsGuide(context);
    };

    offer();

    return vscode.workspace.onDidChangeWorkspaceFolders(offer);
}

async function offerAgentsGuide(context: vscode.ExtensionContext): Promise<void> {
    const folder = await findFolderToOffer(context);
    if (!folder) {
        return;
    }

    const stateKey = getStateKey(folder);
    const choice = await vscode.window.showInformationMessage(
        `Add an AGENTS.md guide for AI coding agents in "${folder.name}"?`,
        CREATE_ACTION,
        NEVER_ACTION
    );

    if (choice === CREATE_ACTION) {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Creating AGENTS.md', cancellable: false },
                async () => createAgentsGuide(folder)
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
                vscode.window.showErrorMessage(`Failed to create AGENTS.md: ${err?.message ?? String(err)}`);
            }
        }
        return;
    }

    await context.workspaceState.update(stateKey, true);
}

async function findFolderToOffer(context: vscode.ExtensionContext): Promise<vscode.WorkspaceFolder | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (context.workspaceState.get<boolean>(getStateKey(folder), false)) {
            continue;
        }
        if (fs.existsSync(path.join(folder.uri.fsPath, 'AGENTS.md'))) {
            continue;
        }
        if (await isWurstProject(folder)) {
            return folder;
        }
    }
    return undefined;
}

async function isWurstProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
    const root = folder.uri.fsPath;
    for (const marker of ['wurst.build', 'wurst.dependencies', 'wurst_run.args']) {
        if (fs.existsSync(path.join(root, marker))) {
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

async function createAgentsGuide(folder: vscode.WorkspaceFolder): Promise<void> {
    const target = path.join(folder.uri.fsPath, 'AGENTS.md');
    const content = await downloadAgentsGuide();
    await fs.promises.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
}

function getStateKey(folder: vscode.WorkspaceFolder): string {
    return `${PROMPT_STATE_PREFIX}${folder.uri.toString()}`;
}

function downloadAgentsGuide(): Promise<string> {
    return new Promise((resolve, reject) => {
        requestAgentsGuide(AGENTS_GUIDE_URL, 0, resolve, reject);
    });
}

function requestAgentsGuide(
    url: string,
    redirects: number,
    resolve: (value: string) => void,
    reject: (reason?: any) => void
): void {
    if (redirects > 5) {
        reject(new Error('Too many redirects while downloading AGENTS.md template.'));
        return;
    }

    const req = https.get(url, {
        headers: {
            'User-Agent': 'wurst4vscode',
            Accept: 'text/markdown,text/plain',
        },
    }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
            const location = res.headers.location;
            res.resume();
            if (!location) {
                reject(new Error('Redirect without Location header while downloading AGENTS.md template.'));
                return;
            }
            requestAgentsGuide(new URL(location, url).toString(), redirects + 1, resolve, reject);
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
