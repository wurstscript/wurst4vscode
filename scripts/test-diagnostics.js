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

    await mod.exports.showErrorWithLogs('Preview failed.', new Error('decoder stack detail'));
    assert(outputShown, 'View Logs should reveal the extension diagnostics output');
    assert(outputLines.some((line) => line.includes('Preview failed.')));
    assert(outputLines.some((line) => line.includes('decoder stack detail')));
    console.log('diagnostics tests passed (bounded tails, stack traces, and View Logs action)');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
