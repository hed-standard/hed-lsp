/**
 * Tests for the measurement and probe scripts in deploy/hedtools: check-client-key.sh, neighbor-probe.sh,
 * and measure.sh. The first two run against a real daemon on a real socket with the real engine; the
 * third is run as far as it can go without a Docker container, which is its argument handling, its
 * refusal to run without a pinned image, and its dry run. The steps that need the container on the host
 * are run by hand, at the approval gates of the deployment runbook. No mocks, no stand-in for a service.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { call, type RunningDaemon, startDaemon, waitFor } from './daemonHarness.js';
import {
	bash,
	DEPLOY,
	envFor,
	findOnPath,
	onPath,
	pathWithoutDocker,
	removeTempDirs,
	run,
	stateDirWith,
	tempDir,
} from './scriptHarness.js';

afterAll(removeTempDirs);

const haveCurl = findOnPath('curl') !== undefined;
const haveJq = findOnPath('jq') !== undefined;

/** The default limits of the daemon, which the behavioral check is written against. */
const DEFAULT_RATES = { HED_LSP_RATE_ITEMS_PER_SEC: '100', HED_LSP_RATE_ITEMS_BURST: '1000' };

/** A daemon that trusts the sender of every request, as it trusts Apache or the gateway of its network. */
const TRUSTING = { ...DEFAULT_RATES, HED_LSP_TRUSTED_PROXIES: '127.0.0.1' };
/**
 * A daemon that trusts no one, so it ignores X-Forwarded-For, as it does behind a proxy that is not trusted.
 * It refills one unit a second, so that its bucket cannot refill between the three requests of the check on a slow
 * machine: at the default rate, a request that took a second would get through, and the test would depend on speed.
 */
const NOT_TRUSTING = { HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '1000', HED_LSP_TRUSTED_PROXIES: '' };

/**
 * A real HTTP forwarder in front of a daemon that holds every answer for `delayMs`, as a slow network
 * does. The request goes through at once, so the daemon charges it when it arrives, and the client
 * sees the next chance to send only `delayMs` later; X-Forwarded-For passes through untouched.
 */
async function startDelayProxy(target: string, delayMs: number): Promise<{ url: string; stop: () => Promise<void> }> {
	const upstream = new URL(target);
	const server = http.createServer((request, response) => {
		const forward = http.request(
			{
				host: upstream.hostname,
				port: upstream.port,
				method: request.method,
				path: request.url,
				headers: request.headers,
			},
			(answer) => {
				setTimeout(() => {
					response.writeHead(answer.statusCode ?? 502, answer.headers);
					answer.pipe(response);
				}, delayMs);
			},
		);
		forward.on('error', () => {
			response.writeHead(502);
			response.end();
		});
		request.pipe(forward);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

/** How the n-th request, counting from 1, is answered by a scripted server. */
interface Answer {
	/** The HTTP status; 200 when absent. */
	status?: number;
	/** How long the server holds the answer back; none when absent. */
	delayMs?: number;
}

/**
 * A real HTTP server on a real socket, whose answers follow a script: it holds the n-th answer back for the
 * delay that `plan(n)` gives and then sends the status that it gives. Nothing about the client is faked; this
 * is the slow, failing, or silent neighbor that the probe has to notice.
 */
async function startScriptedServer(
	plan: (n: number) => Answer,
): Promise<{ url: string; requests: () => number; stop: () => Promise<void> }> {
	let count = 0;
	const timers = new Set<NodeJS.Timeout>();
	const server = http.createServer((_request, response) => {
		const { status = 200, delayMs = 0 } = plan(++count);
		const timer = setTimeout(() => {
			timers.delete(timer);
			response.writeHead(status, { 'Content-Type': 'application/json' });
			response.end('{}');
		}, delayMs);
		timers.add(timer);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests: () => count,
		stop: () =>
			new Promise<void>((resolve) => {
				for (const timer of timers) {
					clearTimeout(timer);
				}
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

describe.skipIf(!haveCurl)('check-client-key.sh', () => {
	const script = path.join(DEPLOY, 'check-client-key.sh');
	const env = (): Record<string, string> => ({ PATH: pathWithoutDocker(), HOME: tempDir('hed-lsp-home-') });

	it('direct: passes when the daemon trusts the sender and limits each address in X-Forwarded-For on its own', async () => {
		const daemon = await startDaemon(TRUSTING);
		try {
			const result = await bash(script, ['direct', '--no-docker', '--url', daemon.url], env());

			expect(result.stderr).toBe('');
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('expected: 200 for the first, and a 429 within 40 requests');
			// Requests are sent until the first 429, so the count in between is not fixed.
			expect(result.stdout).toMatch(/got: {6}200( 200)+ 429\n/);
			expect(result.stdout).toContain('expected: 200 for all, a client of its own');
			expect(result.stdout).toMatch(/got: {6}200 200 200\n/);
			expect(result.stdout).toContain('all checks passed');
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('direct: fails, and says why, when the daemon does not trust the sender and every client shares one key', async () => {
		const daemon = await startDaemon(NOT_TRUSTING);
		try {
			const result = await bash(script, ['direct', '--no-docker', '--url', daemon.url], env());

			expect(result.code).toBe(1);
			expect(result.stdout).toContain('ok    the limit is reached');
			expect(result.stdout).toMatch(/got: {6}(?:200|429) 429 429\n/);
			expect(result.stdout).toContain('FAIL  a different address is not limited');
			expect(result.stdout).toContain('every client shares one key');
			expect(result.stdout).toContain('1 checks failed');
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('proxy: passes when a spoofed X-Forwarded-For changes nothing, and fails when it lets a client escape the limit', async () => {
		const ignoring = await startDaemon(NOT_TRUSTING);
		const honoring = await startDaemon(TRUSTING);
		try {
			const passes = await bash(script, ['proxy', '--url', ignoring.url], env());
			const fails = await bash(script, ['proxy', '--url', honoring.url], env());

			expect(passes.code).toBe(0);
			expect(passes.stdout).toContain('expected: a 429 among them, because the header does not choose the key');
			expect(passes.stdout).toContain('ok    a spoofed address does not escape the limit');
			expect(fails.code).toBe(1);
			expect(fails.stdout).toContain('FAIL  a spoofed address does not escape the limit');
		} finally {
			await ignoring.stop();
			await honoring.stop();
		}
	}, 60_000);

	it('other: passes for an address that has sent nothing, and fails when the key is already spent by another', async () => {
		const shared = await startDaemon(NOT_TRUSTING);
		const fresh = await startDaemon(TRUSTING);
		try {
			const alone = await bash(script, ['other', '--url', fresh.url], env());
			// On a daemon that ignores the header both runs have the same key, as two addresses behind a proxy
			// that hides them would. The flood of the first spends it, and the second finds it empty.
			await bash(script, ['proxy', '--url', shared.url], env());
			const second = await bash(script, ['other', '--url', shared.url], env());

			expect(alone.code).toBe(0);
			expect(alone.stdout).toContain('ok    the limit is per real address');
			expect(second.code).toBe(1);
			expect(second.stdout).toMatch(/got: {6}(?:200|429) 429 429\n/);
			expect(second.stdout).toContain('share a key');
		} finally {
			await shared.stop();
			await fresh.stop();
		}
	}, 60_000);

	it('direct: still passes when every request takes 170 ms longer, which refills the bucket between requests', async () => {
		// The case that broke a fixed count of 12 requests: at this pace the bucket refills 17 units
		// between requests, so the limit comes later, and the check must send requests until it does.
		const daemon = await startDaemon(TRUSTING);
		const slow = await startDelayProxy(daemon.url, 170);
		try {
			const result = await bash(script, ['direct', '--no-docker', '--url', slow.url], env());

			expect(result.stderr).toBe('');
			expect(result.code).toBe(0);
			const statuses = /got: {6}(200(?: 200)+ 429)\n/.exec(result.stdout)?.[1]?.split(' ') ?? [];
			// On loopback the 429 is the 11th answer, so a longer run shows that the check went on to find it.
			expect(statuses.length).toBeGreaterThan(11);
			expect(statuses.length).toBeLessThanOrEqual(40);
			expect(result.stdout).toMatch(/got: {6}200 200 200\n/);
			expect(result.stdout).toContain('all checks passed');
		} finally {
			await slow.stop();
			await daemon.stop();
		}
	}, 120_000);

	it('says that nothing answered when the address is closed, and does not call it a spent limit', async () => {
		const result = await bash(script, ['direct', '--no-docker', '--url', 'http://127.0.0.1:1'], env());

		expect(result.code).toBe(1);
		expect(result.stdout).toContain('no answer from http://127.0.0.1:1');
		// The flood stops at the first request that gets no answer, in place of waiting for 40 of them.
		expect(result.stdout).toMatch(/got: {6}000\n/);
	}, 60_000);

	it.each([
		[[], 'Usage:'],
		[['bogus'], 'the first argument is direct, proxy, or other'],
		[['proxy'], 'proxy needs --url'],
		[['other'], 'other needs --url'],
		[['direct', '--hold', 'x'], '--hold must be a whole number'],
		[['direct', '--wat'], 'unknown argument: --wat'],
		[['direct', '--url'], '--url needs a value'],
	])('exits 2 for the arguments %j', async (args, message) => {
		const result = await bash(script, args, env());

		expect(result.code).toBe(2);
		expect(result.stderr).toContain(message);
	});

	it('prints its usage for --help', async () => {
		const result = await bash(script, ['--help'], env());

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Usage:');
		expect(result.stdout).toContain('behavioral spoof test');
	});
});

describe.skipIf(!(haveCurl && haveJq))('neighbor-probe.sh', () => {
	const script = path.join(DEPLOY, 'neighbor-probe.sh');
	const env = (): Record<string, string> => ({ PATH: pathWithoutDocker(), HOME: tempDir('hed-lsp-home-') });

	it('samples its targets for the duration and writes a summary, and a sample file, without a breach', async () => {
		const daemon = await startDaemon();
		const dir = tempDir('hed-lsp-probe-');
		const out = path.join(dir, 'summary.json');
		const tsv = path.join(dir, 'samples.tsv');
		try {
			const result = await bash(
				script,
				[
					'--interval',
					'1',
					'--duration',
					'5',
					'--target',
					`daemon=loopback=${daemon.url}/v1/health`,
					'--target',
					`route=apache=${daemon.url}/v1/schemas`,
					'--out',
					out,
					'--tsv',
					tsv,
				],
				env(),
			);

			expect(result.stderr).toBe('');
			expect(result.code).toBe(0);
			const summary = JSON.parse(fs.readFileSync(out, 'utf-8'));
			expect(summary.tool).toBe('hed-lsp-neighbor-probe');
			expect(summary.aborted).toBe(false);
			expect(summary.reason).toBeNull();
			expect(summary.samples).toBeGreaterThanOrEqual(3);
			expect(Object.keys(summary.targets)).toEqual(['daemon', 'route']);
			expect(summary.targets.daemon.kind).toBe('loopback');
			expect(summary.targets.route.kind).toBe('apache');
			for (const target of Object.values(summary.targets) as {
				n: number;
				p95Ms: number;
				maxMs: number;
				non200: number;
			}[]) {
				expect(target.n).toBe(summary.samples);
				expect(target.non200).toBe(0);
				expect(target.p95Ms).toBeGreaterThan(0);
				expect(target.p95Ms).toBeLessThanOrEqual(target.maxMs);
				expect(target.maxMs).toBeLessThan(1000);
			}
			// Docker was not on the PATH, so its health was not checked, and the summary says so: health that was
			// never checked is null and not true, and no container was watched.
			expect(summary.dockerChecked).toBe(false);
			expect(summary.dockerHealthy).toBeNull();
			expect(summary.dockerContainers).toEqual([]);
			// The targets were given with --target, so they are not the defaults.
			expect(summary.targetsAreDefault).toBe(false);
			const lines = fs.readFileSync(tsv, 'utf-8').trim().split('\n');
			expect(lines).toHaveLength(summary.samples * 2);
			expect(lines.every((line) => line.split('\t')[2] === '200')).toBe(true);
			// The p95 and the maximum are the nearest-rank figures of the samples in the file.
			for (const name of ['daemon', 'route']) {
				const times = lines
					.map((line) => line.split('\t'))
					.filter((fields) => fields[1] === name)
					.map((fields) => Number(fields[3]))
					.sort((a, b) => a - b);
				expect(times).toHaveLength(summary.samples);
				expect(summary.targets[name].p95Ms).toBe(times[Math.ceil(0.95 * times.length) - 1]);
				expect(summary.targets[name].maxMs).toBe(times[times.length - 1]);
			}
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('says that targets from HED_LSP_PROBE_TARGETS are not the defaults either, and keeps the defaults when none are given', async () => {
		const daemon = await startDaemon();
		const dir = tempDir('hed-lsp-probe-');
		try {
			const replaced = path.join(dir, 'replaced.json');
			const fromEnv = await bash(script, ['--interval', '1', '--duration', '1', '--out', replaced], {
				...env(),
				HED_LSP_PROBE_TARGETS: `daemon=loopback=${daemon.url}/v1/health`,
			});
			// The summary lists all four neighbors in the order of the runbook, whether the probe stopped at the
			// first of them (nothing listens on the loopback port of osa on most machines) or ran for its second.
			const defaults = path.join(dir, 'defaults.json');
			const withDefaults = await bash(script, ['--interval', '1', '--duration', '1', '--out', defaults], env());

			expect(fromEnv.code).toBe(0);
			const changed = JSON.parse(fs.readFileSync(replaced, 'utf-8'));
			expect(changed.targetsAreDefault).toBe(false);
			expect(Object.keys(changed.targets)).toEqual(['daemon']);
			const kept = JSON.parse(fs.readFileSync(defaults, 'utf-8'));
			expect(kept.targetsAreDefault).toBe(true);
			expect(Object.entries(kept.targets).map(([name, target]) => [name, (target as { kind: string }).kind])).toEqual([
				['osa', 'loopback'],
				['hedit', 'loopback'],
				['hedtools', 'loopback'],
				['hedtools-apache', 'apache'],
			]);
			expect(withDefaults.code).toBeLessThanOrEqual(1);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('aborts at the first answer that is not 200, names the target, and still writes its summary', async () => {
		const daemon = await startDaemon();
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		try {
			const result = await bash(
				script,
				['--interval', '1', '--target', `missing=loopback=${daemon.url}/v1/no-such-route`, '--out', out],
				env(),
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('ABORT: missing answered 404, not 200');
			const summary = JSON.parse(fs.readFileSync(out, 'utf-8'));
			expect(summary.aborted).toBe(true);
			expect(summary.reason).toContain('missing answered 404');
			expect(summary.targets.missing.non200).toBe(1);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('says that it could not kill the load container, and not that it killed it, when docker kill fails', async () => {
		const daemon = await startDaemon();
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		try {
			// There is no docker on this PATH, so docker kill fails, as it does for a container that is gone. The
			// success of the kill is checked on Docker by the image job of CI.
			const result = await bash(
				script,
				[
					'--interval',
					'1',
					'--abort-container',
					'hed-lsp-load',
					'--target',
					`missing=loopback=${daemon.url}/v1/no-such-route`,
					'--out',
					out,
				],
				env(),
			);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain('ABORT: missing answered 404, not 200');
			expect(result.stderr).toContain('could not kill hed-lsp-load: ');
			expect(result.stderr).not.toContain('killed hed-lsp-load');
			const summary = JSON.parse(fs.readFileSync(out, 'utf-8'));
			expect(summary.aborted).toBe(true);
			expect(summary.reason).toContain('missing answered 404');
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('aborts when a target does not answer at all', async () => {
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');

		const result = await bash(script, ['--target', 'gone=loopback=http://127.0.0.1:1/', '--out', out], env());

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('ABORT: gone answered 000');
		expect(JSON.parse(fs.readFileSync(out, 'utf-8')).aborted).toBe(true);
	}, 60_000);

	it('writes its summary and exits 0 when it is told to stop', async () => {
		const daemon = await startDaemon();
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		try {
			const child = spawn(
				onPath('bash'),
				[script, '--interval', '1', '--target', `daemon=loopback=${daemon.url}/v1/health`, '--out', out],
				{ env: env(), stdio: 'ignore' },
			);
			const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
			await new Promise((resolve) => setTimeout(resolve, 2500));

			child.kill('SIGTERM');

			expect(await exited).toBe(0);
			const summary = JSON.parse(fs.readFileSync(out, 'utf-8'));
			expect(summary.aborted).toBe(false);
			expect(summary.samples).toBeGreaterThanOrEqual(2);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it.each([
		['the daemon itself', 'hed-lsp'],
		['a container of another service', 'osa'],
		['an empty name', ''],
		['a name with a semicolon', 'hed-lsp-load;rm'],
		['a name that starts with a dash', '-hed-lsp-x'],
		['a name with the prefix and nothing after it', 'hed-lsp-'],
	])('refuses to kill %s: --abort-container %j', async (_label, name) => {
		const result = await bash(script, ['--abort-container', name, '--target', 'x=loopback=http://127.0.0.1:1/'], env());

		expect(result.code).toBe(2);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('--abort-container may name only a container whose name starts with hed-lsp-');
		expect(result.stderr).toContain(`refusing '${name}'`);
	});

	it('accepts a container whose name starts with hed-lsp-, and runs on', async () => {
		const daemon = await startDaemon();
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		try {
			const result = await bash(
				script,
				[
					'--interval',
					'1',
					'--duration',
					'1',
					'--abort-container',
					'hed-lsp-load',
					'--target',
					`daemon=loopback=${daemon.url}/v1/health`,
					'--out',
					out,
				],
				env(),
			);

			expect(result.stderr).toBe('');
			expect(result.code).toBe(0);
			expect(JSON.parse(fs.readFileSync(out, 'utf-8')).aborted).toBe(false);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it.each([
		[['--target', 'no-kind=http://x/'], 'a target is NAME=KIND=URL'],
		[['--target', 'x=cdn=http://x/'], 'a target is NAME=KIND=URL'],
		[['--interval', '0'], '--interval must be above 0'],
		[['--interval', 'fast'], '--interval must be a number'],
		[['--duration', '-1'], '--duration must be a number'],
		[['--wat'], 'unknown argument: --wat'],
		[['--out'], '--out needs a value'],
	])('exits 2 for the arguments %j', async (args, message) => {
		const result = await bash(script, args, env());

		expect(result.code).toBe(2);
		expect(result.stderr).toContain(message);
	});
});

/** The numbers of a probe summary that the thresholds are about. */
interface ProbeSummary {
	aborted: boolean;
	reason: string | null;
	samples: number;
	targets: Record<string, { n: number; p95Ms: number | null; maxMs: number | null; non200: number }>;
	hostAvailableMinMiB: number | null;
	swapInPagesPerSecMax: number | null;
	cpuPressureSomeAvg10Max: number | null;
}

describe.skipIf(!(haveCurl && haveJq))('the thresholds of neighbor-probe.sh, against a real server', () => {
	const script = path.join(DEPLOY, 'neighbor-probe.sh');
	const env = (): Record<string, string> => ({ PATH: pathWithoutDocker(), HOME: tempDir('hed-lsp-home-') });

	/** Run the probe against one scripted target, and return what it did. */
	async function probe(
		plan: (n: number) => Answer,
		args: string[] = [],
	): Promise<{ code: number; stderr: string; summary: ProbeSummary; served: number }> {
		const server = await startScriptedServer(plan);
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		try {
			const result = await bash(
				script,
				['--interval', '1', '--target', `neighbor=loopback=${server.url}/`, '--out', out, ...args],
				env(),
			);
			return {
				code: result.code,
				stderr: result.stderr,
				summary: JSON.parse(fs.readFileSync(out, 'utf-8')),
				served: server.requests(),
			};
		} finally {
			await server.stop();
		}
	}

	it('aborts when the neighbor takes 1.5 s to answer, which is over the limit of 1 s, though it answered 200', async () => {
		const run = await probe(() => ({ delayMs: 1500 }));

		expect(run.code).toBe(1);
		const took = /ABORT: neighbor took (\d+)\.\d ms, over 1000 ms/.exec(run.stderr);
		expect(took).not.toBeNull();
		expect(Number(took?.[1])).toBeGreaterThanOrEqual(1500);
		expect(run.summary.aborted).toBe(true);
		expect(run.summary.reason).toContain('took');
		expect(run.summary.samples).toBe(1);
		expect(run.summary.targets.neighbor.non200).toBe(0);
		expect(run.summary.targets.neighbor.p95Ms).toBeGreaterThanOrEqual(1500);
		expect(run.served).toBe(1);
	}, 30_000);

	it('does not abort for a neighbor that answers at once, or in 0.6 s, which is under the limit', async () => {
		const fast = await probe(() => ({}), ['--duration', '3']);
		const slowish = await probe(() => ({ delayMs: 600 }), ['--duration', '3']);

		expect(fast.code).toBe(0);
		expect(fast.summary.aborted).toBe(false);
		expect(fast.summary.samples).toBeGreaterThanOrEqual(3);
		expect(fast.summary.targets.neighbor.maxMs).toBeLessThan(500);
		expect(slowish.code).toBe(0);
		expect(slowish.summary.aborted).toBe(false);
		expect(slowish.summary.targets.neighbor.p95Ms).toBeGreaterThanOrEqual(600);
		expect(slowish.summary.targets.neighbor.p95Ms).toBeLessThan(1000);
	}, 60_000);

	it('aborts in a later round, and stops asking, when a neighbor that was fast turns slow', async () => {
		const run = await probe((n) => ({ delayMs: n <= 2 ? 0 : 1500 }));

		expect(run.code).toBe(1);
		expect(run.stderr).toContain('ABORT: neighbor took');
		expect(run.summary.samples).toBe(3);
		expect(run.summary.targets.neighbor.n).toBe(3);
		expect(run.summary.targets.neighbor.p95Ms).toBeGreaterThanOrEqual(1500);
		expect(run.served).toBe(3);
	}, 30_000);

	it('aborts on the first answer that is not 200, counts it, and stops asking, when a neighbor starts to fail', async () => {
		const run = await probe((n) => ({ status: n <= 2 ? 200 : 503 }));

		expect(run.code).toBe(1);
		expect(run.stderr).toContain('ABORT: neighbor answered 503, not 200');
		expect(run.summary.samples).toBe(3);
		expect(run.summary.targets.neighbor.non200).toBe(1);
		expect(run.served).toBe(3);
	}, 30_000);

	it('aborts after 3 s, the time the probe waits at most, for a neighbor that never answers', async () => {
		const run = await probe(() => ({ delayMs: 60_000 }));

		expect(run.code).toBe(1);
		expect(run.stderr).toContain('ABORT: neighbor answered 000, not 200');
		expect(run.summary.targets.neighbor.non200).toBe(1);
		expect(run.summary.targets.neighbor.p95Ms).toBeGreaterThanOrEqual(3000);
		expect(run.summary.targets.neighbor.p95Ms).toBeLessThan(10_000);
	}, 30_000);
});

// The memory, swap, and pressure counters are read from /proc, which only Linux has. The tests of the
// numbers read the real files and are skipped, with the reason in their names, where there is none (macOS);
// the test of the other branch, a machine without /proc, runs only there.
const hasProc = fs.existsSync('/proc/meminfo') && fs.existsSync('/proc/vmstat');
const hasPressure = fs.existsSync('/proc/pressure/cpu');

/** MemAvailable of the real /proc/meminfo, in whole MiB, as the probe reads it. */
function memAvailableMiB(): number {
	const found = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf-8'));
	return Math.floor(Number(found?.[1]) / 1024);
}

/** The "some" avg10 figure of the real /proc/pressure/cpu. */
function cpuPressureSomeAvg10(): number {
	const found = /^some .*avg10=([0-9.]+)/m.exec(fs.readFileSync('/proc/pressure/cpu', 'utf-8'));
	return Number(found?.[1]);
}

describe.skipIf(!(haveCurl && haveJq))('the /proc counters of neighbor-probe.sh', () => {
	const script = path.join(DEPLOY, 'neighbor-probe.sh');

	/** Seven rounds, half a second apart, against a server that answers at once. */
	async function sample(): Promise<{ summary: ProbeSummary; before: number[]; after: number[] }> {
		const server = await startScriptedServer(() => ({}));
		const out = path.join(tempDir('hed-lsp-probe-'), 'summary.json');
		const read = (): number[] => [
			hasProc ? memAvailableMiB() : Number.NaN,
			hasPressure ? cpuPressureSomeAvg10() : Number.NaN,
		];
		try {
			const before = read();
			await bash(
				script,
				['--interval', '0.5', '--duration', '3', '--target', `neighbor=loopback=${server.url}/`, '--out', out],
				{ PATH: pathWithoutDocker(), HOME: tempDir('hed-lsp-home-') },
			);
			return { summary: JSON.parse(fs.readFileSync(out, 'utf-8')), before, after: read() };
		} finally {
			await server.stop();
		}
	}

	it.skipIf(!hasProc)(
		'reads MemAvailable and the swap-in counter of the real /proc (skipped without /proc, as on macOS)',
		async () => {
			const { summary, before, after } = await sample();

			const [memoryBefore, memoryAfter] = [before[0], after[0]];
			// The probe keeps the lowest MemAvailable it saw, in whole MiB, so it is close to what the file said at the
			// start and the end; a unit slip (kB for MiB) or another field would be far off.
			expect(Number.isInteger(summary.hostAvailableMinMiB)).toBe(true);
			expect(summary.hostAvailableMinMiB as number).toBeLessThanOrEqual(Math.max(memoryBefore, memoryAfter) * 1.25);
			expect(summary.hostAvailableMinMiB as number).toBeGreaterThanOrEqual(Math.min(memoryBefore, memoryAfter) * 0.1);
			if (summary.aborted) {
				// A machine that is short of memory or swapping aborts, and then it names the threshold it crossed.
				expect(summary.reason).toMatch(/host memory available is \d+ MiB, under 1024 MiB|swap-in averages/);
			} else {
				// Seven rounds fill the window of five, so the rate of pages read back from swap was worked out, and
				// it is under the limit of 50 pages a second, because the probe did not abort.
				expect(typeof summary.swapInPagesPerSecMax).toBe('number');
				expect(summary.swapInPagesPerSecMax as number).toBeGreaterThanOrEqual(0);
				expect(summary.swapInPagesPerSecMax as number).toBeLessThan(50);
			}
		},
		60_000,
	);

	it.skipIf(!hasProc || !hasPressure)(
		'reads the CPU pressure of the real /proc/pressure/cpu (skipped without it)',
		async () => {
			const { summary, before, after } = await sample();

			const [pressureBefore, pressureAfter] = [before[1], after[1]];
			expect(typeof summary.cpuPressureSomeAvg10Max).toBe('number');
			expect(summary.cpuPressureSomeAvg10Max as number).toBeGreaterThanOrEqual(0);
			expect(summary.cpuPressureSomeAvg10Max as number).toBeLessThanOrEqual(100);
			// The highest avg10 of the run is not far under what the file said at the start and the end.
			expect(summary.cpuPressureSomeAvg10Max as number).toBeGreaterThanOrEqual(
				Math.min(pressureBefore, pressureAfter) - 5,
			);
		},
		60_000,
	);

	it.skipIf(!hasProc || hasPressure)(
		'leaves the CPU pressure null on a Linux kernel without /proc/pressure/cpu',
		async () => {
			const { summary } = await sample();

			expect(summary.cpuPressureSomeAvg10Max).toBeNull();
			expect(typeof summary.hostAvailableMinMiB === 'number' || summary.aborted).toBe(true);
		},
		60_000,
	);

	it.skipIf(hasProc)(
		'skips the three counters on a machine without /proc, as macOS, and still probes (skipped on Linux)',
		async () => {
			const { summary } = await sample();

			expect(summary.hostAvailableMinMiB).toBeNull();
			expect(summary.swapInPagesPerSecMax).toBeNull();
			expect(summary.cpuPressureSomeAvg10Max).toBeNull();
			expect(summary.aborted).toBe(false);
			expect(summary.samples).toBeGreaterThanOrEqual(5);
		},
		60_000,
	);
});

describe('measure.sh', () => {
	const script = path.join(DEPLOY, 'measure.sh');
	const IMAGE = `sha256:${'5e'.repeat(32)}`;
	const withPin = (pin: string): Record<string, string> =>
		envFor(stateDirWith(`HED_LSP_SEMANTIC=0\nHED_LSP_IMAGE_ID=${pin}\n`));

	it('prints the harness command for the S0 concurrency-4 step, and calls no Docker', async () => {
		const env = withPin(IMAGE);

		const result = await bash(script, ['--dry-run', 's0-c4'], { ...env, HED_LSP_REPO_DIR: '/srv/hed-lsp' });

		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Image under test: ${IMAGE}`);
		const harness = result.stdout.split('\n').find((line) => line.startsWith('+ docker run'));
		expect(harness).toBeDefined();
		expect(harness).toContain(
			// --init: without an init process the harness is PID 1 and ignores Ctrl-C and `docker stop`.
			'+ docker run --rm --init --name hed-lsp-load --network host --cpus 0.2 --memory 256m -v /srv/hed-lsp/server/eval:/corpus:ro ' +
				`--entrypoint node ${IMAGE} out/daemon/loadTest.js --url http://127.0.0.1:38530 --corpus /corpus/hed-examples-pairs.json ` +
				'--concurrency 4 --duration 60 --mix suggest=65,validate=35 --clients 64 > ',
		);
		expect(result.stdout).toContain('bun scripts/check-load-report.ts --profile s0 TIME-s0-c4.json');
		// The probe runs beside the load and kills the harness container on a breach.
		expect(result.stdout).toContain('neighbor-probe.sh --abort-container hed-lsp-load --out ');
	});

	it('bounds the probe by the length of its step, for the case that the script is killed and cannot clean up', async () => {
		const full = await bash(script, ['--dry-run', 's0-c4', 's1-soak'], withPin(IMAGE));
		const rehearsal = await bash(script, ['--dry-run', '--rehearsal', '5', 's0-c4'], withPin(IMAGE));

		const probe = (text: string, step: string): string | undefined =>
			text
				.split('\n')
				.find((line) => line.includes('neighbor-probe.sh') && line.includes(`TIME-${step}.neighbors.json`));
		expect(probe(full.stdout, 's0-c4')).toMatch(/--tsv \S+ --duration 360 ?$/);
		expect(probe(full.stdout, 's1-soak')).toMatch(/--tsv \S+ --duration 2100 ?$/);
		expect(probe(rehearsal.stdout, 's0-c4')).toMatch(/--tsv \S+ --duration 305 ?$/);
	});

	it('says that it stops the probe and the load on Ctrl-C, on a signal, and on exit', async () => {
		const result = await bash(script, ['--dry-run', 's0-c4'], withPin(IMAGE));

		expect(result.stdout).toContain(
			'On Ctrl-C, SIGTERM, SIGHUP, or any exit, it stops the probe and the sampler and runs: docker kill hed-lsp-load',
		);
	});

	// What the traps do to a running probe and a running container needs Docker and the host, so it is
	// rehearsed there (step 10 of the runbook: start a rehearsal, press Ctrl-C, look for leftovers). This
	// only keeps the pieces from being dropped: the traps for the four ways out, the kill of the load
	// container, and a harness that is waited for, because a trap waits for a foreground command to end.
	it('keeps the traps, the kill of the load container, and the waited-for harness in the script', () => {
		const source = fs.readFileSync(script, 'utf-8');

		expect(source).toMatch(/^trap cleanup EXIT$/m);
		expect(source).toMatch(/^trap '[^']*exit 130' INT$/m);
		expect(source).toMatch(/^trap '[^']*exit 143' TERM$/m);
		expect(source).toMatch(/^trap '[^']*exit 129' HUP$/m);
		expect(source).toMatch(/docker kill "\$LOAD_CONTAINER"/);
		expect(source).toMatch(/"\$\{HARNESS\[@\]\}" >"\$base\.json" &\n\s+HARNESS_PID=\$!\n\s+wait "\$HARNESS_PID"/);
		expect(source.indexOf('trap cleanup EXIT')).toBeGreaterThan(source.indexOf('the container $LOAD_CONTAINER exists'));
	});

	it('runs a group in the order of the runbook, with the options of each step', async () => {
		const s0 = await bash(script, ['--dry-run', 's0'], withPin(IMAGE));
		const s1 = await bash(script, ['--dry-run', 's1'], withPin(IMAGE));

		const steps = (text: string): string[] =>
			text
				.split('\n')
				.filter((line) => /^# s\d-/.test(line))
				.map((line) => line.split(':')[0]);
		expect(steps(s0.stdout)).toEqual(['# s0-c1', '# s0-c4', '# s0-c8', '# s0-overload']);
		expect(steps(s1.stdout)).toEqual(['# s1-mixed', '# s1-capacity', '# s1-realistic', '# s1-soak']);
		expect(s0.stdout).toContain('--concurrency 12 --duration 60 --mix suggest=65,validate=35');
		expect(s0.stdout).toContain('profile s0-overload, semantic search off');
		expect(s1.stdout).toContain(
			'--concurrency 4 --duration 300 --mix suggest=60,validate=30,semantic=10 --clients 64 --semantic-top 50',
		);
		expect(s1.stdout).toContain('--duration 120 --mix semantic=1 --clients 64 --semantic-top 50 --reach-check');
		expect(s1.stdout).toContain(
			'--duration 120 --mix suggest=60,validate=30,semantic=10 --clients 64 --semantic-top 10 --semantic-batch 10',
		);
		expect(s1.stdout).toContain('--concurrency 1 --duration 1800');
	});

	it('refuses HED_LSP_PROBE_TARGETS outside a rehearsal, because a run that watched other targets protected no neighbor', async () => {
		const targets = 'daemon=loopback=http://127.0.0.1:1/health';

		const real = await bash(script, ['--dry-run', 's0-c4'], { ...withPin(IMAGE), HED_LSP_PROBE_TARGETS: targets });
		const rehearsal = await bash(script, ['--dry-run', '--rehearsal', '5', 's0-c4'], {
			...withPin(IMAGE),
			HED_LSP_PROBE_TARGETS: targets,
		});

		expect(real.code).toBe(1);
		expect(real.stdout).toBe('');
		expect(real.stderr).toContain('HED_LSP_PROBE_TARGETS replaces the neighbors that the probe watches');
		expect(real.stderr).toContain('add --rehearsal, or unset it');
		expect(rehearsal.code).toBe(0);
	});

	it('shortens every step for a rehearsal, and names the files so', async () => {
		const result = await bash(script, ['--dry-run', '--rehearsal', '5', 's1-soak', 's0-c1'], withPin(IMAGE));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('--concurrency 1 --duration 5 --mix suggest=60');
		expect(result.stdout).not.toContain('1800');
		// The files of a rehearsal are judged only with --rehearsal, so the hint says so; a real run's does not.
		expect(result.stdout).toContain(
			'# then: bun scripts/check-load-report.ts --profile s0 --rehearsal TIME-s0-c1.json',
		);
		expect((await bash(script, ['--dry-run', 's0-c1'], withPin(IMAGE))).stdout).toContain(
			'# then: bun scripts/check-load-report.ts --profile s0 TIME-s0-c1.json',
		);
	});

	it.each([
		['an empty pin', ''],
		['a tag', 'hed-lsp-daemon:ci'],
		['a short ID', 'sha256:5e5e5e5e'],
		['an ID in capitals', `sha256:${'5E'.repeat(32)}`],
	])('refuses to measure with %s as the image', async (_label, pin) => {
		const result = await bash(script, ['--dry-run', 's0-c4'], withPin(pin));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('set HED_LSP_IMAGE_ID=sha256:<64 hex digits>');
		expect(result.stdout).toBe('');
	});

	it('refuses to measure when the env file has no pin line at all', async () => {
		const result = await bash(script, ['s0-c4'], envFor(stateDirWith('HED_LSP_SEMANTIC=0\n')));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("it is 'empty'");
	});

	it('refuses a real run without Docker, after it has read the pin', async () => {
		const result = await bash(script, ['s0-c4'], withPin(IMAGE));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('docker is not installed');
	});

	it.each([
		[[], 'name at least one step'],
		[['s9'], "unknown step 's9'"],
		[['--bogus', 's0'], 'unknown option: --bogus'],
		[['--rehearsal'], '--rehearsal needs a value'],
		[['--rehearsal', '0', 's0'], '--rehearsal must be a whole number'],
		[['--rehearsal', 'x', 's0'], '--rehearsal must be a whole number'],
	])('refuses the arguments %j', async (args, message) => {
		const result = await bash(script, ['--dry-run', ...args], withPin(IMAGE));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(message);
	});

	it('names what a rehearsal may do with a degraded daemon in its dry run, and what a run on the host needs', async () => {
		const rehearsal = await bash(script, ['--dry-run', '--rehearsal', '5', 's0-c4'], withPin(IMAGE));
		const real = await bash(script, ['--dry-run', 's0-c4'], withPin(IMAGE));

		expect(rehearsal.stdout).toContain('that its health is ok (or degraded, for a rehearsal),');
		expect(real.stdout).toContain('that its health is ok,');
		expect(real.stdout).not.toContain('degraded');
	});

	// The health gate sits behind the Docker checks of a real run, which need the container of the host: the
	// container must run the pinned image. So its function is run as it ships, text and all, with the real curl and
	// jq, against a real daemon. The whole run is rehearsed by the image job of CI, which also reads the status
	// back from the host file.
	describe.skipIf(!(haveCurl && haveJq))('the health gate', () => {
		/** The text of a top-level shell function of the script, from `name() {` to its closing brace. */
		function shellFunction(name: string): string {
			const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(fs.readFileSync(script, 'utf-8'));
			if (!found) {
				throw new Error(`measure.sh has no function ${name}`);
			}
			return found[0];
		}

		/** Run the gate against a daemon at `url`, as a rehearsal of `rehearsal` seconds, or on the host when empty. */
		function gate(url: string, rehearsal: string): Promise<{ code: number; stdout: string; stderr: string }> {
			const program = [
				'set -euo pipefail',
				`DAEMON_URL='${url}'`,
				`REHEARSAL='${rehearsal}'`,
				'HEALTH_STATUS=""',
				shellFunction('die'),
				shellFunction('health_field'),
				shellFunction('require_health'),
				'require_health',
				'echo "status kept: $HEALTH_STATUS"',
			].join('\n');
			return run(onPath('bash'), ['-c', program], { PATH: pathWithoutDocker(), HOME: tempDir('hed-lsp-home-') });
		}

		/** A daemon that really is degraded: a library schema that does not exist cannot load. */
		async function startDegraded(): Promise<RunningDaemon> {
			const daemon = await startDaemon({
				HED_LSP_SCHEMAS: '8.4.0;8.4.0,sc:score_9.9.9',
				HED_LSP_DEFAULT_SCHEMA: '8.4.0',
			});
			await waitFor(async () => (await call(daemon.url, '/v1/health')).json.status === 'degraded', 10_000, 'degraded');
			return daemon;
		}

		/** An address on this machine that had a free port a moment ago and has nothing on it now. */
		async function closedAddress(): Promise<string> {
			const server = net.createServer();
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const { port } = server.address() as AddressInfo;
			await new Promise((resolve) => server.close(resolve));
			return `http://127.0.0.1:${port}`;
		}

		it.each([
			['a run on the host', ''],
			['a rehearsal', '5'],
		])(
			'goes on without a word for a daemon that answers ok: %s',
			async (_label, rehearsal) => {
				const daemon = await startDaemon();
				try {
					const result = await gate(daemon.url, rehearsal);

					expect(result.stderr).toBe('');
					expect(result.code).toBe(0);
					expect(result.stdout).toBe('status kept: ok\n');
				} finally {
					await daemon.stop();
				}
			},
			60_000,
		);

		it('stops a run on the host at degraded, and says that it saw degraded', async () => {
			const daemon = await startDegraded();
			try {
				const result = await gate(daemon.url, '');

				expect(result.code).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain(`does not answer health with status ok at ${daemon.url}`);
				expect(result.stderr).toContain('it answered status degraded');
			} finally {
				await daemon.stop();
			}
		}, 60_000);

		it('goes on in a rehearsal at degraded, says so, and keeps the status for the host file', async () => {
			const daemon = await startDegraded();
			try {
				const result = await gate(daemon.url, '5');

				expect(result.stderr).toBe('');
				expect(result.code).toBe(0);
				expect(result.stdout).toContain('note: the daemon answers health with status degraded');
				expect(result.stdout).toContain('a rehearsal checks the scripts and not the schema');
				expect(result.stdout).toContain('status kept: degraded\n');
			} finally {
				await daemon.stop();
			}
		}, 60_000);

		it.each([
			['a run on the host', ''],
			['a rehearsal', '5'],
		])(
			'stops at a daemon that is still starting, and says that it saw no status: %s',
			async (_label, rehearsal) => {
				// A daemon that has not loaded its schema answers health with 503, which is no status at all.
				const daemon = await startDaemon({}, { autoPreload: false });
				try {
					expect((await call(daemon.url, '/v1/health')).status).toBe(503);

					const result = await gate(daemon.url, rehearsal);

					expect(result.code).toBe(1);
					expect(result.stderr).toContain(`does not answer health with status ok at ${daemon.url}`);
					expect(result.stderr).toContain('it answered no status');
				} finally {
					await daemon.stop();
				}
			},
			60_000,
		);

		it('stops at an address where nothing listens, and says that it saw no status', async () => {
			const url = await closedAddress();

			const result = await gate(url, '5');

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`does not answer health with status ok at ${url}`);
			expect(result.stderr).toContain('it answered no status');
		}, 60_000);

		it('writes the status that the gate saw into the host file, next to the commit', () => {
			const source = fs.readFileSync(script, 'utf-8');

			expect(source).toContain('--arg healthStatus "$HEALTH_STATUS"');
			expect(source).toMatch(/envSha256: \$envSha,\n\s+healthStatus: \$healthStatus,/);
		});
	});

	it('prints its usage for --help', async () => {
		const result = await bash(script, ['--help'], withPin(IMAGE));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Usage: measure.sh [--dry-run]');
		expect(result.stdout).toContain('refuses to run');
		expect(result.stdout).toContain('emergency stop');
		expect(result.stdout).toContain('docker kill hed-lsp-load');
	});
});
