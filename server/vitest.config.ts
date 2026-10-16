import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		// Each worker can hold several loaded HED schemas. Parallelism is capped so the peak stays under
		// the 4 GB Docker VM that runs CI locally with act; the default worker count peaked near 5 GiB
		// of resident memory in a local measurement, and two workers peaked near 2 GiB.
		maxWorkers: 2,
		// Provide minimal browser globals for transformers.js compatibility
		setupFiles: ['./src/__tests__/setup.ts'],
	},
});
