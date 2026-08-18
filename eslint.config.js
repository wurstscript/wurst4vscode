// @ts-check
'use strict';

const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const sonarjs = require('eslint-plugin-sonarjs');
const globals = require('globals');

module.exports = tseslint.config(
	{
		// The webview scripts are plain bundled browser JS with `// @ts-nocheck` and a very
		// different style (inline HTML template strings) — see AGENTS.md. Lint everything else.
		ignores: ['dist/**', 'out/**', 'node_modules/**', 'src/webview/**', '.claude/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	sonarjs.configs.recommended,
	{
		languageOptions: {
			globals: globals.node,
		},
		rules: {
			// Lazy/optional `require()` (native addons, avoiding upfront bundling cost) is an
			// established pattern in this codebase — see src/languageServer.ts, imageDecoders.ts.
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-unused-vars': 'off',
			// Swallowed errors (best-effort cleanup, optional feature probing) are common and
			// intentional here; still flag genuinely empty branches other than catch.
			'no-empty': ['error', { allowEmptyCatch: true }],

			// These sonarjs rules assume an untrusted, internet-facing execution context and don't
			// fit this codebase's actual usage — reviewed at adoption time (see AGENTS.md), not
			// worth 24 individual inline suppressions:
			//  - code-eval: scripts/test-*.js and test-webview.js use `new Function`/`vm.Script` to
			//    transpile-and-run this repo's OWN TypeScript in a local test harness — not
			//    executing untrusted input.
			//  - no-os-command-from-path: PATH is read (never written) to locate an existing local
			//    Java/Wurst installation for the installer/e2e scripts, not to resolve a command
			//    that's then executed with elevated trust.
			//  - file-permissions: the chmod calls in src/install/ set intentionally permissive
			//    modes on files this extension itself just downloaded/wrote into `~/.wurst`.
			//  - pseudo-random: Math.random() is only used for webview CSP nonces and non-secret
			//    ids/jitter — not for anything security-sensitive.
			//  - hashing: MD5/SHA1 usage here is cache-key/dedup hashing of local files, not a
			//    security boundary.
			'sonarjs/code-eval': 'off',
			'sonarjs/no-os-command-from-path': 'off',
			'sonarjs/file-permissions': 'off',
			'sonarjs/pseudo-random': 'off',
			'sonarjs/hashing': 'off',
		},
	},
	{
		files: ['**/*.js'],
		languageOptions: {
			sourceType: 'commonjs',
		},
	},
	{
		// The Playwright suite and the harness behind it are Node code that also contains callbacks
		// evaluated inside a real browser page (`page.evaluate`, `locator.evaluate`), so both global
		// sets are legitimately in scope in the same file.
		files: ['e2e/**/*.js'],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser },
		},
		rules: {
			// Playwright's own web-first assertions (`await expect(locator).toBeVisible()`) aren't
			// recognised by this rule, so it fires on tests that are entirely assertions.
			'sonarjs/assertions-in-tests': 'off',
		},
	},
);
