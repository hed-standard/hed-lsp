/**
 * Tests for semantic search through POST /v1/suggest with a loaded model. They run only when the
 * model is cached locally (`embeddingsManager.isModelCached()`); otherwise they are reported as
 * skipped, never as passed. The real daemon, model, and shipped embeddings run. The daemon warms
 * the model in the background after it listens, so the first requests here arrive while the state is
 * still loading, which also pins the loading status. No mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingsManager, suggestBatch } from '../engine/index.js';
import { BUNDLED, call, hasKey, postJson, type RunningDaemon, sleep, startDaemon, waitFor } from './daemonHarness.js';

const suite = embeddingsManager.isModelCached() ? describe : describe.skip;

// Queries that keyword and schema search leave short of ten tags, so semantic search adds some.
const QUERIES = ['xyzzy nonsense', 'a loud bang', 'marmoset eating', 'red square', 'house'];

suite('semantic suggest (model cached)', () => {
	let daemon: RunningDaemon;
	let whileLoading: { state: string; status: number; semantic: unknown; results: unknown };
	let plain: { json: { results: { suggestions: { tag: string }[] }[] } };

	beforeAll(async () => {
		// Return as soon as the server listens, before the model has loaded.
		daemon = await startDaemon({ HED_LSP_SEMANTIC: '1', HED_LSP_MODEL_DOWNLOAD: '0' }, { skipReady: true });
		const state = (await call(daemon.url, '/v1/health')).json.semantic.state;
		await daemon.daemon.ready;
		const asked = await postJson(daemon.url, '/v1/suggest', { queries: QUERIES, schema: BUNDLED, semantic: true });
		whileLoading = {
			state,
			status: asked.status,
			semantic: asked.json.semantic,
			results: asked.json.results,
		};
		plain = (await postJson(daemon.url, '/v1/suggest', { queries: QUERIES, schema: BUNDLED })) as typeof plain;
		await waitFor(async () => (await call(daemon.url, '/v1/health')).json.semantic.state === 'ready', 60000, 'ready');
	}, 90000);

	afterAll(async () => {
		await daemon.stop();
	});

	it('warms up after listen, so the first request sees loading and still gets keyword and schema results', () => {
		expect(whileLoading.state).toBe('loading');
		expect(whileLoading.status).toBe(200);
		expect(whileLoading.semantic).toEqual({ requested: true, status: 'loading' });
		expect(whileLoading.results).toEqual(plain.json.results);
	});

	it('reports ready in health with no failures, and the health status stays ok', async () => {
		const reply = await call(daemon.url, '/v1/health');

		expect(reply.json.status).toBe('ok');
		expect(reply.json.semantic).toEqual({
			state: 'ready',
			failures: 0,
			index: '8.5.0,sc:score_2.1.0,la:lang_1.1.0',
		});
	});

	it('answers semantic requests with status ok and the same tags as suggestBatch for each query', async () => {
		const expected = await suggestBatch(QUERIES, { schema: BUNDLED, top: 8, semantic: true });

		const reply = await postJson(daemon.url, '/v1/suggest', {
			queries: QUERIES,
			schema: BUNDLED,
			top: 8,
			semantic: true,
		});

		expect(reply.status).toBe(200);
		expect(reply.json.semantic).toEqual({ requested: true, status: 'ok' });
		for (const [index, query] of QUERIES.entries()) {
			const tags = reply.json.results[index].suggestions.map((s: { tag: string }) => s.tag);
			expect(tags, query).toEqual(expected[query]);
		}
	});

	it('adds tags that keyword and schema search alone do not find', async () => {
		const withSemantic = await postJson(daemon.url, '/v1/suggest', {
			queries: ['xyzzy nonsense', 'a loud bang'],
			schema: BUNDLED,
			semantic: true,
		});
		const without = await postJson(daemon.url, '/v1/suggest', {
			queries: ['xyzzy nonsense', 'a loud bang'],
			schema: BUNDLED,
		});

		expect(without.json.results[0].suggestions).toEqual([]);
		expect(withSemantic.json.results[0].suggestions.length).toBeGreaterThan(0);
		expect(withSemantic.json.results[1].suggestions.length).toBeGreaterThan(without.json.results[1].suggestions.length);
		expect(hasKey(withSemantic.json, 'source')).toBe(false);
	});

	it('honors top, order, duplicates, and prototype names under semantic search', async () => {
		const queries = ['a loud bang', '__proto__', 'a loud bang', 'constructor'];
		const expected = await suggestBatch(queries, { schema: BUNDLED, top: 3, semantic: true });

		const reply = await postJson(daemon.url, '/v1/suggest', { queries, schema: BUNDLED, top: 3, semantic: true });

		expect(reply.json.results.map((item: { index: number }) => item.index)).toEqual([0, 1, 2, 3]);
		for (const [index, query] of queries.entries()) {
			const tags = reply.json.results[index].suggestions.map((s: { tag: string }) => s.tag);
			expect(tags.length).toBeLessThanOrEqual(3);
			expect(tags, `${index} ${query}`).toEqual(expected[query]);
		}
	});

	it('refuses more than MAX_SEMANTIC_QUERIES queries, accepts exactly that many, and takes 50 without semantic', async () => {
		const twentyOne = Array.from({ length: 21 }, (_, i) => `query ${i}`);

		const refused = await postJson(daemon.url, '/v1/suggest', { queries: twentyOne, semantic: true });
		const atLimit = await postJson(daemon.url, '/v1/suggest', { queries: twentyOne.slice(0, 20), semantic: true });
		const plain = await postJson(daemon.url, '/v1/suggest', { queries: twentyOne });

		expect(refused.status).toBe(400);
		expect(refused.json.error.code).toBe('BATCH_TOO_LARGE');
		expect(atLimit.status).toBe(200);
		expect(atLimit.json.semantic.status).toBe('ok');
		expect(plain.status).toBe(200);
	});

	it('answers a request that does not ask for semantic search without the semantic object', async () => {
		const reply = await postJson(daemon.url, '/v1/suggest', { queries: ['house'], semantic: false });

		expect(reply.json.semantic).toBeUndefined();
	});

	it('logs the status of a semantic request and none of its text', async () => {
		const marker = 'secret-semantic-marker';
		const reply = await postJson(daemon.url, '/v1/suggest', { queries: [marker], semantic: true });

		const line = daemon
			.logLines()
			.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
		expect(line).toMatchObject({ status: 200, items: 1, semantic: 'ok' });
		expect(daemon.rawLines.join('\n').toLowerCase()).not.toContain(marker);
	});

	/**
	 * A second daemon on the model that is already loaded, with its own limits, once it reports ready.
	 * Batches of up to 50 queries are allowed, so one request can hold the semantic slot for a while.
	 */
	async function withSemanticDaemon(
		overrides: Record<string, string>,
		run: (extra: RunningDaemon) => Promise<void>,
		options: Parameters<typeof startDaemon>[1] = {},
	): Promise<void> {
		const extra = await startDaemon(
			{
				HED_LSP_SEMANTIC: '1',
				HED_LSP_MODEL_DOWNLOAD: '0',
				HED_LSP_MAX_QUERIES: '50',
				HED_LSP_MAX_SEMANTIC_QUERIES: '50',
				...overrides,
			},
			options,
		);
		try {
			await waitFor(async () => (await call(extra.url, '/v1/health')).json.semantic.state === 'ready', 60000, 'ready');
			await run(extra);
		} finally {
			await extra.stop();
		}
	}

	// Each of these needs an embedding, so a batch of them holds the slot for as long as the model takes.
	const SLOW = Array.from({ length: 50 }, (_, i) => `xyzzy nonsense ${i}`);
	const ONE = ['xyzzy nonsense single'];

	it('refuses a semantic request with SEMANTIC_BUSY and Retry-After 5 when the slot is taken and the queue is 0', async () => {
		await withSemanticDaemon({ HED_LSP_SEMANTIC_QUEUE: '0', HED_LSP_REQUEST_TIMEOUT_MS: '30000' }, async (extra) => {
			const slow = postJson(extra.url, '/v1/suggest', { queries: SLOW, schema: BUNDLED, semantic: true });
			let refused: Awaited<typeof slow> | undefined;
			await waitFor(
				async () => {
					refused = await postJson(extra.url, '/v1/suggest', { queries: ONE, schema: BUNDLED, semantic: true });
					return refused.status === 503;
				},
				10000,
				'the semantic slot to be taken',
			);

			expect(refused?.json.error.code).toBe('SEMANTIC_BUSY');
			expect(refused?.headers['retry-after']).toBe('5');
			expect(refused?.headers['access-control-allow-origin']).toBe('*');
			// A request that does not ask for semantic search is not held up by the slot or refused for it.
			const plain = await postJson(extra.url, '/v1/suggest', { queries: ['house'], schema: BUNDLED });
			expect(plain.status).toBe(200);
			const finished = await slow;
			expect(finished.status).toBe(200);
			expect(finished.json.semantic).toEqual({ requested: true, status: 'ok' });
			const line = extra.logLines().find((entry) => entry.msg === 'request' && entry.status === 503);
			expect(line).toMatchObject({ error: 'SEMANTIC_BUSY', semantic: 'ok' });
		});
	}, 60000);

	it('queues a semantic request behind the one that holds the slot, and answers both', async () => {
		await withSemanticDaemon({}, async (extra) => {
			const first = postJson(extra.url, '/v1/suggest', { queries: SLOW, schema: BUNDLED, semantic: true });
			await sleep(40);

			const queued = await postJson(extra.url, '/v1/suggest', { queries: ONE, schema: BUNDLED, semantic: true });

			expect(queued.status).toBe(200);
			expect(queued.json.semantic).toEqual({ requested: true, status: 'ok' });
			expect((await first).status).toBe(200);
			const line = extra
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === queued.headers['x-request-id']);
			// The single query takes a few milliseconds, so the rest of its time was spent waiting for the slot.
			expect(line?.ms as number).toBeGreaterThan(150);
		});
	}, 60000);

	it('answers 503 TIMEOUT for a semantic request that runs past the timeout, then frees the slot for the next', async () => {
		await withSemanticDaemon(
			{ HED_LSP_REQUEST_TIMEOUT_MS: '150', HED_LSP_HEADERS_TIMEOUT_MS: '1000' },
			async (extra) => {
				const startedAt = Date.now();

				const timedOut = await postJson(extra.url, '/v1/suggest', { queries: SLOW, schema: BUNDLED, semantic: true });
				const next = await postJson(extra.url, '/v1/suggest', { queries: ONE, schema: BUNDLED, semantic: true });

				expect(timedOut.status).toBe(503);
				expect(timedOut.json.error.code).toBe('TIMEOUT');
				expect(timedOut.headers['retry-after']).toBe('1');
				// The first batch stopped between queries, so the second was served long before 50 queries finished.
				expect(next.status).toBe(200);
				expect(next.json.semantic).toEqual({ requested: true, status: 'ok' });
				expect(Date.now() - startedAt).toBeLessThan(5000);
			},
		);
	}, 60000);

	it('charges the semantic bucket for each query of a request that runs semantic search, apart from the general one', async () => {
		let time = 5_000_000;
		await withSemanticDaemon(
			{ HED_LSP_SEMANTIC_RATE_PER_SEC: '1', HED_LSP_SEMANTIC_RATE_BURST: '3' },
			async (extra) => {
				const ask = (queries: string[], semantic: boolean, client = '198.51.100.1'): ReturnType<typeof postJson> =>
					postJson(extra.url, '/v1/suggest', { queries, schema: BUNDLED, semantic }, { 'X-Forwarded-For': client });

				const first = await ask(['xyzzy one', 'xyzzy two'], true);
				const refused = await ask(['xyzzy three', 'xyzzy four'], true);
				const plain = await ask(['xyzzy three', 'xyzzy four'], false);
				const otherClient = await ask(['xyzzy three', 'xyzzy four'], true, '198.51.100.2');
				time += 1000;
				const refilled = await ask(['xyzzy five', 'xyzzy six'], true);

				expect(first.status).toBe(200);
				expect(first.json.semantic.status).toBe('ok');
				expect(refused.status).toBe(429);
				expect(refused.json.error.code).toBe('RATE_LIMITED');
				expect(refused.headers['retry-after']).toBe('1');
				expect(plain.status).toBe(200);
				expect(otherClient.status).toBe(200);
				expect(refilled.status).toBe(200);
			},
			{ now: () => time },
		);
	}, 60000);

	it('charges the semantic bucket by the length of each query, as it charges the general one', async () => {
		let time = 5_000_000;
		await withSemanticDaemon(
			{ HED_LSP_SEMANTIC_RATE_PER_SEC: '1', HED_LSP_SEMANTIC_RATE_BURST: '3' },
			async (extra) => {
				const perUnit = extra.config.chargeCharsPerUnit;
				// One character over a unit, so by design it costs two units, though it is one query.
				const long = 'xyzzy '.repeat(Math.ceil((perUnit + 1) / 6)).slice(0, perUnit + 1);
				expect(Math.ceil(long.length / perUnit)).toBe(2);
				const ask = (semantic: boolean): ReturnType<typeof postJson> =>
					postJson(extra.url, '/v1/suggest', { queries: [long], schema: BUNDLED, semantic });

				const first = await ask(true);
				// Counted by query it would cost one of the unit left; by length it costs two.
				const refused = await ask(true);
				const plain = await ask(false);
				time += 1000;
				const refilled = await ask(true);

				expect(first.status).toBe(200);
				expect(first.json.semantic.status).toBe('ok');
				expect(refused.status).toBe(429);
				expect(refused.json.error.code).toBe('RATE_LIMITED');
				expect(refused.headers['retry-after']).toBe('1');
				expect(plain.status).toBe(200);
				expect(refilled.status).toBe(200);
			},
			{ now: () => time },
		);
	}, 60000);

	// Last, because it evicts the loaded model, and a model that is gone stays gone for the process.
	it('answers a request whose semantic step fails with status unavailable and the other results', async () => {
		const queries = ['xyzzy nonsense', 'red square'];
		const plain = await postJson(daemon.url, '/v1/suggest', { queries, schema: BUNDLED });
		const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-empty-home-'));
		const fakeCache = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-fake-cache-'));
		const realHome = process.env.HOME;
		try {
			// The model is ready when the request starts, and then it is lost: a directory shaped like the
			// model cache is deleted through the engine, which unloads the model, and HOME points at an empty
			// directory with downloads off, so the engine's reload fails as it does without the model.
			fs.mkdirSync(path.join(fakeCache, 'neuromechanist', 'Qwen3-Embedding-0.6B-ONNX-Q8'), { recursive: true });
			expect(await embeddingsManager.deleteCache(fakeCache)).toBe(true);
			process.env.HOME = emptyHome;
			expect((await call(daemon.url, '/v1/health')).json.semantic.state).toBe('ready');

			const reply = await postJson(daemon.url, '/v1/suggest', { queries, schema: BUNDLED, semantic: true });

			expect(reply.status).toBe(200);
			expect(reply.json.semantic).toEqual({ requested: true, status: 'unavailable' });
			expect(reply.json.results).toEqual(plain.json.results);
			const line = daemon
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
			expect(line).toMatchObject({ status: 200, semantic: 'unavailable' });
		} finally {
			if (realHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = realHome;
			}
			fs.rmSync(emptyHome, { recursive: true, force: true });
			fs.rmSync(fakeCache, { recursive: true, force: true });
		}
	}, 30000);
});
