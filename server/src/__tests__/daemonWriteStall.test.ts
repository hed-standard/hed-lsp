/**
 * Tests for connections that move no bytes. A response that is being written is bounded by
 * WRITE_STALL_MS: a client that sends a request and then stops reading loses its connection once the
 * write has made no progress for that long. Node's own socket timeout does not do this, because it
 * does not fire while a write is in progress until a whole period has passed without the write queue
 * moving, so a stalled write is cut off after two to three periods (measured: 2.0, 2.0, and 3.0 times
 * the timeout on a plain Node server, 70 to 105 seconds at the defaults). That timeout stays set,
 * at REQUEST_TIMEOUT_MS plus 5 seconds, as a backstop, and an idle kept-alive connection still lives
 * for KEEPALIVE_TIMEOUT_MS, which replaces the socket timeout between two requests. The timeouts are
 * real, so each case takes seconds; the cases run at the same time, each with its own daemon. Real
 * daemon, real engine, raw sockets. No mocks.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { call, postJson, type RunningDaemon, sleep, startDaemon, waitFor } from './daemonHarness.js';

const VALID = 'Sensory-event, Visual-presentation';

function portOf(daemon: RunningDaemon): number {
	return Number(new URL(daemon.url).port);
}

/** Node refuses a headers timeout longer than the request timeout plus 5 s, so short timeouts shorten it too. */
const SHORT = { HED_LSP_HEADERS_TIMEOUT_MS: '1000' };

/**
 * A validate request of 100 strings of 4096 open parentheses, the limit of strings and of characters,
 * about 410 KB and under the body limit. At the default limits it is answered with about 1.1 MB of
 * JSON, but the loopback buffers of the two ends took in at least 2.4 MB on the macOS host that this
 * was measured on, so such an answer is written out whole even when nobody reads it, and nothing
 * stalls. Raising the message text limit to 16 MB makes the answer about 11 MB, which no buffer holds.
 */
const LARGE_ANSWER = JSON.stringify({ strings: Array.from({ length: 100 }, () => '('.repeat(4096)), schema: '8.4.0' });
const LARGE_ANSWER_LIMITS = { HED_LSP_MAX_ISSUE_TEXT_CHARS: '16000000' };

/** How a client reads a response. By default it reads the first data that arrives, and no more. */
interface Reading {
	/** Read on, but pause for `pauseMs` after every `everyBytes` bytes: slow, and never idle for long. */
	paced?: { everyBytes: number; pauseMs: number };
}

/** A client that sends a validate request and then reads slowly or not at all. */
interface SlowClient {
	socket: net.Socket;
	/** When the first bytes of the response arrived, which is when the daemon began to write it. */
	firstDataAt(): number;
	/** The bytes of the response read so far. */
	received(): number;
	/** The total size of the response, headers included, from its Content-Length; zero until it is known. */
	expected(): number;
	/** The code of the first error of the socket, such as ECONNRESET for a reset, or undefined if there was none. */
	errorCode(): string | undefined;
	/**
	 * Start reading again without pauses, as a client that was only slow. What is left is read one byte
	 * at a time, so that a reset reaches the client as an error on Linux too: see `slowClient`.
	 */
	resume(): void;
	closed: Promise<void>;
}

/**
 * Why `resume()` reads one byte at a time. A reset does not drop the data that the client's kernel
 * already holds, so the client reads that first and meets the reset after it. On Linux, libuv reads
 * the queue in buffers of 64 KB; when the last read does not fill its buffer and the poll event carries
 * POLLHUP, which a reset sets, libuv ends the stream at once without another read(), and the
 * ECONNRESET stays unread in the kernel. The client then gets a plain 'end' with no error, as for a clean
 * close (seen with strace on Node 22, and the same on Node 20; the RST itself is on the wire in tcpdump).
 * macOS has no such shortcut. A buffer of one byte is full for as long as any data is left, so the read
 * after the last byte is made on an empty queue and fails with ECONNRESET on both systems, while a
 * connection that was closed with a FIN still ends with 'end'. The reset is thereby told from a clean
 * close by the error the client reads. What is left to drain is the receive buffer of one connection.
 */
function slowClient(daemon: RunningDaemon, body: string, reading: Reading = {}): SlowClient {
	let firstDataAt = 0;
	let received = 0;
	let expected = 0;
	let sinceBreak = 0;
	let errorCode: string | undefined;
	let draining = false;
	const bulk = Buffer.alloc(64 * 1024);
	const single = Buffer.alloc(1);
	const socket = net.connect({
		port: portOf(daemon),
		host: '127.0.0.1',
		onread: {
			buffer: () => (draining ? single : bulk),
			callback: (size, chunk) => {
				firstDataAt ||= Date.now();
				received += size;
				if (expected === 0) {
					const text = Buffer.from(chunk.buffer, chunk.byteOffset, size).toString('latin1');
					const length = /content-length: (\d+)/i.exec(text);
					const headEnd = text.indexOf('\r\n\r\n');
					if (length && headEnd !== -1) {
						expected = headEnd + 4 + Number(length[1]);
					}
				}
				if (draining) {
					return true;
				}
				if (reading.paced) {
					sinceBreak += size;
					if (sinceBreak >= reading.paced.everyBytes) {
						sinceBreak = 0;
						setTimeout(() => socket.resume(), reading.paced.pauseMs);
						return false;
					}
					return true;
				}
				// The default client reads the first data that arrives and no more.
				return false;
			},
		},
	});
	// An RST or an error ends the connection too, so one promise covers both.
	const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
	socket.on('error', (error: NodeJS.ErrnoException) => {
		errorCode ??= error.code;
	});
	socket.on('connect', () =>
		socket.write(
			`POST /v1/validate HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
		),
	);
	return {
		socket,
		firstDataAt: () => firstDataAt,
		received: () => received,
		expected: () => expected,
		errorCode: () => errorCode,
		resume: () => {
			draining = true;
			socket.resume();
		},
		closed,
	};
}

describe('connections that move no bytes', () => {
	it.concurrent('closes the connection of a client that stops reading a large response within WRITE_STALL_MS, and serves the others', async () => {
		const stallMs = 500;
		const daemon = await startDaemon({ ...LARGE_ANSWER_LIMITS, HED_LSP_WRITE_STALL_MS: String(stallMs) });
		expect(daemon.config.writeStallMs).toBe(stallMs);
		const client = slowClient(daemon, LARGE_ANSWER);

		try {
			await waitFor(() => client.firstDataAt() > 0 && client.expected() > 0, 30_000, 'the response to start');
			// The client reads no more, so its write has stalled, and a second client is answered at once.
			const during = await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: '8.4.0' });
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('"aborted":true')),
				10_000,
				'the stalled connection to be closed',
			);
			const closedAfter = Date.now() - client.firstDataAt();
			const stall = daemon
				.logLines()
				.find((entry) => entry.msg === 'connection closed because a response write stalled');
			const request = daemon.logLines().find((entry) => entry.msg === 'request' && entry.aborted === true);

			// The premise: the answer is about 11 MB, and far more than the client read.
			expect(client.expected()).toBeGreaterThan(10_000_000);
			expect(client.received()).toBeLessThan(client.expected());
			expect(during.status).toBe(200);
			expect(closedAfter).toBeGreaterThanOrEqual(0.8 * stallMs);
			expect(closedAfter).toBeLessThan(stallMs + 2000);
			expect(stall).toMatchObject({ level: 'warn' });
			expect(request).toMatchObject({ method: 'POST', path: '/v1/validate', aborted: true });
			expect(request?.requestId).toBe(stall?.requestId);

			// The client sees a reset, not a clean close, and never gets the rest of the answer. A plain close
			// of the socket would let the client read what the kernel still holds and then end without an error.
			client.resume();
			await client.closed;
			expect(client.received()).toBeLessThan(client.expected());
			expect(client.errorCode()).toBe('ECONNRESET');

			// The daemon is still running and answers a new client.
			const after = await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: '8.4.0' });
			expect(after.status).toBe(200);
			expect(after.json.results[0].valid).toBe(true);
		} finally {
			client.socket.destroy();
			await daemon.stop();
		}
	}, 60_000);

	it.concurrent('does not cut off a client that reads steadily, although the whole answer takes longer than WRITE_STALL_MS', async () => {
		const stallMs = 1500;
		const daemon = await startDaemon({ ...LARGE_ANSWER_LIMITS, HED_LSP_WRITE_STALL_MS: String(stallMs) });
		// The client reads 1 MB, waits 400 ms, and reads on, so its pauses are short but the answer of
		// about 11 MB takes it more than twice the stall time: ten pauses of 400 ms are 4 s against the 3 s
		// that the test asks for, a margin of about a second. Every pause ends with progress.
		const client = slowClient(daemon, LARGE_ANSWER, { paced: { everyBytes: 1_000_000, pauseMs: 400 } });

		try {
			await waitFor(() => client.expected() > 0, 30_000, 'the response to start');
			await waitFor(() => client.received() === client.expected(), 30_000, 'the whole response to be read');
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('"msg":"request"')),
				5000,
				'the request to be logged',
			);
			const readingTook = Date.now() - client.firstDataAt();
			const request = daemon.logLines().find((entry) => entry.msg === 'request');

			expect(client.expected()).toBeGreaterThan(10_000_000);
			expect(readingTook).toBeGreaterThan(2 * stallMs);
			expect(request).toMatchObject({ method: 'POST', path: '/v1/validate', status: 200 });
			expect(request?.aborted).toBeUndefined();
			expect(daemon.rawLines.some((line) => line.includes('write stalled'))).toBe(false);
		} finally {
			client.socket.destroy();
			await daemon.stop();
		}
	}, 60_000);

	it.concurrent('resets a client that reads slowly but steadily once the whole write has taken WRITE_TOTAL_MS', async () => {
		const totalMs = 1000;
		// The stall bound is far away, so only the total can end this connection. The client reads 1 MB,
		// waits 400 ms, and reads on: it makes progress all the time and never stalls, and the answer of
		// about 11 MB would take it several seconds.
		const daemon = await startDaemon({
			...LARGE_ANSWER_LIMITS,
			HED_LSP_WRITE_STALL_MS: '30000',
			HED_LSP_WRITE_TOTAL_MS: String(totalMs),
		});
		expect(daemon.config.writeTotalMs).toBe(totalMs);
		const client = slowClient(daemon, LARGE_ANSWER, { paced: { everyBytes: 1_000_000, pauseMs: 400 } });

		try {
			await waitFor(() => client.expected() > 0, 30_000, 'the response to start');
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('"aborted":true')),
				30_000,
				'the connection to be reset',
			);
			const closedAfter = Date.now() - client.firstDataAt();
			const total = daemon
				.logLines()
				.find((entry) => entry.msg === 'connection closed because a response write took too long');
			const request = daemon.logLines().find((entry) => entry.msg === 'request' && entry.aborted === true);

			expect(client.expected()).toBeGreaterThan(10_000_000);
			expect(closedAfter).toBeGreaterThanOrEqual(0.8 * totalMs);
			expect(closedAfter).toBeLessThan(totalMs + 2500);
			expect(total).toMatchObject({ level: 'warn' });
			expect(request?.requestId).toBe(total?.requestId);
			expect(daemon.rawLines.some((line) => line.includes('write stalled'))).toBe(false);

			// The client sees a reset, and never gets the rest of the answer.
			client.resume();
			await client.closed;
			expect(client.received()).toBeLessThan(client.expected());
			expect(client.errorCode()).toBe('ECONNRESET');

			// The daemon is still running and answers a new client.
			expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: '8.4.0' })).status).toBe(200);
		} finally {
			client.socket.destroy();
			await daemon.stop();
		}
	}, 60_000);

	it.concurrent('does not cut a kept-alive connection after its response was written, because the watchdog stops at the end of the response', async () => {
		const stallMs = 300;
		const daemon = await startDaemon({ HED_LSP_WRITE_STALL_MS: String(stallMs) });
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

		try {
			const first = await call(daemon.url, '/v1/health', { agent });
			// Three times the stall time with no response pending: a timer that outlived the response would have fired.
			await sleep(3 * stallMs);
			const second = await call(daemon.url, '/v1/health', { agent });

			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			// The connection was reused, so the pause did not cost it.
			expect(second.localPort).toBe(first.localPort);
			expect(daemon.rawLines.some((line) => line.includes('write stalled'))).toBe(false);
		} finally {
			agent.destroy();
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
