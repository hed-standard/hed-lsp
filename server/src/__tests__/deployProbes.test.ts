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
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startDaemon } from './daemonHarness.js';
import {
	bash,
	DEPLOY,
	envFor,
	findOnPath,
	onPath,
	pathWithoutDocker,
	removeTempDirs,
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
/** A daemon that trusts no one, so it ignores X-Forwarded-For, as it does behind a proxy that is not trusted. */
const NOT_TRUSTING = { ...DEFAULT_RATES, HED_LSP_TRUSTED_PROXIES: '' };

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
			// Docker was not on the PATH, so its checks did not run and nothing was unhealthy.
			expect(summary.dockerHealthy).toBe(true);
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

describe('measure.sh', () => {
	const script = path.join(DEPLOY, 'measure.sh');
	const IMAGE = `sha256:${'5e'.repeat(32)}`;
	const withPin = (pin: string): Record<string, string> =>
		envFor(stateDirWith(`HED_LSP_SEMANTIC=0\nHED_LSP_IMAGE_ID=${pin}\n`));

	it('prints the harness command of the plan for the S0 concurrency-4 step, and calls no Docker', async () => {
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

	it('runs a group in the order of the plan, with the options of each step', async () => {
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

	it('shortens every step for a rehearsal, and names the files so', async () => {
		const result = await bash(script, ['--dry-run', '--rehearsal', '5', 's1-soak', 's0-c1'], withPin(IMAGE));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('--concurrency 1 --duration 5 --mix suggest=60');
		expect(result.stdout).not.toContain('1800');
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

	it('prints its usage for --help', async () => {
		const result = await bash(script, ['--help'], withPin(IMAGE));

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Usage: measure.sh [--dry-run]');
		expect(result.stdout).toContain('refuses to run');
		expect(result.stdout).toContain('emergency stop');
		expect(result.stdout).toContain('docker kill hed-lsp-load');
	});
});
