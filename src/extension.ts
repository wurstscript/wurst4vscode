'use strict';

import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient/node';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { spawn, spawnSync } from 'child_process';

import { registerCommands } from './features/commands';
import { registerFileCreation } from './features/fileCreation';
import { registerBlpPreview } from './features/blpPreview';
import { registerMpqViewer } from './features/mpqViewer';
import { registerAssetLinks } from './features/assetLinks';
import { registerImagePreviewHover } from './features/imagePreviewHover';
import { registerInlineImageDecorations } from './features/inlineImageDecorations';
import StreamZip = require('node-stream-zip');

const WURST_HOME = path.join(os.homedir(), '.wurst');
const RUNTIME_DIR = path.join(WURST_HOME, 'wurst-runtime');
const COMPILER_DIR = path.join(WURST_HOME, 'wurst-compiler');
const COMPILER_JAR = path.join(COMPILER_DIR, 'wurstscript.jar'); // new structure ships this jar
const LEGACY_GRILL_DIR = path.join(WURST_HOME, 'grill');
const GRILL_HOME_DIR = path.join(WURST_HOME, 'grill-cli');
const NIGHTLY_RELEASE_BY_TAG_API = 'https://api.github.com/repos/wurstscript/WurstScript/releases/tags/nightly';
const NIGHTLY_COMMIT_API = 'https://api.github.com/repos/wurstscript/WurstScript/commits/nightly';
const WURSTSETUP_RELEASE = 'https://api.github.com/repos/wurstscript/WurstSetup/releases/tags/nightly-master';


let clientRef: LanguageClient | null = null;
let envCollection: vscode.EnvironmentVariableCollection | null = null;
const prependedPathEntries = new Set<string>();

async function stopLanguageServerIfRunning(): Promise<void> {
    if (!clientRef) return;
    try {
        await clientRef.stop();
    } catch {
        // ignore
    }
    clientRef = null;
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

async function withRetry<T>(fn: () => T | Promise<T>, attempts = 8, delayMs = 200): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            lastErr = e;
            if (e?.code !== 'EBUSY' && e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
            await sleep(delayMs * Math.pow(1.4, i));
        }
    }
    throw lastErr;
}

function copyDirContents(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, entry);
        const d = path.join(destDir, entry);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
            copyDirContents(s, d);
        } else if (st.isFile()) {
            fs.copyFileSync(s, d);
        }
    }
}

async function upgradeFolder(src: string, dest: string) {
    // Try clean replace
    try {
        if (fs.existsSync(dest)) await removeDirSafe(dest);
        await withRetry(() => fs.renameSync(src, dest));
        return;
    } catch {
        // Fallback: merge/copy over existing destination
        copyDirContents(src, dest);
        try {
            await removeDirSafe(src);
        } catch {}
    }
}

async function removeDirSafe(dir: string) {
    if (!fs.existsSync(dir)) return;
    await withRetry(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function ensureDirectoryPath(dir: string) {
    if (fs.existsSync(dir)) {
        const st = fs.lstatSync(dir);
        if (st.isDirectory()) return;
        if (!forceDeletePath(dir)) {
            throw new Error(`Path exists but is not a directory: ${dir}`);
        }
    }
    fs.mkdirSync(dir, { recursive: true });
}

function migrateLegacyGrillLayout() {
    if (!fs.existsSync(WURST_HOME) || !fs.existsSync(LEGACY_GRILL_DIR)) return;

    let st: fs.Stats;
    try {
        st = fs.lstatSync(LEGACY_GRILL_DIR);
    } catch {
        return;
    }

    // Only migrate the old "grill" directory layout.
    if (!st.isDirectory()) return;

    // Preserve useful legacy jars by moving them into the new dedicated CLI directory.
    ensureDirectoryPath(GRILL_HOME_DIR);
    try {
        for (const entry of fs.readdirSync(LEGACY_GRILL_DIR)) {
            if (!entry.toLowerCase().endsWith('.jar')) continue;
            const src = path.join(LEGACY_GRILL_DIR, entry);
            const dst = path.join(GRILL_HOME_DIR, entry);
            if (fs.existsSync(dst)) {
                forceDeletePath(src);
                continue;
            }
            try {
                fs.renameSync(src, dst);
            } catch {
                try {
                    fs.copyFileSync(src, dst);
                    forceDeletePath(src);
                } catch {}
            }
        }
    } catch {}

    // Remove the old directory so ~/.wurst/grill can be used as executable path on unix.
    forceDeletePath(LEGACY_GRILL_DIR);
}

function installLauncherExecutable(srcExecutable: string) {
    if (!fs.existsSync(srcExecutable)) return;

    const target = path.join(WURST_HOME, path.basename(srcExecutable));
    try {
        if (fs.existsSync(target) && !forceDeletePath(target)) {
            throw new Error(`Failed to replace existing path: ${target}`);
        }
        fs.renameSync(srcExecutable, target);
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(target, 0o755);
            } catch {}
        }
    } catch {
        /* ignore */
    }
}

function isDirectoryPath(p: string): boolean {
    try {
        return fs.lstatSync(p).isDirectory();
    } catch {
        return false;
    }
}

function ensureDirOrDeleteConflictingPath(p: string) {
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        return;
    }
    if (isDirectoryPath(p)) return;
    if (!forceDeletePath(p)) {
        throw new Error(`Conflicting non-directory path cannot be removed: ${p}`);
    }
    fs.mkdirSync(p, { recursive: true });
}

function normalizeInstallerPaths() {
    ensureDirOrDeleteConflictingPath(WURST_HOME);
    ensureDirOrDeleteConflictingPath(RUNTIME_DIR);
    ensureDirOrDeleteConflictingPath(COMPILER_DIR);
    ensureDirOrDeleteConflictingPath(GRILL_HOME_DIR);
    migrateLegacyGrillLayout();
}

function isRecoverableInstallError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const recoverableMarkers = [
        'eexist',
        'enotdir',
        'enotempty',
        'eperm',
        'ebusy',
        'path exists but is not a directory',
    ];
    return recoverableMarkers.some((m) => msg.includes(m));
}

async function repairInstallationLayout() {
    await stopLanguageServerIfRunning();
    normalizeInstallerPaths();
    cleanupWurstSetupJar();
}


export async function activate(context: ExtensionContext) {
    console.log('Wurst extension activated!');
    envCollection = context.environmentVariableCollection;

    setupDecorators(context);
    context.subscriptions.push(registerBlpPreview(context));
    context.subscriptions.push(registerMpqViewer(context));
    context.subscriptions.push(registerAssetLinks(context));
    context.subscriptions.push(registerImagePreviewHover(context));
    context.subscriptions.push(registerInlineImageDecorations(context));

    registerBasicCommands(context);

    try {
        await startLanguageClient(context);
    } catch (err) {
        console.error('Failed to start language client:', err);
        vscode.window.showWarningMessage(`Wurst language features disabled: ${err}`);
    }
}

function registerBasicCommands(context: ExtensionContext) {
    // Choose game executable (unchanged)
    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.chooseGameExecutable', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                filters: { Executables: ['exe', 'bin', '*'] },
                openLabel: 'Select Game Executable',
            });

            if (uris && uris.length > 0) {
                const exePath = uris[0].fsPath;
                await workspace
                    .getConfiguration()
                    .update('wurst.gameExePath', exePath, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage(`Wurst game executable path set: ${exePath}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.installOrUpdate', async () => {
            try {
                await ensureInstalledOrOfferMigration(/*forcePrompt=*/ true);
                await maybeOfferUpdate();
                vscode.window.showInformationMessage('WurstScript is installed and up to date.');
            } catch (e: any) {
                vscode.window.showErrorMessage(`Install/Update failed: ${e?.message || e}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.newProject', async () => {
            try {
                await createNewWurstProject();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to create Wurst project: ${e?.message ?? String(e)}`);
            }
        })
    );
}

function setupDecorators(context: ExtensionContext) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const extension = vscode.extensions.getExtension('peterzeller.wurst')!;
    const extPath = extension.extensionPath;
    const decorator = vscode.window.createTextEditorDecorationType({
        gutterIconPath: path.join(extPath, 'images', 'gears.svg'),
        gutterIconSize: 'contain',
    });

    let activeEditor = vscode.window.activeTextEditor;

    function updateDecorations() {
        if (!activeEditor) return;
        const regEx = /@compiletime\s+(\s*(static|public|private)\s)*function.+/g;
        const text = activeEditor.document.getText();
        const decorations: vscode.DecorationOptions[] = [];
        let match: RegExpExecArray | null;

        while ((match = regEx.exec(text))) {
            const start = activeEditor.document.positionAt(match.index);
            const end = activeEditor.document.positionAt(match.index + match[0].length);
            decorations.push({
                range: new vscode.Range(start, end),
                hoverMessage: 'This function will be executed at compile time.',
            });
        }

        activeEditor.setDecorations(decorator, decorations);
    }

    function triggerUpdate() {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(updateDecorations, 500);
    }

    if (activeEditor) {
        triggerUpdate();
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            activeEditor = editor;
            if (editor) triggerUpdate();
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (activeEditor && event.document === activeEditor.document) {
                triggerUpdate();
            }
        })
    );
}

async function startLanguageClient(context: ExtensionContext) {
    // Ensure installation/migration & optional update prompt
    await ensureInstalledOrOfferMigration(/*forcePrompt=*/ false);
    await maybeOfferUpdate();

    const clientOptions: LanguageClientOptions = {
        documentSelector: ['wurst'],
        synchronize: { configurationSection: 'wurst' },
    };

    const serverOptions = await getServerOptions();
    const client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);
    clientRef = client;

    const startResult = client.start();
    if (isDisposable(startResult)) {
        context.subscriptions.push(startResult);
    } else {
        context.subscriptions.push({ dispose: () => client.stop() });
        await startResult;
    }

    const anyClient = client as LanguageClient & { onReady?: () => Promise<void> };
    try {
        if (typeof anyClient.onReady === 'function') {
            await anyClient.onReady();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Wurst language server failed to start: ${message}`);
        throw error;
    }

    const version = getInstalledVersionString() ?? 'unknown';
    const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    sb.text = '$(check) WurstScript';
    sb.tooltip = [
        'WurstScript language server is running.',
        `Version: ${version}`,
        'Click to open logs.',
    ]
        .filter(Boolean)
        .join('\n');
    sb.command = 'wurst.showLogs';
    sb.show();
    context.subscriptions.push(sb);

    // Command to focus Output with the Wurst channel selected (like Prettier)
    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.showLogs', () => {
            try {
                // languageclient exposes the output channel
                client.outputChannel.show(); // focus + selects the channel
            } catch {
                // fallback: just open Output panel
                vscode.commands.executeCommand('workbench.action.output.toggleOutput');
            }
        })
    );
    client.onNotification('wurst/updateGamePath', (params) => {
        workspace.getConfiguration().update('wurst.wc3path', params);
    });

    context.subscriptions.push(registerCommands(client));
    context.subscriptions.push(registerFileCreation());
    context.subscriptions.push(registerFileChanges(client));
}

function registerFileChanges(client: LanguageClient): vscode.FileSystemWatcher {
    const watcher = workspace.createFileSystemWatcher('**/*.wurst');
    function notify(type: number, uri: vscode.Uri) {
        client.sendNotification('workspace/didChangeWatchedFiles', {
            changes: [{ uri: uri.toString(), type }],
        });
    }
    watcher.onDidCreate((uri) => notify(1, uri));
    watcher.onDidChange((uri) => notify(2, uri));
    watcher.onDidDelete((uri) => notify(3, uri));
    return watcher;
}

async function createNewWurstProject(): Promise<void> {
    // 1) Ask for project name
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new Wurst project (folder name)',
        value: 'MyWurstProject',
        validateInput: (value) => {
            if (!value.trim()) return 'Project name must not be empty';
            if (value.indexOf('/') >= 0 || value.indexOf('\\') >= 0) {
                return 'Project name must not contain path separators';
            }
            return undefined;
        },
    });
    if (!name) {
        return; // user cancelled
    }

    // 2) Ask for parent folder
    const parentPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select parent folder for the new Wurst project',
    });
    if (!parentPick || parentPick.length === 0) {
        return; // user cancelled
    }

    const parentDir = parentPick[0].fsPath;
    const destDir = path.join(parentDir, name);

    // 3) Check destination
    if (fs.existsSync(destDir)) {
        const existingEntries = fs.readdirSync(destDir);
        if (existingEntries.length > 0) {
            await vscode.window.showWarningMessage(
                `The folder "${name}" already exists and is not empty.\n\nPlease choose an empty folder for Grill project generation.`,
                { modal: true }
            );
            return;
        }
    } else {
        fs.mkdirSync(destDir, { recursive: true });
    }

    // 4) Generate project via Grill
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Creating Wurst project',
            cancellable: false,
        },
        async (progress) => {
            progress.report({ message: 'Ensuring WurstScript/Grill installation…', increment: 10 });

            // Make sure install has run at least once (so bundled grill exists),
            // and PATH in this extension host is updated if needed.
            await ensureInstalledOrOfferMigration(/*forcePrompt=*/ false);
            await ensureGrillAvailable();

            progress.report({ message: 'Generating project with Grill…', increment: 30 });

            // Grill often expects an empty/non-existing directory. Your earlier logic allows “use existing folder”.
            // If the folder exists and is not empty, Grill may refuse or create a partial project.
            if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
                throw new Error(
                    `Destination folder is not empty:\n${destDir}\n\nPlease choose an empty folder (Grill project generation may refuse non-empty directories).`
                );
            }

            await runGrillGenerate(destDir);

            progress.report({ message: 'Project created.', increment: 60 });
        }
    );

    // 5) Offer to open the created folder
    const choice = await vscode.window.showInformationMessage(
        `Wurst project created at:\n${destDir}`,
        'Open Folder',
        'Close'
    );
    if (choice === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destDir), true);
    }
}

/** =========================
 *  GitHub + Download helpers
 *  ========================= */

function githubJson<T = any>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            url,
            {
                method: 'GET',
                headers: {
                    'User-Agent': 'wurst4vscode',
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            },
            (res) => {
                if (!res.statusCode || res.statusCode >= 400) {
                    reject(new Error(`GitHub API error: HTTP ${res.statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (d) => chunks.push(Buffer.from(d)));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

async function fetchLatestGrillAsset(): Promise<{ name: string; url: string }> {
    const rel = await githubJson(WURSTSETUP_RELEASE);
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];

    const wanted = assets.find((a: any) => {
        const n = String(a?.name ?? '').toLowerCase();
        return n.startsWith('wurstsetup') && n.endsWith('.jar');
    });

    if (!wanted?.browser_download_url) {
        throw new Error('No WurstSetup JAR found in the latest WurstSetup release.');
    }

    return {
        name: wanted.name,
        url: wanted.browser_download_url,
    };
}

async function fetchNightlyZipAsset(): Promise<{ name: string; url: string }> {
    // Map Node’s platform/arch to your release suffixes
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    let plat: string;
    if (process.platform === 'win32') plat = `win-${arch}`;
    else if (process.platform === 'linux') plat = `linux-${arch}`;
    else if (process.platform === 'darwin') plat = `macos-${arch}`; // plan ahead
    else throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);

    const rel = await githubJson(NIGHTLY_RELEASE_BY_TAG_API);
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];

    // Expected naming: wurst-compiler-nightly-<plat>.zip
    const wanted = assets.find((a: any) => {
        const n = String(a?.name ?? '').toLowerCase();
        return n.endsWith(`${plat}.zip`) && n.startsWith('wurst-compiler-nightly-');
    });

    if (!wanted?.browser_download_url) {
        // Helpful macOS message if you haven’t uploaded a mac build yet
        if (process.platform === 'darwin') {
            throw new Error('No macOS build found on the nightly release. Please add macOS zips (macos-x64/arm64).');
        }
        throw new Error(`No matching asset found for ${plat}.`);
    }
    return { name: wanted.name, url: wanted.browser_download_url };
}


async function fetchNightlyCommitSha(): Promise<string> {
    const obj = await githubJson(NIGHTLY_COMMIT_API);
    const sha: string | undefined = obj?.sha;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error('Could not resolve nightly commit SHA.');
    }
    return sha.toLowerCase();
}

/** =========================
 *  Download / Extract
 *  ========================= */
async function downloadFileWithProgress(
    url: string,
    destination: string,
    onPct?: (pct: number) => void,
    cancellationToken?: vscode.CancellationToken
): Promise<number> {
    const maxRedirects = 5;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    return await new Promise<number>((resolve, reject) => {
        let received = 0;
        let total = 0;
        let cancelled = false;

        if (cancellationToken) {
            cancellationToken.onCancellationRequested(() => (cancelled = true));
        }

        function requestUrl(currentUrl: string, redirects: number) {
            if (cancelled) return reject(new Error('Download cancelled by user'));
            if (redirects > maxRedirects) return reject(new Error('Too many redirects'));

            const req = https.get(currentUrl, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
                    const loc = res.headers.location;
                    if (!loc) return reject(new Error('Redirect without Location header'));
                    res.destroy();
                    return requestUrl(loc, redirects + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));

                total = parseInt(res.headers['content-length'] || '0', 10);
                const fileStream = fs.createWriteStream(destination);

                res.on('data', (chunk) => {
                    if (cancelled) {
                        req.destroy();
                        return;
                    }
                    received += chunk.length;
                    if (total > 0 && onPct) onPct((received / total) * 100);
                });

                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    if (cancelled) return reject(new Error('Download cancelled by user'));
                    resolve(fs.statSync(destination).size);
                });
                res.on('error', (err) => {
                    fs.unlink(destination, () => {});
                    reject(err);
                });
            });

            req.on('error', (err) => {
                fs.unlink(destination, () => {});
                reject(err);
            });
        }

        requestUrl(url, 0);
    });
}


function within(destDir: string, p: string) {
    const abs = path.resolve(p);
    return abs.startsWith(path.resolve(destDir) + path.sep);
}

async function extractZipWithByteProgress(
    zipPath: string,
    destDir: string,
    onPct?: (pct: number) => void
): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
        const zip = new StreamZip({ file: zipPath, storeEntries: true });

        zip.on('error', (e: any) => reject(e));

        zip.on('ready', async () => {
            try {
                const entries = zip.entries() as { [name: string]: any };
                const names = Object.keys(entries);

                // Create dirs first
                for (const name of names) {
                    const e = entries[name];
                    if (e.isDirectory) {
                        const d = path.join(destDir, name);
                        if (!within(destDir, d)) throw new Error('Illegal path in zip');
                        fs.mkdirSync(d, { recursive: true });
                    }
                }

                // Total uncompressed bytes
                const files = names.filter((n) => !entries[n].isDirectory);
                const total = files.reduce((s, n) => s + (entries[n].size || 0), 0) || 1;
                let processed = 0;

                // Extract files, streaming bytes to report progress
                for (const name of files) {
                    const outPath = path.join(destDir, name);
                    if (!within(destDir, outPath)) throw new Error('Illegal path in zip');
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });

                    await new Promise<void>((res, rej) => {
                        zip.stream(name, (err: any, stream: any) => {
                            if (err || !stream) return rej(err || new Error('stream error'));
                            const out = fs.createWriteStream(outPath);
                            stream.on('data', (chunk: Buffer) => {
                                processed += chunk.length;
                                onPct?.((processed / total) * 100);
                            });
                            stream.on('end', () => res());
                            stream.on('error', rej);
                            out.on('error', rej);
                            stream.pipe(out);
                        });
                    });
                }

                zip.close();
                resolve();
            } catch (e) {
                try {
                    zip.close();
                } catch {}
                reject(e);
            }
        });
    });
}

/** =========================
 *  Install / Update logic
 *  ========================= */

function hasNewLayout(): boolean {
    return fs.existsSync(RUNTIME_DIR) && fs.existsSync(COMPILER_DIR);
}

function isGrillOnPath(): boolean {
    const result = process.platform === 'win32'
        ? spawnSync('where', ['grill'], { stdio: 'ignore' })
        : spawnSync('which', ['grill'], { stdio: 'ignore' });
    return result.status === 0;
}

async function ensureInstalledOrOfferMigration(forcePrompt: boolean): Promise<void> {
    migrateLegacyGrillLayout();

    const newLayout = hasNewLayout();
    const hasHomeDir = fs.existsSync(WURST_HOME);

    if (!newLayout) {
        if (!hasHomeDir) {
            if (!forcePrompt) {
                const choice = await vscode.window.showInformationMessage(
                    'Welcome to WurstScript! Would you like to install it now?',
                    { modal: true },
                    'Install',
                    'Not now'
                );
                if (choice !== 'Install') {
                    throw new Error('WurstScript is not installed.');
                }
            }

            await installWithRetry();
            return;
        }

        const msg = [
            'Old WurstScript installation detected.',
            '',
            'Wurst just got a major update! We now ship a bundled runtime and deliver updates directly via GitHub Releases through this extension.',
            '',
            'Highlights:',
            '• Much faster warm “runmap” (up to ~80%)',
            '• Many bug fixes and improvements',
            '• New language features',
            '',
            'Note:',
            'This release introduces - and future updates may continue to introduce - breaking changes to improve reliability and maintainability.',
            'If you encounter any issues, please let us know on GitHub or Discord.',
        ].join('\n');

        await vscode.window.showInformationMessage(msg, { modal: true }, 'Continue');
        // Proceed automatically: download zip and lay down new folders
        await installWithRetry();
        return;
    }

    // New layout present but first run could still miss the jar
    if (!fs.existsSync(COMPILER_JAR)) {
        await installWithRetry();
    }
}

async function ensureGrillAvailable(): Promise<void> {
    if (getBundledGrillExecutable() || isGrillOnPath()) {
        return;
    }

    await installWithRetry();

    if (!getBundledGrillExecutable() && !isGrillOnPath()) {
        throw new Error('Grill CLI is not available. Please run "Wurst: Install/Update" and try again.');
    }
}

async function installWithRetry(): Promise<void> {
    let autoRepairAttempted = false;
    while (true) {
        try {
            await installFreshFromNightly();
            return;
        } catch (error) {
            if (!autoRepairAttempted && isRecoverableInstallError(error)) {
                autoRepairAttempted = true;
                try {
                    await repairInstallationLayout();
                    continue;
                } catch {
                    // fall through to user-visible choices
                }
            }

            const message = error instanceof Error ? error.message : String(error);
            const choice = await vscode.window.showErrorMessage(
                `Installation failed: ${message}`,
                { modal: true },
                'Retry',
                'Repair',
                'Cancel'
            );
            if (choice === 'Repair') {
                await repairInstallationLayout();
                continue;
            }
            if (choice !== 'Retry') {
                throw error;
            }
        }
    }
}

async function installFreshFromNightly(): Promise<void> {
    await stopLanguageServerIfRunning(); // release locks if LS was running

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing WurstScript', cancellable: false },
        async (progress) => {
            progress.report({ message: 'Preparing…', increment: 2 });

            progress.report({ message: 'Fetching release info…', increment: 3 });
            const asset = await fetchNightlyZipAsset();

            const tmpWork = path.join(os.tmpdir(), `wurst-install-${Date.now()}`);
            const tmpZip = path.join(tmpWork, 'payload.zip');
            const unpack = path.join(tmpWork, 'unpacked');
            fs.mkdirSync(unpack, { recursive: true });

            let last = 0;
            // Weights within the main 0–100 range for the heavy work:
            // 70% compiler ZIP download, 18% extract, 10% Grill download, rest finishing.
            const DL_WEIGHT = 70;
            const EX_WEIGHT = 18;
            const GRILL_WEIGHT = 10;

            await downloadFileWithProgress(asset.url, tmpZip, (pct) => {
                const scaled = (pct / 100) * DL_WEIGHT;
                const inc = Math.max(0, scaled - last);
                last += inc;
                progress.report({ message: `Downloading compiler… ${Math.floor(pct)}%`, increment: inc });
            });

            await extractZipWithByteProgress(tmpZip, unpack, (pct) => {
                const scaled = DL_WEIGHT + (pct / 100) * EX_WEIGHT;
                const inc = Math.max(0, scaled - last);
                last += inc;
                progress.report({ message: `Extracting compiler… ${Math.floor(pct)}%`, increment: inc });
            });

            progress.report({ message: 'Finishing up compiler install…', increment: 0 });

            const srcRuntime = path.join(unpack, 'wurst-runtime');
            const srcCompiler = path.join(unpack, 'wurst-compiler');
            const srcLauncher = path.join(unpack, process.platform === 'win32' ? 'wurstscript.cmd' : 'wurstscript');
            const srcGrill = path.join(unpack, process.platform === 'win32' ? 'grill.cmd' : 'grill');

            if (!fs.existsSync(srcRuntime) || !fs.existsSync(path.join(srcCompiler, 'wurstscript.jar'))) {
                throw new Error('Installation incomplete: runtime or compiler not found after extraction.');
            }

            // Ensure ~/.wurst exists
            fs.mkdirSync(WURST_HOME, { recursive: true });

            // Upgrade subfolders in place (no touching ~/.wurst itself)
            await upgradeFolder(srcRuntime, RUNTIME_DIR);
            await upgradeFolder(srcCompiler, COMPILER_DIR);

            // Place/refresh launchers (best effort).
            // Handles legacy file/dir collisions (e.g. ~/.wurst/grill directory from old layouts).
            installLauncherExecutable(srcLauncher);
            installLauncherExecutable(srcGrill);

            // Ensure java is executable on unix
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(getBundledJava(), 0o755);
                } catch {}
            }

            // ------------------ Install Grill CLI with progress ------------------
            const grillAsset = await fetchLatestGrillAsset();
            const grillDir = GRILL_HOME_DIR;
            ensureDirectoryPath(grillDir);

            const tmpGrillJar = path.join(tmpWork, 'grill.jar');

            await downloadFileWithProgress(grillAsset.url, tmpGrillJar, (pct) => {
                const scaled = DL_WEIGHT + EX_WEIGHT + (pct / 100) * GRILL_WEIGHT;
                const inc = Math.max(0, scaled - last);
                last += inc;
                progress.report({
                    message: `Downloading Grill CLI… ${Math.floor(pct)}%`,
                    increment: inc,
                });
            });

            const grillDest = path.join(grillDir, 'grill.jar');
            fs.copyFileSync(tmpGrillJar, grillDest);
            try {
                fs.unlinkSync(tmpGrillJar);
            } catch {}

            console.log('[wurst] Installed Grill CLI at', grillDest);

            cleanupOldWurstHome();
            cleanupWurstSetupJar();

            // Cleanup tmp
            try {
                await removeDirSafe(tmpWork);
            } catch {}

            progress.report({ message: 'Finishing up installation…', increment: Math.max(0, 100 - last) });

            const pathUpdate = await ensureCliOnPath();
            await offerPostInstallActions(pathUpdate);
        }
    );
}
function cleanupOldWurstHome() {
    const allowed = new Set([
        'logs',
        'grill',
        'grill-cli',
        'grill.cmd',
        'wurstscript',
        'wurstscript.cmd',
        'wurst-runtime',
        'wurst-compiler',
    ]);

    if (!fs.existsSync(WURST_HOME)) return;

    for (const entry of fs.readdirSync(WURST_HOME)) {
        if (!allowed.has(entry)) {
            const p = path.join(WURST_HOME, entry);
            // remove old jars, exes, folders, etc.
            if (!forceDeletePath(p)) {
                console.warn('Failed to delete old file:', p);
            }
        }
    }
}

function cleanupWurstSetupJar() {
    if (!fs.existsSync(WURST_HOME)) return;

    const jarPattern = /^wurstsetup.*\.jar$/i;
    const dirs = [WURST_HOME, GRILL_HOME_DIR, LEGACY_GRILL_DIR];

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            if (!fs.lstatSync(dir).isDirectory()) continue;
        } catch {
            continue;
        }
        for (const entry of fs.readdirSync(dir)) {
            if (!jarPattern.test(entry)) continue;
            const p = path.join(dir, entry);
            if (!forceDeletePath(p)) {
                console.warn('Failed to delete WurstSetup jar:', p);
            }
        }
    }
}

function forceDeletePath(p: string): boolean {
    try {
        fs.rmSync(p, { recursive: true, force: true });
        return !fs.existsSync(p);
    } catch {}

    // Windows can fail on read-only files; clear mode and retry.
    try {
        fs.chmodSync(p, 0o666);
    } catch {}
    try {
        fs.unlinkSync(p);
        return !fs.existsSync(p);
    } catch {}

    return false;
}


async function maybeOfferUpdate(): Promise<void> {
    try {
        if (!hasNewLayout() || !fs.existsSync(COMPILER_JAR)) return;

        const installed = getInstalledVersionString(); // e.g. 1.8.1.0-nightly-master-3-ge4a2bd1
        const installedShort = installed ? extractShortSha(installed) : null;

        const latestSha = await fetchNightlyCommitSha(); // 40-hex
        if (installedShort && latestSha.startsWith(installedShort)) return;

        const detail = [
            installed ? `Installed: ${installedShort}` : 'Installed: unknown',
            `Latest: ${latestSha.slice(0, 7)}`,
        ].join('\n');

        const choice = await vscode.window.showInformationMessage(
            'A newer WurstScript version is available.',
            { modal: true, detail },
            'Update', 'Later'
        );
        if (choice === 'Update') {
            await installWithRetry();
        }
    } catch (e) {
        console.warn('Update check failed:', e);
    }
}

function getBundledGrillExecutable(): string | null {
    // The installer drops these directly into ~/.wurst
    const p = path.join(WURST_HOME, process.platform === 'win32' ? 'grill.cmd' : 'grill');
    return fs.existsSync(p) ? p : null;
}

async function runGrillGenerate(destDir: string): Promise<void> {
    // Prefer an on-disk bundled grill (works immediately after installFreshFromNightly, even before a reload),
    // otherwise fall back to PATH ("grill").
    const bundled = getBundledGrillExecutable();
    const grillCmd = bundled ?? 'grill';

    // Make sure the current extension host can resolve the bundled one right away
    // (ensureCliOnPath updates process.env.PATH too, but this makes it deterministic).
    if (bundled) {
        prependPathForVsCodeTerminals(WURST_HOME);
    }

    await new Promise<void>((resolve, reject) => {
        const out: string[] = [];
        const push = (s: any) => {
            const str = String(s ?? '');
            if (!str) return;
            out.push(str);
            if (out.length > 2000) out.shift(); // cap memory
        };

        let child;
        if (process.platform === 'win32') {
            // Use cmd.exe so .cmd + PATH resolution works reliably
            child = spawn('cmd.exe', ['/c', grillCmd, 'generate', destDir], { windowsHide: true });
        } else {
            child = spawn(grillCmd, ['generate', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        }

        child.on('error', (err: any) => {
            const details = out.join('').trim();
            if (err?.code === 'ENOENT') {
                reject(
                    new Error(
                        [
                            `Could not execute "grill".`,
                            `Make sure Grill is installed and on PATH, or run "Wurst: Install/Update" once.`,
                            details ? `\nLast output:\n${details}` : '',
                        ].join('\n')
                    )
                );
            } else {
                reject(new Error(`${err?.message ?? String(err)}${details ? `\n\n${details}` : ''}`));
            }
        });

        child.stdout?.on('data', push);
        child.stderr?.on('data', push);

        child.on('close', (code) => {
            const details = out.join('').trim();
            if (code === 0) return resolve();
            reject(
                new Error(
                    [`"grill generate" failed (exit code ${code}).`, details ? `\nOutput:\n${details}` : ''].join('\n')
                )
            );
        });
    });
}

function getBundledJava(): string {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    return path.join(RUNTIME_DIR, 'bin', exe);
}

/** Checks that the given java binary exists and is version >= 25. Throws with a user-facing message if not. */
function checkCustomJavaVersion(javaBin: string): void {
    if (!fs.existsSync(javaBin)) {
        throw new Error(`Custom Java executable not found: "${javaBin}". Check your wurst.javaExecutable setting.`);
    }
    const res = spawnSync(javaBin, ['-version'], { encoding: 'utf8', windowsHide: true });
    // java -version writes to stderr; combine both just in case
    const output = `${res.stderr || ''}${res.stdout || ''}`.trim();
    if (res.error || res.status !== 0) {
        throw new Error(`Failed to run custom Java at "${javaBin}": ${res.error?.message ?? output}`);
    }
    // Version line looks like: openjdk version "25.0.1" or java version "25"
    const match = output.match(/version "(\d+)/);
    if (!match) {
        throw new Error(`Could not determine Java version from output:\n${output}`);
    }
    const major = parseInt(match[1], 10);
    if (major < 25) {
        throw new Error(
            `WurstScript requires Java 25 or newer, but "${javaBin}" reports version ${major}.\n` +
            `On NixOS, add jdk25 (or newer) to your environment and update wurst.javaExecutable accordingly.`
        );
    }
}

function getInstalledVersionString(): string | null {
    try {
        const customJava = workspace.getConfiguration('wurst').get<string>('javaExecutable')?.trim() || '';
        const java = customJava || getBundledJava();
        if (!customJava && (!fs.existsSync(java) || !fs.existsSync(COMPILER_JAR))) return null;
        if (customJava && !fs.existsSync(COMPILER_JAR)) return null;

        const res = spawnSync(java, ['-jar', COMPILER_JAR, '--version'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
        if (!out) return null;
        // Example line contains: 1.8.1.0-nightly-master-3-ge4a2bd1
        return out.split(/\r?\n/).pop() || out;
    } catch {
        return null;
    }
}

function extractShortSha(versionString: string): string | null {
    return versionString.substring(versionString.lastIndexOf('-') + 2);
}

type CliPathUpdate = {
    updated: boolean;
    targetDir: string | null;
    needsTerminalRestart: boolean;
    notes: string[];
};

async function ensureCliOnPath(): Promise<CliPathUpdate> {
    const notes: string[] = [];
    if (!fs.existsSync(WURST_HOME)) {
        return { updated: false, targetDir: null, needsTerminalRestart: false, notes };
    }
    const targetDir = WURST_HOME;

    const envPath = process.env.PATH ?? '';
    const entries = envPath.split(path.delimiter).filter(Boolean);
    const normalized = entries.map((entry) => normalizePath(entry));
    const normalizedTarget = normalizePath(targetDir);

    const isOnPath = normalized.includes(normalizedTarget);
    if (isOnPath) {
        return { updated: false, targetDir, needsTerminalRestart: false, notes };
    }

    prependPathForVsCodeTerminals(targetDir);
    const updated = await updateUserPath(targetDir, notes);
    if (updated) {
        return { updated: true, targetDir, needsTerminalRestart: true, notes };
    }

    return { updated: false, targetDir, needsTerminalRestart: true, notes };
}

function normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isDisposable(value: unknown): value is vscode.Disposable {
    return !!value && typeof (value as vscode.Disposable).dispose === 'function';
}

function prependPathForVsCodeTerminals(pathEntry: string) {
    if (!envCollection) return;
    const normalizedEntry = normalizePath(pathEntry);
    if (prependedPathEntries.has(normalizedEntry)) {
        return;
    }

    const envPath = process.env.PATH ?? '';
    const existingEntries = envPath.split(path.delimiter).filter(Boolean).map((entry) => normalizePath(entry));
    if (existingEntries.includes(normalizedEntry)) {
        prependedPathEntries.add(normalizedEntry);
        return;
    }

    envCollection.prepend('PATH', `${pathEntry}${path.delimiter}`);
    process.env.PATH = `${pathEntry}${path.delimiter}${envPath}`;
    prependedPathEntries.add(normalizedEntry);
}

async function updateUserPath(pathEntry: string, notes: string[]): Promise<boolean> {
    if (process.platform === 'win32') {
        const updated = setWindowsUserPath(pathEntry);
        if (updated) notes.push('Updated Windows user PATH.');
        return updated;
    }

    const updated = updateShellProfiles(pathEntry, notes);
    if (updated) return true;
    return false;
}

function updateShellProfiles(pathEntry: string, notes: string[]): boolean {
    const home = os.homedir();
    const profile = path.join(home, '.profile');
    const zprofile = path.join(home, '.zprofile');
    let changed = false;

    changed = ensurePathExport(profile, pathEntry, notes) || changed;
    changed = ensurePathExport(zprofile, pathEntry, notes) || changed;

    return changed;
}

function ensurePathExport(profilePath: string, pathEntry: string, notes: string[]): boolean {
    const markerStart = '# >>> WurstScript CLI >>>';
    const markerEnd = '# <<< WurstScript CLI <<<';
    const line = `export PATH="${pathEntry}:$PATH"`;

    let content = '';
    if (fs.existsSync(profilePath)) {
        content = fs.readFileSync(profilePath, 'utf8');
        if (content.includes(markerStart) && content.includes(markerEnd)) {
            return false;
        }
    }

    const block = `\n${markerStart}\n${line}\n${markerEnd}\n`;
    try {
        fs.appendFileSync(profilePath, block, 'utf8');
        notes.push(`Added PATH export to ${profilePath}.`);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`Could not update ${profilePath}: ${message}`);
        return false;
    }
}

function setWindowsUserPath(pathEntry: string): boolean {
    const existing = getWindowsUserPath();
    const entries = existing
        ? existing
              .split(';')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : [];
    const normalized = entries.map((entry) => normalizePath(entry));
    const normalizedEntry = normalizePath(pathEntry);
    if (normalized.includes(normalizedEntry)) return false;

    const updated = [...entries, pathEntry].join(';');
    const escaped = escapePowerShellString(updated);
    const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path', '${escaped}', 'User')`],
        { encoding: 'utf8', windowsHide: true }
    );
    return res.status === 0;
}

function getWindowsUserPath(): string {
    const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path', 'User')"],
        { encoding: 'utf8', windowsHide: true }
    );
    return (res.stdout || '').trim();
}

function escapePowerShellString(value: string): string {
    return value.replace(/'/g, "''");
}

async function offerPostInstallActions(update: CliPathUpdate): Promise<void> {
    const baseMessage = 'WurstScript was updated. Restart VS Code now to use the new runtime?';
    const extraMessage = update.updated ? '\n\nRestart terminals or open a new shell to pick up PATH changes.' : '';

    const message = `${baseMessage}${extraMessage}`;
    const choice = await vscode.window.showInformationMessage(message, { modal: true }, 'Restart', 'Cancel');
    if (choice === 'Restart') {
        if (update.needsTerminalRestart) {
            await vscode.commands.executeCommand('workbench.action.terminal.killAll');
            await vscode.commands.executeCommand('workbench.action.terminal.new');
        }
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

/** =========================
 *  Language Server launch
 *  ========================= */

async function getServerOptions(): Promise<ServerOptions> {
    // Only keep minimal config knobs; old ones removed
    const config = workspace.getConfiguration('wurst');
    const javaOpts = config.get<string[]>('javaOpts') ?? []; // still useful for power users
    const debugMode = config.get<boolean>('debugMode');
    const customJava = config.get<string>('javaExecutable')?.trim() || '';

    // Validate installation
    if (!customJava && (!fs.existsSync(RUNTIME_DIR) || !fs.existsSync(COMPILER_JAR))) {
        throw new Error('WurstScript is not installed. Use the "Wurst: Install/Update" command.');
    }
    if (customJava && !fs.existsSync(COMPILER_JAR)) {
        throw new Error('WurstScript compiler not found. Use the "Wurst: Install/Update" command.');
    }

    const java = customJava || getBundledJava();
    if (customJava) checkCustomJavaVersion(customJava);
    const args = [...javaOpts, '-jar', COMPILER_JAR, '-languageServer'];

    if (debugMode && (await isPortOpen(5005))) {
        args.unshift('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y');
    }

    const exec: Executable = { command: java, args };
    return { run: exec, debug: exec };
}

/** =========================
 *  Utilities
 *  ========================= */

function isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', (err: { code: string }) => resolve(err.code !== 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port);
    });
}
