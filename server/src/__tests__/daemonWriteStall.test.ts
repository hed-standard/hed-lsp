/**
 * Tests for connections that move no bytes. Node's socket timeout is set to REQUEST_TIMEOUT_MS plus
 * 5 seconds, so a client that stops reading a response is cut off instead of holding its connection
 * until the operating system gives up, and an idle kept-alive connection still lives for
 * KEEPALIVE_TIMEOUT_MS, which replaces the socket timeout between two requests.
 *
 * Node does not fire the socket timeout while a write is in progress until a whole period has
 * passed without the write queue moving, so a stalled write is cut off after two to three periods
 * (measured: 2.0, 2.0, and 3.0 times the timeout on a plain Node server), not one. The cases below
 * allow for that. The timeouts are real, so each case takes many seconds; the cases run at the same
 * time, each with its own daemon. Real daemon, real engine, raw sockets. No mocks.
 */

import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { postJson, type RunningDaemon, startDaemon, waitFor } from './daemonHarness.js';

const VALID = 'Sensory-event, Visual-presentation';

function portOf(daemon: RunningDaemon): number {
	return Number(new URL(daemon.url).port);
}

/** Node refuses a headers timeout longer than the request timeout plus 5 s, so short timeouts shorten it too. */
const SHORT = { HED_LSP_HEADERS_TIMEOUT_MS: '1000' };

/** Limits raised so that one string of 4096 open parentheses is answered with about 17 MB of JSON. */
const HUGE_ANSWERS = {
	HED_LSP_MAX_ISSUES_PER_STRING: '5000',
	HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '10000',
	HED_LSP_MAX_ISSUE_TEXT_CHARS: '100000000',
};

describe('connections that move no bytes', () => {
	it.concurrent('closes the connection of a client that stops reading a large response, and serves the next client', async () => {
		// The socket timeout is 1 s + 5 s = 6 s.
		const daemon = await startDaemon({ ...SHORT, ...HUGE_ANSWERS, HED_LSP_REQUEST_TIMEOUT_MS: '1000' });
		const socketTimeout = daemon.daemon.server.timeout;
		expect(socketTimeout).toBe(6000);
		const body = JSON.stringify({ strings: ['('.repeat(4096)], schema: '8.4.0' });
		const socket = net.connect(portOf(daemon), '127.0.0.1');
		socket.on('error', () => undefined);
		const sentAt = await new Promise<number>((resolve) => {
			socket.on('connect', () => {
				// Reading stops here, so the answer, which is far larger than the buffers of the two
				// ends of a loopback connection, cannot be written out.
				socket.pause();
				socket.write(
					`POST /v1/validate HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
				);
				resolve(Date.now());
			});
		});

		try {
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('"aborted":true')),
				30_000,
				'the stalled connection to be closed',
			);
			const closedAfter = Date.now() - sentAt;
			const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.aborted === true);

			expect(closedAfter).toBeGreaterThanOrEqual(socketTimeout);
			expect(closedAfter).toBeLessThan(3.5 * socketTimeout);
			expect(line).toMatchObject({ method: 'POST', path: '/v1/validate', aborted: true });
			const next = await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: '8.4.0' });
			expect(next.status).toBe(200);
		} finally {
			socket.destroy();
			await daemon.stop();
		}
	}, 60_000);

	it.concurrent('keeps an idle kept-alive connection for KEEPALIVE_TIMEOUT_MS even though the socket timeout is shorter', async () => {
		// The socket timeout is 1 s + 5 s = 6 s; the keep-alive timeout is 8 s.
		const daemon = await startDaemon({
			...SHORT,
			HED_LSP_REQUEST_TIMEOUT_MS: '1000',
			HED_LSP_KEEPALIVE_TIMEOUT_MS: '8000',
		});
		expect(daemon.daemon.server.timeout).toBe(6000);
		const socket = net.connect(portOf(daemon), '127.0.0.1');
		socket.on('error', () => undefined);
		let answeredAt = 0;
		let closedAt = 0;
		socket.on('data', () => {
			answeredAt ||= Date.now();
		});
		socket.on('close', () => {
			closedAt = Date.now();
		});
		socket.on('connect', () => socket.write('GET /v1/health HTTP/1.1\r\nHost: localhost\r\n\r\n'));

		try {
			await waitFor(() => answeredAt > 0, 5000, 'the answer');
			// Wait until the socket timeout has passed, and check that the connection is still open.
			await new Promise((resolve) => setTimeout(resolve, 6600));
			const openAfterSocketTimeout = closedAt === 0;
			await waitFor(() => closedAt > 0, 12_000, 'the idle connection to be closed');

			expect(openAfterSocketTimeout).toBe(true);
			// Node closes a kept-alive connection a second after its keep-alive timeout.
			expect(closedAt - answeredAt).toBeGreaterThanOrEqual(7800);
			expect(closedAt - answeredAt).toBeLessThan(11_000);
		} finally {
			socket.destroy();
			await daemon.stop();
		}
	}, 60_000);
});
