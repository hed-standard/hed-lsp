/**
 * Tests for the daemon's HTTP framework and the health and schemas endpoints: a real server on a
 * real socket (port 0) with the real engine and the bundled schemas, so they run offline. The
 * starting state is held open by creating the daemon with `autoPreload: false` and starting the
 * real preload later, which controls when startup happens and fakes nothing. The generic 500 is
 * checked on the function that maps an unexpected error to its reply, with a real Error. No mocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../daemon/log.js';
import { ApiError } from '../daemon/protocol.js';
import { failureReply } from '../daemon/server.js';
import { schemaManager } from '../engine/index.js';
import {
	BUNDLED,
	BUNDLED_WITH_LIBRARIES,
	call,
	holdRequest,
	type RunningDaemon,
	sleep,
	startDaemon,
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

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'Content-Type',
	'access-control-expose-headers': 'Retry-After, X-Request-Id',
};

describe('GET /v1/health', () => {
	it('reports ok with the version, commit, schemas, semantic state, and uptime', async () => {
		const { url } = await start({ HED_LSP_COMMIT: 'abc1234' });

		const reply = await call(url, '/v1/health');

		expect(reply.status).toBe(200);
		expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
		expect(reply.json).toEqual({
			apiVersion: '1.0',
			status: 'ok',
			version: expect.stringMatching(/^\d+\.\d+\.\d+/),
			commit: 'abc1234',
			schemas: { default: BUNDLED, degraded: [] },
			semantic: { state: 'disabled', failures: 0, index: '8.5.0,sc:score_2.1.0,la:lang_1.1.0' },
			uptimeSeconds: expect.any(Number),
		});
	});

	it('counts the uptime in whole seconds from the start of the daemon', async () => {
		const { url } = await start();
		const early = (await call(url, '/v1/health')).json.uptimeSeconds;
		await sleep(1100);
		const later = (await call(url, '/v1/health')).json.uptimeSeconds;

		expect(Number.isInteger(early)).toBe(true);
		expect(early).toBeGreaterThanOrEqual(0);
		expect(early).toBeLessThan(3);
		expect(later).toBeGreaterThanOrEqual(early + 1);
		expect(later).toBeLessThan(early + 4);
	});

	it('reports a commit of unknown when none is configured', async () => {
		const { url } = await start();

		expect((await call(url, '/v1/health')).json.commit).toBe('unknown');
	});

	it('answers 503 starting, with Retry-After, until the default schema has loaded', async () => {
		const daemon = await start({}, { autoPreload: false });

		const starting = await call(daemon.url, '/v1/health');
		expect(starting.status).toBe(503);
		expect(starting.headers['retry-after']).toBe('1');
		expect(starting.json.status).toBe('starting');

		const gated = await call(daemon.url, '/v1/schemas');
		expect(gated.status).toBe(503);
		expect(gated.headers['retry-after']).toBe('1');
		expect(gated.json.error.code).toBe('STARTING');
		expect(gated.json.requestId).toBe(gated.headers['x-request-id']);

		await daemon.daemon.preload();
		await daemon.daemon.ready;

		expect((await call(daemon.url, '/v1/health')).json.status).toBe('ok');
		expect((await call(daemon.url, '/v1/schemas')).status).toBe(200);
	});

	it('still answers a 404 and a 405 while starting', async () => {
		const daemon = await start({}, { autoPreload: false });

		expect((await call(daemon.url, '/nope')).status).toBe(404);
		expect((await call(daemon.url, '/v1/schemas', { method: 'POST' })).status).toBe(405);

		await daemon.daemon.preload();
	});

	it('stays starting until preload is called, and preload can be called again once loaded', async () => {
		const daemon = await start({}, { autoPreload: false });
		const readyBefore = await Promise.race([
			daemon.daemon.ready.then(() => 'ready'),
			new Promise((resolve) => setTimeout(() => resolve('waiting'), 100)),
		]);

		expect(readyBefore).toBe('waiting');
		expect((await call(daemon.url, '/v1/health')).status).toBe(503);

		await daemon.daemon.preload();
		await daemon.daemon.preload();

		expect(
			(await call(daemon.url, '/v1/schemas')).json.schemas.map((entry: { status: string }) => entry.status),
		).toEqual(['loaded', 'loaded']);
	});
});

describe('GET /v1/schemas', () => {
	it('lists the allowlist in order with the load status and the version used', async () => {
		const { url } = await start();

		const reply = await call(url, '/v1/schemas');

		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			apiVersion: '1.0',
			default: BUNDLED,
			schemas: [
				{ spec: BUNDLED, status: 'loaded', used: BUNDLED },
				{ spec: BUNDLED_WITH_LIBRARIES, status: 'loaded', used: BUNDLED_WITH_LIBRARIES },
			],
		});
	});

	it('lists each configured entry trimmed and comma-joined, in configured order', async () => {
		const { url } = await start({
			HED_LSP_SCHEMAS: ` ${BUNDLED}; sc:score_2.1.0 , 8.4.0 `,
		});

		const reply = await call(url, '/v1/schemas');

		expect(reply.json.schemas.map((entry: { spec: string }) => entry.spec)).toEqual([BUNDLED, 'sc:score_2.1.0,8.4.0']);
	});
});

describe('routing', () => {
	it('answers 404 NOT_FOUND for an unknown path, a trailing slash, and the root', async () => {
		const { url } = await start();

		for (const path of ['/', '/v1', '/v1/health/', '/v2/health', '/v1/Health', '/hed-lsp/v1/health']) {
			const reply = await call(url, path);

			expect(reply.status, path).toBe(404);
			expect(reply.json.error.code, path).toBe('NOT_FOUND');
		}
	});

	it('ignores the query string when routing', async () => {
		const { url } = await start();

		expect((await call(url, '/v1/health?x=1')).status).toBe(200);
	});

	it.each([
		['/v1/health', 'POST', 'GET, HEAD, OPTIONS'],
		['/v1/health', 'PUT', 'GET, HEAD, OPTIONS'],
		['/v1/health', 'DELETE', 'GET, HEAD, OPTIONS'],
		['/v1/schemas', 'POST', 'GET, HEAD, OPTIONS'],
		['/v1/validate', 'HEAD', 'POST, OPTIONS'],
		['/v1/suggest', 'HEAD', 'POST, OPTIONS'],
		['/v1/validate', 'GET', 'POST, OPTIONS'],
	])('answers 405 with Allow for %s %s', async (path, method, allow) => {
		const { url } = await start();

		const reply = await call(url, path, { method });

		expect(reply.status).toBe(405);
		expect(reply.headers.allow).toBe(allow);
		if (method === 'HEAD') {
			expect(reply.text).toBe('');
		} else {
			expect(reply.json.error.code).toBe('METHOD_NOT_ALLOWED');
		}
	});

	it('answers an OPTIONS preflight with 204, Allow, and the CORS headers', async () => {
		const { url } = await start();

		const reply = await call(url, '/v1/health', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://example.org',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type',
			},
		});

		expect(reply.status).toBe(204);
		expect(reply.text).toBe('');
		expect(reply.headers.allow).toBe('GET, HEAD, OPTIONS');
		expect(reply.headers).toMatchObject(CORS);
	});

	it('lets a browser keep a preflight answer for 10 minutes, and only a preflight answer', async () => {
		const { url } = await start();

		const known = await call(url, '/v1/validate', { method: 'OPTIONS' });
		const health = await call(url, '/v1/health', { method: 'OPTIONS' });
		const others = [
			await call(url, '/v1/health'),
			await call(url, '/v1/schemas'),
			await call(url, '/missing', { method: 'OPTIONS' }),
			await call(url, '/v1/validate'),
		];

		expect(known.headers['access-control-max-age']).toBe('600');
		expect(health.headers['access-control-max-age']).toBe('600');
		for (const reply of others) {
			expect(reply.headers['access-control-max-age']).toBeUndefined();
		}
	});

	it('sets the CORS headers on every kind of response', async () => {
		const { url } = await start();
		const replies = [
			await call(url, '/v1/health'),
			await call(url, '/v1/schemas'),
			await call(url, '/missing'),
			await call(url, '/v1/health', { method: 'POST' }),
			await call(url, '/v1/health', { method: 'OPTIONS' }),
		];

		expect(replies.map((reply) => reply.status)).toEqual([200, 200, 404, 405, 204]);
		for (const reply of replies) {
			expect(reply.headers).toMatchObject(CORS);
			expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
		}
	});

	it('sets the CORS headers on a 503 while starting', async () => {
		const daemon = await start({}, { autoPreload: false });

		const reply = await call(daemon.url, '/v1/schemas');

		expect(reply.status).toBe(503);
		expect(reply.headers).toMatchObject(CORS);

		await daemon.daemon.preload();
	});
});

describe('HEAD', () => {
	it('answers HEAD on a GET route with the headers of the GET and no body', async () => {
		const { url } = await start();

		const get = await call(url, '/v1/schemas');
		const head = await call(url, '/v1/schemas', { method: 'HEAD' });

		expect(head.status).toBe(200);
		expect(head.text).toBe('');
		expect(head.headers['content-type']).toBe(get.headers['content-type']);
		expect(head.headers['content-length']).toBe(get.headers['content-length']);
		expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(get.text));
		expect(head.headers['cache-control']).toBe('no-store');
		expect(head.headers).toMatchObject(CORS);
		expect(head.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('answers HEAD on health with its status, and 503 while starting, as the GET does', async () => {
		const daemon = await start({}, { autoPreload: false });

		const starting = await call(daemon.url, '/v1/health', { method: 'HEAD' });
		await daemon.daemon.preload();
		const ready = await call(daemon.url, '/v1/health', { method: 'HEAD' });
		const get = await call(daemon.url, '/v1/health');

		expect(starting.status).toBe(503);
		expect(starting.headers['retry-after']).toBe('1');
		expect(starting.text).toBe('');
		expect(ready.status).toBe(200);
		expect(ready.text).toBe('');
		// The uptime may have gained a digit between the two requests.
		expect(
			Math.abs(Number(ready.headers['content-length']) - Number(get.headers['content-length'])),
		).toBeLessThanOrEqual(1);
	});

	it('answers HEAD with no body for an error too, and logs the method', async () => {
		const daemon = await start();

		const missing = await call(daemon.url, '/missing', { method: 'HEAD' });

		expect(missing.status).toBe(404);
		expect(missing.text).toBe('');
		expect(Number(missing.headers['content-length'])).toBeGreaterThan(0);
		const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.method === 'HEAD');
		expect(line).toMatchObject({ method: 'HEAD', path: 'unknown route', status: 404 });
	});

	it('exempts HEAD on health from the limits like GET, and charges HEAD on schemas like GET', async () => {
		const daemon = await start({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '2' });

		const health = [];
		for (let i = 0; i < 5; i++) {
			health.push((await call(daemon.url, '/v1/health', { method: 'HEAD' })).status);
		}
		const schemas = [];
		for (let i = 0; i < 3; i++) {
			schemas.push((await call(daemon.url, '/v1/schemas', { method: 'HEAD' })).status);
		}

		expect(health).toEqual([200, 200, 200, 200, 200]);
		expect(schemas).toEqual([200, 200, 429]);
	});
});

describe('request IDs', () => {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

	it('gives every response a fresh X-Request-Id', async () => {
		const { url } = await start();
		const replies = [await call(url, '/v1/health'), await call(url, '/v1/health'), await call(url, '/missing')];

		const ids = replies.map((reply) => reply.headers['x-request-id']);
		expect(ids.every((id) => typeof id === 'string' && uuid.test(id))).toBe(true);
		expect(new Set(ids).size).toBe(3);
	});

	it('repeats the ID in the body of an error', async () => {
		const { url } = await start();

		const reply = await call(url, '/missing');

		expect(reply.json).toEqual({
			apiVersion: '1.0',
			error: { code: 'NOT_FOUND', message: expect.any(String) },
			requestId: reply.headers['x-request-id'],
		});
	});

	it('ignores an X-Request-Id sent by the client', async () => {
		const { url } = await start();

		const reply = await call(url, '/missing', { headers: { 'X-Request-Id': 'attacker-chosen' } });

		expect(reply.headers['x-request-id']).not.toBe('attacker-chosen');
		expect(reply.headers['x-request-id']).toMatch(uuid);
		expect(reply.json.requestId).toBe(reply.headers['x-request-id']);
	});
});

describe('server errors', () => {
	// No real request reaches the generic 500, so the function that maps a failure to its reply is
	// tested directly, with real errors whose messages hold a marker.
	function replyFor(error: unknown): { reply: ReturnType<typeof failureReply>; lines: string[] } {
		const lines: string[] = [];
		return {
			reply: failureReply(
				error,
				'req-1',
				createLogger((line) => lines.push(line)),
			),
			lines,
		};
	}

	it('maps an unexpected error to a generic 500 and keeps its text out of the reply and the log', () => {
		const marker = 'SECRET-exception-text-7f3a';

		const { reply, lines } = replyFor(new Error(marker));

		expect(reply.status).toBe(500);
		expect(reply.code).toBe('INTERNAL_ERROR');
		expect(reply.body).toEqual({
			apiVersion: '1.0',
			error: { code: 'INTERNAL_ERROR', message: 'internal error' },
			requestId: 'req-1',
		});
		expect(reply.headers).toEqual({});
		expect(JSON.stringify(reply)).not.toContain(marker);
		expect(lines).toHaveLength(1);
		expect(lines.join('\n')).not.toContain(marker);
		const logged = JSON.parse(lines[0]);
		expect(logged).toMatchObject({ level: 'error', msg: 'request failed', requestId: 'req-1', errorType: 'Error' });
		expect(Array.isArray(logged.frames)).toBe(true);
		expect(logged.frames.every((frame: string) => frame.startsWith('at '))).toBe(true);
	});

	it('treats a thrown value that is not an Error the same way', () => {
		const marker = 'SECRET-thrown-string-2b9d';

		for (const value of [marker, { message: marker }, 42, null, undefined]) {
			const { reply, lines } = replyFor(value);

			expect(reply.status).toBe(500);
			expect(JSON.stringify(reply)).not.toContain(marker);
			expect(lines.join('\n')).not.toContain(marker);
		}
	});

	it('passes an ApiError through with its status, details, and headers, and logs nothing', () => {
		const limited = replyFor(new ApiError('RATE_LIMITED', 'slow down', { retryAfterSeconds: 7 }));
		const wrongMethod = replyFor(
			new ApiError('METHOD_NOT_ALLOWED', 'method not allowed', { allow: ['GET', 'OPTIONS'] }),
		);
		const unknown = replyFor(new ApiError('UNKNOWN_SCHEMA', 'no', { details: { allowed: ['8.4.0'] } }));

		expect(limited.reply).toMatchObject({ status: 429, code: 'RATE_LIMITED', headers: { 'Retry-After': '7' } });
		expect(wrongMethod.reply).toMatchObject({ status: 405, headers: { Allow: 'GET, OPTIONS' } });
		expect(unknown.reply.body.error.details).toEqual({ allowed: ['8.4.0'] });
		expect([limited.lines, wrongMethod.lines, unknown.lines]).toEqual([[], [], []]);
	});
});

describe('logging', () => {
	it('writes every line as a JSON object with time, level, and msg, engine lines included', async () => {
		// A cleared engine cache makes the preload log its schema loads through the engine sink.
		schemaManager.clearCache();
		const daemon = await start();
		await call(daemon.url, '/v1/health');
		await call(daemon.url, '/missing?secret=value');

		expect(daemon.rawLines.length).toBeGreaterThan(2);
		for (const line of daemon.logLines()) {
			expect(typeof line.time).toBe('string');
			expect(Number.isNaN(Date.parse(line.time as string))).toBe(false);
			expect(['info', 'warn', 'error']).toContain(line.level);
			expect(typeof line.msg).toBe('string');
		}
		expect(daemon.logLines().some((line) => String(line.msg).startsWith('[HED] Loading schema'))).toBe(true);
	});

	it('logs one request line with the planned fields and no query string, body, or address', async () => {
		const daemon = await start();
		const reply = await call(daemon.url, '/v1/health?secret=value');
		await call(daemon.url, '/missing?secret=value');

		const lines = daemon.logLines().filter((line) => line.msg === 'request');
		const health = lines.find((line) => line.path === '/v1/health');
		const missing = lines.find((line) => line.path === 'unknown route');

		expect(health).toMatchObject({
			level: 'info',
			requestId: reply.headers['x-request-id'],
			method: 'GET',
			path: '/v1/health',
			status: 200,
		});
		expect(typeof health?.ms).toBe('number');
		expect(missing).toMatchObject({ status: 404, error: 'NOT_FOUND' });
		const everything = daemon.rawLines.join('\n');
		expect(everything).not.toContain('secret');
		expect(everything).not.toContain('127.0.0.1');
		expect(everything).not.toContain('::1');
	});
});

describe('logging a path and an aborted request', () => {
	it('logs the label "unknown route" for a path that is not a route, and never the path itself', async () => {
		const daemon = await start();
		const marker = 'SECRET-path-4f2a';

		await call(daemon.url, `/${marker}/${'x'.repeat(300)}?q=${marker}`);
		await call(daemon.url, `/v1/${marker}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		await call(daemon.url, '/v1/schemas');

		const lines = daemon.logLines().filter((entry) => entry.msg === 'request');
		expect(lines.map((entry) => entry.path)).toEqual(['unknown route', 'unknown route', '/v1/schemas']);
		expect(lines.slice(0, 2).map((entry) => entry.status)).toEqual([404, 404]);
		expect(daemon.rawLines.join('\n')).not.toContain(marker);
	});

	it('logs a request that was cut off before its answer with aborted true and no status', async () => {
		const daemon = await start();
		const held = holdRequest(daemon.url, '/v1/validate', { length: 1000, first: '{"strings"' });
		await sleep(100);

		held.abandon();
		await waitFor(
			() => daemon.logLines().some((entry) => entry.msg === 'request' && entry.aborted === true),
			5000,
			'the aborted request to be logged',
		);

		const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.aborted === true);
		expect(line).toMatchObject({ method: 'POST', path: '/v1/validate', aborted: true });
		expect('status' in (line ?? {})).toBe(false);
		// A request that was answered carries its status and no aborted field.
		await call(daemon.url, '/v1/health');
		const answered = daemon.logLines().find((entry) => entry.msg === 'request' && entry.path === '/v1/health');
		expect(answered).toMatchObject({ status: 200 });
		expect('aborted' in (answered ?? {})).toBe(false);
	});
});

describe('close', () => {
	it('stops listening and finishes while a keep-alive client is idle', async () => {
		const daemon = await startDaemon();

		expect((await call(daemon.url, '/v1/health')).status).toBe(200);
		await daemon.stop();

		await expect(call(daemon.url, '/v1/health')).rejects.toThrow();
	});
});
