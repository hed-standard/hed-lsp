/**
 * Cache handling and embed-failure counting that need no model download: a
 * disabled manager returns before loading anything, and deleteCache is pointed at a
 * temporary directory. Real filesystem and real manager; no mocks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_ID } from '../embeddingConfig.js';
import { embeddingsManager } from '../embeddings.js';

describe('embed failures without a model', () => {
	it('counts an embed that cannot start because embeddings are disabled', async () => {
		embeddingsManager.setEnabled(false);
		const before = embeddingsManager.embedFailureCount();

		const result = await embeddingsManager.embed('event');

		expect(result).toBeNull();
		expect(embeddingsManager.embedFailureCount()).toBe(before + 1);
	});
});

describe('deleteCache', () => {
	it('removes the model directory in the transformers.js layout', async () => {
		const cacheDir = mkdtempSync(path.join(tmpdir(), 'hed-cache-'));
		const modelDir = path.join(cacheDir, ...MODEL_ID.split('/'));
		mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
		writeFileSync(path.join(modelDir, 'onnx', 'model_uint8.onnx'), 'placeholder');
		try {
			expect(await embeddingsManager.deleteCache(cacheDir)).toBe(true);
			expect(existsSync(modelDir)).toBe(false);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	it('reports nothing to delete when the model directory is absent', async () => {
		const cacheDir = mkdtempSync(path.join(tmpdir(), 'hed-cache-'));
		try {
			expect(await embeddingsManager.deleteCache(cacheDir)).toBe(false);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});
});
