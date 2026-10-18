/**
 * Cache handling and embed-failure counting that need no model download: a
 * disabled manager returns before loading anything, deleteCache is pointed at a
 * temporary directory, and a model load with downloads disabled runs in a child process whose
 * HOME is an empty directory. Real filesystem and real manager; no mocks.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_ID } from '../engine/embeddingConfig.js';
import { embeddingsManager } from '../engine/embeddings.js';

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

describe('runtime options', () => {
	it('rejects a thread count that is not a positive integer and accepts valid options', () => {
		for (const threads of [0, -1, 1.5, Number.NaN]) {
			expect(() => embeddingsManager.setRuntimeOptions({ threads })).toThrow(RangeError);
		}

		expect(() => embeddingsManager.setRuntimeOptions({ threads: 1, allowDownload: true })).not.toThrow();
		expect(() => embeddingsManager.setRuntimeOptions({})).not.toThrow();
	});

	it('fails the load and returns false when downloads are off and the cache is empty', () => {
		const built = path.join(__dirname, '..', '..', 'out', 'engine', 'embeddings.js');
		if (!existsSync(built)) {
			throw new Error(`${built} is missing; run "bun run compile" before this test`);
		}
		// The child resolves its model cache from HOME, so an empty directory means an empty cache and
		// the real cache is never read or written.
		const home = mkdtempSync(path.join(tmpdir(), 'hed-home-'));
		const script = `
			const { embeddingsManager } = require(${JSON.stringify(built)});
			embeddingsManager.setRuntimeOptions({ allowDownload: false });
			embeddingsManager.setEnabled(true);
			const cached = embeddingsManager.isModelCached();
			embeddingsManager.initializeModel().then((loaded) => {
				process.stdout.write(JSON.stringify({ cached, loaded, enabled: embeddingsManager.isAvailable() }));
			});
		`;
		try {
			const result = spawnSync(process.execPath, ['-e', script], {
				encoding: 'utf-8',
				env: { ...process.env, HOME: home, USERPROFILE: home },
				timeout: 120000,
			});

			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ cached: false, loaded: false, enabled: false });
			// The failure comes from the download switch, not from a network error.
			expect(result.stderr).toContain('[HED Embeddings] Failed to load model');
			expect(result.stderr).toContain('allowRemoteModels=false');
			expect(existsSync(path.join(home, '.cache', 'huggingface', 'hub', ...MODEL_ID.split('/')))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 150000);
});
