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

// Static Java download URLs
const JAVA_DOWNLOAD_URLS: { [key: string]: string } = {
    win32: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.15%2B6/OpenJDK17U-jdk_x64_windows_hotspot_17.0.15_6.msi',
    darwin: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.15%2B6/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.15_6.pkg',
    linux: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.15%2B6/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.15_6.tar.gz',
};

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
    // Choose game executable
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

    // Install Java command
    context.subscriptions.push(
        vscode.commands.registerCommand('wurst.installJava', async () => {
            console.log('Command wurst.installJava invoked');
            await installJavaAutomatically(context);
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
    const clientOptions: LanguageClientOptions = {
        documentSelector: ['wurst'],
        synchronize: { configurationSection: 'wurst' },
    };

    const serverOptions = await getServerOptions(context);
    const client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);

    context.subscriptions.push(client.start());

    client.onReady().then(() => {
        const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        sb.text = '$(check) WurstScript';
        sb.tooltip = 'WurstScript language server is running.';
        sb.show();
        context.subscriptions.push(sb);
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

async function downloadWithProgress(
    url: string,
    destination: string,
    progressTitle: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
    cancellationToken?: vscode.CancellationToken
): Promise<void> {
    const maxRedirects = 5;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: progressTitle,
            cancellable: !!cancellationToken,
        },
        (_progress, token) => {
            let received = 0;
            let total = 0;
            let lastPct = 0;
            let cancelled = false;

            if (cancellationToken) {
                cancellationToken.onCancellationRequested(() => (cancelled = true));
            } else {
                token.onCancellationRequested(() => (cancelled = true));
            }

            return new Promise<void>((resolve, reject) => {
                function requestUrl(url: string, redirectCount: number) {
                    if (cancelled) return reject(new Error('Download cancelled by user'));
                    if (redirectCount > maxRedirects) return reject(new Error('Too many redirects'));

                    const req = https.get(url, (res) => {
                        if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
                            const loc = res.headers.location;
                            if (!loc) return reject(new Error('Redirect without Location header'));
                            res.destroy();
                            return requestUrl(loc, redirectCount + 1);
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
                            if (total > 0 && progress) {
                                const pct = (received / total) * 100;
                                const inc = pct - lastPct;
                                if (inc > 0) {
                                    progress.report({ increment: inc, message: `${Math.floor(pct)}%` });
                                    lastPct = pct;
                                }
                            }
                        });

                        res.pipe(fileStream);

                        fileStream.on('finish', () => {
                            fileStream.close();
                            if (cancelled) return reject(new Error('Download cancelled by user'));
                            resolve();
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
    );
}

export async function downloadFile(
    url: string,
    destination: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>
): Promise<number> {
    await downloadWithProgress(url, destination, 'Downloading…', progress);
    return fs.statSync(destination).size;
}

async function downloadWurstSetup(destination: string): Promise<void> {
    const url = 'https://github.com/wurstscript/WurstSetup/releases/download/nightly-master/WurstSetup.jar';
    await downloadWithProgress(url, destination, 'Downloading WurstSetup…');
}


async function getServerOptions(context: ExtensionContext): Promise<ServerOptions> {
    const config = workspace.getConfiguration('wurst');
    const java = config.get<string>('javaExecutable') ?? 'java';
    const javaOpts = config.get<string[]>('javaOpts') ?? [];
    const wurstJar = (config.get<string>('wurstJar') ?? '$HOME/.wurst/wurstscript.jar').replace('$HOME', os.homedir());
    const debugMode = config.get<boolean>('debugMode');

    console.log('Checking Java availability at', java);
    if (!isJavaAvailable(java)) {
        console.log('Java not available, invoking installer');
        await installJavaAutomatically(context);
        if (!isJavaAvailable(java)) {
            console.error('Java still not found after installation');
            throw new Error('Java not found after installation.');
        }
    }

    if (!(await doesFileExist(wurstJar))) {
        const choice = await vscode.window.showWarningMessage(
            `WurstScript not found at ${wurstJar}. Download now?`,
            'Yes',
            'No');

            if (choice !== 'Yes') {
            throw new Error('WurstScript not installed.');
        }
        const setupJar = path.join(os.homedir(), '.wurst', 'WurstSetup.jar');
        await downloadWurstSetup(setupJar);

        // 3) Run the installer in a Terminal
        const term = vscode.window.createTerminal({
            name: 'WurstScript Installer',
            shellPath:
                process.platform === 'win32'
                    ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
                    : undefined,
            shellArgs:
                process.platform === 'win32'
                    ? [
                          '-NoExit',
                          '-Command',
                          // 1) switch code page, 2) set PS’s OutputEncoding, all in one line
                          'chcp 65001; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
                      ]
                    : undefined,
            env: {
                LANG: 'en_US.UTF-8',
            },
        });
        term.show(true);

        // make sure your PowerShell terminal is in UTF-8 mode…
        if (process.platform === 'win32') {
            term.sendText('chcp 65001; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()');
        }

        // now send the properly quoted install command:
        const installerCmd = [
            `& "${java}"`,
            `"-Dfile.encoding=UTF-8"`,
            `-jar "${setupJar}"`,
            `install wurstscript`,
        ].join(' ');
        term.sendText(installerCmd);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing WurstScript…',
                cancellable: false,
            },
            async (_progress) => {
                const interval = 2000;
                const timeout = 5 * 60 * 1000;
                const start = Date.now();

                return new Promise<void>((resolve, reject) => {
                    const handle = setInterval(async () => {
                        if (await doesFileExist(wurstJar)) {
                            clearInterval(handle);
                            resolve();
                        } else if (Date.now() - start > timeout) {
                            clearInterval(handle);
                            reject(new Error('Timed out waiting for WurstScript installation.'));
                        }
                    }, interval);
                });
            }
        );
    }

    let args = [...javaOpts, '-jar', wurstJar, '-languageServer'];
    if (debugMode && (await isPortOpen(5005))) {
        args.unshift('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y');
    }

    const exec: Executable = { command: java, args };
    return { run: exec, debug: exec };
}

async function installJavaAutomatically(context: ExtensionContext): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
        'Java 17+ is required but not found. Automatically download and install OpenJDK 17?',
        'Yes',
        'No'
    );
    console.log('User chose to install Java:', choice);
    if (choice !== 'Yes') {
        console.log('Opening manual download page');
        vscode.env.openExternal(vscode.Uri.parse(JAVA_DOWNLOAD_URLS[os.platform()] || 'https://adoptium.net'));
        return;
    }

    const plat = os.platform();
    const url = JAVA_DOWNLOAD_URLS[plat];
    if (!url) {
        console.error('No download URL for platform', plat);
        vscode.window.showErrorMessage(`Unsupported platform for auto-install: ${plat}`);
        return;
    }

    const installerName = path.basename(url);
    const dest = path.join(os.tmpdir(), installerName);

    try {
        console.log('Downloading Java from', url, 'to', dest);
        let expectedSize = 0;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Downloading OpenJDK…', cancellable: false },
            (progress) =>
                downloadFile(url, dest, progress).then((size) => {
                    expectedSize = size;
                })
        );
        console.log(`Download completed, size=${expectedSize} bytes`);

        const stats = fs.statSync(dest);
        if (stats.size < expectedSize) {
            throw new Error(`Downloaded file incomplete: ${stats.size}/${expectedSize}`);
        }

        console.log('Running installer at', dest);

        const copyPath = path.join(os.tmpdir(), 'jdk-installer-copy.msi');
        fs.copyFileSync(dest, copyPath);
        console.log('Copied installer to', copyPath);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Installing Java…', cancellable: false },
            async () => await runInstaller(copyPath)
        );
        console.log('Installation completed');

        const proceed = await vscode.window.showInformationMessage(
            'The java installer has been launched. Click "Done" after installation is complete.',
            'Done'
        );

        if (proceed === 'Done') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }

        vscode.window.showInformationMessage('Java installed. Restarting extension...');
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
        console.error('Java installation failed:', error);
        fs.existsSync(dest) && fs.unlinkSync(dest);
        vscode.window.showErrorMessage(`Java installation failed: ${error}`);
    }
}


export async function runInstaller(installerPath: string): Promise<void> {
    const plat = os.platform();
    console.log('Launching installer for platform', plat, 'at path', installerPath);

    if (!fs.existsSync(installerPath)) {
        throw new Error(`Installer file not found at ${installerPath}`);
    }

    try {
        // Open with default system installer (works for .msi, .pkg, etc.)
        await vscode.env.openExternal(vscode.Uri.file(installerPath));
    } catch (err) {
        console.error('Failed to open installer:', err);
        throw new Error(`Failed to open installer: ${err}`);
    }
}

function isJavaAvailable(java: string): boolean {
    const result = spawnSync('cmd', ['/c', java, '-version'], {
        encoding: 'utf8',
        shell: false,
    });

    if (result.status === 0) {
        console.log('Java output:', result.stdout || result.stderr);
        return true;
    } else {
        console.error('Java not found:', result.stderr || result.stdout);
        return false;
    }
}

function doesFileExist(filePath: string): Promise<boolean> {
    return new Promise((resolve) => fs.stat(filePath, (err) => resolve(!err)));
}

function isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', (err: { code: string }) => resolve(err.code !== 'EADDRINUSE'));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port);
    });
}
