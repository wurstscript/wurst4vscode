#!/usr/bin/env node
// Standalone CASC extractor — spawned as a child process by the extension.
// Args: <wc3Root> <cascPath> <outputFile>
// Exits 0 on success, 1 on failure. Writes result to <outputFile>.
'use strict';

const [,, wc3Root, cascPath, outputFile] = process.argv;
if (!wc3Root || !cascPath || !outputFile) {
    console.error('Usage: casc-extract-worker.js <wc3Root> <cascPath> <outputFile>');
    process.exit(1);
}

const casclib = require('@dschu012/casclib');
const fs = require('fs');
const path = require('path');

async function main() {
    const storage = await casclib.openStorage(wc3Root);
    try {
        const buf = await casclib.readFile(storage, cascPath);
        if (!buf || buf.length === 0) { console.error('empty result'); process.exit(1); }
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, buf);
        process.stdout.write(String(buf.length));
    } finally {
        casclib.closeStorage(storage);
    }
}

main().catch(e => { console.error(String(e)); process.exit(1); });
