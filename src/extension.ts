'use strict';

import * as vscode from 'vscode';
import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Executable } from 'vscode-languageclient';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { spawnSync } from 'child_process';

import { registerCommands } from './features/commands';
import { registerFileCreation } from './features/fileCreation';
import { languageConfig } from './languageConfig';
import StreamZip = require('node-stream-zip');

const WURST_HOME = path.join(os.homedir(), '.wurst');
const RUNTIME_DIR = path.join(WURST_HOME, 'wurst-runtime');
const COMPILER_DIR = path.join(WURST_HOME, 'wurst-compiler');
const COMPILER_JAR = path.join(COMPILER_DIR, 'wurstscript.jar'); // new structure ships this jar
const NIGHTLY_RELEASE_BY_TAG_API = 'https://api.github.com/repos/wurstscript/WurstScript/releases/tags/nightly';
const NIGHTLY_COMMIT_API = 'https://api.github.com/repos/wurstscript/WurstScript/commits/nightly';

let clientRef: LanguageClient | null = null;

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


export async function activate(context: ExtensionContext) {
    console.log('Wurst extension activated!');

    setupDecorators(context);
    vscode.languages.setLanguageConfiguration('wurst', languageConfig);

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

    // New: manual install/update command (replaces old Java install)
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
}

function setupDecorators(context: ExtensionContext) {
    let timeout: NodeJS.Timer | undefined;
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

    context.subscriptions.push(client.start());

    client.onReady().then(() => {
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
    });

    await client.onReady();
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

async function ensureInstalledOrOfferMigration(_forcePrompt: boolean): Promise<void> {
    const newLayout = hasNewLayout();

    if (!newLayout) {
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
        await installFreshFromNightly();
        return;
    }

    // New layout present but first run could still miss the jar
    if (!fs.existsSync(COMPILER_JAR)) {
        await installFreshFromNightly();
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
            // 80% of bar for download, 18% for extraction, 2% finishing
            const DL_WEIGHT = 80;
            const EX_WEIGHT = 18;

            await downloadFileWithProgress(asset.url, tmpZip, (pct) => {
                const scaled = (pct / 100) * DL_WEIGHT;
                const inc = Math.max(0, scaled - last);
                last += inc;
                progress.report({ message: `Downloading ${Math.floor(pct)}%`, increment: inc });
            });

            await extractZipWithByteProgress(tmpZip, unpack, (pct) => {
                const scaled = DL_WEIGHT + (pct / 100) * EX_WEIGHT;
                const inc = Math.max(0, scaled - last);
                last += inc;
                progress.report({ message: `Extracting ${Math.floor(pct)}%`, increment: inc });
            });

            progress.report({ message: 'Finishing up…', increment: Math.max(0, 100 - last) });

            const srcRuntime = path.join(unpack, 'wurst-runtime');
            const srcCompiler = path.join(unpack, 'wurst-compiler');
            const srcLauncher = path.join(unpack, process.platform === 'win32' ? 'wurstscript.cmd' : 'wurstscript');

            if (!fs.existsSync(srcRuntime) || !fs.existsSync(path.join(srcCompiler, 'wurstscript.jar'))) {
                throw new Error('Installation incomplete: runtime or compiler not found after extraction.');
            }

            // Ensure ~/.wurst exists
            fs.mkdirSync(WURST_HOME, { recursive: true });

            // Upgrade subfolders in place (no touching ~/.wurst itself)
            await upgradeFolder(srcRuntime, RUNTIME_DIR);
            await upgradeFolder(srcCompiler, COMPILER_DIR);

            cleanupOldWurstHome();

            // Place/refresh launcher (best effort)
            try {
                const targetLauncher = path.join(WURST_HOME, path.basename(srcLauncher));
                try {
                    fs.unlinkSync(targetLauncher);
                } catch {}
                fs.renameSync(srcLauncher, targetLauncher);
                if (process.platform !== 'win32') {
                    try {
                        fs.chmodSync(targetLauncher, 0o755);
                    } catch {}
                }
            } catch {
                /* ignore */
            }

            // Ensure java is executable on unix
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(getBundledJava(), 0o755);
                } catch {}
            }

            // Cleanup tmp
            try {
                await removeDirSafe(tmpWork);
            } catch {}

            progress.report({ message: 'Ready', increment: 10 });
        }
    );

    // Ask for reload so the LS restarts against the new layout
    const reload = await vscode.window.showInformationMessage(
        'WurstScript was updated. Reload VS Code now to use the new runtime?',
        { modal: true },
        'Reload',
        'Later'
    );
    if (reload === 'Reload') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
}

function cleanupOldWurstHome() {
    const allowed = new Set(['logs', 'wurst-runtime', 'wurst-compiler', 'grill.cmd', 'wurstscript.cmd']);

    if (!fs.existsSync(WURST_HOME)) return;

    for (const entry of fs.readdirSync(WURST_HOME)) {
        if (!allowed.has(entry)) {
            const p = path.join(WURST_HOME, entry);
            try {
                // remove old jars, exes, folders, etc.
                fs.rmSync(p, { recursive: true, force: true });
            } catch (e) {
                console.warn('Failed to delete old file:', p, e);
            }
        }
    }
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
            await installFreshFromNightly();
        }
    } catch (e) {
        console.warn('Update check failed:', e);
    }
}

function getBundledJava(): string {
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    return path.join(RUNTIME_DIR, 'bin', exe);
}

function getInstalledVersionString(): string | null {
    try {
        const java = getBundledJava();
        if (!fs.existsSync(java) || !fs.existsSync(COMPILER_JAR)) return null;

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

/** =========================
 *  Language Server launch
 *  ========================= */

async function getServerOptions(): Promise<ServerOptions> {
    // Only keep minimal config knobs; old ones removed
    const config = workspace.getConfiguration('wurst');
    const javaOpts = config.get<string[]>('javaOpts') ?? []; // still useful for power users
    const debugMode = config.get<boolean>('debugMode');

    // Validate installation
    if (!fs.existsSync(RUNTIME_DIR) || !fs.existsSync(COMPILER_JAR)) {
        throw new Error('WurstScript is not installed. Use the "Wurst: Install/Update" command.');
    }

    const java = getBundledJava();
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
