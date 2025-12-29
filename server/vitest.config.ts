import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/**/*.test.ts'],
		// Provide minimal browser globals for transformers.js compatibility
		setupFiles: ['./src/__tests__/setup.ts'],
	},
});
