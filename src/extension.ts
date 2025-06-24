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

export async function activate(context: ExtensionContext) {
    console.log('Wurst extension activated!');

    setupDecorators(context);
    vscode.languages.setLanguageConfiguration('wurst', languageConfig);

    registerBasicCommands(context);

    try {
        await startLanguageClient(context);
    } catch (err) {
        vscode.window.showWarningMessage(`Wurst language features disabled: ${err}`);
    }
}

function registerBasicCommands(context: ExtensionContext) {
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
        }),
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

    const serverOptions = await getServerOptions();
    const client = new LanguageClient('Wurstscript Language Server', serverOptions, clientOptions);

    context.subscriptions.push(client.start());

    client.onReady().then(() => {
        // 1) Create a status‐bar item
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

async function getServerOptions(): Promise<ServerOptions> {
    const config = workspace.getConfiguration('wurst');
    const java = config.get<string>('javaExecutable') ?? 'java';
    const javaOpts = config.get<string[]>('javaOpts') ?? [];
    const wurstJar = (config.get<string>('wurstJar') ?? '$HOME/.wurst/wurstscript.jar').replace('$HOME', os.homedir());
    const debugMode = config.get<boolean>('debugMode');

    // 1) Check for Java
    if (!isJavaAvailable(java)) {
        await vscode.window
            .showErrorMessage(
                'Java 17+ is required but not found. Please install Java or configure "wurst.javaExecutable".',
                'Download Temurin JDK'
            )
            .then((selection) => {
                if (selection === 'Download Temurin JDK') {
                    vscode.env.openExternal(
                        vscode.Uri.parse('https://adoptium.net/en-GB/temurin/releases/?version=17')
                    );
                }
            });
        throw new Error('Java not found.');
    }

    // 2) Download WurstSetup if needed
    if (!(await doesFileExist(wurstJar))) {
        const choice = await vscode.window.showWarningMessage(
            `WurstScript not found at ${wurstJar}. Download now?`,
            'Yes',
            'No'
        );
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

        // 3) when we get here, lsJar exists
        vscode.window.showInformationMessage('WurstScript installed successfully! Launching language server…');

    }

    // 4) Build and return the Language Server command
    let args = [...javaOpts, '-jar', wurstJar, '-languageServer'];
    if (debugMode && (await isPortOpen(5005))) {
        args.unshift('-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y');
    }

    const exec: Executable = { command: java, args };
    return { run: exec, debug: exec };
}

function isJavaAvailable(java: string): boolean {
    const result = spawnSync(java, ['-version'], { encoding: 'utf8' });
    return result.status === 0 && result.stderr.includes('version');
}

function doesFileExist(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
        fs.stat(filePath, (err) => resolve(!err));
    });
}

async function downloadWurstSetup(destination: string): Promise<void> {
    const initialUrl = 'https://github.com/wurstscript/WurstSetup/releases/download/nightly-master/WurstSetup.jar';
    const maxRedirects = 5;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading WurstSetup…',
            cancellable: true,
        },
        (progress, token) => {
            return new Promise<void>((resolve, reject) => {
                let received = 0;
                let total = 0;
                let lastPct = 0;
                let cancelled = false;

                token.onCancellationRequested(() => {
                    cancelled = true;
                });

                function requestUrl(url: string, redirectCount: number) {
                    if (cancelled) {
                        return reject(new Error('Download cancelled by user'));
                    }
                    if (redirectCount > maxRedirects) {
                        return reject(new Error('Too many redirects'));
                    }

                    const req = https.get(url, (res) => {
                        // follow redirects
                        if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
                            const loc = res.headers.location;
                            if (!loc) {
                                return reject(new Error(`Redirect response without Location header`));
                            }
                            // abandon this response and follow the new URL
                            res.destroy();
                            return requestUrl(loc, redirectCount + 1);
                        }

                        if (res.statusCode !== 200) {
                            return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                        }

                        total = parseInt(res.headers['content-length'] || '0', 10);
                        const fileStream = fs.createWriteStream(destination);

                        res.on('data', (chunk) => {
                            if (cancelled) {
                                req.abort();
                                return;
                            }
                            received += chunk.length;
                            if (total > 0) {
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
                            if (cancelled) {
                                return reject(new Error('Download cancelled by user'));
                            }
                            vscode.window.showInformationMessage('WurstSetup downloaded.');
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

                // kick off the first request
                requestUrl(initialUrl, 0);
            });
        }
    );
}

function isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', (err: { code: string }) => {
            resolve(err.code !== 'EADDRINUSE');
        });
        srv.once('listening', () => {
            srv.close();
            resolve(true);
        });
        srv.listen(port);
    });
}
