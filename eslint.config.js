// @ts-check
'use strict';

const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
	{
		// The webview scripts are plain bundled browser JS with `// @ts-nocheck` and a very
		// different style (inline HTML template strings) — see AGENTS.md. Lint everything else.
		ignores: ['dist/**', 'out/**', 'node_modules/**', 'src/webview/**', '.claude/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
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
		},
	},
	{
		files: ['**/*.js'],
		languageOptions: {
			sourceType: 'commonjs',
		},
	},
	{
		// These harnesses embed a function body as a string and run it inside a real browser
		// page (Puppeteer/Playwright-style `page.evaluate`) — the browser globals below are
		// used there, not in the surrounding Node script.
		files: ['scripts/*-e2e.js'],
		languageOptions: {
			globals: { ...globals.node, ...globals.browser },
		},
	},
);
