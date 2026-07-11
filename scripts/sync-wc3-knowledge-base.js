'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(root, '..', 'WurstScript', 'de.peeeq.wurstscript', 'src', 'main', 'resources', 'wc3-knowledge-base.json');
const destination = path.join(root, 'resources', 'wc3-knowledge-base.json');

const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
if (parsed.schemaVersion !== 1 || !parsed.fieldSchemas || !parsed.objects) {
    throw new Error(`Unsupported WC3 knowledge base: ${source}`);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify(parsed));
console.log(`Synced ${path.relative(root, destination)} (${fs.statSync(destination).size} bytes)`);
