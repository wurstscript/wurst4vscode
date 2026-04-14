#!/usr/bin/env node
// Standalone CASC extractor — bundled by webpack, spawned as a child process by the extension.
// Args: <wc3Root> <cascPath> <outputFile>
// Exits 0 on success, 1 on failure. Writes result to <outputFile>.

import { CascStorage } from 'casc-ts';
import * as fs from 'fs';
import * as path from 'path';

const [,, wc3Root, cascPath, outputFile] = process.argv;
if (!wc3Root || !cascPath || !outputFile) {
    console.error('Usage: casc-extract-worker.js <wc3Root> <cascPath> <outputFile>');
    process.exit(1);
}

// casc-ts stores paths with forward slashes; normalize before lookup
function normalizePath(p: string): string {
    // Convert backslashes but preserve the colon separator for sub-archive paths (e.g. war3.w3mod:path/to/file)
    const colonIdx = p.indexOf(':');
    if (colonIdx !== -1) {
        return p.slice(0, colonIdx + 1) + p.slice(colonIdx + 1).replace(/\\/g, '/');
    }
    return p.replace(/\\/g, '/');
}

try {
    const storage = CascStorage.open(wc3Root);
    const buf = storage.readFile(normalizePath(cascPath));
    if (!buf || buf.length === 0) { console.error('empty result'); process.exit(1); }
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, buf);
    process.stdout.write(String(buf.length));
} catch (e) {
    console.error(String(e));
    process.exit(1);
}
