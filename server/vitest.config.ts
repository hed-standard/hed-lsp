import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		// Each worker can hold several loaded HED schemas. Parallelism is capped so the peak stays under
		// the 4 GB Docker VM that runs CI locally with act; the default worker count peaked near 5 GiB
		// of resident memory in a local measurement, and two workers peaked near 2 GiB.
		maxWorkers: 2,
		// hed-validator ships its ESM build as a .js file in a package without "type": "module", so Vitest
		// transforms it itself instead of loading it: a 10 MB bundle with a 13 MB source map. On a cold cache,
		// which is every CI run, that took 1.3 GB in the main process, and each worker process then loaded the
		// transformed copy as well. With the package external, Node loads the bundle itself: the main process
		// stays near 250 MB, and the peak of a whole run fell from 2.9 GB to 1.6 GB in a 3.8 GB container. Node
		// reads the bundle as ESM by detecting its syntax, in Node 20.19+ and 22.7+.
		server: { deps: { external: [/node_modules\/hed-validator\//] } },
		// Provide minimal browser globals for transformers.js compatibility
		setupFiles: ['./src/__tests__/setup.ts'],
	},
});
