'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'features', 'diagnostics.ts'), 'utf8');
const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
const outputLines = [];
let outputShown = false;
const vscodeMock = {
    window: {
        createOutputChannel: () => ({
            appendLine: (line) => outputLines.push(line),
            show: () => { outputShown = true; },
        }),
        showErrorMessage: async () => 'View Logs',
        showWarningMessage: async () => 'View Logs',
    },
};
const mockRequire = (id) => id === 'vscode' ? vscodeMock : require(id);
new Function('exports', 'module', 'require', js)(mod.exports, mod, mockRequire);

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wurst-diagnostics-'));
fs.mkdirSync(path.join(tempHome, 'logs'));
fs.writeFileSync(
    path.join(tempHome, 'logs', 'languageServer.log'),
    Array.from({ length: 125 }, (_, index) => `language-server-${index + 1}`).join('\n')
);

mod.exports.appendDiagnostic('WC3 data', 'PKExplode: invalid literal size byte 40\n  at explode (pkware.ts:42:7)');
mod.exports.appendDiagnostic('MPQ', 'MPQ archive opened');
mod.exports.appendDiagnostic('Inline icons', 'thumb generation failed');
async function main() {
    const report = mod.exports.buildDiagnosticsText(tempHome);

    assert(report.includes('PKExplode: invalid literal size byte 40'));
    assert(report.includes('at explode (pkware.ts:42:7)'));
    assert(report.includes('MPQ archive opened'));
    assert(report.includes('language-server-125'));
    assert(!report.includes('language-server-25\n'));
    assert(report.split('\n').filter((line) => line.includes('language-server-')).length === 100);

    // Entries carry a local wall-clock stamp on their first line only; stack frames keep their indentation.
    assert(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] PKExplode: invalid literal size byte 40$/m.test(report), report);
    assert(/^ {2}at explode \(pkware\.ts:42:7\)$/m.test(report), report);
    assert(/^Generated: \S+ \(local \d{2}:\d{2}:\d{2}\.\d{3}, UTC[+-]\d{2}:\d{2}\)$/m.test(report), report);

    mod.exports.appendDiagnostic('Inline icons', 'applied thumb: D:\\Maps\\Proj\\imports\\BTNHeal.blp');
    mod.exports.appendDiagnostic('Inline icons', 'extracted to C:\\Users\\bob\\.wurst\\casc_cache\\casc\\a0\\x.dds');
    mod.exports.appendDiagnostic('Inline icons', 'other user C:\\Users\\bobby\\file.txt');
    const withHeader = mod.exports.buildDiagnosticsText(tempHome, {
        header: ['Extension: 1.2.3, VS Code 1.109.0'],
        pathAliases: [
            { dir: 'D:\\Maps\\Proj', label: '<project>' },
            { dir: 'C:\\Users\\bob', label: '~' },
            { dir: 'C:\\Users\\bob\\.wurst\\casc_cache', label: '<casc-cache>' },
        ],
    });
    assert(withHeader.split('\n')[3] === 'Extension: 1.2.3, VS Code 1.109.0', withHeader);
    assert(withHeader.includes('applied thumb: <project>\\imports\\BTNHeal.blp'), 'workspace prefix shortened');
    assert(withHeader.includes('extracted to <casc-cache>\\casc\\a0\\x.dds'), 'the longest matching directory wins');
    assert(withHeader.includes('C:\\Users\\bobby\\file.txt'), 'only whole path segments are shortened');

    const compact = mod.exports.compactPaths;
    assert.strictEqual(compact('/home/bob/.wurst/x', [{ dir: '/home/bob/', label: '~' }], false), '~/.wurst/x');
    assert.strictEqual(compact('/HOME/bob/x', [{ dir: '/home/bob', label: '~' }], false), '/HOME/bob/x', 'case-sensitive off Windows');
    assert.strictEqual(compact('C:/Users/bob/x', [{ dir: 'C:\\Users\\bob', label: '~' }], true), '~/x', 'either separator matches');
    assert.strictEqual(compact('D:\\Maps\\Proj\\x', [{ dir: 'd:\\maps\\proj', label: '<project>' }], true), '<project>\\x', 'case-insensitive on Windows');

    await mod.exports.showErrorWithLogs('Preview failed.', new Error('decoder stack detail'));
    assert(outputShown, 'View Logs should reveal the extension diagnostics output');
    assert(outputLines.some((line) => line.includes('Preview failed.')));
    assert(outputLines.some((line) => line.includes('decoder stack detail')));
    console.log('diagnostics tests passed (bounded tails, stack traces, timestamps, header, path shortening, and View Logs action)');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
