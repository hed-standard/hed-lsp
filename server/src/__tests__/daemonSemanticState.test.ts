/**
 * Tests for the semantic state machine that need no model: retry timing, a failed warm-up with the
 * model cache pointed at an empty directory and downloads off, and a request that asks for semantic
 * search while it is unavailable. The real daemon, engine, and model loader run; the cache location
 * is the process HOME, which each test points at an empty temporary directory and then restores.
 * The last test recovers to a loaded model and runs only when the model is cached; it is last
 * because a loaded model stays loaded for the rest of the process. No mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	SEMANTIC_BACKOFF_BASE_MS,
	SEMANTIC_BACKOFF_MAX_MS,
	SemanticService,
	semanticBackoffMs,
	semanticStatusOf,
} from '../daemon/semantic.js';
import { embeddingsManager, suggestBatch } from '../engine/index.js';
import { BUNDLED, call, postJson, type RunningDaemon, startDaemon, testConfig, waitFor } from './daemonHarness.js';

const realHome = process.env.HOME;
let emptyHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
	emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-empty-home-'));
	process.env.HOME = emptyHome;
});

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	if (realHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = realHome;
	}
	fs.rmSync(emptyHome, { recursive: true, force: true });
});

const SEMANTIC_NO_DOWNLOADS = { HED_LSP_SEMANTIC: '1', HED_LSP_MODEL_DOWNLOAD: '0' };

async function health(url: string): Promise<{ state: string; failures: number; index: string }> {
	return (await call(url, '/v1/health')).json.semantic;
}

describe('semanticBackoffMs', () => {
	it('starts at 30 seconds, doubles, and stops at 15 minutes', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 20].map((failures) => semanticBackoffMs(failures))).toEqual([
			30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
		]);
		expect(SEMANTIC_BACKOFF_BASE_MS).toBe(30_000);
		expect(SEMANTIC_BACKOFF_MAX_MS).toBe(900_000);
	});

	it('honors another base and maximum', () => {
		const backoff = { baseMs: 100, maxMs: 350 };

		expect([1, 2, 3, 4].map((failures) => semanticBackoffMs(failures, backoff))).toEqual([100, 200, 350, 350]);
	});
});

describe('semanticStatusOf', () => {
	it('is ok when the semantic step ran, or was not needed, for every query', () => {
		expect(semanticStatusOf([])).toBe('ok');
		expect(semanticStatusOf(['ran'])).toBe('ok');
		expect(semanticStatusOf(['skipped', 'skipped'])).toBe('ok');
		expect(semanticStatusOf(['ran', 'skipped', 'ran'])).toBe('ok');
	});

	it('is unavailable when the semantic step failed for any query', () => {
		expect(semanticStatusOf(['failed'])).toBe('unavailable');
		expect(semanticStatusOf(['ran', 'failed', 'skipped'])).toBe('unavailable');
		expect(semanticStatusOf(['failed', 'ran'])).toBe('unavailable');
	});
});

describe('SemanticService before warm-up', () => {
	it('is disabled when the flag is off, and stays disabled after start', () => {
		const service = new SemanticService(testConfig());

		service.start();

		expect(service.snapshot()).toMatchObject({ state: 'disabled', failures: 0 });
		expect(service.ready).toBe(false);
		expect(service.statusForRequest()).toBe('disabled');
		service.stop();
	});

	it('is loading from the start when enabled, until a warm-up finishes', () => {
		const service = new SemanticService(testConfig(SEMANTIC_NO_DOWNLOADS));

		expect(service.snapshot()).toMatchObject({ state: 'loading', failures: 0 });
		expect(service.ready).toBe(false);
		expect(service.statusForRequest()).toBe('loading');
		service.stop();
	});
});

describe('semantic warm-up that fails', () => {
	it('becomes unavailable with one failure, and a request for semantic search still gets 200 and results', async () => {
		daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS);
		await waitFor(async () => (await health(daemon?.url ?? '')).state === 'unavailable', 15000, 'unavailable');
		const queries = ['red square', 'xyzzy nonsense', 'a loud bang'];

		const plain = await postJson(daemon.url, '/v1/suggest', { queries, schema: BUNDLED });
		const asked = await postJson(daemon.url, '/v1/suggest', { queries, schema: BUNDLED, semantic: true });
		const expected = await suggestBatch(queries, { schema: BUNDLED });

		expect(asked.status).toBe(200);
		expect(asked.json.semantic).toEqual({ requested: true, status: 'unavailable' });
		expect(asked.json.results).toEqual(plain.json.results);
		expect(
			asked.json.results.map((item: { suggestions: { tag: string }[] }) => item.suggestions.map((s) => s.tag)),
		).toEqual(queries.map((query) => expected[query]));
		const state = await health(daemon.url);
		expect(state).toEqual({ state: 'unavailable', failures: 1, index: '8.5.0,sc:score_2.1.0,la:lang_1.1.0' });
	});

	it('does not change the health status, and does not stop the other endpoints', async () => {
		daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS);
		await waitFor(async () => (await health(daemon?.url ?? '')).state === 'unavailable', 15000, 'unavailable');

		const reply = await call(daemon.url, '/v1/health');

		expect(reply.status).toBe(200);
		expect(reply.json.status).toBe('ok');
		expect((await postJson(daemon.url, '/v1/validate', { strings: ['Event'] })).status).toBe(200);
	});

	it('never retries because of a request, and never starts the engine warm-up itself', async () => {
		daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS);
		await waitFor(async () => (await health(daemon?.url ?? '')).state === 'unavailable', 15000, 'unavailable');
		const loadsBefore = daemon.rawLines.filter((line) => line.includes('Loading Qwen3-Embedding model')).length;

		for (let i = 0; i < 25; i++) {
			const reply = await postJson(daemon.url, '/v1/suggest', { queries: ['house', 'walk'], semantic: true });
			expect(reply.json.semantic.status).toBe('unavailable');
		}

		expect(loadsBefore).toBe(1);
		expect(daemon.rawLines.filter((line) => line.includes('Loading Qwen3-Embedding model'))).toHaveLength(1);
		expect((await health(daemon.url)).failures).toBe(1);
		expect(embeddingsManager.isModelLoaded()).toBe(false);
	});

	it('retries in the background with a doubling wait, not on requests', async () => {
		const timestamps: number[] = [];
		daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS, {
			semanticBackoff: { baseMs: 150, maxMs: 10_000 },
			write: (line) => {
				const entry = JSON.parse(line) as { msg: string; time: string };
				if (entry.msg === 'semantic warm-up failed') {
					timestamps.push(Date.parse(entry.time));
				}
			},
		});
		await waitFor(() => timestamps.length >= 3, 15000, 'three failed warm-ups');

		const gaps = [timestamps[1] - timestamps[0], timestamps[2] - timestamps[1]];

		// A timer never fires early, so each gap is at least the wait that was scheduled; allow a
		// few milliseconds for timer granularity.
		expect(gaps[0]).toBeGreaterThanOrEqual(150 - 5);
		expect(gaps[1]).toBeGreaterThanOrEqual(300 - 5);
		const state = await health(daemon.url);
		expect(state.state).toBe('unavailable');
		expect(state.failures).toBeGreaterThanOrEqual(3);
	});

	it('stops retrying once the daemon is closed', async () => {
		const warmups: string[] = [];
		daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS, {
			semanticBackoff: { baseMs: 100, maxMs: 100 },
			write: (line) => {
				if (JSON.parse(line).msg === 'semantic warm-up failed') {
					warmups.push(line);
				}
			},
		});
		await waitFor(() => warmups.length >= 1, 15000, 'a failed warm-up');
		await daemon.stop();
		daemon = undefined;
		const count = warmups.length;

		await new Promise((resolve) => setTimeout(resolve, 500));

		expect(warmups.length).toBe(count);
	});
});

const modelCached = embeddingsManager.isModelCached();

describe('semantic recovery', () => {
	it.skipIf(!modelCached)(
		'recovers when the cache becomes available, and then reports ready with no failures (model cached)',
		async () => {
			daemon = await startDaemon(SEMANTIC_NO_DOWNLOADS, { semanticBackoff: { baseMs: 200, maxMs: 200 } });
			await waitFor(async () => (await health(daemon?.url ?? '')).state === 'unavailable', 15000, 'unavailable');
			expect((await health(daemon.url)).failures).toBeGreaterThanOrEqual(1);

			// The real cache comes back; the next background retry finds the model.
			if (realHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = realHome;
			}
			await waitFor(async () => (await health(daemon?.url ?? '')).state === 'ready', 60000, 'ready');

			expect(await health(daemon.url)).toMatchObject({ state: 'ready', failures: 0 });
			const reply = await postJson(daemon.url, '/v1/suggest', { queries: ['xyzzy nonsense'], semantic: true });
			expect(reply.json.semantic).toEqual({ requested: true, status: 'ok' });
			expect(reply.json.results[0].suggestions.length).toBeGreaterThan(0);
		},
		90000,
	);
});
