/**
 * Tests for POST /v1/suggest with semantic search off: a real server on a real socket with the real
 * engine and the bundled schemas, so they run offline. Results are compared with `suggestBatch` for
 * the same queries. A spec that fails to load is a real one (`8.4.0,sc:score_9.9.9` does not
 * exist). The semantic state machine has its own files. No mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { suggestBatch } from '../engine/index.js';
import {
	BUNDLED,
	BUNDLED_WITH_LIBRARIES,
	call,
	hasKey,
	postJson,
	type RunningDaemon,
	startDaemon,
	waitFor,
} from './daemonHarness.js';

let shared: RunningDaemon;
beforeAll(async () => {
	shared = await startDaemon();
});
afterAll(async () => {
	await shared.stop();
});

async function withDaemon(
	overrides: Record<string, string>,
	run: (daemon: RunningDaemon) => Promise<void>,
	options: Parameters<typeof startDaemon>[1] = {},
): Promise<void> {
	const daemon = await startDaemon(overrides, options);
	try {
		await run(daemon);
	} finally {
		await daemon.stop();
	}
}

/** The tags of one result item, or fail the test if the item is an error. */
function tagsOf(item: { suggestions?: { tag: string }[] }): string[] {
	if (!item.suggestions) {
		throw new Error(`expected suggestions, got ${JSON.stringify(item)}`);
	}
	return item.suggestions.map((suggestion) => suggestion.tag);
}

/** A spec that does not exist, so loading it fails for real. */
const MISSING = '8.4.0,sc:score_9.9.9';

const QUERIES = ['red square', 'button press', 'house', 'xyzzy nonsense', 'walk', 'a loud bang', 'run', 'click'];

describe('POST /v1/suggest results', () => {
	it('gives the same tags as suggestBatch for each query, in an ordered array with indexes', async () => {
		const expected = await suggestBatch(QUERIES, { schema: BUNDLED, top: 5 });

		const reply = await postJson(shared.url, '/v1/suggest', { queries: QUERIES, schema: BUNDLED, top: 5 });

		expect(reply.status).toBe(200);
		expect(reply.json.apiVersion).toBe('1.0');
		expect(reply.json.schema).toEqual({ requested: BUNDLED, used: BUNDLED });
		expect(reply.json.results).toHaveLength(QUERIES.length);
		for (const [index, query] of QUERIES.entries()) {
			const item = reply.json.results[index];
			expect(item.index).toBe(index);
			expect(item.query).toBe(query);
			expect(tagsOf(item), query).toEqual(expected[query]);
			expect(item.suggestions.every((s: object) => Object.keys(s).join() === 'tag')).toBe(true);
		}
	});

	it('uses the default schema and ten suggestions when neither is given', async () => {
		const expected = await suggestBatch(['house', 'button'], { schema: BUNDLED });

		const reply = await postJson(shared.url, '/v1/suggest', { queries: ['house', 'button'] });

		expect(reply.json.schema).toEqual({ requested: BUNDLED, used: BUNDLED });
		expect(tagsOf(reply.json.results[0])).toEqual(expected.house);
		expect(tagsOf(reply.json.results[1])).toEqual(expected.button);
		expect(tagsOf(reply.json.results[1]).length).toBeLessThanOrEqual(10);
	});

	it('honors top, with the same tags as suggestBatch at that top', async () => {
		for (const top of [1, 2, 3, 10, 50]) {
			const expected = await suggestBatch(['button press', 'red square'], { schema: BUNDLED, top });

			const reply = await postJson(shared.url, '/v1/suggest', {
				queries: ['button press', 'red square'],
				schema: BUNDLED,
				top,
			});

			expect(reply.status, `top ${top}`).toBe(200);
			expect(tagsOf(reply.json.results[0]), `top ${top}`).toEqual(expected['button press']);
			expect(tagsOf(reply.json.results[1]), `top ${top}`).toEqual(expected['red square']);
			expect(tagsOf(reply.json.results[0]).length).toBeLessThanOrEqual(top);
		}
		const one = await postJson(shared.url, '/v1/suggest', { queries: ['button press'], schema: BUNDLED, top: 1 });
		expect(tagsOf(one.json.results[0])).toHaveLength(1);
	});

	it.each([
		[0, 'zero'],
		[51, 'above the maximum'],
		[1.5, 'a fraction'],
		['5', 'a string'],
		[null, 'null'],
		[true, 'a boolean'],
		[-1, 'negative'],
		[[5], 'an array'],
		[{}, 'an object'],
	])('answers 400 INVALID_REQUEST for top of %j (%s)', async (top, _label) => {
		const reply = await postJson(shared.url, '/v1/suggest', { queries: ['house'], top });

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_REQUEST');
	});

	it('keeps duplicate queries, __proto__, and constructor at their positions', async () => {
		const queries = ['red', 'red', '__proto__', 'Red', 'constructor', 'toString', '__proto__', 'red'];
		const expected = await suggestBatch(queries, { schema: BUNDLED, top: 5 });

		const reply = await postJson(shared.url, '/v1/suggest', { queries, schema: BUNDLED, top: 5 });

		expect(reply.status).toBe(200);
		expect(reply.json.results.map((item: { index: number }) => item.index)).toEqual(queries.map((_, i) => i));
		expect(reply.json.results.map((item: { query: string }) => item.query)).toEqual(queries);
		for (const [index, query] of queries.entries()) {
			expect(tagsOf(reply.json.results[index]), `${index} ${query}`).toEqual(
				Object.hasOwn(expected, query) ? expected[query] : [],
			);
		}
		expect(tagsOf(reply.json.results[0])).toEqual(tagsOf(reply.json.results[1]));
		expect(tagsOf(reply.json.results[0]).length).toBeGreaterThan(0);
	});

	it('puts an INVALID_QUERY item in place and answers the other queries', async () => {
		await withDaemon({ HED_LSP_MAX_QUERY_CHARS: '20' }, async (daemon) => {
			const long = 'x'.repeat(21);
			const reply = await postJson(daemon.url, '/v1/suggest', {
				queries: ['house', '', '   ', 7, null, ['x'], { a: 1 }, long, 'x'.repeat(20), 'walk'],
				schema: BUNDLED,
			});

			expect(reply.status).toBe(200);
			const results = reply.json.results;
			const message = 'must be a non-empty string of at most 20 characters';
			expect(results).toHaveLength(10);
			expect(tagsOf(results[0])).toContain('Building');
			expect(results[1]).toEqual({ index: 1, query: '', error: { code: 'INVALID_QUERY', message } });
			expect(results[2]).toEqual({ index: 2, query: '   ', error: { code: 'INVALID_QUERY', message } });
			for (const index of [3, 4, 5, 6]) {
				expect(results[index], `item ${index}`).toEqual({ index, error: { code: 'INVALID_QUERY', message } });
			}
			expect(results[7]).toEqual({ index: 7, query: long, error: { code: 'INVALID_QUERY', message } });
			expect(results[8].error).toBeUndefined();
			expect(results[8].suggestions).toBeInstanceOf(Array);
			expect(tagsOf(results[9])).toContain('Walk');
		});
	});

	it('answers an empty queries array with 200 and no results', async () => {
		const reply = await postJson(shared.url, '/v1/suggest', { queries: [] });

		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			apiVersion: '1.0',
			schema: { requested: BUNDLED, used: BUNDLED },
			results: [],
		});
	});

	it('never carries a source field, which this contract dropped', async () => {
		const reply = await postJson(shared.url, '/v1/suggest', { queries: QUERIES, semantic: true, top: 5 });

		expect(reply.status).toBe(200);
		expect(hasKey(reply.json, 'source')).toBe(false);
	});

	it('returns library-prefixed tags only when the library set is requested', async () => {
		const bare = await postJson(shared.url, '/v1/suggest', { queries: ['modulator'], schema: BUNDLED, top: 5 });
		const withLibraries = await postJson(shared.url, '/v1/suggest', {
			queries: ['modulator'],
			schema: BUNDLED_WITH_LIBRARIES,
			top: 5,
		});
		const expected = await suggestBatch(['modulator'], { schema: BUNDLED_WITH_LIBRARIES, top: 5 });

		expect(tagsOf(bare.json.results[0])).toEqual([]);
		expect(tagsOf(withLibraries.json.results[0])).toEqual(expected.modulator);
		expect(tagsOf(withLibraries.json.results[0])).toContain('sc:Modulator');
	});
});

describe('POST /v1/suggest batch limits', () => {
	it('answers BATCH_TOO_LARGE for 51 queries, and accepts 50', async () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `query ${i}`);

		const ok = await postJson(shared.url, '/v1/suggest', { queries: fifty });
		const tooMany = await postJson(shared.url, '/v1/suggest', { queries: [...fifty, 'one more'] });

		expect(ok.status).toBe(200);
		expect(ok.json.results).toHaveLength(50);
		expect(tooMany.status).toBe(400);
		expect(tooMany.json.error.code).toBe('BATCH_TOO_LARGE');
		expect(tooMany.json.error.details).toEqual({ field: 'queries', max: 50 });
	});

	it('applies MAX_SEMANTIC_QUERIES to every request with semantic true, whatever the server state', async () => {
		await withDaemon({ HED_LSP_MAX_SEMANTIC_QUERIES: '3' }, async (daemon) => {
			const four = ['a', 'b', 'c', 'd'];

			const refused = await postJson(daemon.url, '/v1/suggest', { queries: four, semantic: true });
			const atLimit = await postJson(daemon.url, '/v1/suggest', { queries: four.slice(0, 3), semantic: true });
			const plain = await postJson(daemon.url, '/v1/suggest', { queries: four });
			const explicitlyOff = await postJson(daemon.url, '/v1/suggest', { queries: four, semantic: false });

			expect(refused.status).toBe(400);
			expect(refused.json.error.code).toBe('BATCH_TOO_LARGE');
			expect(refused.json.error.details).toEqual({ field: 'queries', max: 3, semantic: true });
			expect(atLimit.status).toBe(200);
			expect(plain.status).toBe(200);
			expect(explicitlyOff.status).toBe(200);
		});
	});
});

describe('POST /v1/suggest semantic status without semantic search', () => {
	it('answers 200 with status disabled, and the same results, when the server flag is off', async () => {
		const queries = ['red square', 'xyzzy nonsense', 'a loud bang'];
		const plain = await postJson(shared.url, '/v1/suggest', { queries, schema: BUNDLED });

		const asked = await postJson(shared.url, '/v1/suggest', { queries, schema: BUNDLED, semantic: true });

		expect(asked.status).toBe(200);
		expect(asked.json.semantic).toEqual({ requested: true, status: 'disabled' });
		expect(asked.json.results).toEqual(plain.json.results);
	});

	it('omits the semantic object unless the request set semantic true', async () => {
		for (const body of [{ queries: ['house'] }, { queries: ['house'], semantic: false }]) {
			const reply = await postJson(shared.url, '/v1/suggest', body);

			expect(reply.status).toBe(200);
			expect(Object.keys(reply.json).sort()).toEqual(['apiVersion', 'results', 'schema']);
		}
	});

	it.each([
		['true', 'a string'],
		[1, 'a number'],
		[null, 'null'],
		[[], 'an array'],
	])('answers 400 INVALID_REQUEST for semantic of %j (%s)', async (semantic, _label) => {
		const reply = await postJson(shared.url, '/v1/suggest', { queries: ['house'], semantic });

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_REQUEST');
	});
});

describe('POST /v1/suggest request checks', () => {
	it('answers UNKNOWN_FIELD for queryFormat, __proto__, constructor, and any other key', async () => {
		const bodies = [
			'{"queries": [], "queryFormat": "qwen"}',
			'{"queries": ["house"], "__proto__": {"semantic": true}}',
			'{"queries": [], "constructor": {}}',
			'{"queries": [], "strings": []}',
			'{"queries": [], "Top": 5}',
			'{"__proto__": 1}',
		];
		for (const body of bodies) {
			const reply = await postJson(shared.url, '/v1/suggest', body);

			expect(reply.status, body).toBe(400);
			expect(reply.json.error.code, body).toBe('UNKNOWN_FIELD');
			expect(reply.json.error.details.allowed).toEqual(['queries', 'top', 'schema', 'semantic']);
		}
		const proto = await postJson(shared.url, '/v1/suggest', '{"queries": [], "queryFormat": "hed", "__proto__": 1}');
		expect(proto.json.error.details.fields).toEqual(['queryFormat', '__proto__']);
	});

	it.each([
		[{}, 'queries missing'],
		[{ queries: null }, 'null queries'],
		[{ queries: 'house' }, 'a string for queries'],
		[{ queries: { 0: 'house' } }, 'an object for queries'],
	])('answers INVALID_REQUEST for %j (%s)', async (body, _label) => {
		const reply = await postJson(shared.url, '/v1/suggest', body);

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_REQUEST');
	});

	it('answers INVALID_REQUEST for a top-level array and INVALID_JSON for bad syntax', async () => {
		expect((await postJson(shared.url, '/v1/suggest', '["house"]')).json.error.code).toBe('INVALID_REQUEST');
		expect((await postJson(shared.url, '/v1/suggest', '{"queries": [')).json.error.code).toBe('INVALID_JSON');
		expect((await postJson(shared.url, '/v1/suggest', '')).json.error.code).toBe('INVALID_JSON');
	});

	it('answers 415, 413, and 405 like the validate endpoint', async () => {
		const wrongType = await call(shared.url, '/v1/suggest', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: '{"queries": []}',
		});
		expect(wrongType.status).toBe(415);

		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '100' }, async (daemon) => {
			const large = await postJson(daemon.url, '/v1/suggest', { queries: ['x'.repeat(200)] });
			expect(large.status).toBe(413);
			expect(large.json.error.code).toBe('PAYLOAD_TOO_LARGE');
		});

		for (const method of ['GET', 'HEAD', 'PUT']) {
			const reply = await call(shared.url, '/v1/suggest', { method });
			expect(reply.status, method).toBe(405);
			expect(reply.headers.allow, method).toBe('POST, OPTIONS');
		}
		expect((await call(shared.url, '/v1/suggest', { method: 'OPTIONS' })).status).toBe(204);
	});

	it('maps a schema field like the validate endpoint does', async () => {
		const reordered = await postJson(shared.url, '/v1/suggest', {
			queries: ['modulator'],
			schema: ['la:lang_1.1.0', 'sc:score_2.1.0', '8.4.0'],
		});
		const unknown = await postJson(shared.url, '/v1/suggest', { queries: ['house'], schema: '8.5.0' });
		const wrongType = await postJson(shared.url, '/v1/suggest', { queries: ['house'], schema: 5 });
		const blank = await postJson(shared.url, '/v1/suggest', { queries: ['house'], schema: '  ' });

		expect(reordered.json.schema).toEqual({ requested: BUNDLED_WITH_LIBRARIES, used: BUNDLED_WITH_LIBRARIES });
		expect(tagsOf(reordered.json.results[0])).toContain('sc:Modulator');
		expect(unknown.status).toBe(400);
		expect(unknown.json.error.code).toBe('UNKNOWN_SCHEMA');
		expect(unknown.json.error.details).toEqual({ allowed: [BUNDLED, BUNDLED_WITH_LIBRARIES] });
		expect(wrongType.json.error.code).toBe('INVALID_REQUEST');
		expect(blank.json.schema.requested).toBe(BUNDLED);
	});

	it('answers 503 SCHEMA_UNAVAILABLE for a spec that failed to load, and still serves the default', async () => {
		// The second spec does not exist, so its load fails for real, online with a 404 and offline with a network error.
		await withDaemon({ HED_LSP_SCHEMAS: `${BUNDLED};${MISSING}` }, async (daemon) => {
			await waitFor(
				async () => (await call(daemon.url, '/v1/schemas')).json.schemas[1].status === 'failed',
				5000,
				'the spec to fail',
			);

			const reply = await postJson(daemon.url, '/v1/suggest', { queries: ['house'], schema: MISSING });

			expect(reply.status).toBe(503);
			expect(reply.json.error.code).toBe('SCHEMA_UNAVAILABLE');
			expect(reply.headers['retry-after']).toMatch(/^[1-9]\d*$/);
			expect((await postJson(daemon.url, '/v1/suggest', { queries: ['house'] })).status).toBe(200);
		});
	});
});

describe('POST /v1/suggest logging', () => {
	it('logs the item count, schema, and semantic status of the request and none of its text', async () => {
		await withDaemon({}, async (daemon) => {
			const marker = 'secret-query-marker';
			const reply = await postJson(daemon.url, '/v1/suggest', {
				queries: [marker, `${marker} again`, 'house', 5],
				schema: BUNDLED,
				semantic: true,
			});

			const line = daemon
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
			expect(line).toMatchObject({
				method: 'POST',
				path: '/v1/suggest',
				status: 200,
				items: 4,
				schema: BUNDLED,
				semantic: 'disabled',
			});
			// The engine logs through the same sink, so its lines are covered by the same check.
			expect(daemon.rawLines.join('\n').toLowerCase()).not.toContain(marker);
		});
	});

	it('leaves the semantic field out of the log when the request did not ask for it', async () => {
		await withDaemon({}, async (daemon) => {
			const reply = await postJson(daemon.url, '/v1/suggest', { queries: ['house'] });

			const line = daemon
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
			expect(line).toBeDefined();
			expect('semantic' in (line ?? {})).toBe(false);
		});
	});
});
