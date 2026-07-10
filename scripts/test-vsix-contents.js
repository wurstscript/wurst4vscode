'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [vsce, 'ls', '--no-dependencies'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);

const files = result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter(Boolean);

const forbidden = [
    /^(?:src|scripts|e2e|wc3data|test|tests|__tests__|fixtures|docs)\//i,
    /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i,
    /(?:^|\/)vsc-extension-quickstart\.md$/i,
    /(?:^|\/)package-lock\.json$/i,
    /\.map$/i,
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
    /\.(?:blp|dds|tga|mdx|w3[a-z0-9]+)$/i,
];

const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
assert.deepStrictEqual(leaked, [], `Test/development files would be packaged:\n${leaked.join('\n')}`);

for (const required of ['package.json', 'README.md', 'dist/extension.js']) {
    assert(files.includes(required), `Required release file is missing: ${required}`);
}

console.log(`VSIX contents verified: ${files.length} runtime files, no test/development assets.`);
