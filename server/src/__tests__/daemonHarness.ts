/**
 * Helpers for the daemon tests: a real daemon on a real socket (port 0, loopback) running the real
 * engine, and a small HTTP client built on node:http so a test can control headers, chunking, and
 * early responses exactly. The test configuration names only the bundled schemas, so the tests run
 * offline. Nothing here replaces daemon or engine behavior; the one fixture is the network-failure
 * fixture below, which makes the network fail and changes nothing else.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type DaemonConfig, loadConfig } from '../daemon/config.js';
import { createDaemon, type Daemon, type DaemonOptions } from '../daemon/server.js';

/** The bundled standard schema and the bundled standard schema with its two libraries. */
export const BUNDLED = '8.4.0';
export const BUNDLED_WITH_LIBRARIES = '8.4.0,sc:score_2.1.0,la:lang_1.1.0';

/** A configuration for tests: loopback, port 0, and the bundled schemas, with `overrides` on top. */
export function testConfig(overrides: Record<string, string> = {}): DaemonConfig {
	return loadConfig({
		HED_LSP_HOST: '127.0.0.1',
		HED_LSP_PORT: '0',
		HED_LSP_SCHEMAS: `${BUNDLED};${BUNDLED_WITH_LIBRARIES}`,
		HED_LSP_DEFAULT_SCHEMA: BUNDLED,
		...overrides,
	});
}

export interface RunningDaemon {
	daemon: Daemon;
	config: DaemonConfig;
	/** Base URL, such as http://127.0.0.1:41234. */
	url: string;
	/** Every line the daemon wrote, parsed. A line that is not JSON fails the parse loudly. */
	logLines(): Record<string, unknown>[];
	/** The raw lines, for tests that check what a line contains. */
	rawLines: string[];
	stop(): Promise<void>;
}

export interface StartOptions extends DaemonOptions {
	/**
	 * Return before the default schema has loaded. For tests of the starting state. A daemon created
	 * with `autoPreload: false` is never waited for, because nothing loads until the test calls
	 * `preload()`.
	 */
	skipReady?: boolean;
}

export async function startDaemon(
	overrides: Record<string, string> = {},
	options: StartOptions = {},
): Promise<RunningDaemon> {
	const config = testConfig(overrides);
	const rawLines: string[] = [];
	const daemon = createDaemon(config, {
		...options,
		write: (line) => {
			rawLines.push(line);
			options.write?.(line);
		},
	});
	await new Promise<void>((resolve, reject) => {
		daemon.server.once('error', reject);
		daemon.server.listen(config.port, config.host, () => resolve());
	});
	if (!options.skipReady && options.autoPreload !== false) {
		await daemon.ready;
	}
	const { port } = daemon.server.address() as AddressInfo;
	return {
		daemon,
		config,
		url: `http://127.0.0.1:${port}`,
		rawLines,
		logLines: () => rawLines.map((line) => JSON.parse(line) as Record<string, unknown>),
		stop: () => daemon.close(2000),
	};
}

export interface NetworkFailure {
	/** Let the stalled fetches fail. Does nothing when the fixture was not asked to stall. */
	release(): void;
}

/**
 * The network-failure fixture that the test policy allows: for the duration of `run`, every fetch
 * fails the way a fetch fails with the network down, with a TypeError, which is how hed-validator
 * sees GitHub when it cannot be reached. With `stall`, a fetch hangs, as a hung GitHub request
 * does, until `release()` is called, and then fails. Only the network is replaced: the daemon,
 * the engine, and the validator run as they are. The real fetch is restored in `finally`, so the
 * fixture covers exactly one load and nothing after it.
 */
export async function withNetworkFailure<T>(
	run: (network: NetworkFailure) => Promise<T>,
	options: { stall?: boolean } = {},
): Promise<T> {
	const realFetch = globalThis.fetch;
	let release = (): void => {};
	const gate = options.stall
		? new Promise<void>((resolve) => {
				release = resolve;
			})
		: Promise.resolve();
	globalThis.fetch = (async () => {
		await gate;
		throw new TypeError('fetch failed (network-failure fixture)');
	}) as typeof fetch;
	try {
		return await run({ release });
	} finally {
		release();
		globalThis.fetch = realFetch;
	}
}

export interface Reply {
	status: number;
	headers: http.IncomingHttpHeaders;
	/** The local port of the connection the response arrived on, to tell whether it was reused. */
	localPort: number | undefined;
	text: string;
	json: any;
}

export interface CallOptions {
	/** A keep-alive agent, to reuse a connection across calls. Each call uses its own connection by default. */
	agent?: http.Agent;
	method?: string;
	headers?: Record<string, string>;
	/** A string or buffer is sent whole; an array is sent as separate chunks with chunked encoding. */
	body?: string | Buffer | (string | Buffer)[];
}

/**
 * One request on its own connection. Resolves with the response once it has ended. A server may
 * answer early and close while the body is still being written; a response that arrived before
 * that failure still counts.
 */
export function call(base: string, path: string, options: CallOptions = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const { body } = options;
		const headers: Record<string, string> = { ...options.headers };
		if (typeof body === 'string' || Buffer.isBuffer(body)) {
			headers['Content-Length'] ??= String(Buffer.byteLength(body));
		}
		const chunks: Buffer[] = [];
		let head: { status: number; headers: http.IncomingHttpHeaders; localPort: number | undefined } | undefined;
		let done = false;
		const finish = (): void => {
			if (done || !head) {
				return;
			}
			done = true;
			const text = Buffer.concat(chunks).toString('utf-8');
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			resolve({ status: head.status, headers: head.headers, localPort: head.localPort, text, json });
		};
		const req = http.request(
			`${base}${path}`,
			{ method: options.method ?? 'GET', headers, agent: options.agent ?? false },
			(res) => {
				head = { status: res.statusCode ?? 0, headers: res.headers, localPort: res.socket?.localPort };
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', finish);
				res.on('close', finish);
				res.on('error', finish);
			},
		);
		req.on('error', (error) => {
			if (head) {
				finish();
			} else if (!done) {
				done = true;
				reject(error);
			}
		});
		if (Array.isArray(body)) {
			for (const chunk of body) {
				req.write(chunk);
			}
			req.end();
		} else {
			req.end(body);
		}
	});
}

/** POST a JSON value (or a raw string) to a path. */
export function postJson(
	base: string,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Reply> {
	return call(base, path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

/** Poll until `check` returns true, or fail after `timeoutMs`. For state that settles in the background. */
export async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 5000,
	what = 'condition',
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
