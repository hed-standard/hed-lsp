/**
 * Tests for the limits on a running daemon: per-client rates charged by item, the in-flight cap, the
 * request timeout, and the Node server's own timeouts and connection cap. A real server on a real
 * socket (port 0) with the real engine and the bundled schemas, over real HTTP. Time enters in two
 * ways only: the clock the rate buckets read is a parameter, so a test moves it instead of waiting,
 * and the timeouts are real and short. The semantic limits that need a loaded model are in
 * daemonSemantic.test.ts. No mocks.
 */

import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { doorCost } from '../daemon/server.js';
import {
	BUNDLED,
	call,
	holdRequest,
	postJson,
	type RunningDaemon,
	sleep,
	startDaemon,
	testConfig,
	waitFor,
} from './daemonHarness.js';

const running: RunningDaemon[] = [];

async function start(...args: Parameters<typeof startDaemon>): Promise<RunningDaemon> {
	const daemon = await startDaemon(...args);
	running.push(daemon);
	return daemon;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.stop()));
});

/** A spec that does not exist, so loading it fails for real. */
const MISSING = '8.4.0,sc:score_9.9.9';

const VALID = 'Sensory-event, Visual-presentation';

/**
 * Node refuses a headers timeout longer than its request timeout, which is the daemon's plus 5 s, so
 * a test with a short request timeout shortens the headers timeout too.
 */
const SHORT_HEADERS = { HED_LSP_HEADERS_TIMEOUT_MS: '1000' };

/** A slow bucket: five items at once, and a refill so slow that only the clock moves it. */
const FIVE_ITEMS = { HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '5' };

/** A clock the test moves by hand. */
function manualClock(): { now: () => number; advance: (ms: number) => void } {
	let time = 1_000_000;
	return {
		now: () => time,
		advance: (ms) => {
			time += ms;
		},
	};
}

/** A validate request with `count` valid strings. */
function strings(count: number): { strings: string[] } {
	return { strings: Array.from({ length: count }, () => VALID) };
}

describe('rate limits charged by item', () => {
	it('charges one unit per string, and refuses with 429 and a whole-second Retry-After when the bucket is short', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });

		const first = await postJson(url, '/v1/validate', strings(3));
		const second = await postJson(url, '/v1/validate', strings(3));
		const third = await postJson(url, '/v1/validate', strings(1));
		const fourth = await postJson(url, '/v1/validate', strings(1));

		expect(first.status).toBe(200);
		expect(second.status).toBe(429);
		expect(second.json.error.code).toBe('RATE_LIMITED');
		expect(second.json.requestId).toBe(second.headers['x-request-id']);
		// Two units were left and the refused request kept its door unit, so one is left, and the same
		// request would need the door again and two more: three units, with one on hand.
		expect(second.headers['retry-after']).toBe('2');
		expect(second.headers['access-control-allow-origin']).toBe('*');
		// A charge is for the request, not its result: the refusal kept the unit it paid at the door.
		expect(third.status).toBe(200);
		expect(fourth.status).toBe(429);
	});

	it('charges each query of a suggest request, and a schemas request one unit', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });

		const queries = await postJson(url, '/v1/suggest', { queries: ['a', 'b', 'c', 'd'] });
		const schemas = await call(url, '/v1/schemas');
		const refused = await call(url, '/v1/schemas');

		expect(queries.status).toBe(200);
		expect(schemas.status).toBe(200);
		expect(refused.status).toBe(429);
	});

	it('tells the truth in Retry-After: the request passes once the clock has moved that far', async () => {
		const clock = manualClock();
		const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '4' }, { now: clock.now });
		expect((await postJson(url, '/v1/validate', strings(3))).status).toBe(200);

		// One unit is left. The refusal keeps the door unit, which leaves none, and the request would
		// pay the door again and two more, so it needs three units.
		const refused = await postJson(url, '/v1/validate', strings(3));
		expect(refused.status).toBe(429);
		expect(refused.headers['retry-after']).toBe('3');

		// A moment short of the wait is refused again, and that attempt pays its door once more.
		clock.advance(2999);
		const almost = await postJson(url, '/v1/validate', strings(3));
		expect(almost.status).toBe(429);
		expect(almost.headers['retry-after']).toBe('2');

		// Waiting exactly as long as the answer said lets the request through.
		clock.advance(2000);
		expect((await postJson(url, '/v1/validate', strings(3))).status).toBe(200);
	});

	it('lets a batch larger than the burst through from a full bucket, charging the whole burst', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });

		const big = await postJson(url, '/v1/validate', strings(10));
		const next = await postJson(url, '/v1/validate', strings(1));

		expect(big.status).toBe(200);
		expect(next.status).toBe(429);
	});

	it('charges an empty batch one unit, so it is not free', async () => {
		const clock = manualClock();
		const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '2' }, { now: clock.now });

		const statuses = [];
		for (let i = 0; i < 3; i++) {
			statuses.push((await postJson(url, '/v1/validate', { strings: [] })).status);
		}

		expect(statuses).toEqual([200, 200, 429]);
	});

	it('exempts /v1/health from every limit', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '1', HED_LSP_MAX_IN_FLIGHT: '1' },
			{ now: clock.now },
		);
		expect((await postJson(url, '/v1/validate', strings(1))).status).toBe(200);
		expect((await postJson(url, '/v1/validate', strings(1))).status).toBe(429);

		const replies = [await call(url, '/v1/health'), await call(url, '/v1/health'), await call(url, '/v1/health')];

		expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
	});

	it('charges a request refused before its items are known one unit, and answers 429 once the units are gone', async () => {
		const clock = manualClock();
		const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '3' }, { now: clock.now });

		// Three refusals use the three units, and the third still answers 400, not 429.
		const refusals = [];
		for (let i = 0; i < 4; i++) {
			refusals.push((await postJson(url, '/v1/validate', '{not json')).status);
		}
		const valid = await postJson(url, '/v1/validate', strings(1));

		expect(refusals).toEqual([400, 400, 400, 429]);
		expect(valid.status).toBe(429);
	});

	it('charges each refused 413 one unit', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '2', HED_LSP_MAX_BODY_BYTES: '100' },
			{ now: clock.now },
		);
		const tooLarge = { strings: ['x'.repeat(200)] };

		const first = await postJson(url, '/v1/validate', tooLarge);
		const second = await postJson(url, '/v1/validate', tooLarge);
		const third = await postJson(url, '/v1/validate', strings(0));

		expect([first.status, second.status]).toEqual([413, 413]);
		expect(third.status).toBe(429);
	});

	it('limits requests for a route that does not exist, and keeps health open to the same client', async () => {
		const clock = manualClock();
		const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '3' }, { now: clock.now });

		const statuses = [];
		for (let i = 0; i < 5; i++) {
			statuses.push((await call(url, '/missing')).status);
		}
		const refused = await call(url, '/missing');
		const health = [await call(url, '/v1/health'), await call(url, '/v1/health')];
		// One bucket serves every kind of request, so the spent units refuse a real one too.
		const valid = await postJson(url, '/v1/validate', strings(1));

		expect(statuses).toEqual([404, 404, 404, 429, 429]);
		expect(refused.json.error.code).toBe('RATE_LIMITED');
		expect(refused.json.requestId).toBe(refused.headers['x-request-id']);
		expect(refused.headers['retry-after']).toBe('1');
		expect(refused.headers['access-control-allow-origin']).toBe('*');
		expect(health.map((reply) => reply.status)).toEqual([200, 200]);
		expect(valid.status).toBe(429);
	});

	it.each([
		['a wrong method', 405, (url: string) => call(url, '/v1/validate')],
		['a preflight', 204, (url: string) => call(url, '/v1/validate', { method: 'OPTIONS' })],
		[
			'an unsupported media type',
			415,
			(url: string) =>
				call(url, '/v1/validate', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }),
		],
		['a POST to health', 405, (url: string) => call(url, '/v1/health', { method: 'POST' })],
		['a preflight for health', 204, (url: string) => call(url, '/v1/health', { method: 'OPTIONS' })],
	])(
		'charges %s one unit, so past the burst it answers 429 with a whole-second Retry-After',
		async (_label, status, send) => {
			const clock = manualClock();
			const { url } = await start(FIVE_ITEMS, { now: clock.now });

			const answered = [];
			for (let i = 0; i < 5; i++) {
				answered.push((await send(url)).status);
			}
			const refused = await send(url);

			expect(answered).toEqual([status, status, status, status, status]);
			expect(refused.status).toBe(429);
			expect(refused.json.error.code).toBe('RATE_LIMITED');
			expect(refused.headers['retry-after']).toMatch(/^[1-9]\d*$/);
			// Health for a GET is never charged.
			expect((await call(url, '/v1/health')).status).toBe(200);
		},
	);

	it('charges a request that is refused as starting or as overloaded', async () => {
		const clock = manualClock();
		const starting = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '2' },
			{ now: clock.now, autoPreload: false },
		);
		const startingStatuses = [];
		for (let i = 0; i < 3; i++) {
			startingStatuses.push((await postJson(starting.url, '/v1/validate', strings(1))).status);
		}
		expect(startingStatuses).toEqual([503, 503, 429]);

		// One request holds the only slot. Another client, named by a header that the trusted local proxy
		// may set, finds out when the slot is taken. The clock then moves far enough to refill every bucket.
		const busy = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '3', HED_LSP_MAX_IN_FLIGHT: '1' },
			{ now: clock.now },
		);
		const held = holdRequest(busy.url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await waitFor(
			async () => {
				clock.advance(1000);
				return (await call(busy.url, '/v1/schemas', { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status === 503;
			},
			5000,
			'the slot to be taken',
		);
		clock.advance(60_000);
		const overloaded = [];
		for (let i = 0; i < 4; i++) {
			overloaded.push((await call(busy.url, '/v1/schemas')).status);
		}

		expect(overloaded).toEqual([503, 503, 503, 429]);
		held.abandon();
	});

	it('does not charge the semantic bucket for a request that does not run semantic search', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ HED_LSP_SEMANTIC_RATE_PER_SEC: '1', HED_LSP_SEMANTIC_RATE_BURST: '2' },
			{ now: clock.now },
		);

		// Semantic search is off on this daemon, so the three queries run without it.
		const statuses = [];
		for (let i = 0; i < 4; i++) {
			const reply = await postJson(url, '/v1/suggest', { queries: ['a', 'b', 'c'], semantic: true });
			expect(reply.json.semantic).toEqual({ requested: true, status: 'disabled' });
			statuses.push(reply.status);
		}

		expect(statuses).toEqual([200, 200, 200, 200]);
	});
});

describe('the door charged by body length, and refusals that keep their charge', () => {
	/** A request that is refused as UNKNOWN_FIELD after its body is read, with a body of about `bytes` bytes. */
	function padded(bytes: number): string {
		const overhead = '{"strings":[],"pad":""}'.length;
		return `{"strings":[],"pad":"${'a'.repeat(bytes - overhead)}"}`;
	}

	it('charges a POST one unit for each 4096 bytes it declares, rounded up, before it is read', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '10' },
			{ now: clock.now },
		);
		const body = padded(2 * 4096 + 1);
		expect(doorCost('POST', String(Buffer.byteLength(body)))).toBe(3);

		// The body is refused for its unknown field, and the door took 3 of the 10 units.
		const refused = await postJson(url, '/v1/validate', body);
		// Seven units are left: a request of seven strings takes them all, and the next finds none.
		const seven = await postJson(url, '/v1/validate', strings(7));
		const none = await postJson(url, '/v1/validate', strings(1));

		expect(refused.status).toBe(400);
		expect(refused.json.error.code).toBe('UNKNOWN_FIELD');
		expect([seven.status, none.status]).toEqual([200, 429]);
	});

	it('charges a body of exactly 4096 bytes one unit and one byte more two', () => {
		expect([0, 1, 4096].map((bytes) => doorCost('POST', String(bytes)))).toEqual([1, 1, 1]);
		expect([4097, 8192].map((bytes) => doorCost('POST', String(bytes)))).toEqual([2, 2]);
		expect(doorCost('POST', String(8193))).toBe(3);
	});

	it.each(['GET', 'OPTIONS', 'PUT', 'DELETE'])('charges a %s one unit whatever it declares', (method) => {
		expect(doorCost(method, String(10_000_000))).toBe(1);
	});

	it('charges a POST without a usable length one unit', () => {
		expect([undefined, '', '-5', '1.5', 'abc'].map((length) => doorCost('POST', length))).toEqual([1, 1, 1, 1, 1]);
	});

	it('charges a declared length past the burst as the whole burst, even when the body is refused unread', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '50' },
			{ now: clock.now },
		);
		const held = holdRequest(url, '/v1/validate', { length: 100 * 1024 * 1024, first: '{"strings"' });

		const tooLarge = await held.response;
		held.abandon();
		const next = await postJson(url, '/v1/validate', strings(1));

		expect(tooLarge.status).toBe(413);
		expect(next.status).toBe(429);
	});

	it('refuses a second large POST once the first has used most of the burst, and keeps refusing', async () => {
		const clock = manualClock();
		const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '5' }, { now: clock.now });
		const body = padded(3 * 4096);
		expect(doorCost('POST', String(Buffer.byteLength(body)))).toBe(3);

		const statuses = [];
		for (let i = 0; i < 3; i++) {
			statuses.push((await postJson(url, '/v1/validate', body)).status);
		}

		// Five units pay for one door of three, and the second finds two.
		expect(statuses).toEqual([400, 429, 429]);
	});

	it('keeps the charge of a request that is refused because its schema is unavailable', async () => {
		const clock = manualClock();
		const { url } = await start(
			{ ...FIVE_ITEMS, HED_LSP_SCHEMAS: `${BUNDLED};${MISSING}`, HED_LSP_DEFAULT_SCHEMA: BUNDLED },
			{ now: clock.now },
		);
		await waitFor(
			async () => {
				clock.advance(1000);
				return (await call(url, '/v1/schemas')).json.schemas[1].status === 'failed';
			},
			5000,
			'the spec to fail',
		);
		// Five seconds refill the bucket, and stay well inside the 30 second backoff of the failed schema.
		clock.advance(5000);

		const unavailable = await postJson(url, '/v1/validate', { ...strings(3), schema: MISSING });
		// A full bucket held five units, and the refused request spent three of them.
		const next = await postJson(url, '/v1/validate', strings(3));
		// The refusal of the second request kept its door unit, so one unit is left.
		const last = await postJson(url, '/v1/validate', strings(1));

		expect(unavailable.status).toBe(503);
		expect(unavailable.json.error.code).toBe('SCHEMA_UNAVAILABLE');
		expect([next.status, last.status]).toEqual([429, 200]);
	});
});

describe('the clock of the rate limits', () => {
	it('keeps refilling the buckets when the wall clock steps back an hour', async () => {
		// The wall clock is installed before the daemon starts, because the daemon keeps the clock function it
		// finds. It reads real time until the test steps it back. No clock is passed to the daemon, so it
		// uses its default one: on the wall clock its buckets would stay empty for the whole hour.
		const realNow = Date.now;
		let stepBackMs = 0;
		Date.now = () => realNow() - stepBackMs;
		try {
			// 20 units a second, and a burst of 5.
			const { url } = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '20', HED_LSP_RATE_ITEMS_BURST: '5' });
			expect((await postJson(url, '/v1/validate', strings(5))).status).toBe(200);

			stepBackMs = 3_600_000;

			await waitFor(
				async () => (await postJson(url, '/v1/validate', strings(1))).status === 200,
				5000,
				'the bucket to refill',
			);
		} finally {
			Date.now = realNow;
		}
	});
});

describe('rate limits charged by length of text', () => {
	const config = testConfig();
	const perUnit = config.chargeCharsPerUnit;
	/** The longest string a validate request accepts. */
	const longest = 'a'.repeat(config.maxStringChars);
	/** By design a string costs one unit for each `perUnit` characters, rounded up. */
	const longestCost = Math.ceil(longest.length / perUnit);

	it.each([
		['one unit short of its cost', 429, 0],
		['exactly its cost', 200, 1],
	])('a string of the longest length, with a bucket holding %s, answers %i', async (_label, expectedStatus, spare) => {
		expect(longestCost).toBeGreaterThan(1);
		const clock = manualClock();
		// One short string takes one unit first, so the long one needs its whole cost from what is left,
		// and a lone request over the burst, which a full bucket lets through, does not hide the charge.
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: String(longestCost + spare) },
			{ now: clock.now },
		);

		expect((await postJson(url, '/v1/validate', strings(1))).status).toBe(200);
		const long = await postJson(url, '/v1/validate', { strings: [longest] });

		expect(long.status).toBe(expectedStatus);
		if (expectedStatus === 429) {
			expect(long.json.error.code).toBe('RATE_LIMITED');
			// The body of about 4 KB paid 2 units at the door, which the refusal kept, so 13 are left and
			// the same request needs all 16 again: three more units, so three seconds.
			expect(long.headers['retry-after']).toBe('3');
			// What the refusal left still serves ordinary strings.
			expect((await postJson(url, '/v1/validate', strings(1))).status).toBe(200);
		}
	});

	it('charges exactly CHARGE_CHARS_PER_UNIT characters one unit, and one character more two', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });
		const exact = 'a'.repeat(perUnit);
		const oneMore = 'a'.repeat(perUnit + 1);

		// Each client has its own bucket of five, and spends four of them on two long strings.
		const send = (client: string, strings: string[]): Promise<number> =>
			postJson(url, '/v1/validate', { strings }, { 'X-Forwarded-For': client }).then((reply) => reply.status);

		const spent = [await send('203.0.113.1', [oneMore, oneMore]), await send('203.0.113.2', [oneMore, oneMore])];
		// One unit is left. A string of exactly the unit costs it, and one character more costs two.
		const exactFits = await send('203.0.113.1', [exact]);
		const nothingLeft = await send('203.0.113.1', ['a']);
		const oneMoreRefused = await send('203.0.113.2', [oneMore]);

		expect(spent).toEqual([200, 200]);
		expect([exactFits, nothingLeft, oneMoreRefused]).toEqual([200, 429, 429]);
	});

	it('charges an ordinary string one unit, so a request of short strings costs what it did by count', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });

		const statuses = [];
		for (const count of [5, 1]) {
			statuses.push((await postJson(url, '/v1/validate', strings(count))).status);
		}

		expect(strings(1).strings[0].length).toBeLessThanOrEqual(perUnit);
		expect(statuses).toEqual([200, 429]);
	});

	it('charges each query of a suggest request by its length', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });
		const long = 'a'.repeat(perUnit + 1);
		expect(long.length).toBeLessThanOrEqual(config.maxQueryChars);

		// Each client has its own bucket of five, and spends four of them on two long queries.
		const send = (client: string, queries: string[]): Promise<number> =>
			postJson(url, '/v1/suggest', { queries }, { 'X-Forwarded-For': client }).then((reply) => reply.status);

		const spent = [await send('203.0.113.1', [long, long]), await send('203.0.113.2', [long, long])];
		// One unit is left: an ordinary query fits, and a query of one character over the unit does not.
		const ordinaryFits = await send('203.0.113.1', ['a']);
		const longRefused = await send('203.0.113.2', [long]);

		expect(spent).toEqual([200, 200]);
		expect([ordinaryFits, longRefused]).toEqual([200, 429]);
	});

	it('charges an item that is not a string one unit', async () => {
		const clock = manualClock();
		const { url } = await start(FIVE_ITEMS, { now: clock.now });

		const refusedItems = await postJson(url, '/v1/validate', { strings: [1, null, true, [], {}] });
		const next = await postJson(url, '/v1/validate', strings(1));

		expect(refusedItems.status).toBe(200);
		expect(next.status).toBe(429);
	});
});

describe('the client a request is limited as', () => {
	const ONE_REQUEST = { HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '1' };

	async function statusFor(url: string, forwardedFor?: string): Promise<number> {
		return (
			await postJson(
				url,
				'/v1/validate',
				strings(1),
				forwardedFor === undefined ? {} : { 'X-Forwarded-For': forwardedFor },
			)
		).status;
	}

	it('keys a request by the rightmost X-Forwarded-For entry when the peer is a trusted proxy', async () => {
		const clock = manualClock();
		const { url } = await start(ONE_REQUEST, { now: clock.now });

		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		expect(await statusFor(url, '203.0.113.1')).toBe(429);
		expect(await statusFor(url, '203.0.113.2')).toBe(200);
		// The leftmost entry can be forged by the client; the proxy appended the rightmost one.
		expect(await statusFor(url, '6.6.6.6, 203.0.113.1')).toBe(429);
		expect(await statusFor(url, '203.0.113.1, 6.6.6.6')).toBe(200);
	});

	it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
		const clock = manualClock();
		const { url } = await start({ ...ONE_REQUEST, HED_LSP_TRUSTED_PROXIES: '10.9.9.9' }, { now: clock.now });

		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		expect(await statusFor(url, '203.0.113.2')).toBe(429);
		expect(await statusFor(url)).toBe(429);
	});

	it('ignores X-Forwarded-For when no proxy is trusted', async () => {
		const clock = manualClock();
		const { url } = await start({ ...ONE_REQUEST, HED_LSP_TRUSTED_PROXIES: '' }, { now: clock.now });

		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		expect(await statusFor(url, '203.0.113.2')).toBe(429);
	});

	it('limits an IPv6 client by its /64, so addresses of one subscriber share a bucket', async () => {
		const clock = manualClock();
		const { url } = await start(ONE_REQUEST, { now: clock.now });

		expect(await statusFor(url, '2001:db8:1:2::1')).toBe(200);
		expect(await statusFor(url, '2001:db8:1:2:ffff:eeee:dddd:cccc')).toBe(429);
		expect(await statusFor(url, '2001:db8:1:3::1')).toBe(200);
	});

	it('falls back to the peer when the forwarded address is not an IP address', async () => {
		const clock = manualClock();
		const { url } = await start(ONE_REQUEST, { now: clock.now });

		expect(await statusFor(url, 'not-an-ip')).toBe(200);
		expect(await statusFor(url, 'also-not-an-ip')).toBe(429);
	});

	it('evicts the least recently used client when the table is full, which gives it a fresh bucket', async () => {
		const clock = manualClock();
		const { url } = await start({ ...ONE_REQUEST, HED_LSP_MAX_CLIENTS: '2' }, { now: clock.now });

		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		expect(await statusFor(url, '203.0.113.1')).toBe(429);
		expect(await statusFor(url, '203.0.113.2')).toBe(200);
		// A third client pushes out the least recently used one, the first.
		expect(await statusFor(url, '203.0.113.3')).toBe(200);
		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		// The second was the least recently used by then, so it was pushed out in turn.
		expect(await statusFor(url, '203.0.113.2')).toBe(200);
	});

	it('forgets a client that has been idle for CLIENT_IDLE_MS, and only then', async () => {
		const clock = manualClock();
		// A bucket that refills 0.06 items in a minute, so only forgetting the client can give it back its item.
		const { url } = await start(
			{ HED_LSP_RATE_ITEMS_PER_SEC: '0.001', HED_LSP_RATE_ITEMS_BURST: '1', HED_LSP_CLIENT_IDLE_MS: '60000' },
			{ now: clock.now },
		);
		expect(await statusFor(url, '203.0.113.1')).toBe(200);
		expect(await statusFor(url, '203.0.113.1')).toBe(429);

		clock.advance(59_999);
		expect(await statusFor(url, '203.0.113.1')).toBe(429);

		// The refused request just above counted as a visit, so the minute runs from there.
		clock.advance(60_000);
		expect(await statusFor(url, '203.0.113.1')).toBe(200);
	});
});

describe('requests in flight', () => {
	it('holds a slot from the headers until the work stops, so a half-sent body makes the next request overloaded', async () => {
		const { url } = await start({ HED_LSP_MAX_IN_FLIGHT: '1' });
		const body = JSON.stringify(strings(1));
		const held = holdRequest(url, '/v1/validate', { length: body.length, first: body.slice(0, 5) });

		await waitFor(async () => (await call(url, '/v1/schemas')).status === 503, 5000, 'the slot to be taken');
		const refused = await call(url, '/v1/schemas');
		const refusedPost = await postJson(url, '/v1/validate', strings(1));
		const health = await call(url, '/v1/health');

		expect(refused.json.error.code).toBe('OVERLOADED');
		expect(refused.headers['retry-after']).toBe('1');
		expect(refused.headers['access-control-allow-origin']).toBe('*');
		expect(refusedPost.json.error.code).toBe('OVERLOADED');
		expect(health.status).toBe(200);

		held.complete(body.slice(5));
		const finished = await held.response;
		expect(finished.status).toBe(200);
		expect(finished.json.results).toHaveLength(1);
		await waitFor(async () => (await call(url, '/v1/schemas')).status === 200, 5000, 'the slot to be free');
	});

	it('caps the requests in flight for one client, and still serves another client', async () => {
		const { url } = await start({ HED_LSP_MAX_IN_FLIGHT: '8', HED_LSP_MAX_IN_FLIGHT_PER_CLIENT: '2' });
		const greedy = { 'X-Forwarded-For': '203.0.113.1' };
		const other = { 'X-Forwarded-For': '203.0.113.2' };
		const held = [1, 2].map(() =>
			holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"', headers: greedy }),
		);
		await waitFor(
			async () => (await postJson(url, '/v1/validate', strings(1), greedy)).status === 503,
			5000,
			'the client to reach its cap',
		);

		const refused = await postJson(url, '/v1/validate', strings(1), greedy);
		const served = await postJson(url, '/v1/validate', strings(1), other);
		const health = await call(url, '/v1/health', { headers: greedy });

		expect(refused.status).toBe(503);
		expect(refused.json.error.code).toBe('OVERLOADED');
		expect(refused.headers['retry-after']).toBe('1');
		expect(refused.headers['access-control-allow-origin']).toBe('*');
		expect(served.status).toBe(200);
		expect(health.status).toBe(200);
		for (const request of held) {
			request.abandon();
		}
		await waitFor(
			async () => (await postJson(url, '/v1/validate', strings(1), greedy)).status === 200,
			5000,
			'the slots to be free',
		);
	});

	it('counts the shared cap over all clients, and gives a client its own slot back when the shared cap refuses it', async () => {
		const { url } = await start({ HED_LSP_MAX_IN_FLIGHT: '2', HED_LSP_MAX_IN_FLIGHT_PER_CLIENT: '2' });
		const first = { 'X-Forwarded-For': '203.0.113.1' };
		const second = { 'X-Forwarded-For': '203.0.113.2' };
		const heldFirst = holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"', headers: first });
		const heldSecond = holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"', headers: second });
		await waitFor(
			async () =>
				(await postJson(url, '/v1/validate', strings(1), { 'X-Forwarded-For': '203.0.113.3' })).status === 503,
			5000,
			'the shared cap to be reached',
		);

		// The first client is under its own cap of two, and the shared cap refuses it five times.
		const refusals = [];
		for (let i = 0; i < 5; i++) {
			refusals.push((await postJson(url, '/v1/validate', strings(1), first)).status);
		}
		heldSecond.abandon();
		await waitFor(
			async () => (await postJson(url, '/v1/validate', strings(1), second)).status === 200,
			5000,
			'the shared slot to be free',
		);

		// The first client holds one slot of its two. Had a refusal kept a slot, it would be at its cap now.
		const again = await postJson(url, '/v1/validate', strings(1), first);

		expect(refusals).toEqual([503, 503, 503, 503, 503]);
		expect(again.status).toBe(200);
		heldFirst.abandon();
	});

	it('frees the slot when a client abandons a half-sent body', async () => {
		const { url } = await start({ HED_LSP_MAX_IN_FLIGHT: '1' });
		const held = holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await waitFor(async () => (await call(url, '/v1/schemas')).status === 503, 5000, 'the slot to be taken');

		held.abandon();

		await waitFor(async () => (await call(url, '/v1/schemas')).status === 200, 5000, 'the slot to be free');
	});

	it('does not count a refused OVERLOADED request, a 404, or a preflight against the cap', async () => {
		const { url } = await start({ HED_LSP_MAX_IN_FLIGHT: '1' });
		const held = holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await waitFor(async () => (await call(url, '/v1/schemas')).status === 503, 5000, 'the slot to be taken');

		expect((await call(url, '/nope')).status).toBe(404);
		expect((await call(url, '/v1/validate', { method: 'OPTIONS' })).status).toBe(204);
		expect((await call(url, '/v1/validate')).status).toBe(405);

		held.abandon();
	});
});

describe('the request timeout', () => {
	// A valid string of about 9,000 characters: a few milliseconds each for the parser, no issues, a small
	// answer. It is longer than the default limit on a string, so these daemons raise that limit.
	const LONG_STRINGS = { HED_LSP_MAX_STRING_CHARS: '16384' };
	const SLOW_STRING = Array.from({ length: 600 }, (_, i) => `Label/item${i}`).join(', ');
	const BATCH = { strings: Array.from({ length: 100 }, () => SLOW_STRING) };

	it('answers 503 TIMEOUT with Retry-After 1, then stops the work between items and frees the slot', async () => {
		// How long the whole batch takes on this machine when nothing interrupts it.
		const baseline = await start({ ...LONG_STRINGS, HED_LSP_MAX_IN_FLIGHT: '1', HED_LSP_MAX_BODY_BYTES: '2000000' });
		const fullStart = Date.now();
		expect((await postJson(baseline.url, '/v1/validate', BATCH)).status).toBe(200);
		const fullMs = Date.now() - fullStart;
		// The timeout is a fraction of that time, so the batch is cut off at the same point on a slow machine
		// and a fast one. The floor leaves room for the request to arrive before its timer runs out.
		const timeoutMs = Math.max(20, Math.floor(fullMs / 4));
		expect(fullMs, 'the batch must outlast the timeout, or there is nothing to cut off').toBeGreaterThan(2 * timeoutMs);

		const daemon = await start({
			...SHORT_HEADERS,
			...LONG_STRINGS,
			HED_LSP_REQUEST_TIMEOUT_MS: String(timeoutMs),
			HED_LSP_MAX_IN_FLIGHT: '1',
			HED_LSP_MAX_BODY_BYTES: '2000000',
		});
		const startedAt = Date.now();

		const reply = await postJson(daemon.url, '/v1/validate', BATCH);

		expect(reply.status).toBe(503);
		expect(reply.json.error.code).toBe('TIMEOUT');
		expect(reply.json.requestId).toBe(reply.headers['x-request-id']);
		expect(reply.headers['retry-after']).toBe('1');
		expect(reply.headers.connection).toBe('close');
		expect(reply.headers['access-control-allow-origin']).toBe('*');
		// The slot is held until the work has stopped, which is after the item in progress, not after all 100.
		await waitFor(async () => (await call(daemon.url, '/v1/schemas')).status === 200, 5000, 'the slot to be free');
		expect(Date.now() - startedAt).toBeLessThan(fullMs / 2);
		const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.status === 503);
		expect(line).toMatchObject({ error: 'TIMEOUT', items: 100 });
	});

	it('answers a request that times out while its body is still arriving, and frees the slot', async () => {
		const { url } = await start({ ...SHORT_HEADERS, HED_LSP_REQUEST_TIMEOUT_MS: '300', HED_LSP_MAX_IN_FLIGHT: '1' });
		const startedAt = Date.now();
		const held = holdRequest(url, '/v1/validate', { length: 1000, first: '{"strings"' });

		const reply = await held.response;

		expect(reply.status).toBe(503);
		expect(reply.json.error.code).toBe('TIMEOUT');
		expect(reply.headers['retry-after']).toBe('1');
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
		expect(Date.now() - startedAt).toBeLessThan(3000);
		await waitFor(async () => (await call(url, '/v1/schemas')).status === 200, 5000, 'the slot to be free');
	});

	it('does not time out a request that finishes in time, and leaves nothing running afterward', async () => {
		const { url } = await start({ ...SHORT_HEADERS, HED_LSP_REQUEST_TIMEOUT_MS: '2000', HED_LSP_MAX_IN_FLIGHT: '1' });

		for (let i = 0; i < 3; i++) {
			expect((await postJson(url, '/v1/validate', strings(2))).status).toBe(200);
		}
		await sleep(50);

		expect((await call(url, '/v1/schemas')).status).toBe(200);
	});
});

describe('the body timeout', () => {
	/**
	 * A POST that declares `length` bytes and sends `parts` of them, `gapMs` apart, over a raw socket.
	 * Resolves with everything the daemon sent and how long the connection lasted. The client ends the
	 * connection itself when a whole JSON answer has arrived and `stopOnAnswer` is set, and gives up
	 * after 10 seconds.
	 */
	function sendSlowly(
		daemon: RunningDaemon,
		length: number,
		parts: string[],
		gapMs: number,
		stopOnAnswer = false,
	): Promise<{ text: string; ms: number; closedByDaemon: boolean }> {
		return new Promise((resolve) => {
			const startedAt = Date.now();
			const socket = net.connect(Number(new URL(daemon.url).port), '127.0.0.1');
			let text = '';
			let closedByDaemon = true;
			const giveUp = setTimeout(() => {
				closedByDaemon = false;
				socket.destroy();
			}, 10_000);
			socket.on('data', (chunk) => {
				text += chunk.toString('latin1');
				if (stopOnAnswer && text.includes('\r\n\r\n') && text.endsWith('}')) {
					closedByDaemon = false;
					socket.destroy();
				}
			});
			socket.on('error', () => undefined);
			socket.on('close', () => {
				clearTimeout(giveUp);
				resolve({ text, ms: Date.now() - startedAt, closedByDaemon });
			});
			socket.on('connect', async () => {
				socket.write(
					`POST /v1/validate HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`,
				);
				for (const part of parts) {
					await sleep(gapMs);
					if (socket.destroyed) {
						return;
					}
					socket.write(part);
				}
			});
		});
	}

	it('answers 408 and closes the connection when the body is still incomplete, and frees the slot', async () => {
		const daemon = await start({ HED_LSP_BODY_TIMEOUT_MS: '300', HED_LSP_MAX_IN_FLIGHT: '1' });
		const startedAt = Date.now();
		const held = holdRequest(daemon.url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await waitFor(async () => (await call(daemon.url, '/v1/schemas')).status === 503, 5000, 'the slot to be taken');

		const reply = await held.response;

		expect(reply.status).toBe(408);
		expect(reply.json.error.code).toBe('REQUEST_TIMEOUT');
		expect(reply.json.requestId).toBe(reply.headers['x-request-id']);
		expect(reply.headers.connection).toBe('close');
		expect(reply.headers['access-control-allow-origin']).toBe('*');
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
		expect(Date.now() - startedAt).toBeLessThan(3000);
		await waitFor(async () => (await call(daemon.url, '/v1/schemas')).status === 200, 5000, 'the slot to be free');
		const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.error === 'REQUEST_TIMEOUT');
		expect(line).toMatchObject({ method: 'POST', path: '/v1/validate', status: 408 });
	});

	it('counts from the headers, so a body that drips in a byte at a time still times out on schedule', async () => {
		const daemon = await start({ HED_LSP_BODY_TIMEOUT_MS: '400' });

		const result = await sendSlowly(
			daemon,
			1000,
			Array.from({ length: 40 }, () => 'a'),
			50,
		);

		expect(result.text.split('\r\n')[0]).toBe('HTTP/1.1 408 Request Timeout');
		expect(result.text).toContain('REQUEST_TIMEOUT');
		expect(result.closedByDaemon).toBe(true);
		// The last piece would have gone out after 2 seconds; the daemon gave up at 400 ms.
		expect(result.ms).toBeGreaterThanOrEqual(350);
		expect(result.ms).toBeLessThan(1800);
	});

	it('leaves a body that arrives in time alone, and keeps the connection', async () => {
		const daemon = await start({ HED_LSP_BODY_TIMEOUT_MS: '2000' });
		const body = JSON.stringify({ strings: [VALID] });

		const result = await sendSlowly(daemon, body.length, [body.slice(0, 5), body.slice(5)], 100, true);

		expect(result.text.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
		// The connection stayed open: the client was the one to end it, after the answer.
		expect(result.closedByDaemon).toBe(false);
		expect(result.text).not.toContain('Connection: close');
	});
});

describe('the Node server settings', () => {
	it('sets the headers, request, and keep-alive timeouts and the connection cap from the configuration', async () => {
		const { daemon, config } = await start({
			HED_LSP_HEADERS_TIMEOUT_MS: '1500',
			HED_LSP_REQUEST_TIMEOUT_MS: '2500',
			HED_LSP_KEEPALIVE_TIMEOUT_MS: '3500',
			HED_LSP_MAX_CONNECTIONS: '7',
		});

		expect(daemon.server.headersTimeout).toBe(1500);
		// Node's own timer sits 5 s past the daemon's, so it never answers first.
		expect(daemon.server.requestTimeout).toBe(config.requestTimeoutMs + 5000);
		expect(daemon.server.requestTimeout).toBe(7500);
		expect(daemon.server.keepAliveTimeout).toBe(3500);
		// The socket timeout, which ends a connection that moves no bytes, such as a client that stops reading.
		expect(daemon.server.timeout).toBe(config.requestTimeoutMs + 5000);
		expect(daemon.server.maxConnections).toBe(7);
	});

	it('closes a connection whose headers do not arrive within HEADERS_TIMEOUT_MS', async () => {
		const { daemon } = await start({ HED_LSP_HEADERS_TIMEOUT_MS: '300' });
		const { port } = daemon.server.address() as net.AddressInfo;

		const closedAfter = await new Promise<number>((resolve, reject) => {
			const startedAt = Date.now();
			const socket = net.connect(port, '127.0.0.1', () => {
				socket.write('POST /v1/validate HTTP/1.1\r\nHost: localhost\r\n');
			});
			socket.on('close', () => resolve(Date.now() - startedAt));
			socket.on('error', () => undefined);
			socket.setTimeout(5000, () => {
				socket.destroy();
				reject(new Error('the slow-header connection was still open after 5 s'));
			});
			socket.resume();
		});

		expect(closedAfter).toBeGreaterThanOrEqual(250);
		expect(closedAfter).toBeLessThan(3000);
	});

	it('closes an idle keep-alive connection after KEEPALIVE_TIMEOUT_MS', async () => {
		const { daemon } = await start({ HED_LSP_KEEPALIVE_TIMEOUT_MS: '200' });
		const { port } = daemon.server.address() as net.AddressInfo;

		const idleFor = await new Promise<number>((resolve, reject) => {
			const socket = net.connect(port, '127.0.0.1', () => {
				socket.write('GET /v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n');
			});
			let answeredAt = 0;
			socket.on('data', () => {
				answeredAt ||= Date.now();
			});
			socket.on('close', () => resolve(Date.now() - answeredAt));
			socket.on('error', () => undefined);
			socket.setTimeout(8000, () => {
				socket.destroy();
				reject(new Error('the idle connection was still open after 8 s'));
			});
		});

		expect(idleFor).toBeGreaterThanOrEqual(150);
		expect(idleFor).toBeLessThan(6000);
	});

	it('drops a connection past MAX_CONNECTIONS, and accepts one again when a slot frees', async () => {
		const { daemon, url } = await start({ HED_LSP_MAX_CONNECTIONS: '2' });
		const { port } = daemon.server.address() as net.AddressInfo;
		const open = (): Promise<net.Socket> =>
			new Promise((resolve, reject) => {
				const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
				socket.on('error', reject);
			});
		const first = await open();
		const second = await open();
		const third = await open();

		const dropped = await new Promise<boolean>((resolve) => {
			third.on('close', () => resolve(true));
			third.on('error', () => undefined);
			setTimeout(() => resolve(false), 2000);
		});
		expect(dropped).toBe(true);
		expect(first.destroyed).toBe(false);
		expect(second.destroyed).toBe(false);

		first.destroy();
		await waitFor(
			async () => {
				try {
					return (await call(url, '/v1/health')).status === 200;
				} catch {
					return false;
				}
			},
			5000,
			'a connection to be accepted again',
		);
		second.destroy();
	});
});

describe('close', () => {
	it('waits the grace for a request that is still running, then stops it and closes its connection', async () => {
		const daemon = await startDaemon();
		const held = holdRequest(daemon.url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await sleep(150);

		const startedAt = Date.now();
		await daemon.daemon.close(300);
		const took = Date.now() - startedAt;

		expect(took).toBeGreaterThanOrEqual(250);
		expect(took).toBeLessThan(3000);
		await expect(held.response).rejects.toThrow();
	});

	it('closes at once when nothing is running', async () => {
		const daemon = await startDaemon();
		expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: BUNDLED })).status).toBe(200);

		const startedAt = Date.now();
		await daemon.daemon.close(5000);

		expect(Date.now() - startedAt).toBeLessThan(1000);
	});
});
