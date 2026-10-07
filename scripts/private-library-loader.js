'use strict';

const { obfuscate } = require('javascript-obfuscator');

// Runs locally at build time, before webpack's final production minification.
// Preserve package exports/properties and avoid transformations of hot control flow.
module.exports = function privateLibraryLoader(source) {
    this.cacheable();
    return obfuscate(source, {
        target: 'browser-no-eval',
        compact: true,
        seed: 42,
        renameGlobals: false,
        renameProperties: false,
        ignoreImports: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        selfDefending: false,
        disableConsoleOutput: false,
        numbersToExpressions: false,
        splitStrings: false,
        stringArray: true,
        stringArrayThreshold: 0.5,
        stringArrayEncoding: [],
        stringArrayCallsTransform: false,
        stringArrayRotate: false,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 1,
        stringArrayWrappersType: 'variable',
        sourceMap: false,
    }).getObfuscatedCode();
};
