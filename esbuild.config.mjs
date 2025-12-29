/**
 * esbuild configuration for bundling the HED-LSP server.
 * Bundles all dependencies into a single file for VS Code extension packaging.
 */
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Plugin to handle .node native modules by marking them as external.
 */
const nativeNodeModulesPlugin = {
	name: 'native-node-modules',
	setup(build) {
		// Mark .node files as external
		build.onResolve({ filter: /\.node$/ }, (args) => {
			return { path: args.path, external: true };
		});
	},
};

/**
 * Build the server bundle.
 */
async function buildServer() {
	const ctx = await esbuild.context({
		entryPoints: ['server/src/server.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		outfile: 'server/out/server.js',
		external: [
			// Native modules that can't be bundled
			'onnxruntime-node',
			'sharp',
			// transformers.js must be external - dynamic imports break when bundled
			'@huggingface/transformers',
		],
		sourcemap: !production,
		// Don't minify - @huggingface/transformers breaks when minified
		minify: false,
		plugins: [nativeNodeModulesPlugin],
		// Keep __dirname and __filename working
		define: {
			'import.meta.url': 'undefined',
		},
		// Handle dynamic imports in transformers.js
		mainFields: ['module', 'main'],
		conditions: ['node', 'import', 'require'],
	});

	if (watch) {
		await ctx.watch();
		console.log('[esbuild] Watching for changes...');
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		console.log('[esbuild] Server bundled successfully');
	}
}

/**
 * Build the client (simple compile, no bundling needed for client).
 */
async function buildClient() {
	const ctx = await esbuild.context({
		entryPoints: ['client/src/extension.ts'],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		outfile: 'client/out/extension.js',
		external: ['vscode'],
		sourcemap: !production,
		minify: production,
	});

	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		console.log('[esbuild] Client bundled successfully');
	}
}

// Run builds
Promise.all([buildServer(), buildClient()]).catch((err) => {
	console.error(err);
	process.exit(1);
});
