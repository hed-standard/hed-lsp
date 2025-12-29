/**
 * Vitest setup file - provides minimal browser globals for transformers.js compatibility.
 * The embeddings module uses @huggingface/transformers which checks for navigator.
 */

// Provide minimal navigator mock for environment detection
if (typeof globalThis.navigator === 'undefined') {
	// @ts-expect-error - minimal mock for transformers.js environment detection
	globalThis.navigator = {
		userAgent: 'node',
	};
}
