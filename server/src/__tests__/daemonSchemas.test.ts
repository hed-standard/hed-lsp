/**
 * Tests for the schema allowlist: normalization of a request's schema field, per-spec load status,
 * the load timeout, and the backoff. They run the real registry against the real engine and the
 * bundled schemas. A load that fails is a real one: `8.4.0,sc:score_9.9.9` does not exist, so the
 * load fails with a 404 when GitHub is reachable and with a network error when it is not. The clock
 * is a parameter. Only the 8.5.0 cases need the network-failure fixture, which the test policy
 * allows: 8.5.0 is fetched from GitHub, so a stalled or failed fetch is the only way to make it
 * time out or fall back. No mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../daemon/config.js';
import { ApiError } from '../daemon/protocol.js';
import {
	SCHEMA_BACKOFF_BASE_MS,
	SCHEMA_BACKOFF_MAX_MS,
	SchemaRegistry,
	type SchemaRegistryOptions,
	schemaBackoffMs,
} from '../daemon/schemas.js';
import { type LogSink, schemaManager, setLogger } from '../engine/index.js';
import {
	BUNDLED,
	BUNDLED_WITH_LIBRARIES,
	call,
	type RunningDaemon,
	startDaemon,
	waitFor,
	withNetworkFailure,
} from './daemonHarness.js';

/** A spec that does not exist, so loading it fails for real, whether or not the network is up. */
const MISSING = '8.4.0,sc:score_9.9.9';

function registry(env: Record<string, string> = {}, options: SchemaRegistryOptions = {}): SchemaRegistry {
	const config = loadConfig({
		HED_LSP_SCHEMAS: `${BUNDLED};${BUNDLED_WITH_LIBRARIES}`,
		HED_LSP_DEFAULT_SCHEMA: BUNDLED,
		...env,
	});
	return new SchemaRegistry(config, options);
}

function thrown(action: () => unknown): ApiError {
	try {
		action();
	} catch (error) {
		if (error instanceof ApiError) {
			return error;
		}
		throw error;
	}
	throw new Error('expected the call to throw an ApiError');
}

async function rejected(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) {
			return error;
		}
		throw error;
	}
	throw new Error('expected the promise to reject with an ApiError');
}

describe('schemaBackoffMs', () => {
	it('starts at 30 seconds, doubles, and stops at 10 minutes', () => {
		expect([1, 2, 3, 4, 5, 6, 7, 20].map(schemaBackoffMs)).toEqual([
			30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
		]);
		expect(SCHEMA_BACKOFF_BASE_MS).toBe(30_000);
		expect(SCHEMA_BACKOFF_MAX_MS).toBe(600_000);
	});
});

describe('SchemaRegistry.resolve', () => {
	const schemas = registry();

	it('maps a missing, null, or blank schema to the default', () => {
		for (const value of [undefined, null, '', '   ', ' , ', []]) {
			expect(schemas.resolve(value), JSON.stringify(value)).toBe(BUNDLED);
		}
	});

	it('maps reordered and array forms of a spec to the allowlisted spec', () => {
		const forms: unknown[] = [
			BUNDLED_WITH_LIBRARIES,
			' 8.4.0 , la:lang_1.1.0, sc:score_2.1.0 ',
			'la:lang_1.1.0,sc:score_2.1.0,8.4.0',
			['sc:score_2.1.0', 'la:lang_1.1.0', '8.4.0'],
			['8.4.0,sc:score_2.1.0', 'la:lang_1.1.0'],
		];
		for (const form of forms) {
			expect(schemas.resolve(form), JSON.stringify(form)).toBe(BUNDLED_WITH_LIBRARIES);
		}
		expect(schemas.resolve([BUNDLED])).toBe(BUNDLED);
	});

	it('refuses a spec outside the allowlist with the allowed list', () => {
		const outside = [
			'8.5.0',
			'8.4.0,sc:score_2.0.0',
			'8.4.0,sc:score_2.1.0',
			'SC:score_2.1.0,8.4.0,la:lang_1.1.0',
			'8.4',
		];
		for (const value of outside) {
			const error = thrown(() => schemas.resolve(value));

			expect(error.code, value).toBe('UNKNOWN_SCHEMA');
			expect(error.status).toBe(400);
			expect(error.options.details).toEqual({ allowed: [BUNDLED, BUNDLED_WITH_LIBRARIES] });
		}
	});

	it('refuses a spec that repeats a part', () => {
		expect(thrown(() => schemas.resolve('8.4.0,8.4.0')).code).toBe('UNKNOWN_SCHEMA');
	});

	it('refuses a value of the wrong type as a malformed request', () => {
		for (const value of [5, true, {}, [1], ['8.4.0', null]]) {
			expect(thrown(() => schemas.resolve(value)).code, JSON.stringify(value)).toBe('INVALID_REQUEST');
		}
	});

	it('does not let a prototype name pass as a spec', () => {
		for (const value of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
			expect(thrown(() => schemas.resolve(value)).code, value).toBe('UNKNOWN_SCHEMA');
		}
	});
});

describe('SchemaRegistry with the real engine', () => {
	it('preloads the allowlist and reports each spec as loaded with the version used', async () => {
		const schemas = registry();

		expect(schemas.defaultReady).toBe(false);
		expect(schemas.list().map((entry) => entry.status)).toEqual(['loading', 'loading']);

		await schemas.preload();

		expect(schemas.defaultReady).toBe(true);
		expect(schemas.list()).toEqual([
			{ spec: BUNDLED, status: 'loaded', used: BUNDLED },
			{ spec: BUNDLED_WITH_LIBRARIES, status: 'loaded', used: BUNDLED_WITH_LIBRARIES },
		]);
		expect(schemas.degraded()).toEqual([]);
		expect(await schemas.ensure(BUNDLED_WITH_LIBRARIES)).toBe(BUNDLED_WITH_LIBRARIES);
	});

	it('shares one load between concurrent callers', async () => {
		// A cleared engine cache makes the load visible in the engine's log, which is captured here.
		schemaManager.clearCache();
		const loads: string[] = [];
		const sink: LogSink = {
			info: () => {},
			error: (message) => message.startsWith('[HED] Loading') && loads.push(message),
		};
		const previous = setLogger(sink);
		try {
			const schemas = registry();

			const first = schemas.ensure(BUNDLED);
			const second = schemas.ensure(BUNDLED);
			const third = schemas.ensure(BUNDLED);

			expect(second).toBe(first);
			expect(third).toBe(first);
			expect(await Promise.all([first, second, third])).toEqual([BUNDLED, BUNDLED, BUNDLED]);
			expect(loads).toEqual([`[HED] Loading schema: ${BUNDLED}`]);
		} finally {
			setLogger(previous);
		}
	});

	it('settles the default as soon as the default spec has loaded', async () => {
		const schemas = registry();

		const settled = schemas.whenDefaultSettled();
		void schemas.ensure(BUNDLED);
		await settled;

		expect(schemas.defaultReady).toBe(true);
	});
});

describe('SchemaRegistry failures', () => {
	// The backoff is computed from this clock, so the test controls how much time has passed.
	let clock = 1_000_000;
	const now = (): number => clock;
	// The engine's own log, captured so each real load attempt can be counted and stderr stays quiet.
	let engineLines: string[] = [];
	let previousSink: LogSink;
	beforeEach(() => {
		clock = 1_000_000;
		schemaManager.clearCache();
		engineLines = [];
		previousSink = setLogger({ info: () => {}, error: (message) => engineLines.push(message) });
	});
	afterEach(() => {
		setLogger(previousSink);
	});

	/** A registry whose only spec, and default, is one that cannot load. */
	function failing(): SchemaRegistry {
		return registry({ HED_LSP_SCHEMAS: MISSING, HED_LSP_DEFAULT_SCHEMA: MISSING }, { now });
	}

	/** How many times the engine has tried to load `spec` so far. */
	function loadAttempts(spec: string): number {
		return engineLines.filter((line) => line === `[HED] Loading schema: ${spec}`).length;
	}

	it('refuses a failed spec during its backoff without loading again, then retries for real', async () => {
		const schemas = failing();

		const first = await rejected(schemas.ensure(MISSING));
		expect(first.code).toBe('SCHEMA_UNAVAILABLE');
		expect(first.status).toBe(503);
		expect(first.options.retryAfterSeconds).toBe(30);
		expect(schemas.list()[0]).toEqual({ spec: MISSING, status: 'failed', retryAfterSeconds: 30 });
		expect(schemas.degraded()).toEqual([MISSING]);
		expect(schemas.defaultReady).toBe(true);
		expect(loadAttempts(MISSING)).toBe(1);

		clock += 10_000;
		const during = await rejected(schemas.ensure(MISSING));
		expect(during.options.retryAfterSeconds).toBe(20);
		expect(schemas.list()[0].retryAfterSeconds).toBe(20);
		expect(loadAttempts(MISSING)).toBe(1);

		clock += 20_000;
		const again = await rejected(schemas.ensure(MISSING));
		expect(again.options.retryAfterSeconds).toBe(60);
		expect(loadAttempts(MISSING)).toBe(2);
		expect(schemas.list()[0]).toEqual({ spec: MISSING, status: 'failed', retryAfterSeconds: 60 });
	});

	it('doubles the backoff with each consecutive failure', async () => {
		const schemas = failing();

		const waits: (number | undefined)[] = [];
		for (let round = 0; round < 4; round++) {
			waits.push((await rejected(schemas.ensure(MISSING))).options.retryAfterSeconds);
			clock += 1_000_000;
		}

		expect(waits).toEqual([30, 60, 120, 240]);
		expect(loadAttempts(MISSING)).toBe(4);
	});

	it('times out a load that does not finish, and recovers when it finishes late', async () => {
		// 8.5.0 is fetched from GitHub, so a stalled fetch holds its load past the timer. When the
		// fetch finally fails, the engine falls back to the bundled 8.4.0 and the spec recovers.
		await withNetworkFailure(
			async (network) => {
				const schemas = registry(
					{ HED_LSP_SCHEMAS: '8.5.0', HED_LSP_DEFAULT_SCHEMA: '8.5.0', HED_LSP_SCHEMA_LOAD_TIMEOUT_MS: '40' },
					{ now },
				);

				const error = await rejected(schemas.ensure('8.5.0'));

				expect(error.code).toBe('SCHEMA_UNAVAILABLE');
				expect(schemas.list()[0].status).toBe('failed');
				expect(schemas.defaultReady).toBe(true);

				network.release();
				await waitFor(() => schemas.list()[0].status === 'loaded', 5000, 'the late load');
				expect(schemas.list()[0]).toEqual({ spec: '8.5.0', status: 'loaded', used: BUNDLED });
				expect(schemas.degraded()).toEqual(['8.5.0']);
			},
			{ stall: true },
		);
	});

	it('rejects an ensure for a spec outside the allowlist as a programming error', async () => {
		await expect(registry().ensure('9.9.9')).rejects.toThrow(/allowlist/);
	});
});

describe('a daemon with schemas that cannot load', () => {
	let daemon: RunningDaemon | undefined;

	beforeEach(() => {
		// The engine caches loads for the life of the process, so each case starts clean.
		schemaManager.clearCache();
	});

	afterEach(async () => {
		await daemon?.stop();
		daemon = undefined;
	});

	it('serves the bundled 8.4.0 for 8.5.0 when the network is down, labels it, and reports degraded', async () => {
		daemon = await startDaemon(
			{ HED_LSP_SCHEMAS: `8.5.0;${BUNDLED}`, HED_LSP_DEFAULT_SCHEMA: '8.5.0' },
			{ autoPreload: false },
		);
		const running = daemon;

		// The fixture covers the one preload and is gone before any request is made.
		await withNetworkFailure(() => running.daemon.preload());
		await running.daemon.ready;

		const schemas = await call(running.url, '/v1/schemas');
		const health = await call(running.url, '/v1/health');

		expect(schemas.json.default).toBe('8.5.0');
		expect(schemas.json.schemas).toEqual([
			{ spec: '8.5.0', status: 'loaded', used: BUNDLED },
			{ spec: BUNDLED, status: 'loaded', used: BUNDLED },
		]);
		expect(health.status).toBe(200);
		expect(health.json.status).toBe('degraded');
		expect(health.json.schemas).toEqual({ default: '8.5.0', degraded: ['8.5.0'] });
	});

	it('marks a spec that cannot load as failed, with a retry time, and reports degraded', async () => {
		daemon = await startDaemon({ HED_LSP_SCHEMAS: `${BUNDLED};${MISSING}`, HED_LSP_DEFAULT_SCHEMA: BUNDLED });
		const running = daemon;
		await waitFor(
			async () => (await call(running.url, '/v1/schemas')).json.schemas[1].status === 'failed',
			5000,
			'the spec to fail',
		);

		const schemas = await call(running.url, '/v1/schemas');
		const health = await call(running.url, '/v1/health');

		expect(schemas.json.schemas[0]).toEqual({ spec: BUNDLED, status: 'loaded', used: BUNDLED });
		expect(schemas.json.schemas[1]).toMatchObject({ spec: MISSING, status: 'failed' });
		expect(schemas.json.schemas[1].retryAfterSeconds).toBeGreaterThan(0);
		expect(schemas.json.schemas[1].retryAfterSeconds).toBeLessThanOrEqual(30);
		expect(health.status).toBe(200);
		expect(health.json.status).toBe('degraded');
		expect(health.json.schemas.degraded).toEqual([MISSING]);
	});

	it('is ready, and degraded, when the default itself cannot load', async () => {
		daemon = await startDaemon({ HED_LSP_SCHEMAS: MISSING, HED_LSP_DEFAULT_SCHEMA: MISSING });

		const health = await call(daemon.url, '/v1/health');

		expect(health.status).toBe(200);
		expect(health.json.status).toBe('degraded');
		expect((await call(daemon.url, '/v1/schemas')).status).toBe(200);
	});
});
