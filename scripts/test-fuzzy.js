'use strict';

/**
 * Unit tests for the shared fuzzy search (src/features/preview/fuzzy.ts).
 * Transpiles the actual source (no duplication) and asserts matches/non-matches.
 * Run: `node scripts/test-fuzzy.js`
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const srcPath = path.join(__dirname, '..', 'src', 'features', 'preview', 'fuzzy.ts');
const src = fs.readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: 'commonjs', target: 'es2020' } }).outputText;
const mod = { exports: {} };
new Function('exports', 'module', js)(mod.exports, mod);
const { fuzzyMatch } = mod.exports;
assert.strictEqual(typeof fuzzyMatch, 'function', 'fuzzyMatch should be exported');

let passed = 0;
function ok(query, text, expected, msg) {
    const got = fuzzyMatch(query, text);
    assert.strictEqual(got, expected, `fuzzyMatch(${JSON.stringify(query)}, ${JSON.stringify(text)}) → ${got}, expected ${expected}${msg ? ' — ' + msg : ''}`);
    passed++;
}

// empty query matches anything
ok('', 'whatever', true);
ok('   ', 'whatever', true);

// plain substring (case-insensitive)
ok('grav', 'Graveyard', true);
ok('GRAVE', 'Graveyard', true);
ok('yard', 'Graveyard', true);

// the regression that prompted this: typo inside a compound name
ok('billiance', 'BTNBrilliance - Brilliance Aura', true, 'single deletion typo');
ok('billiance', 'BTNBrillianceAura', true, 'typo inside a compound (no spaces)');
ok('brilliance', 'ReplaceableTextures\\CommandButtons\\BTNBrilliance.blp', true, 'matches inside a path');

// small typos
ok('graveyrd', 'Graveyard', true, 'one deletion');
ok('graevyard', 'Graveyard', true, 'one transposition (2 edits)');
ok('footmen', 'Footman', true, 'one substitution');

// short queries: substring only, no fuzzy (avoid noise)
ok('xj', 'Graveyard', false, 'too short to fuzz');
ok('ab', 'crab', true, 'short but substring');

// clear non-matches stay non-matches
ok('zzzzzzz', 'Graveyard', false);
ok('peasant', 'Brilliance Aura', false);
ok('xyzqq', 'Graveyard', false);

// threshold stays low — not loose
ok('catapult', 'Graveyard', false, 'too many edits');

console.log(`fuzzy unit tests passed (${passed} assertions)`);
