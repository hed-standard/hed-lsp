/**
 * Tests for the Docker health probe, `out/daemon/healthcheck.js`, run as a process against a real
 * daemon and against real servers that answer the way a broken one would: nothing listening, an
 * answer that never comes, and an answer that is not a healthy one. The probe exits 0 only for HTTP
 * 200 with a status of ok or degraded. No mocks.
 */

import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHealth, isHealthy } from '../daemon/healthcheck.js';
import { call, childEnv, compiled, type RunningDaemon, startDaemon, waitFor } from './daemonHarness.js';

const running: RunningDaemon[] = [];
const servers: (net.Server | http.Server)[] = [];

afterEach(async () => {
	await Promise.all(running.splice(0).map((daemon) => daemon.stop()));
	for (const server of servers.splice(0)) {
		if (server instanceof http.Server) {
			server.closeAllConnections();
		}
		server.close();
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

/** A real HTTP server on a free port that answers every request with `answer`. */
async function answering(
	answer: (response: http.ServerResponse) => void,
): Promise<{ port: number; server: http.Server }> {
	const server = http.createServer((_request, response) => answer(response));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { port: (server.address() as net.AddressInfo).port, server };
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
		const { port } = await daemon();

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

	it('exits 1 for a daemon that is still starting and answers 503', async () => {
		const { daemon: started, port } = await daemon({}, { autoPreload: false });

		const result = await probe(port);

		expect(result.code).toBe(1);
		await started.daemon.preload();
		expect((await probe(port)).code).toBe(0);
	});
});

describe('the health probe against a server that is not healthy', () => {
	it('exits 1 when nothing is listening', async () => {
		const result = await probe(await closedPort());

		expect(result.code).toBe(1);
		expect(result.ms).toBeLessThan(2000);
	});

	it('exits 1 within about two seconds when the connection is accepted and never answered', async () => {
		const silent = net.createServer(() => undefined);
		servers.push(silent);
		await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));

		const result = await probe((silent.address() as net.AddressInfo).port);

		expect(result.code).toBe(1);
		expect(result.ms).toBeGreaterThanOrEqual(1800);
		expect(result.ms).toBeLessThan(5000);
	});

	it('exits 1 for an answer that starts but never finishes', async () => {
		const { port } = await answering((response) => {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.write('{"status":');
		});

		const result = await probe(port);

		expect(result.code).toBe(1);
		expect(result.ms).toBeLessThan(5000);
	});

	it.each([
		[200, '{"status":"starting"}', 'a 200 that says starting'],
		[200, 'ok', 'a 200 that is not JSON'],
		[200, '{"state":"ok"}', 'a 200 without a status'],
		[200, '', 'an empty 200'],
		[503, '{"status":"ok"}', 'a 503 that says ok'],
		[500, '{"status":"degraded"}', 'a 500 that says degraded'],
		[404, '{"status":"ok"}', 'a 404'],
	])('exits 1 for %i with body %j (%s)', async (status, body) => {
		const { port } = await answering((response) => {
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end(body);
		});

		expect((await probe(port)).code).toBe(1);
	});

	it.each(['ok', 'degraded'])('exits 0 for a 200 that says %s', async (status) => {
		const { port } = await answering((response) => {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ status }));
		});

		expect((await probe(port)).code).toBe(0);
	});

	it('exits 1 for an answer larger than it will read', async () => {
		const { port } = await answering((response) => {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ status: 'ok', padding: 'x'.repeat(200_000) }));
		});

		expect((await probe(port)).code).toBe(1);
	});

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
		expect(isHealthy(undefined, '{"status":"ok"}')).toBe(false);
		expect(isHealthy(200, 'not json')).toBe(false);
		expect(isHealthy(200, 'null')).toBe(false);
	});
});
