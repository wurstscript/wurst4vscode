'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';
import { NIGHTLY_RELEASE_BY_TAG_API, NIGHTLY_COMMIT_API, WURSTSETUP_RELEASE } from '../paths';
import StreamZip = require('node-stream-zip');

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer) clearTimeout(timer);
}

function cleanupDownloadedFile(destination: string): void {
    try { fs.unlinkSync(destination); } catch {}
}

function resolveRedirect(baseUrl: string, location: string): string {
    try { return new URL(location, baseUrl).toString(); } catch { return location; }
}

export function githubJson<T = any>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const req = https.request(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'wurst4vscode',
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        }, (res) => {
            clearTimer(timer);
            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                if (!done) {
                    done = true;
                    reject(new Error(`GitHub API error: HTTP ${res.statusCode}`));
                }
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(Buffer.from(d)));
            res.on('end', () => {
                try {
                    if (!done) {
                        done = true;
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    }
                } catch (error) {
                    if (!done) {
                        done = true;
                        reject(error);
                    }
                } finally {
                    clearTimer(timer);
                }
            });
        });
        timer = setTimeout(() => {
            req.destroy();
            if (!done) {
                done = true;
                reject(new Error(`GitHub API request timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
            }
        }, DOWNLOAD_TIMEOUT_MS);
        req.on('error', (error) => {
            clearTimer(timer);
            if (done) return;
            done = true;
            reject(error);
        });
        req.end();
    });
}

export async function fetchLatestGrillAsset(): Promise<{ name: string; url: string }> {
    const rel = await githubJson(WURSTSETUP_RELEASE);
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];
    const wanted = assets.find((a: any) => {
        const n = String(a?.name ?? '').toLowerCase();
        return n.startsWith('wurstsetup') && n.endsWith('.jar');
    });
    if (!wanted?.browser_download_url) throw new Error('No WurstSetup JAR found in the latest WurstSetup release.');
    return { name: wanted.name, url: wanted.browser_download_url };
}

export async function fetchNightlyZipAsset(): Promise<{ name: string; url: string }> {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    let plat: string;
    if (process.platform === 'win32') plat = `win-${arch}`;
    else if (process.platform === 'linux') plat = `linux-${arch}`;
    else if (process.platform === 'darwin') plat = `macos-${arch}`;
    else throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);

    const rel = await githubJson(NIGHTLY_RELEASE_BY_TAG_API);
    const assets = Array.isArray(rel?.assets) ? rel.assets : [];
    const wanted = assets.find((a: any) => {
        const n = String(a?.name ?? '').toLowerCase();
        return n.endsWith(`${plat}.zip`) && n.startsWith('wurst-compiler-nightly-');
    });
    if (!wanted?.browser_download_url) {
        if (process.platform === 'darwin') throw new Error('No macOS build found on the nightly release.');
        throw new Error(`No matching asset found for ${plat}.`);
    }
    return { name: wanted.name, url: wanted.browser_download_url };
}

export async function fetchNightlyCommitSha(): Promise<string> {
    const obj = await githubJson(NIGHTLY_COMMIT_API);
    const sha: string | undefined = obj?.sha;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Could not resolve nightly commit SHA.');
    return sha.toLowerCase();
}

export async function downloadFileWithProgress(
    url: string,
    destination: string,
    onPct?: (pct: number) => void,
    cancellationToken?: vscode.CancellationToken
): Promise<number> {
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    return new Promise<number>((resolve, reject) => {
        let received = 0;
        let total = 0;
        let cancelled = false;
        let settled = false;
        let request: https.ClientRequest | null = null;
        let output: fs.WriteStream | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        if (cancellationToken) cancellationToken.onCancellationRequested(() => {
            if (settled) return;
            cancelled = true;
            finishFailure(new Error('Download cancelled by user'));
        });

        const clearDownloadTimeout = () => clearTimer(timeout);
        const finishFailure = (error: Error) => {
            if (settled) return;
            settled = true;
            clearDownloadTimeout();
            if (request) request.destroy();
            if (output) {
                output.destroy();
            }
            cleanupDownloadedFile(destination);
            reject(error);
        };

        const finishSuccess = () => {
            if (settled) return;
            settled = true;
            clearDownloadTimeout();
            try {
                resolve(fs.statSync(destination).size);
            } catch (error) {
                finishFailure(error instanceof Error ? error : new Error(String(error)));
            }
        };

        const requestUrl = (currentUrl: string, redirects: number) => {
            if (settled) return;
            if (cancelled) return finishFailure(new Error('Download cancelled by user'));
            if (redirects > MAX_REDIRECTS) return finishFailure(new Error('Too many redirects'));

            clearDownloadTimeout();
            const req = https.get(currentUrl, { headers: { 'User-Agent': 'wurst4vscode' } }, (res) => {
                clearDownloadTimeout();
                if ([301, 302, 303, 307, 308].includes(res.statusCode!)) {
                    const loc = res.headers.location;
                    if (!loc) return finishFailure(new Error('Redirect without Location header'));
                    res.destroy();
                    return requestUrl(resolveRedirect(currentUrl, String(loc)), redirects + 1);
                }
                if (res.statusCode !== 200) {
                    const status = res.statusCode == null ? 'unknown' : res.statusCode;
                    res.destroy();
                    return finishFailure(new Error(`Download failed: HTTP ${status}`));
                }

                total = parseInt(res.headers['content-length'] || '0', 10);
                output = fs.createWriteStream(destination);

                // eslint-disable-next-line sonarjs/no-nested-functions -- TODO(lint-cleanup): pre-existing Node callback-style download logic; tracked for an async/await refactor rather than a rushed change to this path.
                res.on('data', (chunk) => {
                    if (cancelled) return finishFailure(new Error('Download cancelled by user'));
                    received += chunk.length;
                    if (total > 0 && onPct) onPct((received / total) * 100);
                });
                // eslint-disable-next-line sonarjs/no-nested-functions -- TODO(lint-cleanup): pre-existing Node callback-style download logic; tracked for an async/await refactor rather than a rushed change to this path.
                output.on('finish', () => {
                    output?.close();
                    if (cancelled) return finishFailure(new Error('Download cancelled by user'));
                    finishSuccess();
                });
                // eslint-disable-next-line sonarjs/no-nested-functions -- TODO(lint-cleanup): pre-existing Node callback-style download logic; tracked for an async/await refactor rather than a rushed change to this path.
                res.on('error', (err) => { finishFailure(err); });
            // eslint-disable-next-line sonarjs/no-nested-functions -- TODO(lint-cleanup): pre-existing Node callback-style download logic; tracked for an async/await refactor rather than a rushed change to this path.
            output.on('error', (err) => { finishFailure(err); });
            res.pipe(output);
        });
            req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
                finishFailure(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
            });
            req.on('error', (err) => { finishFailure(err); });
            request = req;
            timeout = setTimeout(() => {
                finishFailure(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
            }, DOWNLOAD_TIMEOUT_MS);
        };

        requestUrl(url, 0);
    });
}

function within(destDir: string, p: string) {
    return path.resolve(p).startsWith(path.resolve(destDir) + path.sep);
}

export async function extractZipWithByteProgress(
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

                for (const name of names) {
                    const e = entries[name];
                    if (e.isDirectory) {
                        const d = path.join(destDir, name);
                        if (!within(destDir, d)) throw new Error('Illegal path in zip');
                        fs.mkdirSync(d, { recursive: true });
                    }
                }

                const files = names.filter((n) => !entries[n].isDirectory);
                const total = files.reduce((s, n) => s + (entries[n].size || 0), 0) || 1;
                let processed = 0;

                for (const name of files) {
                    const outPath = path.join(destDir, name);
                    if (!within(destDir, outPath)) throw new Error('Illegal path in zip');
                    fs.mkdirSync(path.dirname(outPath), { recursive: true });

                    await new Promise<void>((res, rej) => {
                        // eslint-disable-next-line sonarjs/no-nested-functions -- TODO(lint-cleanup): pre-existing Node callback-style zip-extraction logic; tracked for an async/await refactor rather than a rushed change to this path.
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
                try { zip.close(); } catch {}
                reject(e);
            }
        });
    });
}
