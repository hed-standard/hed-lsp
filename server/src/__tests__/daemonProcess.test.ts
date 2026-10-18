/**
 * Process tests for the compiled entry point, `out/daemon/main.js`: the exit code and message for an
 * invalid configuration, the listening line, a shutdown on SIGTERM and SIGINT that drains the
 * requests in flight, a failure to bind, the semantic warm-up of a process that has no model, and
 * the promise that the daemon never loads the language server. Each test runs the real process
 * with the real engine on a real socket, and they run after `bun run compile`, which the test
 * script does first. No mocks.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_GRACE_MS } from '../daemon/main.js';
import {
	BUNDLED,
	call,
	childEnv,
	compiled,
	type DaemonProcess,
	holdRequest,
	postJson,
	sleep,
	spawnDaemon,
	waitFor,
} from './daemonHarness.js';

const spawned: DaemonProcess[] = [];

function launch(env: Record<string, string> = {}): DaemonProcess {
	const proc = spawnDaemon(env);
	spawned.push(proc);
	return proc;
}

afterEach(() => {
	for (const proc of spawned.splice(0)) {
		proc.child.kill('SIGKILL');
	}
});

const VALID = 'Sensory-event, Visual-presentation';

describe('an invalid configuration', () => {
	it.each([
		['HED_LSP_PORT', 'banana'],
		['HED_LSP_MAX_BODY_BYTES', '0'],
		['HED_LSP_DEFAULT_SCHEMA', '9.9.9'],
		['HED_LSP_SEMANTIC', 'maybe'],
		['HED_LSP_HEADERS_TIMEOUT_MS', '999999'],
	])('exits 2 and names %s for the value "%s", without listening', async (variable, value) => {
		const proc = launch({ [variable]: value });

		const exit = await proc.exited();

		expect(exit).toEqual({ code: 2, signal: null });
		const output = proc.lines.join('\n');
		expect(output).toContain(variable);
		const entry = JSON.parse(proc.lines[0]);
		expect(entry).toMatchObject({ level: 'error', msg: 'invalid configuration', variable });
		expect(output).not.toContain('"msg":"listening"');
	});
});

describe('starting', () => {
	it('writes one JSON listening line with the address and version, and then serves requests', async () => {
		const proc = launch();

		const port = await proc.port();
		const base = `http://127.0.0.1:${port}`;
		await waitFor(async () => (await call(base, '/v1/health')).status === 200, 15000, 'the schemas to load');

		const listening = proc.lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.msg === 'listening');
		expect(listening).toHaveLength(1);
		expect(listening[0]).toMatchObject({
			level: 'info',
			host: '127.0.0.1',
			port,
			version: expect.stringMatching(/^\d+\.\d+\.\d+/),
			semantic: false,
		});
		// Every line the process writes is one JSON object, so a log collector can parse the stream.
		for (const line of proc.lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		const validated = await postJson(base, '/v1/validate', { strings: [VALID], schema: BUNDLED });
		expect(validated.json.results[0]).toEqual({ index: 0, valid: true, issues: [], issueCount: 0, truncated: false });
		// The listening line comes before the first schema load is logged.
		const messages = proc.lines.map((line) => JSON.parse(line).msg as string);
		expect(messages.indexOf('listening')).toBeLessThan(messages.findIndex((msg) => msg.startsWith('[HED] Loading')));
	}, 30000);

	it('exits 1 with the system error code when the address is already in use', async () => {
		const first = launch();
		const port = await first.port();

		const second = launch({ HED_LSP_PORT: String(port) });
		const exit = await second.exited();

		expect(exit).toEqual({ code: 1, signal: null });
		expect(second.lines.some((line) => line.includes('EADDRINUSE'))).toBe(true);
		expect(JSON.parse(second.lines[second.lines.length - 1])).toMatchObject({ level: 'error', code: 'EADDRINUSE' });
	}, 30000);
});

describe('shutting down', () => {
	it.each(['SIGTERM', 'SIGINT'] as const)(
		'exits 0 within 10 seconds on %s, after stopping to accept',
		async (signal) => {
			const proc = launch();
			const port = await proc.port();
			await waitFor(async () => (await call(`http://127.0.0.1:${port}`, '/v1/health')).status === 200, 15000, 'ready');
			const sentAt = Date.now();

			proc.child.kill(signal);
			const exit = await proc.exited();

			expect(exit).toEqual({ code: 0, signal: null });
			expect(Date.now() - sentAt).toBeLessThan(10_000);
			const messages = proc.lines.map((line) => JSON.parse(line).msg as string);
			expect(messages).toContain('shutting down');
			const announced = proc.lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === 'shutting down');
			expect(announced).toMatchObject({ signal, graceMs: 8000 });
			expect(messages[messages.length - 1]).toBe('stopped');
			await expect(call(`http://127.0.0.1:${port}`, '/v1/health')).rejects.toThrow();
		},
		30000,
	);

	it('stops accepting at once but lets a request in flight finish, and exits 0 after it', async () => {
		const proc = launch();
		const port = await proc.port();
		const base = `http://127.0.0.1:${port}`;
		await waitFor(async () => (await call(base, '/v1/health')).status === 200, 15000, 'ready');
		const body = JSON.stringify({ strings: [VALID], schema: BUNDLED });
		const held = holdRequest(base, '/v1/validate', { length: body.length, first: body.slice(0, 5) });
		await sleep(200);

		proc.child.kill('SIGTERM');
		await waitFor(
			async () => {
				try {
					await call(base, '/v1/health');
					return false;
				} catch {
					return true;
				}
			},
			5000,
			'the daemon to stop accepting',
		);

		// The process is still draining: it has not exited, and the held request is still waiting for its body.
		expect(proc.child.exitCode).toBeNull();
		held.complete(body.slice(5));
		const reply = await held.response;
		const exit = await proc.exited();

		expect(reply.status).toBe(200);
		expect(reply.json.results[0]).toEqual({ index: 0, valid: true, issues: [], issueCount: 0, truncated: false });
		expect(reply.headers.connection).toBe('close');
		expect(exit).toEqual({ code: 0, signal: null });
	}, 30000);

	it('ignores a second signal while it is shutting down', async () => {
		const proc = launch();
		const port = await proc.port();
		const base = `http://127.0.0.1:${port}`;
		await waitFor(async () => (await call(base, '/v1/health')).status === 200, 15000, 'ready');
		const held = holdRequest(base, '/v1/validate', { length: 1000, first: '{"strings"' });
		await sleep(200);

		proc.child.kill('SIGTERM');
		proc.child.kill('SIGTERM');
		proc.child.kill('SIGINT');
		await sleep(300);

		expect(proc.child.exitCode).toBeNull();
		expect(proc.lines.filter((line) => JSON.parse(line).msg === 'shutting down')).toHaveLength(1);
		held.abandon();
		expect(await proc.exited()).toEqual({ code: 0, signal: null });
	}, 30000);
});

describe('semantic search in a process without the model', () => {
	it('reports unavailable, still answers keyword results, and does not retry inside the backoff', async () => {
		// An empty HOME is an empty model cache, and downloads are off, so the warm-up fails for real.
		const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-empty-home-'));
		try {
			const proc = launch({ HOME: emptyHome, HED_LSP_SEMANTIC: '1', HED_LSP_MODEL_DOWNLOAD: '0' });
			const port = await proc.port();
			const base = `http://127.0.0.1:${port}`;
			const state = async (): Promise<{ state: string; failures: number }> =>
				(await call(base, '/v1/health')).json.semantic;

			await waitFor(
				async () => (await state()).state === 'unavailable',
				60000,
				'semantic search to become unavailable',
			);
			const queries = ['red square', 'button press', 'xyzzy nonsense'];
			const plain = await postJson(base, '/v1/suggest', { queries, schema: BUNDLED });
			const asked = await postJson(base, '/v1/suggest', { queries, schema: BUNDLED, semantic: true });

			expect((await state()).failures).toBe(1);
			expect(asked.status).toBe(200);
			expect(asked.json.semantic).toEqual({ requested: true, status: 'unavailable' });
			expect(asked.json.results).toEqual(plain.json.results);
			expect(asked.json.results[0].suggestions.length).toBeGreaterThan(0);
			// Requests do not trigger another warm-up, and the backoff of 30 seconds has not run out.
			for (let i = 0; i < 10; i++) {
				await postJson(base, '/v1/suggest', { queries, schema: BUNDLED, semantic: true });
			}
			await sleep(1500);
			expect(await state()).toMatchObject({ state: 'unavailable', failures: 1 });
			expect(proc.lines.filter((line) => JSON.parse(line).msg === 'semantic warm-up failed')).toHaveLength(1);
			expect((await call(base, '/v1/health')).json.status).toBe('ok');
		} finally {
			fs.rmSync(emptyHome, { recursive: true, force: true });
		}
	}, 120000);
});

describe('the shutdown grace', () => {
	it('is 8 seconds, below the 10 seconds that Docker waits after SIGTERM before it sends SIGKILL', () => {
		expect(SHUTDOWN_GRACE_MS).toBe(8000);
		expect(SHUTDOWN_GRACE_MS).toBeLessThan(10_000);
	});
});

describe('the hed-lsp-daemon command', () => {
	it('is the compiled entry point, which starts with a Node shebang line like the health probe', () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
		const target = path.resolve(path.join(__dirname, '..', '..'), manifest.bin['hed-lsp-daemon']);

		expect(target).toBe(compiled('main.js'));
		for (const file of [target, compiled('healthcheck.js')]) {
			expect(fs.readFileSync(file, 'utf-8').split('\n')[0], file).toBe('#!/usr/bin/env node');
		}
	});
});

describe('the language server', () => {
	/** The paths of the modules that a child process has loaded after running `script`. */
	function loadedModules(script: string): { status: number | null; modules: string[]; stderr: string } {
		const result = spawnSync(process.execPath, ['-e', script], {
			env: childEnv(),
			encoding: 'utf-8',
			timeout: 60_000,
		});
		let modules: string[] = [];
		try {
			modules = JSON.parse(result.stdout) as string[];
		} catch {
			// The assertions report the empty list and the status.
		}
		return { status: result.status, modules, stderr: result.stderr };
	}

	it('is never loaded by a process that imports every compiled daemon module', () => {
		const directory = path.dirname(compiled('main.js'));
		const names = ['config', 'limits', 'log', 'protocol', 'schemas', 'semantic', 'server', 'main', 'healthcheck'];
		const script = `
			const path = require('node:path');
			for (const name of ${JSON.stringify(names)}) {
				require(path.join(${JSON.stringify(directory)}, name + '.js'));
			}
			process.stdout.write(JSON.stringify(Object.keys(require.cache)));
		`;

		const { status, modules, stderr } = loadedModules(script);

		// The child exits by itself, so importing main.js did not start a daemon.
		expect(status, stderr).toBe(0);
		expect(modules.some((file) => file.endsWith(path.join('engine', 'index.js')))).toBe(true);
		expect(modules.filter((file) => file.includes('vscode'))).toEqual([]);
		expect(modules.some((file) => file.endsWith(path.join('out', 'server.js')))).toBe(false);
	}, 90000);

	it('would be seen by the same check if it were loaded', () => {
		const serverDirectory = path.join(path.dirname(compiled('main.js')), '..', '..');
		const script = `
			require(require.resolve('vscode-languageserver', { paths: [${JSON.stringify(serverDirectory)}] }));
			process.stdout.write(JSON.stringify(Object.keys(require.cache)));
		`;

		const { status, modules, stderr } = loadedModules(script);

		expect(status, stderr).toBe(0);
		expect(modules.some((file) => file.includes('vscode-languageserver'))).toBe(true);
	}, 90000);
});

describe('listening', () => {
	/** Whether a TCP connection to `host`:`port` is accepted within two seconds. */
	function reachable(host: string, port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = net.connect({ host, port, timeout: 2000 }, () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => resolve(false));
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
		});
	}

	/** The other addresses of this machine: every non-loopback IPv4 one, the IPv6 loopback, and a second IPv4 loopback. */
	function otherAddresses(): string[] {
		const external = Object.values(os.networkInterfaces())
			.flatMap((addresses) => addresses ?? [])
			.filter((address) => address.family === 'IPv4' && !address.internal)
			.map((address) => address.address);
		return [...external, '127.0.0.2', '::1'];
	}

	it('binds the address it was given, and no other', async () => {
		const proc = launch();
		const port = await proc.port();

		const answers = new Map<string, boolean>([['127.0.0.1', await reachable('127.0.0.1', port)]]);
		for (const host of otherAddresses()) {
			answers.set(host, await reachable(host, port));
		}

		// The daemon says what it bound, and only that address accepts the connection.
		const listening = proc.lines.map((line) => JSON.parse(line)).find((entry) => entry.msg === 'listening');
		expect(listening).toMatchObject({ host: '127.0.0.1', port });
		expect(Object.fromEntries(answers)).toEqual({
			'127.0.0.1': true,
			...Object.fromEntries(otherAddresses().map((host) => [host, false])),
		});
	}, 30000);
});
