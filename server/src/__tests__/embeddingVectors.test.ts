/**
 * Model-gated checks of the runtime embedding path against the shipped vectors.
 *
 * They need the ~600MB model in the local cache. When it is absent they are
 * reported as skipped, never as passed. Real model and real shipped data; no mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { embeddingsManager } from '../engine/embeddings.js';

const dataPath = path.join(__dirname, '..', '..', 'data', 'tag-embeddings.compact.json');

function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / Math.sqrt(normA * normB);
}

const suite = embeddingsManager.isModelCached() ? describe : describe.skip;

suite('runtime embeddings against the shipped vectors (model cached)', () => {
	it('embeds a tag name close to the vector stored for it', async () => {
		embeddingsManager.setEnabled(true);
		expect(await embeddingsManager.initializeModel()).toBe(true);
		const db: { tags: { tag: string; prefix: string; vector: number[] }[] } = JSON.parse(
			readFileSync(dataPath, 'utf-8'),
		);
		const stored = db.tags.find((t) => t.prefix === '' && t.tag === 'Event');
		expect(stored, 'shipped data should contain the Event tag').toBeDefined();

		const vector = await embeddingsManager.embed('event');

		// Stored document vectors are padded-batch outputs, so they differ from single-text
		// runtime vectors by a few percent; 0.9 catches wrong pooling or a wrong model.
		expect(vector).not.toBeNull();
		expect(cosine(vector ?? [], stored?.vector ?? [])).toBeGreaterThanOrEqual(0.9);
	});

	it('counts a failed embed instead of hiding it', async () => {
		const before = embeddingsManager.embedFailureCount();

		const result = await embeddingsManager.embed(undefined as unknown as string);

		expect(result).toBeNull();
		expect(embeddingsManager.embedFailureCount()).toBe(before + 1);
	});
});
