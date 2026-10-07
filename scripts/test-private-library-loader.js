'use strict';

const assert = require('assert');
const vm = require('vm');
const path = require('path');
const loader = require('./private-library-loader');
const configure = require('../webpack.config');

const source = `exports.parse = function (buffer) { const internalMessage = 'private parser fixture';
return { message: internalMessage, value: buffer.readUInt32LE(0) }; };`;
const protectedSource = loader.call({ cacheable() {} }, source);
const exportsObject = {};
vm.runInNewContext(protectedSource, { exports: exportsObject });
assert.strictEqual(exportsObject.parse(Buffer.from([42, 0, 0, 0])).value, 42);
assert.strictEqual(exportsObject.parse(Buffer.alloc(4)).message, 'private parser fixture');
assert(!protectedSource.includes('internalMessage'), 'Internal variable names should be obscured');
assert(!/\beval\s*\(/.test(protectedSource), 'Protected modules must work with the webview CSP');
assert.strictEqual(loader.call({ cacheable() {} }, source), protectedSource, 'Release transforms should be reproducible');

for (const config of configure({}, { mode: 'production' })) {
    assert.strictEqual(config.devtool, false);
    assert.strictEqual(config.optimization.minimize, true);
    const rule = config.module.rules.find(item => item.include);
    for (const name of ['war3-model', 'casc-ts']) assert(rule.include(require.resolve(name)));
    assert(!rule.include(path.resolve(__dirname, '../src/extension.js')));
    assert(!rule.include(require.resolve('typescript')));
}
for (const config of configure({}, { mode: 'none' })) {
    assert.strictEqual(config.optimization.minimize, false);
    assert(!config.module.rules.some(item => item.include));
}
console.log('Private library protection preserves API behavior, CSP compatibility, reproducibility and release-only scope.');
