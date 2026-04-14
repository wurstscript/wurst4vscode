'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';
import { NIGHTLY_RELEASE_BY_TAG_API, NIGHTLY_COMMIT_API, WURSTSETUP_RELEASE } from '../paths';
import StreamZip = require('node-stream-zip');

export function githubJson<T = any>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'wurst4vscode',
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        }, (res) => {
            if (!res.statusCode || res.statusCode >= 400) {
                reject(new Error(`GitHub API error: HTTP ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(Buffer.from(d)));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
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
    const maxRedirects = 5;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    return new Promise<number>((resolve, reject) => {
        let received = 0, total = 0, cancelled = false;
        if (cancellationToken) cancellationToken.onCancellationRequested(() => (cancelled = true));

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
                    if (cancelled) { req.destroy(); return; }
                    received += chunk.length;
                    if (total > 0 && onPct) onPct((received / total) * 100);
                });
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    if (cancelled) return reject(new Error('Download cancelled by user'));
                    resolve(fs.statSync(destination).size);
                });
                res.on('error', (err) => { fs.unlink(destination, () => {}); reject(err); });
            });
            req.on('error', (err) => { fs.unlink(destination, () => {}); reject(err); });
        }

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
