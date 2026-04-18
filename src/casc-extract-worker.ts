#!/usr/bin/env node
// Standalone CASC extractor — bundled by webpack, spawned as a child process by the extension.
// Args: <wc3Root> <cascPath> <outputFile>
// Exits 0 on success, 1 on failure. Writes result to <outputFile>.

import { CascStorage, closeAllSegments } from 'casc-ts';
import * as fs from 'fs';
import * as path from 'path';

const [,, wc3Root, cascPath, outputFile] = process.argv;
if (!wc3Root || !cascPath || !outputFile) {
    console.error('Usage: casc-extract-worker.js <wc3Root> <cascPath> <outputFile>');
    process.exit(1);
}

(async () => {
    try {
        const storage = await CascStorage.openAsync(wc3Root);
        const buf = await storage.readFileAsync(cascPath);
        if (!buf || buf.length === 0) { console.error('empty result'); process.exit(1); }
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, buf);
        process.stdout.write(String(buf.length));
    } catch (e) {
        console.error(String(e));
        process.exit(1);
    } finally {
        await closeAllSegments().catch(() => {});
    }
})();
