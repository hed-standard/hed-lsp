/**
 * Helpers for the daemon tests: a real daemon on a real socket (port 0, loopback) running the real
 * engine, and a small HTTP client built on node:http so a test can control headers, chunking, and
 * early responses exactly. The test configuration names only the bundled schemas, so the tests run
 * offline. Nothing here replaces daemon or engine behavior; the one fixture is the network-failure
 * fixture below, which makes the network fail and changes nothing else.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { type DaemonConfig, loadConfig } from '../daemon/config.js';
import { createDaemon, type Daemon, type DaemonOptions } from '../daemon/server.js';

/** The bundled standard schema and the bundled standard schema with its two libraries. */
export const BUNDLED = '8.4.0';
export const BUNDLED_WITH_LIBRARIES = '8.4.0,sc:score_2.1.0,la:lang_1.1.0';

/**
 * The rate limits for tests that are not about limits: far above anything a test sends, so the
 * limits never interfere. A test about limits overrides them.
 */
const GENEROUS_RATES = {
	HED_LSP_RATE_ITEMS_PER_SEC: '1000000',
	HED_LSP_RATE_ITEMS_BURST: '1000000',
	HED_LSP_SEMANTIC_RATE_PER_SEC: '1000000',
	HED_LSP_SEMANTIC_RATE_BURST: '1000000',
};

/** A configuration for tests: loopback, port 0, and the bundled schemas, with `overrides` on top. */
export function testConfig(overrides: Record<string, string> = {}): DaemonConfig {
	return loadConfig({
		HED_LSP_HOST: '127.0.0.1',
		HED_LSP_PORT: '0',
		HED_LSP_SCHEMAS: `${BUNDLED};${BUNDLED_WITH_LIBRARIES}`,
		HED_LSP_DEFAULT_SCHEMA: BUNDLED,
		...GENEROUS_RATES,
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

export interface HeldRequest {
	/** Send the rest of the body and end the request. */
	complete(rest: string): void;
	/** Give up on the request: close its connection. */
	abandon(): void;
	/** The response, once it has arrived. Rejects when the connection ends without one. */
	response: Promise<Reply>;
}

/**
 * Start a POST that promises `length` bytes of body and sends only `first` of them, so the daemon
 * sees a request whose headers have arrived and whose body has not. The connection is not reused.
 */
export function holdRequest(
	base: string,
	path: string,
	init: { length: number; first: string; headers?: Record<string, string> },
): HeldRequest {
	const chunks: Buffer[] = [];
	let head: { status: number; headers: http.IncomingHttpHeaders } | undefined;
	let settle!: (reply: Reply) => void;
	let fail!: (error: Error) => void;
	const response = new Promise<Reply>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// A caller that never looks at the response must not see an unhandled rejection from it.
	response.catch(() => undefined);
	const finish = (): void => {
		if (!head) {
			return;
		}
		const text = Buffer.concat(chunks).toString('utf-8');
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		settle({ status: head.status, headers: head.headers, localPort: undefined, text, json });
	};
	const req = http.request(
		`${base}${path}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': String(init.length), ...init.headers },
			agent: false,
		},
		(res) => {
			head = { status: res.statusCode ?? 0, headers: res.headers };
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', finish);
			res.on('close', finish);
			res.on('error', finish);
		},
	);
	req.on('error', (error) => (head ? finish() : fail(error)));
	req.write(init.first);
	return {
		complete: (rest) => req.end(rest),
		abandon: () => req.destroy(),
		response,
	};
}

/** Wait `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Whether any object nested in `value` has a property named `key`. */
export function hasKey(value: unknown, key: string): boolean {
	if (Array.isArray(value)) {
		return value.some((item) => hasKey(item, key));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.keys(value).some((name) => name === key || hasKey((value as Record<string, unknown>)[name], key));
	}
	return false;
}

/** The compiled daemon module `name`, such as `main.js`. The process tests run what ships. */
export function compiled(name: string): string {
	const file = path.join(__dirname, '..', '..', 'out', 'daemon', name);
	if (!fs.existsSync(file)) {
		throw new Error(`${file} is missing; run "bun run compile" before this test`);
	}
	return file;
}

/**
 * The environment of a child process: the PATH and HOME of this process and the given variables,
 * and no HED_LSP_* from the environment of the test run.
 */
export function childEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	if (process.env.HOME !== undefined) {
		base.HOME = process.env.HOME;
	}
	return { ...base, ...env };
}

export interface DaemonProcess {
	child: ChildProcess;
	/** Every line the process wrote to stderr so far. */
	lines: string[];
	/** Resolves with the port from the `listening` line, or rejects if the process exits first. */
	port(): Promise<number>;
	/** Resolves when the process has exited, with how, and how long after this call it took. */
	exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Run the compiled daemon as a child process on port 0 with the bundled schemas, which run offline.
 * `env` is added to the environment, and replaces any of those defaults.
 */
export function spawnDaemon(env: Record<string, string> = {}): DaemonProcess {
	const child = spawn(process.execPath, [compiled('main.js')], {
		env: childEnv({
			HED_LSP_HOST: '127.0.0.1',
			HED_LSP_PORT: '0',
			HED_LSP_SCHEMAS: BUNDLED,
			HED_LSP_DEFAULT_SCHEMA: BUNDLED,
			...env,
		}),
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	const lines: string[] = [];
	let partial = '';
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	const listeners: (() => void)[] = [];
	const notify = (): void => {
		for (const listener of listeners.splice(0)) {
			listener();
		}
	};
	child.stderr?.setEncoding('utf-8');
	child.stderr?.on('data', (chunk: string) => {
		const pieces = (partial + chunk).split('\n');
		partial = pieces.pop() ?? '';
		lines.push(...pieces.filter((line) => line !== ''));
		notify();
	});
	child.on('exit', (code, signal) => {
		exit = { code, signal };
		notify();
	});
	const waitForChange = (): Promise<void> => new Promise((resolve) => listeners.push(resolve));
	return {
		child,
		lines,
		async port() {
			for (;;) {
				for (const line of lines) {
					try {
						const entry = JSON.parse(line) as { msg?: string; port?: number };
						if (entry.msg === 'listening' && typeof entry.port === 'number') {
							return entry.port;
						}
					} catch {
						// A line that is not JSON cannot be the listening line.
					}
				}
				if (exit) {
					throw new Error(`the daemon exited (${JSON.stringify(exit)}) before it listened:\n${lines.join('\n')}`);
				}
				await waitForChange();
			}
		},
		async exited() {
			while (!exit) {
				await waitForChange();
			}
			return exit;
		},
	};
}
