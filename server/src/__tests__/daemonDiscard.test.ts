/**
 * Tests for the bounded discard of a request body that nobody reads. Every answer that is decided
 * before the body is read (an unsupported media type, an unknown path, a wrong method, a preflight,
 * a rate limit, a daemon that is busy or starting, a body over the limit) leaves the body on the
 * wire. The daemon reads and drops up to four times MAX_BODY_BYTES of it, counted from the start of
 * the body, and cuts the connection past that. Each case sends a body far larger than the bound over
 * a raw socket and checks that the daemon cuts the connection, logs it once, and still answers the
 * next request. Real daemon, real engine, real sockets. No mocks.
 */

import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { call, holdRequest, postJson, type RunningDaemon, sleep, startDaemon, waitFor } from './daemonHarness.js';

const VALID = 'Sensory-event, Visual-presentation';

/** The body limit of these daemons, so the discard bound is 4000 bytes. */
const LIMIT = '1000';

/** Far more than the bound, and more than the kernel buffers of a loopback connection can hold. */
const TOTAL = 8 * 1024 * 1024;

const running: RunningDaemon[] = [];

async function start(...args: Parameters<typeof startDaemon>): Promise<RunningDaemon> {
	const daemon = await startDaemon(...args);
	running.push(daemon);
	return daemon;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.stop()));
});

interface Flood {
	/** Bytes of the body written before the connection ended. */
	sent: number;
	/** Whether the daemon ended the connection, rather than the test giving up. */
	cutByDaemon: boolean;
}

/**
 * Send `head`, then a body of `total` bytes in pieces that honor back pressure, until the connection
 * ends or the whole body is sent. A connection still open after the whole body is the test giving up.
 */
function flood(port: number, head: string, chunked: boolean, total = TOTAL): Promise<Flood> {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1');
		const piece = Buffer.alloc(64 * 1024, 0x61);
		let sent = 0;
		let gaveUp = false;
		const giveUp = (): void => {
			gaveUp = true;
			socket.destroy();
		};
		const timer = setTimeout(giveUp, 15_000);
		socket.on('error', () => undefined);
		socket.on('data', () => undefined);
		socket.on('close', () => {
			clearTimeout(timer);
			resolve({ sent, cutByDaemon: !gaveUp });
		});
		const pump = (): void => {
			while (sent < total && !socket.destroyed) {
				const size = Math.min(piece.length, total - sent);
				sent += size;
				if (chunked) {
					socket.write(`${size.toString(16)}\r\n`);
				}
				const wrote = socket.write(size === piece.length ? piece : piece.subarray(0, size));
				if (chunked) {
					socket.write('\r\n');
				}
				if (!wrote) {
					socket.once('drain', pump);
					return;
				}
			}
			if (!socket.destroyed) {
				// The whole body went through without a cut: give the daemon a moment, then stop waiting.
				setTimeout(giveUp, 300);
			}
		};
		socket.on('connect', () => {
			socket.write(head);
			pump();
		});
	});
}

/** The request line and headers of a request that promises `TOTAL` bytes of body, or sends it chunked. */
function head(method: string, path: string, headers: Record<string, string> = {}, chunked = false): string {
	const lines = [
		`${method} ${path} HTTP/1.1`,
		'Host: localhost',
		...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
	];
	const framing = chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${TOTAL}`;
	return `${lines.join('\r\n')}\r\n${framing}\r\n\r\n`;
}

const JSON_TYPE = { 'Content-Type': 'application/json' };

function portOf(daemon: RunningDaemon): number {
	return Number(new URL(daemon.url).port);
}

interface Refusal {
	label: string;
	/** What the daemon is configured with, and how it starts. */
	overrides?: Record<string, string>;
	options?: Parameters<typeof startDaemon>[1];
	/** Bring the daemon into the state the refusal needs; returns what to do afterward. */
	prepare?: (daemon: RunningDaemon) => Promise<() => Promise<void>>;
	request: string;
	/** Whether the body of the request is sent chunked, as the request line promises. */
	chunked?: boolean;
	/** The error code the request log line carries, when the request is an error. */
	code?: string;
}

const REFUSALS: Refusal[] = [
	{
		label: 'a body over the limit (413)',
		request: head('POST', '/v1/validate', JSON_TYPE),
		code: 'PAYLOAD_TOO_LARGE',
	},
	{
		label: 'an unsupported media type (415)',
		request: head('POST', '/v1/validate', { 'Content-Type': 'text/plain' }),
		code: 'UNSUPPORTED_MEDIA_TYPE',
	},
	{
		label: 'a body of unknown length (411)',
		request: head('POST', '/v1/validate', JSON_TYPE, true),
		chunked: true,
		code: 'LENGTH_REQUIRED',
	},
	{ label: 'an unknown path (404)', request: head('POST', '/v1/nothing', JSON_TYPE), code: 'NOT_FOUND' },
	{
		label: 'a wrong method (405)',
		request: head('POST', '/v1/schemas', JSON_TYPE),
		code: 'METHOD_NOT_ALLOWED',
	},
	{ label: 'a preflight (204)', request: head('OPTIONS', '/v1/validate', JSON_TYPE) },
	{ label: 'a health request that is answered (200)', request: head('GET', '/v1/health') },
	{
		label: 'a client over its rate (429)',
		overrides: { HED_LSP_RATE_ITEMS_PER_SEC: '0.001', HED_LSP_RATE_ITEMS_BURST: '1' },
		prepare: async (daemon) => {
			// The one unit of the bucket goes to a schemas request; the flood finds it empty.
			expect((await call(daemon.url, '/v1/schemas')).status).toBe(200);
			return async () => undefined;
		},
		request: head('POST', '/v1/validate', JSON_TYPE),
		code: 'RATE_LIMITED',
	},
	{
		// A client over its limit of pending bodies is refused before its body is read. A client over a limit of
		// requests in flight is refused after, because the body is read before the slot is taken.
		label: 'a client at its limit of pending bodies (OVERLOADED)',
		overrides: { HED_LSP_MAX_PENDING_BODIES_PER_CLIENT: '1' },
		prepare: async (daemon) => {
			const held = holdRequest(daemon.url, '/v1/validate', { length: 1000, first: '{"strings"' });
			// The pause comes first: a probe that arrived before the held body could take its slot instead.
			await sleep(100);
			await waitFor(
				async () => (await postJson(daemon.url, '/v1/validate', { strings: [VALID] })).status === 503,
				5000,
				'the pending-body slot to be taken',
			);
			return async () => held.abandon();
		},
		request: head('POST', '/v1/validate', JSON_TYPE),
		code: 'OVERLOADED',
	},
	{
		label: 'a daemon that is still starting (STARTING)',
		options: { autoPreload: false },
		request: head('POST', '/v1/validate', JSON_TYPE),
		code: 'STARTING',
	},
];

describe('a request body that is refused without being read', () => {
	it.each(REFUSALS)(
		'cuts the connection past the bound for $label, and answers the next request',
		async (refusal) => {
			const daemon = await start({ HED_LSP_MAX_BODY_BYTES: LIMIT, ...refusal.overrides }, refusal.options);
			const after = await refusal.prepare?.(daemon);

			const result = await flood(portOf(daemon), refusal.request, refusal.chunked ?? false);

			expect(result.cutByDaemon, 'the daemon ended the connection').toBe(true);
			expect(result.sent).toBeLessThan(TOTAL);
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('kept arriving')),
				5000,
				'the cut-off to be logged',
			);
			expect(daemon.rawLines.filter((line) => line.includes('kept arriving'))).toHaveLength(1);
			if (refusal.code) {
				const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.error === refusal.code);
				expect(line, refusal.code).toBeDefined();
			}
			await after?.();
			if (refusal.options?.autoPreload === false) {
				await daemon.daemon.preload();
			}
			await waitFor(async () => (await call(daemon.url, '/v1/health')).status === 200, 5000, 'health to answer');
			if (refusal.overrides?.HED_LSP_RATE_ITEMS_BURST === undefined) {
				expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID] })).status).toBe(200);
			}
		},
		30_000,
	);

	it('does not cut a client whose body stays within the bound, and reuses the connection', async () => {
		const daemon = await start({ HED_LSP_MAX_BODY_BYTES: LIMIT });
		const socketBody = 3500;
		const result = await new Promise<{ status: string; next: string }>((resolve, reject) => {
			const socket = net.connect(portOf(daemon), '127.0.0.1');
			let received = '';
			socket.on('data', (chunk) => {
				received += chunk.toString('latin1');
				if ((received.match(/HTTP\/1\.1 /g) ?? []).length === 2 && received.endsWith('}')) {
					socket.destroy();
					const [first, second] = received.split(/(?=HTTP\/1\.1 )/);
					resolve({ status: first.split('\r\n')[0], next: second.split('\r\n')[0] });
				}
			});
			socket.on('error', reject);
			socket.on('connect', () => {
				socket.write(
					`POST /v1/nothing HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${socketBody}\r\n\r\n`,
				);
				socket.write(Buffer.alloc(socketBody, 0x61));
				socket.write('GET /v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n');
			});
		});

		expect(result.status).toBe('HTTP/1.1 404 Not Found');
		expect(result.next).toBe('HTTP/1.1 200 OK');
		expect(daemon.rawLines.some((line) => line.includes('kept arriving'))).toBe(false);
	});
});
