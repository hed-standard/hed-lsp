/**
 * Tests for scripts/check-load-report.ts, which judges a report of the load harness against the criteria of
 * the hedtools deployment. The reports are real: the compiled harness runs against a real daemon with the
 * real engine and the real evaluation set, and the script is run as a Bun process on the file it wrote. A
 * deliberately bad report is that report with its numbers made worse. The host files, which measure.sh
 * writes on the host, are written by hand here, with values worked out for each criterion. No mocks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, compiled, startDaemon } from './daemonHarness.js';
import { bash, DEPLOY, findOnPath, pathWithoutDocker, removeTempDirs, run, SCRIPTS, tempDir } from './scriptHarness.js';

afterAll(removeTempDirs);

const bun = findOnPath('bun');
const script = path.join(SCRIPTS, 'check-load-report.ts');

interface Verdict {
	verdict: 'pass' | 'fail' | 'skip';
	criterion: string;
	detail: string;
}

/** Run the script; `--json` output is parsed when asked. */
async function check(args: string[]): Promise<{ code: number; stdout: string; stderr: string; results: Verdict[] }> {
	const result = await run(bun as string, [script, ...args], {
		PATH: process.env.PATH ?? '',
		HOME: tempDir('hed-lsp-home-'),
	});
	let results: Verdict[] = [];
	if (args.includes('--json')) {
		results = JSON.parse(result.stdout).results;
	}
	return { ...result, results };
}

const verdictOf = (results: Verdict[], criterion: string): Verdict['verdict'] | undefined =>
	results.find((result) => result.criterion === criterion)?.verdict;

describe.skipIf(!bun)('check-load-report.ts', () => {
	let dir: string;
	let mixed: string;
	let capacity: string;
	let full: string;
	/** Reports of a daemon that refuses requests: the 429 answers of a limited client, and the OVERLOADED 503 answers. */
	let limited: string;
	let overloaded: string;
	let report: any;

	/** Run the compiled harness against the daemon and return the file it wrote. */
	async function harness(url: string, name: string, args: string[], clients = '64'): Promise<string> {
		const out = path.join(dir, name);
		const result = await run(
			process.execPath,
			[compiled('loadTest.js'), '--url', url, '--clients', clients, '--duration', '1.5', '--out', out, ...args],
			childEnv(),
		);
		expect(result.code).toBe(0);
		return out;
	}

	beforeAll(async () => {
		dir = tempDir('hed-lsp-report-');
		const daemon = await startDaemon();
		try {
			mixed = await harness(daemon.url, 'mixed.json', ['--concurrency', '2', '--mix', 'suggest=65,validate=35']);
			capacity = await harness(daemon.url, 'capacity.json', [
				'--concurrency',
				'2',
				'--mix',
				'semantic=1',
				'--semantic-top',
				'50',
				'--reach-check',
			]);
			full = await harness(daemon.url, 'full.json', ['--concurrency', '2']);
		} finally {
			await daemon.stop();
		}
		// Real refusals: a bucket of 50 units at 10 units a request limits one client from the sixth request on,
		// and one request in flight for each client refuses the second of sixteen workers that share an address.
		const limiting = await startDaemon({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '50' });
		const crowded = await startDaemon({ HED_LSP_MAX_IN_FLIGHT_PER_CLIENT: '1' });
		try {
			limited = await harness(limiting.url, 'limited.json', ['--concurrency', '1', '--mix', 'validate=1'], '1');
			overloaded = await harness(crowded.url, 'overloaded.json', ['--concurrency', '16', '--mix', 'suggest=1'], '1');
		} finally {
			await limiting.stop();
			await crowded.stop();
		}
		report = JSON.parse(fs.readFileSync(mixed, 'utf-8'));
	}, 120_000);

	/** A copy of the real report with `edit` applied, written beside it. */
	function worsened(name: string, edit: (copy: any) => void, from = mixed): string {
		const copy = JSON.parse(fs.readFileSync(from, 'utf-8'));
		edit(copy);
		const file = path.join(dir, name);
		fs.writeFileSync(file, JSON.stringify(copy));
		return file;
	}

	it('judges a real report: the latency lines carry its numbers, and the exit status follows the limits', async () => {
		const result = await check(['--profile', 's0', '--no-host', mixed]);

		for (const name of ['suggest', 'validate'] as const) {
			const { p95, p99 } = report.endpoints[name].latencyMs;
			expect(result.stdout).toContain(`non-semantic ${name} p95: ${p95} ms`);
			expect(result.stdout).toContain(`non-semantic ${name} p99: ${p99} ms`);
			const lines = result.stdout.split('\n');
			expect(
				lines.find((line) => line.includes(`non-semantic ${name} p95`))?.startsWith(p95 <= 100 ? 'PASS' : 'FAIL'),
			).toBe(true);
			expect(
				lines.find((line) => line.includes(`non-semantic ${name} p99`))?.startsWith(p99 <= 300 ? 'PASS' : 'FAIL'),
			).toBe(true);
		}
		expect(result.stdout).toMatch(/PASS {2}5xx other than SEMANTIC_BUSY: 0/);
		expect(result.stdout).toMatch(/PASS {2}429 answers: 0/);
		expect(result.stdout).toMatch(/SKIP {2}host measurements: skipped by --no-host/);
		const latencyHolds = (['suggest', 'validate'] as const).every(
			(name) => report.endpoints[name].latencyMs.p95 <= 100 && report.endpoints[name].latencyMs.p99 <= 300,
		);
		expect(result.code).toBe(latencyHolds ? 0 : 1);
	});

	describe('the overload step', () => {
		const reached = 'the overload was reached';

		it('passes the real report of an overloaded daemon: OVERLOADED answers, each with a Retry-After, and nothing else', async () => {
			const refused = JSON.parse(fs.readFileSync(overloaded, 'utf-8')).overall.rejections['503'].OVERLOADED;

			const result = await check(['--profile', 's0-overload', '--no-host', overloaded]);

			expect(refused).toBeGreaterThan(0);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(`only OVERLOADED rejections: ${refused} OVERLOADED 503 answers`);
			expect(result.stdout).toContain(
				`${reached}: ${refused} OVERLOADED 503 answers with a Retry-After of at least 1 s`,
			);
			expect(result.stdout).toContain('all criteria of s0-overload pass');
		});

		it('fails a run in which every answer was a 200, because the daemon was never overloaded', async () => {
			const result = await check(['--profile', 's0-overload', '--no-host', '--json', mixed]);

			expect(result.code).toBe(1);
			expect(verdictOf(result.results, 'only OVERLOADED rejections')).toBe('pass');
			expect(verdictOf(result.results, reached)).toBe('fail');
			expect(result.results.find((r) => r.criterion === reached)?.detail).toContain('no OVERLOADED 503 answer');
		});

		it('fails OVERLOADED answers that lack a Retry-After, and a report that does not record it', async () => {
			const refused = JSON.parse(fs.readFileSync(overloaded, 'utf-8')).overall.rejections['503'].OVERLOADED;
			const lacking = worsened(
				'overload-no-retry.json',
				(copy) => {
					copy.overall.withoutRetryAfter['503'] = { OVERLOADED: refused };
				},
				overloaded,
			);
			const unrecorded = worsened(
				'overload-unrecorded.json',
				(copy) => {
					delete copy.overall.withoutRetryAfter;
				},
				overloaded,
			);

			const a = await check(['--profile', 's0-overload', '--no-host', '--json', lacking]);
			const b = await check(['--profile', 's0-overload', '--no-host', '--json', unrecorded]);

			expect(verdictOf(a.results, reached)).toBe('fail');
			expect(a.results.find((r) => r.criterion === reached)?.detail).toContain('none with an integer Retry-After');
			expect(verdictOf(b.results, reached)).toBe('fail');
			expect(b.results.find((r) => r.criterion === reached)?.detail).toContain('does not record their Retry-After');
			expect(a.code).toBe(1);
			expect(b.code).toBe(1);
		});

		it('is reached by one OVERLOADED answer with a Retry-After, even when others lack one', async () => {
			const one = worsened(
				'overload-one.json',
				(copy) => {
					copy.overall.rejections['503'] = { OVERLOADED: 5 };
					copy.overall.status['503'] = 5;
					copy.overall.withoutRetryAfter['503'] = { OVERLOADED: 4 };
				},
				overloaded,
			);

			const result = await check(['--profile', 's0-overload', '--no-host', '--json', one]);

			expect(verdictOf(result.results, reached)).toBe('pass');
			// The other four are still a failure of the criterion that every refusal carries one.
			expect(verdictOf(result.results, 'Retry-After on 429 and 503 answers')).toBe('fail');
		});

		it.each([
			['a 500', { '500': 1 }],
			['a 502', { '502': 2 }],
			['a 504', { '504': 1 }],
		])('fails %s next to the OVERLOADED answers', async (_label, extra) => {
			const bad = worsened(
				`overload-5xx-${Object.keys(extra)[0]}.json`,
				(copy) => {
					Object.assign(copy.overall.status, extra);
				},
				overloaded,
			);

			const result = await check(['--profile', 's0-overload', '--no-host', '--json', bad]);

			expect(verdictOf(result.results, 'only OVERLOADED rejections')).toBe('fail');
			expect(verdictOf(result.results, reached)).toBe('pass');
			expect(result.code).toBe(1);
		});
	});

	it('fails a deliberately bad report, and names each criterion it breaks', async () => {
		const bad = worsened('bad.json', (copy) => {
			copy.overall.status['500'] = 3;
			copy.overall.status['429'] = 5;
			copy.endpoints.suggest.latencyMs.p95 = 900;
			copy.endpoints.validate.latencyMs.p99 = 2000;
		});

		const result = await check(['--profile', 's0', '--no-host', '--json', bad]);

		expect(result.code).toBe(1);
		expect(verdictOf(result.results, '5xx other than SEMANTIC_BUSY')).toBe('fail');
		expect(verdictOf(result.results, '429 answers')).toBe('fail');
		expect(verdictOf(result.results, 'non-semantic suggest p95')).toBe('fail');
		expect(verdictOf(result.results, 'non-semantic validate p99')).toBe('fail');
		expect(verdictOf(result.results, 'the run was answered')).toBe('pass');
		const human = await check(['--profile', 's0', '--no-host', bad]);
		expect(human.stdout).toContain('FAIL  5xx other than SEMANTIC_BUSY: 3, over the limit (none)');
		expect(human.stdout).toContain('FAIL  non-semantic suggest p95: 900 ms, over the limit (at most 100 ms)');
		expect(human.stdout).toMatch(/\d+ criteria of s0 fail\n$/);
	});

	describe('Retry-After on the refusals', () => {
		const criterion = 'Retry-After on 429 and 503 answers';
		const detailOf = (results: Verdict[]): string | undefined => results.find((r) => r.criterion === criterion)?.detail;

		it('passes the real refusals of a daemon, each of which carries one, and a run with no refusal', async () => {
			const refused429 = JSON.parse(fs.readFileSync(limited, 'utf-8')).overall.status['429'];
			const refused503 = JSON.parse(fs.readFileSync(overloaded, 'utf-8')).overall.status['503'];

			const rate = await check(['--profile', 's0', '--no-host', '--json', limited]);
			const busy = await check(['--profile', 's0-overload', '--no-host', '--json', overloaded]);
			const none = await check(['--profile', 's0', '--no-host', '--json', mixed]);

			expect(refused429).toBeGreaterThan(0);
			expect(refused503).toBeGreaterThan(0);
			expect(verdictOf(rate.results, criterion)).toBe('pass');
			expect(detailOf(rate.results)).toContain(`${refused429} refusals`);
			expect(verdictOf(busy.results, criterion)).toBe('pass');
			expect(detailOf(busy.results)).toContain(`${refused503} refusals`);
			expect(detailOf(none.results)).toBe('no 429 or 503 answer');
		});

		it('fails a 429 or a 503 without an integer Retry-After of at least 1, and a report that does not record them', async () => {
			const refused429 = JSON.parse(fs.readFileSync(limited, 'utf-8')).overall.status['429'];
			const without429 = worsened(
				'retry-429.json',
				(copy) => {
					copy.overall.withoutRetryAfter['429'] = { RATE_LIMITED: 1 };
				},
				limited,
			);
			const without503 = worsened(
				'retry-503.json',
				(copy) => {
					copy.overall.withoutRetryAfter['503'] = { OVERLOADED: 2 };
				},
				overloaded,
			);
			const unrecorded = worsened(
				'retry-unrecorded.json',
				(copy) => {
					delete copy.overall.withoutRetryAfter;
				},
				limited,
			);

			const a = await check(['--profile', 's0', '--no-host', '--json', without429]);
			const b = await check(['--profile', 's0-overload', '--no-host', '--json', without503]);
			const c = await check(['--profile', 's0', '--no-host', '--json', unrecorded]);

			expect(verdictOf(a.results, criterion)).toBe('fail');
			expect(detailOf(a.results)).toContain(`1 of ${refused429} refusals have no integer Retry-After of at least 1 s`);
			expect(a.code).toBe(1);
			expect(verdictOf(b.results, criterion)).toBe('fail');
			expect(detailOf(b.results)).toMatch(/^2 of \d+ refusals have no integer Retry-After/);
			expect(verdictOf(c.results, criterion)).toBe('fail');
			expect(detailOf(c.results)).toContain('does not record their Retry-After');
		});
	});

	it('does not count a 429 against a run with fewer than 64 clients, and says so', async () => {
		const few = worsened('few-clients.json', (copy) => {
			copy.params.clients = 8;
			copy.overall.status['429'] = 40;
		});

		const result = await check(['--profile', 's0-overload', '--no-host', '--json', few]);

		expect(verdictOf(result.results, '429 answers')).toBe('skip');
		expect(result.results.find((r) => r.criterion === '429 answers')?.detail).toContain('the run used 8 clients');
	});

	it('accepts only OVERLOADED rejections in the overload profile', async () => {
		const overloaded = worsened('overloaded.json', (copy) => {
			copy.overall.status['503'] = 40;
			copy.overall.rejections['503'] = { OVERLOADED: 40 };
		});
		const mixedUp = worsened('mixed-up.json', (copy) => {
			copy.overall.status['503'] = 40;
			copy.overall.rejections['503'] = { OVERLOADED: 30, TIMEOUT: 10 };
		});
		const busy = worsened('busy.json', (copy) => {
			copy.overall.status['500'] = 1;
		});

		const fine = await check(['--profile', 's0-overload', '--no-host', '--json', overloaded]);
		const timeouts = await check(['--profile', 's0-overload', '--no-host', '--json', mixedUp]);
		const errors = await check(['--profile', 's0-overload', '--no-host', '--json', busy]);

		expect(verdictOf(fine.results, 'only OVERLOADED rejections')).toBe('pass');
		expect(verdictOf(timeouts.results, 'only OVERLOADED rejections')).toBe('fail');
		expect(timeouts.results.find((r) => r.criterion === 'only OVERLOADED rejections')?.detail).toContain(
			'10 other 503',
		);
		expect(verdictOf(errors.results, 'only OVERLOADED rejections')).toBe('fail');
	});

	it('judges the reach of a real capacity run, and knows that a daemon with semantic search off has not run the model', async () => {
		const result = await check(['--profile', 's1-capacity', '--no-host', '--json', capacity]);

		const reach = JSON.parse(fs.readFileSync(capacity, 'utf-8')).reach;
		expect(reach.top).toBe(50);
		expect(verdictOf(result.results, 'reach')).toBe(reach.share >= 0.95 ? 'pass' : 'fail');
		expect(result.results.find((r) => r.criterion === 'reach')?.detail).toContain(`${(reach.share * 100).toFixed(1)}%`);
		expect(verdictOf(result.results, 'semantic search ran')).toBe('fail');
		expect(result.results.find((r) => r.criterion === 'semantic search ran')?.detail).toContain('disabled');
		expect(verdictOf(result.results, 'capacity C')).toBe('skip');
		expect(result.code).toBe(1);
	});

	it('fails a reach check that left a query without an answer, and passes one that answered them all', async () => {
		const withErrors = (count: number) =>
			worsened(
				`reach-errors-${count}.json`,
				(copy) => {
					copy.reach.errors = count;
				},
				capacity,
			);

		const none = await check(['--profile', 's1-capacity', '--no-host', '--json', withErrors(0)]);
		const some = await check(['--profile', 's1-capacity', '--no-host', '--json', withErrors(3)]);
		const unrecorded = await check([
			'--profile',
			's1-capacity',
			'--no-host',
			'--json',
			worsened(
				'reach-no-errors.json',
				(copy) => {
					delete copy.reach.errors;
				},
				capacity,
			),
		]);

		expect(verdictOf(none.results, 'reach check answered every query')).toBe('pass');
		expect(verdictOf(some.results, 'reach check answered every query')).toBe('fail');
		expect(some.results.find((r) => r.criterion === 'reach check answered every query')?.detail).toContain(
			'3 of 206 queries without an answer',
		);
		expect(verdictOf(unrecorded.results, 'reach check answered every query')).toBe('fail');
		// The share itself is unchanged, so only the errors make this report fail.
		expect(verdictOf(some.results, 'reach')).toBe(verdictOf(none.results, 'reach'));
	});

	it('fails the capacity profile for a report without a reach, and judges SEMANTIC_BUSY against the semantic requests', async () => {
		const noReach = worsened(
			'no-reach.json',
			(copy) => {
				delete copy.reach;
				const semantic = copy.endpoints.semantic.requests;
				copy.overall.status['503'] = Math.ceil(semantic * 0.02);
				copy.overall.rejections['503'] = { SEMANTIC_BUSY: Math.ceil(semantic * 0.02) };
			},
			capacity,
		);

		const result = await check(['--profile', 's1-capacity', '--no-host', '--json', noReach]);

		expect(verdictOf(result.results, 'reach')).toBe('fail');
		expect(verdictOf(result.results, 'SEMANTIC_BUSY')).toBe('fail');
		expect(verdictOf(result.results, '5xx other than SEMANTIC_BUSY')).toBe('pass');
	});

	describe('the limits of the criteria table, to the last digit', () => {
		/** The verdict of one criterion for a copy of the report in which `edit` was applied. */
		async function verdictFor(
			profile: string,
			criterion: string,
			edit: (copy: any) => void,
			from = full,
		): Promise<string | undefined> {
			const file = worsened(`limit-${Math.random().toString(36).slice(2)}.json`, edit, from);
			return verdictOf((await check(['--profile', profile, '--no-host', '--json', file])).results, criterion);
		}

		it.each([
			['s0', 'non-semantic suggest p95', 'suggest', 'p95', 100],
			['s0', 'non-semantic suggest p99', 'suggest', 'p99', 300],
			['s0', 'non-semantic validate p95', 'validate', 'p95', 100],
			['s0', 'non-semantic validate p99', 'validate', 'p99', 300],
			['s1-mixed', 'semantic p95', 'semantic', 'p95', 500],
			['s1-mixed', 'semantic p99', 'semantic', 'p99', 1000],
			['s1-mixed', 'non-semantic suggest p95', 'suggest', 'p95', 100],
			['s1-mixed', 'non-semantic validate p99', 'validate', 'p99', 300],
		])('%s: %s passes at %d ms and fails above it', async (profile, criterion, endpoint, percentile, limit) => {
			const at = (value: number) => (copy: any) => {
				copy.endpoints[endpoint].latencyMs[percentile] = value;
			};

			expect(await verdictFor(profile, criterion, at(limit))).toBe('pass');
			expect(await verdictFor(profile, criterion, at(limit + 0.01))).toBe('fail');
		});

		it('SEMANTIC_BUSY passes at 1% of the semantic requests and fails above it, whatever else was rejected', async () => {
			const busy = (count: number) => (copy: any) => {
				copy.endpoints.semantic.requests = 2000;
				copy.overall.status['503'] = count;
				copy.overall.rejections['503'] = { SEMANTIC_BUSY: count };
			};

			expect(await verdictFor('s1-mixed', 'SEMANTIC_BUSY', busy(20))).toBe('pass');
			expect(await verdictFor('s1-mixed', 'SEMANTIC_BUSY', busy(21))).toBe('fail');
			// A busy answer is not a server error, but any other 5xx next to it is one.
			expect(await verdictFor('s1-mixed', '5xx other than SEMANTIC_BUSY', busy(3))).toBe('pass');
			expect(
				await verdictFor('s1-mixed', '5xx other than SEMANTIC_BUSY', (copy) => {
					busy(3)(copy);
					copy.overall.status['500'] = 1;
				}),
			).toBe('fail');
		});

		it('the reach passes at 95% and fails below it', async () => {
			const reach = (share: number) => (copy: any) => {
				copy.reach.share = share;
			};

			expect(await verdictFor('s1-capacity', 'reach', reach(0.95), capacity)).toBe('pass');
			expect(await verdictFor('s1-capacity', 'reach', reach(0.9499), capacity)).toBe('fail');
		});

		it('the rate-limit criterion starts at 64 clients', async () => {
			const limited = (clients: number) => (copy: any) => {
				copy.params.clients = clients;
				copy.overall.status['429'] = 1;
			};

			expect(await verdictFor('s0', '429 answers', limited(64))).toBe('fail');
			expect(await verdictFor('s0', '429 answers', limited(63))).toBe('skip');
		});

		it('a semantic answer other than ok means the model did not run', async () => {
			const status = (value: Record<string, number>) => (copy: any) => {
				copy.endpoints.semantic.semanticStatus = value;
			};

			expect(await verdictFor('s1-mixed', 'semantic search ran', status({ ok: 12 }))).toBe('pass');
			expect(await verdictFor('s1-mixed', 'semantic search ran', status({ ok: 12, loading: 1 }))).toBe('fail');
			expect(await verdictFor('s1-mixed', 'semantic search ran', status({}))).toBe('fail');
		});
	});

	describe('the host file that measure.sh writes', () => {
		const good = {
			rehearsal: false,
			container: {
				memoryPeakMiB: 312.4,
				memoryAtMinute5MiB: 300,
				memoryAtEndMiB: 330,
				oomKilled: false,
				restartCount: 0,
			},
			hostAvailableMinMiB: 4096,
			recoverySeconds: 1,
			neighbors: {
				aborted: false,
				reason: null,
				samples: 150,
				targetsAreDefault: true,
				targets: {
					osa: { kind: 'loopback', p95Ms: 40, maxMs: 90 },
					hedit: { kind: 'loopback', p95Ms: 20, maxMs: 60 },
					hedtools: { kind: 'loopback', p95Ms: 150, maxMs: 200 },
					'hedtools-apache': { kind: 'apache', p95Ms: 300, maxMs: 500 },
				},
				dockerChecked: true,
				dockerContainers: ['osa', 'osa-dev', 'hedit', 'hedit-dev', 'hedtools', 'hedtools_dev', 'hed-lsp'],
				dockerHealthy: true,
			},
		};

		/** The results for a profile with this host file, in place of the good one. */
		async function withHost(profile: string, host: unknown, report = mixed): Promise<Verdict[]> {
			const file = path.join(dir, `host-${Math.random().toString(36).slice(2)}.json`);
			fs.writeFileSync(file, JSON.stringify(host));
			return (await check(['--profile', profile, '--host', file, '--json', report])).results;
		}
		const hostCriteria = (results: Verdict[]): Verdict[] =>
			results.filter((r) => /memory|kill|restart|neighbor|Docker|recovery|drift/.test(r.criterion));

		it('passes values on the limits: 600 MiB, 150 ms, 300 ms, 1.5 GiB, and 10% drift', async () => {
			const onTheLimits = {
				...good,
				container: { ...good.container, memoryPeakMiB: 600 },
				hostAvailableMinMiB: 1536,
			};

			const s0 = await withHost('s0', onTheLimits);
			const soak = await withHost(
				's1-soak',
				{ ...onTheLimits, container: { ...onTheLimits.container, memoryPeakMiB: 3072 } },
				capacity,
			);

			expect(hostCriteria(s0).map((r) => r.verdict)).toEqual(hostCriteria(s0).map(() => 'pass'));
			expect(verdictOf(s0, 'host available memory')).toBe('pass');
			expect(verdictOf(soak, 'memory drift after minute 5')).toBe('pass');
			expect(verdictOf(soak, 'container memory peak')).toBe('pass');
		});

		it.each([
			[
				'the memory peak above 600 MiB in S0',
				's0',
				(h: any) => (h.container.memoryPeakMiB = 600.1),
				'container memory peak',
			],
			[
				'the memory peak above 3 GiB in S1',
				's1-mixed',
				(h: any) => (h.container.memoryPeakMiB = 3073),
				'container memory peak',
			],
			['an out-of-memory kill', 's0', (h: any) => (h.container.oomKilled = true), 'no out-of-memory kill'],
			['a restart', 's0', (h: any) => (h.container.restartCount = 1), 'restart count'],
			['less than 1.5 GiB left on the host', 's0', (h: any) => (h.hostAvailableMinMiB = 1535), 'host available memory'],
			[
				'a drift of more than 10% in the soak',
				's1-soak',
				(h: any) => (h.container.memoryAtEndMiB = 331),
				'memory drift after minute 5',
			],
			[
				'a recovery of 5 s after the overload',
				's0-overload',
				(h: any) => (h.recoverySeconds = 5),
				'recovery after the overload',
			],
			[
				'an aborted probe',
				's0',
				(h: any) => {
					h.neighbors.aborted = true;
					h.neighbors.reason = 'osa answered 503';
				},
				'neighbor probe',
			],
			[
				'a loopback neighbor over 150 ms',
				's0',
				(h: any) => (h.neighbors.targets.osa.p95Ms = 150.1),
				'neighbor osa p95',
			],
			[
				'the Apache path over 300 ms',
				's0',
				(h: any) => (h.neighbors.targets['hedtools-apache'].p95Ms = 300.1),
				'neighbor hedtools-apache p95',
			],
			[
				'an unhealthy neighbor',
				's0',
				(h: any) => (h.neighbors.dockerHealthy = false),
				'Docker health of the neighbors',
			],
		])('fails %s', async (_label, profile, edit, criterion) => {
			const host = JSON.parse(JSON.stringify(good));
			edit(host);

			const results = await withHost(profile, host, profile.startsWith('s1') ? capacity : mixed);

			expect(verdictOf(results, criterion)).toBe('fail');
		});

		it('takes the summary of the real probe: its default targets are the four the checker requires, and Docker was not checked', async () => {
			// No Docker on the PATH. The probe writes the summary that measure.sh would put in the host file, whether
			// it stopped at its first default target (nothing listens on the port of osa on most machines) or not.
			const out = path.join(dir, 'probe-summary.json');
			const probe = await bash(path.join(DEPLOY, 'neighbor-probe.sh'), ['--duration', '1', '--out', out], {
				PATH: pathWithoutDocker(),
				HOME: tempDir('hed-lsp-home-'),
			});
			const summary = JSON.parse(fs.readFileSync(out, 'utf-8'));
			const host = { ...good, neighbors: summary };

			const results = await withHost('s0', host);

			expect(probe.code).toBeLessThanOrEqual(1);
			expect(summary.targetsAreDefault).toBe(true);
			expect(verdictOf(results, 'neighbor targets')).toBe('pass');
			expect(results.find((r) => r.criterion === 'neighbor targets')?.detail).toBe(
				'judged osa, hedit, hedtools, hedtools-apache, the defaults of the probe',
			);
			expect(verdictOf(results, 'Docker health of the neighbors')).toBe('fail');
			expect(results.find((r) => r.criterion === 'Docker health of the neighbors')?.detail).toContain(
				'Docker health was not checked',
			);
		});

		it('fails for a value that is missing', async () => {
			const host = JSON.parse(JSON.stringify(good));
			delete host.container.memoryPeakMiB;

			const results = await withHost('s0', host);

			expect(verdictOf(results, 'container memory peak')).toBe('fail');
		});

		it('fails a run on a host without /proc, which measured no memory, and skips it only for a rehearsal', async () => {
			const host = JSON.parse(JSON.stringify(good));
			host.hostAvailableMinMiB = null;
			const rehearsal = { ...host, rehearsal: true };
			const file = path.join(dir, 'no-proc.host.json');
			fs.writeFileSync(file, JSON.stringify(rehearsal));

			const run = await withHost('s0', host);
			const practice = (await check(['--rehearsal', '--profile', 's0', '--host', file, '--json', mixed])).results;

			expect(verdictOf(run, 'host available memory')).toBe('fail');
			expect(verdictOf(practice, 'host available memory')).toBe('skip');
		});

		describe('the neighbors', () => {
			const detail = (results: Verdict[], criterion: string): string =>
				results.find((r) => r.criterion === criterion)?.detail ?? '';

			it('passes when the probe watched all four, with their default targets, and says which it judged', async () => {
				const results = await withHost('s0', good);

				expect(verdictOf(results, 'neighbor targets')).toBe('pass');
				expect(detail(results, 'neighbor targets')).toBe(
					'judged osa, hedit, hedtools, hedtools-apache, the defaults of the probe',
				);
				for (const name of ['osa', 'hedit', 'hedtools', 'hedtools-apache']) {
					expect(verdictOf(results, `neighbor ${name} p95`)).toBe('pass');
				}
				expect(detail(results, 'Docker health of the neighbors')).toContain('7 containers, all healthy');
			});

			it.each(['osa', 'hedit', 'hedtools', 'hedtools-apache'])(
				'fails a host run whose probe did not watch %s',
				async (name) => {
					const host = JSON.parse(JSON.stringify(good));
					delete host.neighbors.targets[name];

					const results = await withHost('s0', host);

					expect(verdictOf(results, 'neighbor targets')).toBe('fail');
					expect(detail(results, 'neighbor targets')).toContain(`the probe did not watch ${name}`);
				},
			);

			it('fails a host run whose probe watched other targets than its defaults, or does not say', async () => {
				const replaced = JSON.parse(JSON.stringify(good));
				replaced.neighbors.targetsAreDefault = false;
				const silent = JSON.parse(JSON.stringify(good));
				delete silent.neighbors.targetsAreDefault;

				const a = await withHost('s0', replaced);
				const b = await withHost('s0', silent);

				expect(verdictOf(a, 'neighbor targets')).toBe('fail');
				expect(detail(a, 'neighbor targets')).toContain('HED_LSP_PROBE_TARGETS');
				expect(verdictOf(b, 'neighbor targets')).toBe('fail');
				expect(detail(b, 'neighbor targets')).toContain('does not say whether its targets are the defaults');
			});

			it('judges a neighbor by the kind it must have: a loopback neighbor given as Apache gets no extra time', async () => {
				const host = JSON.parse(JSON.stringify(good));
				host.neighbors.targets.osa = { kind: 'apache', p95Ms: 200, maxMs: 250 };

				const results = await withHost('s0', host);

				expect(verdictOf(results, 'neighbor targets')).toBe('fail');
				expect(detail(results, 'neighbor targets')).toContain('osa has the wrong kind of target');
				expect(verdictOf(results, 'neighbor osa p95')).toBe('fail');
				expect(detail(results, 'neighbor osa p95')).toContain('at most 150 ms');
			});

			it('fails when Docker health was never checked, whatever dockerHealthy says', async () => {
				const unchecked = JSON.parse(JSON.stringify(good));
				unchecked.neighbors.dockerChecked = false;
				unchecked.neighbors.dockerHealthy = true;
				const silent = JSON.parse(JSON.stringify(good));
				delete silent.neighbors.dockerChecked;

				const a = await withHost('s0', unchecked);
				const b = await withHost('s0', silent);

				expect(verdictOf(a, 'Docker health of the neighbors')).toBe('fail');
				expect(detail(a, 'Docker health of the neighbors')).toContain('Docker health was not checked');
				expect(verdictOf(b, 'Docker health of the neighbors')).toBe('fail');
				expect(detail(b, 'Docker health of the neighbors')).toContain('does not say whether Docker health was checked');
			});

			it('fails a host run whose Docker check did not watch the containers osa, hedit, and hedtools', async () => {
				const host = JSON.parse(JSON.stringify(good));
				host.neighbors.dockerContainers = ['hed-lsp', 'osa-dev'];

				const results = await withHost('s0', host);

				expect(verdictOf(results, 'Docker health of the neighbors')).toBe('fail');
				expect(detail(results, 'Docker health of the neighbors')).toContain(
					'did not watch the containers osa, hedit, hedtools; it watched hed-lsp, osa-dev',
				);
			});

			it('lets a rehearsal watch other targets and containers, and still needs Docker to have been checked', async () => {
				const rehearsal = JSON.parse(JSON.stringify(good));
				rehearsal.rehearsal = true;
				rehearsal.neighbors.targetsAreDefault = false;
				rehearsal.neighbors.targets = { 'hed-lsp': { kind: 'loopback', p95Ms: 12, maxMs: 30 } };
				rehearsal.neighbors.dockerContainers = ['hed-lsp'];
				const unchecked = JSON.parse(JSON.stringify(rehearsal));
				unchecked.neighbors.dockerChecked = false;
				const files = ['practice', 'practice-unchecked'].map((name, i) => {
					const file = path.join(dir, `${name}.host.json`);
					fs.writeFileSync(file, JSON.stringify([rehearsal, unchecked][i]));
					return file;
				});

				const [a, b] = await Promise.all(
					files.map((file) => check(['--rehearsal', '--profile', 's0', '--host', file, '--json', mixed])),
				);

				expect(verdictOf(a.results, 'neighbor targets')).toBe('pass');
				expect(detail(a.results, 'neighbor targets')).toContain('a rehearsal may watch other targets');
				expect(verdictOf(a.results, 'neighbor hed-lsp p95')).toBe('pass');
				expect(verdictOf(a.results, 'Docker health of the neighbors')).toBe('pass');
				expect(verdictOf(b.results, 'Docker health of the neighbors')).toBe('fail');
			});

			it('fails a probe that watched no target at all, in a rehearsal too', async () => {
				const host = JSON.parse(JSON.stringify(good));
				host.rehearsal = true;
				host.neighbors.targets = {};
				const file = path.join(dir, 'no-targets.host.json');
				fs.writeFileSync(file, JSON.stringify(host));

				const result = await check(['--rehearsal', '--profile', 's0', '--host', file, '--json', mixed]);

				expect(verdictOf(result.results, 'neighbor targets')).toBe('fail');
			});
		});

		it('fails every host criterion in one line when there is no host file, and finds it beside the report', async () => {
			const lonely = worsened('lonely.json', () => {}, overloaded);
			const alone = await check(['--profile', 's0-overload', '--json', lonely]);
			fs.writeFileSync(lonely.replace(/\.json$/, '.host.json'), JSON.stringify({ ...good, recoverySeconds: 2 }));
			const found = await check(['--profile', 's0-overload', '--json', lonely]);

			expect(alone.code).toBe(1);
			expect(verdictOf(alone.results, 'host measurements')).toBe('fail');
			expect(verdictOf(found.results, 'recovery after the overload')).toBe('pass');
			expect(found.code).toBe(0);
		});
	});

	describe('a rehearsal of measure.sh', () => {
		const host = (rehearsal: unknown) => ({
			rehearsal,
			container: { memoryPeakMiB: 300, oomKilled: false, restartCount: 0 },
			hostAvailableMinMiB: 4096,
			neighbors: {
				aborted: false,
				samples: 5,
				targetsAreDefault: false,
				targets: { 'hed-lsp': { kind: 'loopback', p95Ms: 12 } },
				dockerChecked: true,
				dockerContainers: ['hed-lsp'],
				dockerHealthy: true,
			},
		});
		const judged = async (rehearsalFlag: boolean, marked: unknown) => {
			const hostFile = path.join(dir, `rehearsal-${Math.random().toString(36).slice(2)}.host.json`);
			fs.writeFileSync(hostFile, JSON.stringify(host(marked)));
			const args = ['--profile', 's0', '--host', hostFile, '--json', mixed];
			return check(rehearsalFlag ? ['--rehearsal', ...args] : args);
		};

		it('is not a result: the files of a rehearsal fail without --rehearsal', async () => {
			const result = await judged(false, true);

			expect(verdictOf(result.results, 'run kind')).toBe('fail');
			expect(result.results.find((r) => r.criterion === 'run kind')?.detail).toContain('judge it with --rehearsal');
			expect(result.code).toBe(1);
		});

		it('is judged as practice with --rehearsal, and the output says so', async () => {
			const hostFile = path.join(dir, 'practice.host.json');
			fs.writeFileSync(hostFile, JSON.stringify(host(true)));

			const json = await check(['--rehearsal', '--profile', 's0', '--host', hostFile, '--json', mixed]);
			const text = await check(['--rehearsal', '--profile', 's0', '--host', hostFile, mixed]);

			expect(verdictOf(json.results, 'run kind')).toBe('pass');
			expect(text.stdout.startsWith('REHEARSAL: these files are practice')).toBe(true);
			expect(text.stdout).toMatch(/PASS {2}run kind: a rehearsal: practice, not a result\n/);
			expect(text.stdout).toMatch(/\(a rehearsal, not a result\)\n$/);
		});

		it('is never excused by --rehearsal for the files of a real run, and a host file that does not say fails', async () => {
			const real = await judged(true, false);
			const silent = await judged(false, undefined);
			const text = await judged(false, 'yes');

			expect(verdictOf(real.results, 'run kind')).toBe('fail');
			expect(real.results.find((r) => r.criterion === 'run kind')?.detail).toContain('judge it without --rehearsal');
			expect(verdictOf(silent.results, 'run kind')).toBe('fail');
			expect(verdictOf(text.results, 'run kind')).toBe('fail');
			expect(silent.results.find((r) => r.criterion === 'run kind')?.detail).toContain('does not say');
		});

		it('says in the JSON that it is a rehearsal, and not otherwise', async () => {
			const hostFile = path.join(dir, 'label.host.json');
			fs.writeFileSync(hostFile, JSON.stringify(host(true)));
			const raw = async (flag: boolean) =>
				JSON.parse(
					(await check([...(flag ? ['--rehearsal'] : []), '--profile', 's0', '--host', hostFile, '--json', mixed]))
						.stdout,
				);

			expect((await raw(true)).rehearsal).toBe(true);
			expect((await raw(false)).rehearsal).toBe(false);
		});
	});

	describe('usage', () => {
		it.each([
			[[], '--profile must be one of'],
			[['--profile', 's9', 'x.json'], '--profile must be one of'],
			[['--profile', 's0'], 'give exactly one report file'],
			[['--profile', 's0', 'a.json', 'b.json'], 'give exactly one report file'],
			[['--profile'], '--profile needs a value'],
			[['--profile', 's0', '--bogus', 'x.json'], 'unknown option --bogus'],
			[['--profile', 's0', '--no-host', '--host', 'h.json', 'x.json'], 'exclude each other'],
			[['--profile', 's0', '--no-host', '--rehearsal', 'x.json'], 'it excludes --no-host'],
			[['--profile', 's0', '--no-host', '/nonexistent/report.json'], 'cannot read the report /nonexistent/report.json'],
		])('exits 2 for the arguments %j', async (args, message) => {
			const result = await check(args);

			expect(result.code).toBe(2);
			expect(result.stderr).toContain(message);
		});

		it('exits 2 for a file that is not JSON, not an object, or not a report of the harness', async () => {
			const files = {
				'not-json.json': 'hello',
				'array.json': '[1, 2]',
				'other.json': JSON.stringify({ tool: 'something-else' }),
			};
			for (const [name, content] of Object.entries(files)) {
				fs.writeFileSync(path.join(dir, name), content);
			}

			const results = await Promise.all(
				Object.keys(files).map((name) => check(['--profile', 's0', '--no-host', path.join(dir, name)])),
			);

			expect(results.map((r) => r.code)).toEqual([2, 2, 2]);
			expect(results[2].stderr).toContain('is not a report of the daemon load harness');
		});

		it('prints its usage for --help', async () => {
			const result = await check(['--help']);

			expect(result.code).toBe(0);
			expect(result.stdout).toContain('Usage: bun scripts/check-load-report.ts');
			expect(result.stdout).toContain('s1-soak');
		});
	});
});
