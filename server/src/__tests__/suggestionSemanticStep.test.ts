/**
 * Tests for `semanticStep` on a suggestion result: whether the semantic step ran, was skipped, or
 * failed. `findSuggestions` never throws for a failed embedding, so this field is the only way a
 * caller tells a failed semantic step from an empty answer. The failures here are real: the engine
 * is asked for semantic search with the model cache pointed at an empty directory and downloads
 * off, so the model load fails exactly as it does on a machine without the model. The case that
 * needs a loaded model runs only when the model is cached, and it comes first, because the failure
 * cases evict the model. No mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingsManager, findSuggestions, type LogSink, setLogger } from '../engine/index.js';

const realHome = process.env.HOME;
let emptyHome: string;
let lines: string[] = [];
let previousSink: LogSink;

beforeAll(() => {
	emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-empty-home-'));
	lines = [];
	// The engine's own log is captured, so the failed loads below stay out of the test output.
	previousSink = setLogger({ info: (message) => lines.push(message), error: (message) => lines.push(message) });
});

afterAll(() => {
	setLogger(previousSink);
	embeddingsManager.setEnabled(false);
	embeddingsManager.setRuntimeOptions({});
	restoreHome();
	fs.rmSync(emptyHome, { recursive: true, force: true });
});

function restoreHome(): void {
	if (realHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = realHome;
	}
}

/** Forget a loaded model the way a lost cache would, using a directory shaped like the model cache. */
async function evictModel(): Promise<void> {
	const fakeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-fake-cache-'));
	try {
		fs.mkdirSync(path.join(fakeCache, 'neuromechanist', 'Qwen3-Embedding-0.6B-ONNX-Q8'), { recursive: true });
		expect(await embeddingsManager.deleteCache(fakeCache)).toBe(true);
	} finally {
		fs.rmSync(fakeCache, { recursive: true, force: true });
	}
}

const NEEDS_SEMANTIC = 'xyzzy nonsense';

describe('semanticStep when the model is loaded', () => {
	it.skipIf(!embeddingsManager.isModelCached())(
		'is ran when semantic search ran to completion, and adds tags the other steps did not find (model cached)',
		async () => {
			embeddingsManager.setRuntimeOptions({ allowDownload: false });
			embeddingsManager.setEnabled(true);
			expect(await embeddingsManager.loadEmbeddings()).toBe(true);
			expect(await embeddingsManager.initializeModel()).toBe(true);

			const result = await findSuggestions(NEEDS_SEMANTIC, { schema: '8.4.0', top: 10, semantic: true });

			expect(result.semanticStep).toBe('ran');
			expect(result.source).toBe('semantic');
			expect(result.suggestions.length).toBeGreaterThan(0);
		},
		60000,
	);
});

describe('semanticStep without semantic search', () => {
	it('is skipped when the caller did not ask for semantic search', async () => {
		const result = await findSuggestions(NEEDS_SEMANTIC, { schema: '8.4.0', top: 10, semantic: false });

		expect(result.semanticStep).toBe('skipped');
		expect(result.suggestions).toEqual([]);
	});

	it('is skipped when the other steps already filled top, even if the caller asked for it', async () => {
		const result = await findSuggestions('house', { schema: '8.4.0', top: 1, semantic: true });

		expect(result.suggestions).toHaveLength(1);
		expect(result.semanticStep).toBe('skipped');
	});

	it('is skipped by default, and present on every result', async () => {
		const result = await findSuggestions('walk', { schema: '8.4.0' });

		expect(result.semanticStep).toBe('skipped');
		expect(Object.keys(result).sort()).toEqual(['query', 'semanticStep', 'source', 'suggestions']);
	});
});

describe('semanticStep when semantic search fails', () => {
	it('is failed when semantic search is needed but the embeddings are not available', async () => {
		embeddingsManager.setEnabled(false);

		const result = await findSuggestions(NEEDS_SEMANTIC, { schema: '8.4.0', top: 10, semantic: true });

		expect(result.semanticStep).toBe('failed');
		expect(result.suggestions).toEqual([]);
	});

	it('is failed when the embedding cannot be computed, which findSimilar reports as no matches', async () => {
		await evictModel();
		process.env.HOME = emptyHome;
		try {
			embeddingsManager.setRuntimeOptions({ allowDownload: false });
			embeddingsManager.setEnabled(true);
			// The shipped embeddings load, so the manager reports itself available and goes on to embed.
			expect(await embeddingsManager.loadEmbeddings()).toBe(true);
			expect(embeddingsManager.isAvailable()).toBe(true);
			const failuresBefore = embeddingsManager.embedFailureCount();

			const result = await findSuggestions(NEEDS_SEMANTIC, { schema: '8.4.0', top: 10, semantic: true });

			expect(embeddingsManager.embedFailureCount()).toBeGreaterThan(failuresBefore);
			expect(result.semanticStep).toBe('failed');
			expect(result.suggestions).toEqual([]);
			// The keyword and schema results are still returned when those steps found something.
			const partial = await findSuggestions('red square', { schema: '8.4.0', top: 50, semantic: true });
			expect(partial.suggestions.length).toBeGreaterThan(0);
			expect(partial.semanticStep).toBe('failed');
		} finally {
			restoreHome();
		}
	}, 30000);

	it('stays failed on the next query, because the engine switched itself off', async () => {
		const result = await findSuggestions(NEEDS_SEMANTIC, { schema: '8.4.0', top: 10, semantic: true });

		expect(embeddingsManager.isAvailable()).toBe(false);
		expect(result.semanticStep).toBe('failed');
	});

	it('does not count a skipped step as a failure', async () => {
		const result = await findSuggestions('house', { schema: '8.4.0', top: 1, semantic: true });

		expect(result.semanticStep).toBe('skipped');
	});
});
