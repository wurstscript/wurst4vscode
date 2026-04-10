/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

/** Copies a file from src to dst after webpack emits — used for files that can't be bundled (e.g. native-addon workers). */
class CopyFilePlugin {
	constructor(src, dst) { this.src = src; this.dst = dst; }
	apply(compiler) {
		compiler.hooks.afterEmit.tap('CopyFilePlugin', () => {
			fs.mkdirSync(path.dirname(this.dst), { recursive: true });
			fs.copyFileSync(this.src, this.dst);
		});
	}
}

/** @type WebpackConfig */
const webExtensionConfig = {
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
	target: 'webworker', // extensions run in a webworker context
	entry: {
		extension: './src/webextension.ts', // source of the web extension main file
		//'test/suite/index': './src/web/test/suite/index.ts', // source of the web extension test runner
	},
	output: {
		filename: '[name].js',
		path: path.join(__dirname, './dist/web'),
		libraryTarget: 'commonjs',
	},
	resolve: {
		mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
		extensions: ['.ts', '.js'], // support ts-files and js-files
		alias: {
			// provides alternate implementation for node module and source files
		},
		fallback: {
			// Webpack 5 no longer polyfills Node.js core modules automatically.
			// see https://webpack.js.org/configuration/resolve/#resolvefallback
			// for the list of Node.js core module polyfills.
			assert: require.resolve('assert'),
		},
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
					},
				],
			},
		],
	},
	plugins: [
		new webpack.ProvidePlugin({
			process: 'process/browser', // provide a shim for the global `process` variable
		}),
	],
	externals: {
		vscode: 'commonjs vscode', // ignored because it doesn't exist
	},
	performance: {
		hints: false,
	},
	devtool: 'nosources-source-map', // create a source map that points to the original source file
};

/** @type WebpackConfig */
const viewerConfig = {
	mode: 'none',
	target: 'web',
	entry: {
		mdxViewer: './src/webview/mdxViewer.ts',
		mpqViewerWebview: './src/webview/mpqViewerWebview.ts',
	},
	output: {
		filename: '[name].js',
		path: path.join(__dirname, './dist/webview'),
	},
	resolve: {
		mainFields: ['browser', 'module', 'main'],
		extensions: ['.ts', '.js'],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
						options: { configFile: 'tsconfig.webview.json' },
					},
				],
			},
		],
	},
	performance: { hints: false },
};

/** @type WebpackConfig */
const nodeExtensionConfig = {
	mode: 'none',
	target: 'node',
	entry: {
		extension: './src/extension.ts',
	},
	output: {
		filename: '[name].js',
		path: path.join(__dirname, './dist'),
		libraryTarget: 'commonjs2',
	},
	resolve: {
		extensions: ['.ts', '.js'],
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [{ loader: 'ts-loader' }],
			},
		],
	},
	externals: {
		vscode: 'commonjs vscode',
	},
	plugins: [
		new CopyFilePlugin(
			path.join(__dirname, 'src', 'casc-extract-worker.js'),
			path.join(__dirname, 'dist', 'casc-extract-worker.js')
		),
	],
	performance: { hints: false },
	devtool: 'nosources-source-map',
};

module.exports = [webExtensionConfig, viewerConfig, nodeExtensionConfig];
