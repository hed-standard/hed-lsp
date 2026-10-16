/**
 * Contract test: the runtime model and the model that produced the shipped
 * embeddings must be the same weights. EQUIVALENT_MODEL_IDS records which
 * repositories publish byte-identical files; a change to either side that
 * leaves that set fails here. Reads the real data file; no mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_QUERY_FORMAT,
	DTYPE,
	EQUIVALENT_MODEL_IDS,
	formatQuery,
	MODEL_ID,
	NORMALIZE,
	POOLING,
} from '../embeddingConfig.js';

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

describe('formatQuery', () => {
	it('leaves the query unchanged in the default (raw) format', () => {
		expect(DEFAULT_QUERY_FORMAT).toBe('raw');
		expect(formatQuery('pupil dilation')).toBe('pupil dilation');
	});

	it('wraps the query with the Qwen retrieval instruction', () => {
		expect(formatQuery('pupil dilation', 'qwen')).toBe(
			'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:pupil dilation',
		);
	});

	it('wraps the query with the HED-specific instruction', () => {
		expect(formatQuery('pupil dilation', 'hed')).toBe(
			'Instruct: Given a description of an experimental event, retrieve the matching HED tag\nQuery:pupil dilation',
		);
	});
});
