/**
 * Tests for the Docker health probe, `out/daemon/healthcheck.js`, run as a process against real
 * daemons in real states, and against ports with nothing on them. The probe exits 0 only for HTTP 200
 * with a status of ok or degraded, so each case is a daemon that really is in that state:
 *
 * - ready, which answers 200 ok: exit 0;
 * - degraded, because a library schema that does not exist cannot load: exit 0;
 * - still starting, because its preload has not begun, which answers 503: exit 1;
 * - frozen, a real daemon process that was stopped after it listened, so the connection is accepted
 *   and never answered: exit 1 after about two seconds;
 * - not running, a port with nothing on it: exit 1;
 * - a probe whose own configuration is invalid: exit 1.
 *
 * The status logic that decides which answers count as healthy is a pure function, `isHealthy`, and
 * is tested on its own. No stand-in server answers on behalf of a daemon. No mocks.
 */

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHealth, isHealthy } from '../daemon/healthcheck.js';
import {
	call,
	childEnv,
	compiled,
	type DaemonProcess,
	type RunningDaemon,
	spawnDaemon,
	startDaemon,
	waitFor,
} from './daemonHarness.js';

const running: RunningDaemon[] = [];
const spawned: DaemonProcess[] = [];

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.stop()));
	for (const proc of spawned.splice(0)) {
		proc.child.kill('SIGKILL');
	}
});

/** Run the probe against a port and report how it exited and how long it took. */
function probe(port: number, env: Record<string, string> = {}): Promise<{ code: number | null; ms: number }> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(process.execPath, [compiled('healthcheck.js')], {
			env: childEnv({ HED_LSP_PORT: String(port), ...env }),
			stdio: 'ignore',
		});
		child.on('error', reject);
		child.on('exit', (code) => resolve({ code, ms: Date.now() - startedAt }));
	});
}

async function daemon(...args: Parameters<typeof startDaemon>): Promise<{ daemon: RunningDaemon; port: number }> {
	const started = await startDaemon(...args);
	running.push(started);
	return { daemon: started, port: Number(new URL(started.url).port) };
}

/** A port that was free a moment ago and has nothing on it now. */
async function closedPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

describe('the health probe against a running daemon', () => {
	it('exits 0 for a daemon that reports ok', async () => {
		const { daemon: started, port } = await daemon();
		expect((await call(started.url, '/v1/health')).json.status).toBe('ok');

		expect((await probe(port)).code).toBe(0);
	});

	it('exits 0 for a daemon that reports degraded, because it still serves requests', async () => {
		// The second spec does not exist, so its load fails for real and the daemon reports degraded.
		const { daemon: started, port } = await daemon({
			HED_LSP_SCHEMAS: '8.4.0;8.4.0,sc:score_9.9.9',
			HED_LSP_DEFAULT_SCHEMA: '8.4.0',
		});
		await waitFor(async () => (await call(started.url, '/v1/health')).json.status === 'degraded', 10000, 'degraded');

		expect((await call(started.url, '/v1/health')).status).toBe(200);
		expect((await probe(port)).code).toBe(0);
	}, 30000);

	it('exits 1 for a daemon that is still starting and answers 503, and 0 once it has loaded', async () => {
		const { daemon: started, port } = await daemon({}, { autoPreload: false });
		expect((await call(started.url, '/v1/health')).status).toBe(503);

		const result = await probe(port);

		expect(result.code).toBe(1);
		await started.daemon.preload();
		expect((await probe(port)).code).toBe(0);
	});
});

describe('the health probe against something that cannot answer', () => {
	it('exits 1 when nothing is listening', async () => {
		const result = await probe(await closedPort());

		expect(result.code).toBe(1);
		expect(result.ms).toBeLessThan(2000);
	});

	it('exits 1 within about two seconds for a daemon that is frozen: it accepts the connection and never answers', async () => {
		const proc = spawnDaemon();
		spawned.push(proc);
		const port = await proc.port();
		await waitFor(async () => (await call(`http://127.0.0.1:${port}`, '/v1/health')).status === 200, 15000, 'ready');
		// A stopped process keeps its listening socket, so the kernel accepts the connection and nothing reads it.
		process.kill(proc.child.pid as number, 'SIGSTOP');

		const result = await probe(port);

		expect(result.code).toBe(1);
		expect(result.ms).toBeGreaterThanOrEqual(1800);
		expect(result.ms).toBeLessThan(5000);
		// The probe is not what froze it: once it runs again, the same probe is satisfied.
		process.kill(proc.child.pid as number, 'SIGCONT');
		expect((await probe(port)).code).toBe(0);
	}, 40000);

	it('exits 1 when the configuration it reads is invalid', async () => {
		const result = await probe(1, { HED_LSP_PORT: 'banana' });

		expect(result.code).toBe(1);
	});
});

describe('checkHealth and isHealthy', () => {
	it('answers true for a running daemon and false for a port with nothing on it', async () => {
		const { port } = await daemon();

		expect(await checkHealth(port)).toBe(true);
		expect(await checkHealth(await closedPort(), 500)).toBe(false);
	});

	it('accepts only a 200 whose status is ok or degraded', () => {
		expect(isHealthy(200, '{"status":"ok"}')).toBe(true);
		expect(isHealthy(200, '{"status":"degraded"}')).toBe(true);
		expect(isHealthy(200, '{"status":"starting"}')).toBe(false);
		expect(isHealthy(503, '{"status":"ok"}')).toBe(false);
		expect(isHealthy(500, '{"status":"degraded"}')).toBe(false);
		expect(isHealthy(404, '{"status":"ok"}')).toBe(false);
		expect(isHealthy(undefined, '{"status":"ok"}')).toBe(false);
		expect(isHealthy(200, 'not json')).toBe(false);
		expect(isHealthy(200, 'ok')).toBe(false);
		expect(isHealthy(200, '')).toBe(false);
		expect(isHealthy(200, '{"state":"ok"}')).toBe(false);
		expect(isHealthy(200, 'null')).toBe(false);
	});
});
