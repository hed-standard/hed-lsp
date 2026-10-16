/**
 * Contract test: the runtime model and the model that produced the shipped
 * embeddings must be the same weights. EQUIVALENT_MODEL_IDS records which
 * repositories publish byte-identical files; a change to either side that
 * leaves that set fails here. Reads the real data file; no mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DTYPE, EQUIVALENT_MODEL_IDS, MODEL_ID, NORMALIZE, POOLING } from '../embeddingConfig.js';

function loadShippedModelId(): string {
	const dataPath = path.join(__dirname, '..', '..', 'data', 'tag-embeddings.compact.json');
	const db: { modelId: string } = JSON.parse(readFileSync(dataPath, 'utf-8'));
	return db.modelId;
}

describe('embedding model configuration', () => {
	it('uses a runtime model that is listed as equivalent to itself', () => {
		expect(EQUIVALENT_MODEL_IDS).toContain(MODEL_ID);
	});

	it('matches the model recorded in the shipped embeddings file', () => {
		expect(
			EQUIVALENT_MODEL_IDS,
			'Shipped embeddings were built from a model that is not listed as equivalent to the runtime model. Regenerate them or record the equivalence.',
		).toContain(loadShippedModelId());
	});

	it('uses the last-token pooling and normalized vectors the stored vectors were built with', () => {
		expect({ pooling: POOLING, normalize: NORMALIZE, dtype: DTYPE }).toEqual({
			pooling: 'last_token',
			normalize: true,
			dtype: 'uint8',
		});
	});
});
