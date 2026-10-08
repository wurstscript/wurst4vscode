'use strict';

import * as fs from 'fs';
import { ClientRequest } from 'http';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';
import { COMPILER_RELEASES_API, WURSTSETUP_RELEASE } from '../paths';
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
        const fail = (error: Error) => {
            if (done) return;
            done = true;
            clearTimer(timer);
            reject(error);
        };
        const succeed = (value: T) => {
            if (done) return;
            done = true;
            clearTimer(timer);
            resolve(value);
        };
        const req = https.request(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'wurst4vscode',
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        }, (res) => {
            if (!res.statusCode || res.statusCode >= 400) {
                res.resume();
                fail(new Error(`GitHub API error: HTTP ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(Buffer.from(d)));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    succeed(parsed);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            });
            res.on('error', (error) => fail(error));
        });
        timer = setTimeout(() => {
            req.destroy();
            fail(new Error(`GitHub API request timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
        }, DOWNLOAD_TIMEOUT_MS);
        req.on('error', fail);
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

export type CompilerRelease = { version: string; tag: string; name: string; url: string };

export function stableCompilerVersion(value: string): string | null {
    return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.replace(/^v/, '') : null;
}

export function compareCompilerVersions(left: string, right: string): number {
    const a = left.split('.').map(BigInt);
    const b = right.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
}

function compilerPlatform(): string {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (process.platform === 'win32') return `win-${arch}`;
    if (process.platform === 'linux') return `linux-${arch}`;
    if (process.platform === 'darwin') return `macos-${arch}`;
    throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
}

export async function fetchCompilerReleases(): Promise<CompilerRelease[]> {
    const platform = compilerPlatform();
    const releases: CompilerRelease[] = [];
    for (let page = 1; ; page++) {
        const batch = await githubJson<any[]>(`${COMPILER_RELEASES_API}?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid WurstScript release response.');
        for (const release of batch) {
            const version = stableCompilerVersion(String(release.tag_name ?? ''));
            if (!version || !String(release.tag_name).startsWith('v') || release.draft || release.prerelease) continue;
            const name = `wurst-compiler-${version}-${platform}.zip`;
            const asset = release.assets?.find((item: any) => item.name === name && item.browser_download_url);
            if (asset) releases.push({ version, tag: release.tag_name, name, url: asset.browser_download_url });
        }
        if (batch.length < 100) break;
    }
    return releases.sort((a, b) => compareCompilerVersions(b.version, a.version));
}

export async function fetchLatestCompilerRelease(): Promise<CompilerRelease> {
    const releases = await fetchCompilerReleases();
    if (!releases.length) throw new Error(`No stable WurstScript compiler release is available for ${compilerPlatform()}.`);
    return releases[0];
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
        let request: ClientRequest | null = null;
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
            clearDownloadTimeout();
            try {
                const size = fs.statSync(destination).size;
                settled = true;
                resolve(size);
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

                res.on('data', (chunk) => {
                    if (cancelled) return finishFailure(new Error('Download cancelled by user'));
                    received += chunk.length;
                    if (total > 0 && onPct) onPct((received / total) * 100);
                });
                output.on('finish', () => {
                    output?.close();
                    if (cancelled) return finishFailure(new Error('Download cancelled by user'));
                    finishSuccess();
                });
                res.on('error', (err) => { finishFailure(err); });
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

                    const onBytes = (chunk: Buffer) => {
                        processed += chunk.length;
                        onPct?.((processed / total) * 100);
                    };
                    await new Promise<void>((res, rej) => {
                        zip.stream(name, (err: any, stream: any) => {
                            if (err || !stream) return rej(err || new Error('stream error'));
                            const out = fs.createWriteStream(outPath);
                            stream.on('data', onBytes);
                            stream.on('end', res);
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
