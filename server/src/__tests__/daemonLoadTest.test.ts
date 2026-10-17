/**
 * Tests for the load harness. The percentile arithmetic, the `--mix` parser, the choice of endpoint,
 * the summary of samples, the command line, and the corpus reader are pure functions and are tested
 * directly, on values worked out by hand and on the real evaluation set. One test runs the compiled
 * harness as a process against a real daemon on a real socket, with the real engine, for about two
 * seconds, and checks the JSON report, the health snapshots, and that the daemon counted every
 * request. The semantic options and the reach check are tested the same way: the tally on numbers
 * worked out by hand, and the check itself against a real daemon with the real engine and the real
 * evaluation set. No mocks.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	BATCH,
	clientAddress,
	createRandom,
	DEFAULT_CORPUS_PATH,
	DEFAULT_SEMANTIC_SHAPE,
	ENDPOINTS,
	HELP,
	type LoadOptions,
	loadCorpus,
	MAX_CLIENTS,
	MAX_SEMANTIC_BATCH,
	MAX_SEMANTIC_TOP,
	type Mix,
	parseArgs,
	parseMix,
	percentile,
	pickEndpoint,
	planRequest,
	REACH_BATCH,
	REACH_CLIENT,
	routeUrl,
	runReachCheck,
	type Sample,
	semanticShape,
	summarizeLatencies,
	summarizeReach,
	summarizeSamples,
	UsageError,
} from '../daemon/loadTest.js';
import { call, childEnv, compiled, startDaemon, waitFor } from './daemonHarness.js';

describe('percentile', () => {
	const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

	it('takes the value at rank ceil(p / 100 * n), counting from 1', () => {
		expect(percentile(hundred, 50)).toBe(50);
		expect(percentile(hundred, 95)).toBe(95);
		expect(percentile(hundred, 99)).toBe(99);
		expect(percentile(hundred, 100)).toBe(100);
		// Ten values: the 95th and 99th percentiles are both the largest, and the median is the fifth.
		const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		expect(percentile(ten, 50)).toBe(50);
		expect(percentile(ten, 95)).toBe(100);
		expect(percentile(ten, 99)).toBe(100);
		expect(percentile(ten, 10)).toBe(10);
		expect(percentile(ten, 11)).toBe(20);
	});

	it('returns a value that was measured, never one between two', () => {
		expect(percentile([1, 3], 50)).toBe(1);
		expect(percentile([1, 3], 51)).toBe(3);
		expect(percentile([7], 1)).toBe(7);
		expect(percentile([7], 99)).toBe(7);
	});

	it('is not thrown off by a product that is a hair over a whole number', () => {
		// 99.9 * 1000 is not exactly 99900 in floating point; the rank must still be 999.
		const thousand = Array.from({ length: 1000 }, (_, i) => i + 1);
		expect(percentile(thousand, 99.9)).toBe(999);
		// 7 * 100 / 100 is 7, and a naive 0.07 * 100 is a hair over it.
		expect(percentile(hundred, 7)).toBe(7);
	});

	it('answers the smallest value for 0, null for no values, and refuses a percentile outside 0 to 100', () => {
		expect(percentile(hundred, 0)).toBe(1);
		expect(percentile([], 50)).toBeNull();
		expect(() => percentile(hundred, 101)).toThrow(RangeError);
		expect(() => percentile(hundred, -1)).toThrow(RangeError);
		expect(() => percentile(hundred, Number.NaN)).toThrow(RangeError);
	});
});

describe('summarizeLatencies', () => {
	it('sorts a copy, leaves the input alone, and rounds to two decimals', () => {
		const values = [30.004, 10.126, 20, 40];

		const summary = summarizeLatencies(values);

		expect(values).toEqual([30.004, 10.126, 20, 40]);
		expect(summary).toEqual({ p50: 20, p95: 40, p99: 40, max: 40 });
		expect(summarizeLatencies([10.126])).toEqual({ p50: 10.13, p95: 10.13, p99: 10.13, max: 10.13 });
	});

	it('reports null for each figure when there is nothing to measure', () => {
		expect(summarizeLatencies([])).toEqual({ p50: null, p95: null, p99: null, max: null });
	});
});

describe('parseMix', () => {
	it('reads the default mix', () => {
		expect(parseMix('suggest=60,validate=30,semantic=10')).toEqual({ suggest: 60, validate: 30, semantic: 10 });
	});

	it('takes the entries in any order and gives an endpoint left out a weight of 0', () => {
		expect(parseMix('semantic=1,validate=3')).toEqual({ suggest: 0, validate: 3, semantic: 1 });
		expect(parseMix('validate=5')).toEqual({ suggest: 0, validate: 5, semantic: 0 });
		expect(parseMix('suggest=0,validate=1')).toEqual({ suggest: 0, validate: 1, semantic: 0 });
	});

	it.each([
		['', 'an empty value'],
		['suggest', 'no weight'],
		['suggest=', 'an empty weight'],
		['=5', 'no name'],
		['suggest=-1', 'a negative weight'],
		['suggest=1.5', 'a fraction'],
		['suggest=1e2', 'an exponent'],
		['suggest=0x10', 'a hexadecimal weight'],
		['suggest=ten', 'a word for a weight'],
		['suggest=60,', 'a trailing comma'],
		[',suggest=60', 'a leading comma'],
		['suggest=60,,validate=1', 'an empty entry'],
		['suggest=60, validate=30', 'a space after a comma'],
		[' suggest=60', 'a leading space'],
		['suggest = 60', 'spaces around the equals sign'],
		['Suggest=60', 'a capital letter'],
		['search=60', 'an unknown endpoint'],
		['search=60,validate=1', 'an unknown endpoint beside a known one'],
		['suggest=60,suggest=30', 'a repeated endpoint'],
		['suggest=0,validate=0,semantic=0', 'every weight 0'],
		['suggest=0', 'a single weight of 0'],
		['suggest=9007199254740993', 'a weight past the safe integers'],
		['suggest=1000001', 'a weight past the limit'],
	])('rejects %j: %s', (text) => {
		expect(() => parseMix(text)).toThrow(UsageError);
	});

	it('names the entry or the endpoint that is wrong', () => {
		expect(() => parseMix('search=60')).toThrow(/"search".*suggest, validate, semantic/);
		expect(() => parseMix('suggest=1,suggest=2')).toThrow(/"suggest" more than once/);
		expect(() => parseMix('validate')).toThrow(/"validate" must look like name=weight/);
	});
});

describe('pickEndpoint', () => {
	const mix: Mix = { suggest: 60, validate: 30, semantic: 10 };

	it('lays the shares end to end, suggest then validate then semantic', () => {
		expect(pickEndpoint(mix, 0)).toBe('suggest');
		expect(pickEndpoint(mix, 0.5999)).toBe('suggest');
		expect(pickEndpoint(mix, 0.6)).toBe('validate');
		expect(pickEndpoint(mix, 0.8999)).toBe('validate');
		expect(pickEndpoint(mix, 0.9)).toBe('semantic');
		expect(pickEndpoint(mix, 0.999999)).toBe('semantic');
	});

	it('never picks an endpoint with weight 0, and treats the weights as shares, not percentages', () => {
		for (const unit of [0, 0.25, 0.5, 0.75, 0.999]) {
			expect(pickEndpoint({ suggest: 0, validate: 2, semantic: 0 }, unit)).toBe('validate');
		}
		expect(pickEndpoint({ suggest: 1, validate: 0, semantic: 1 }, 0.49)).toBe('suggest');
		expect(pickEndpoint({ suggest: 1, validate: 0, semantic: 1 }, 0.5)).toBe('semantic');
	});

	it('follows the weights over many draws from the seeded generator', () => {
		const random = createRandom(1);
		const tally: Record<string, number> = { suggest: 0, validate: 0, semantic: 0 };
		for (let i = 0; i < 20_000; i++) {
			tally[pickEndpoint(mix, random())]++;
		}

		expect(tally.suggest / 20_000).toBeGreaterThan(0.58);
		expect(tally.suggest / 20_000).toBeLessThan(0.62);
		expect(tally.validate / 20_000).toBeGreaterThan(0.28);
		expect(tally.validate / 20_000).toBeLessThan(0.32);
		expect(tally.semantic / 20_000).toBeGreaterThan(0.09);
		expect(tally.semantic / 20_000).toBeLessThan(0.11);
	});
});

describe('createRandom', () => {
	it('repeats for a seed, differs between seeds, and stays in [0, 1)', () => {
		const a = createRandom(7);
		const b = createRandom(7);
		const c = createRandom(8);
		const first = Array.from({ length: 50 }, () => a());

		expect(Array.from({ length: 50 }, () => b())).toEqual(first);
		expect(Array.from({ length: 50 }, () => c())).not.toEqual(first);
		expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
	});
});

describe('summarizeSamples', () => {
	const ok = (ms: number): Sample => ({ status: 200, ms });

	it('counts outcomes, the 429 and 503 answers by error code, and the rates, from hand-worked samples', () => {
		const samples: Sample[] = [
			ok(10),
			ok(20),
			ok(30),
			ok(40),
			ok(50),
			ok(60),
			ok(70),
			{ status: 429, ms: 1, errorCode: 'RATE_LIMITED' },
			{ status: 429, ms: 1, errorCode: 'RATE_LIMITED' },
			{ status: 503, ms: 2, errorCode: 'SEMANTIC_BUSY' },
			{ status: 503, ms: 2, errorCode: 'OVERLOADED' },
			{ status: 503, ms: 2, errorCode: 'OVERLOADED' },
			{ status: 500, ms: 3, errorCode: 'INTERNAL_ERROR' },
			{ status: null, ms: 4, errorCode: 'ECONNRESET' },
		];

		const report = summarizeSamples(samples, 2);

		expect(report.requests).toBe(14);
		expect(report.ok).toBe(7);
		expect(report.errors).toBe(7);
		expect(report.errorRate).toBe(0.5);
		expect(report.status).toEqual({ '200': 7, '429': 2, '503': 3, '500': 1, network: 1 });
		expect(report.rejections).toEqual({
			'429': { RATE_LIMITED: 2 },
			'503': { SEMANTIC_BUSY: 1, OVERLOADED: 2 },
		});
		// Latency is over the seven 2xx answers only: ranks 4, 7, and 7 of seven.
		expect(report.latencyMs).toEqual({ p50: 40, p95: 70, p99: 70, max: 70 });
		expect(report.throughputRps).toBe(7);
		expect(report.semanticStatus).toBeUndefined();
	});

	it('counts the 429 and 503 answers that have no usable Retry-After, by error code, from hand-worked samples', () => {
		const report = summarizeSamples(
			[
				{ status: 429, ms: 1, errorCode: 'RATE_LIMITED', retryAfter: '1' },
				{ status: 429, ms: 1, errorCode: 'RATE_LIMITED', retryAfter: '12' },
				{ status: 429, ms: 1, errorCode: 'RATE_LIMITED' },
				{ status: 503, ms: 1, errorCode: 'OVERLOADED', retryAfter: '1' },
				{ status: 503, ms: 1, errorCode: 'OVERLOADED', retryAfter: '0' },
				{ status: 503, ms: 1, errorCode: 'OVERLOADED', retryAfter: '1.5' },
				{ status: 503, ms: 1, errorCode: 'STARTING', retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' },
				{ status: 503, ms: 1, errorCode: 'STARTING', retryAfter: '' },
				// Only a refusal needs one: a 200 and a 500 are not counted either way.
				{ status: 200, ms: 5 },
				{ status: 500, ms: 1, errorCode: 'INTERNAL_ERROR' },
			],
			1,
		);

		expect(report.rejections).toEqual({ '429': { RATE_LIMITED: 3 }, '503': { OVERLOADED: 3, STARTING: 2 } });
		expect(report.withoutRetryAfter).toEqual({ '429': { RATE_LIMITED: 1 }, '503': { OVERLOADED: 2, STARTING: 2 } });
	});

	it('counts the semantic status of the answers that carried one', () => {
		const report = summarizeSamples(
			[
				{ status: 200, ms: 5, semanticStatus: 'ok' },
				{ status: 200, ms: 6, semanticStatus: 'ok' },
				{ status: 200, ms: 7, semanticStatus: 'loading' },
				{ status: 503, ms: 1, errorCode: 'SEMANTIC_BUSY' },
			],
			1,
		);

		expect(report.semanticStatus).toEqual({ ok: 2, loading: 1 });
		expect(report.rejections['503']).toEqual({ SEMANTIC_BUSY: 1 });
	});

	it('names a rejection without a readable code UNKNOWN, and gives an empty run zeros and nulls', () => {
		expect(summarizeSamples([{ status: 429, ms: 1 }], 1).rejections['429']).toEqual({ UNKNOWN: 1 });

		const empty = summarizeSamples([], 5);

		expect(empty).toEqual({
			requests: 0,
			ok: 0,
			errors: 0,
			errorRate: 0,
			status: {},
			rejections: { '429': {}, '503': {} },
			withoutRetryAfter: { '429': {}, '503': {} },
			latencyMs: { p50: null, p95: null, p99: null, max: null },
			throughputRps: 0,
		});
	});

	it('rounds the error rate to four decimals and the throughput to two', () => {
		const samples = [...Array.from({ length: 2 }, () => ok(1)), { status: 500, ms: 1 } as Sample];

		const report = summarizeSamples(samples, 3);

		expect(report.errorRate).toBe(0.3333);
		expect(report.throughputRps).toBe(1);
		expect(summarizeSamples(samples, 7).throughputRps).toBe(0.43);
	});
});

describe('clientAddress', () => {
	it('gives each index its own IPv4 address in the benchmarking block, up to the client limit', () => {
		const addresses = new Set<string>();
		for (let i = 0; i < MAX_CLIENTS; i++) {
			addresses.add(clientAddress(i));
		}

		expect(addresses.size).toBe(MAX_CLIENTS);
		for (const address of [clientAddress(0), clientAddress(253), clientAddress(254), clientAddress(MAX_CLIENTS - 1)]) {
			expect(net.isIPv4(address)).toBe(true);
			expect(address.startsWith('198.18.')).toBe(true);
		}
		expect(clientAddress(0)).toBe('198.18.0.1');
		expect(clientAddress(254)).toBe('198.18.1.1');
	});
});

describe('routeUrl', () => {
	it('keeps the path prefix of the base URL, with or without a trailing slash', () => {
		expect(routeUrl(new URL('http://127.0.0.1:38530'), '/v1/health').href).toBe('http://127.0.0.1:38530/v1/health');
		expect(routeUrl(new URL('https://hedtools.org/hed-lsp'), '/v1/validate').href).toBe(
			'https://hedtools.org/hed-lsp/v1/validate',
		);
		expect(routeUrl(new URL('https://hedtools.org/hed-lsp/?x=1#y'), '/v1/suggest').href).toBe(
			'https://hedtools.org/hed-lsp/v1/suggest',
		);
	});
});

describe('parseArgs', () => {
	it('uses the documented defaults', () => {
		const options = parseArgs([]);

		expect(options).toEqual({
			url: 'http://127.0.0.1:38530',
			concurrency: 4,
			durationSeconds: 60,
			mix: { suggest: 60, validate: 30, semantic: 10 },
			clients: 1,
			out: undefined,
			corpus: DEFAULT_CORPUS_PATH,
		});
	});

	it('reads every flag, with a value after a space or after an equals sign', () => {
		const options = parseArgs([
			'--url',
			'https://hedtools.org/hed-lsp',
			'--concurrency=8',
			'--duration',
			'2.5',
			'--mix=validate=1,suggest=1',
			'--clients',
			'64',
			'--out=report.json',
			'--corpus',
			'pairs.json',
		]);

		expect(options).toEqual({
			url: 'https://hedtools.org/hed-lsp',
			concurrency: 8,
			durationSeconds: 2.5,
			mix: { suggest: 1, validate: 1, semantic: 0 },
			clients: 64,
			out: 'report.json',
			corpus: 'pairs.json',
		});
	});

	it('answers help for -h and --help, even among other flags', () => {
		expect(parseArgs(['-h'])).toBe('help');
		expect(parseArgs(['--concurrency', '2', '--help'])).toBe('help');
	});

	it.each([
		[['--bogus']],
		[['--concurrency']],
		[['--concurrency', '0']],
		[['--concurrency', '1025']],
		[['--concurrency', '2.5']],
		[['--concurrency', 'many']],
		[['--duration', '0']],
		[['--duration', '-3']],
		[['--duration', '86401']],
		[['--duration', '1e2']],
		[['--clients', '0']],
		[['--clients', '60001']],
		[['--mix', 'search=1']],
		[['--url', 'ftp://example.org']],
		[['--url', 'not a url']],
		[['--url']],
		[['--clients', '2', '--clients', '3']],
		[['positional']],
		[['-x']],
	])('rejects %j as a usage error', (argv) => {
		expect(() => parseArgs(argv)).toThrow(UsageError);
	});

	it('says in the help text that the target must trust this machine for --clients to count', () => {
		expect(HELP).toContain('--clients');
		expect(HELP).toContain('X-Forwarded-For');
		expect(HELP).toContain('HED_LSP_TRUSTED_PROXIES');
		expect(HELP).toContain('shares one rate-limit key');
		for (const flag of ['--url', '--concurrency', '--duration', '--mix', '--clients', '--out', '--corpus']) {
			expect(HELP).toContain(flag);
		}
	});
});

describe('the corpus', () => {
	it('is, by default, the 206 evaluation pairs of the repository: real descriptions and HED strings', () => {
		const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

		expect(corpus.queries).toHaveLength(206);
		expect(corpus.strings).toHaveLength(206);
		expect(corpus.queries[0]).toBe('A target in the attended to modality has been detected.');
		expect(corpus.strings[0]).toBe('(Detect, Target)');
		expect(corpus.queries.every((query) => query.length > 0 && query.length <= 512)).toBe(true);
		expect(corpus.strings.every((hed) => hed.length > 0 && hed.length <= 4096)).toBe(true);
	});

	describe('from a file', () => {
		const dirs: string[] = [];
		afterEach(() => {
			for (const dir of dirs.splice(0)) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
		function corpusFile(content: string): string {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-corpus-'));
			dirs.push(dir);
			const file = path.join(dir, 'pairs.json');
			fs.writeFileSync(file, content);
			return file;
		}

		it('reads the pairs of any file that has the same shape', () => {
			const file = corpusFile(JSON.stringify({ pairs: [{ query: 'a red flash', hed: 'Red, Flash', id: 'x' }] }));

			expect(loadCorpus(file)).toEqual({ queries: ['a red flash'], strings: ['Red, Flash'] });
		});

		it.each([
			['not json'],
			['[]'],
			['{}'],
			['{"pairs":[]}'],
			['{"pairs":[{"query":"a"}]}'],
			['{"pairs":[{"query":"a","hed":""}]}'],
			['{"pairs":[{"query":"  ","hed":"Red"}]}'],
			['{"pairs":[{"query":1,"hed":"Red"}]}'],
			['{"pairs":[null]}'],
		])('rejects %s as a usage error', (content) => {
			expect(() => loadCorpus(corpusFile(content))).toThrow(UsageError);
		});

		it('rejects a file that does not exist, and names it', () => {
			expect(() => loadCorpus('/nonexistent/hed-lsp-pairs.json')).toThrow(/hed-lsp-pairs\.json/);
		});
	});
});

describe('planRequest', () => {
	const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

	it('builds each request from real text, with the documented batch sizes and routes', () => {
		const random = createRandom(3);

		const validate = planRequest('validate', corpus, random);
		const suggest = planRequest('suggest', corpus, random);
		const semantic = planRequest('semantic', corpus, random);

		expect(validate.route).toBe('/v1/validate');
		const validateBody = JSON.parse(validate.body);
		expect(validateBody.strings).toHaveLength(BATCH.validate);
		expect(validateBody.strings.every((hed: string) => corpus.strings.includes(hed))).toBe(true);
		expect(Object.keys(validateBody)).toEqual(['strings']);

		expect(suggest.route).toBe('/v1/suggest');
		const suggestBody = JSON.parse(suggest.body);
		expect(suggestBody.queries).toHaveLength(BATCH.suggest);
		expect(suggestBody.queries.every((query: string) => corpus.queries.includes(query))).toBe(true);
		expect(suggestBody.semantic).toBeUndefined();

		expect(semantic.route).toBe('/v1/suggest');
		const semanticBody = JSON.parse(semantic.body);
		expect(semanticBody.queries).toHaveLength(BATCH.semantic);
		expect(semanticBody.semantic).toBe(true);
		expect(BATCH.semantic).toBe(1);
	});

	it('repeats for a seed, so two runs send the same requests', () => {
		const sequence = (seed: number): string[] => {
			const random = createRandom(seed);
			return ENDPOINTS.map((endpoint) => planRequest(endpoint, corpus, random).body);
		};

		expect(sequence(5)).toEqual(sequence(5));
		expect(sequence(5)).not.toEqual(sequence(6));
	});
});

describe('the semantic options', () => {
	/** The options of a command line that is not a request for help. */
	function options(argv: string[]): LoadOptions {
		const parsed = parseArgs(argv);
		if (parsed === 'help') {
			throw new Error('expected options, got help');
		}
		return parsed;
	}

	it('leave the options as they were when the command line does not name them', () => {
		const defaults = options([]);

		expect(defaults).not.toHaveProperty('semanticTop');
		expect(defaults).not.toHaveProperty('semanticBatch');
		expect(defaults).not.toHaveProperty('reachCheck');
		expect(semanticShape(defaults)).toEqual({ top: 10, batch: 1 });
		expect(DEFAULT_SEMANTIC_SHAPE).toEqual({ top: 10, batch: 1 });
	});

	it('are read with a value after a space or after an equals sign, and --reach-check takes none', () => {
		const spaced = options(['--semantic-top', '50', '--semantic-batch', '10', '--reach-check']);
		const equals = options(['--reach-check', '--semantic-top=1', '--semantic-batch=20']);

		expect(spaced).toMatchObject({ semanticTop: 50, semanticBatch: 10, reachCheck: true });
		expect(semanticShape(spaced)).toEqual({ top: 50, batch: 10 });
		expect(equals).toMatchObject({ semanticTop: 1, semanticBatch: 20, reachCheck: true });
		// A value for the top alone leaves the batch at its default, and the other way round.
		expect(semanticShape(options(['--semantic-top', '50']))).toEqual({ top: 50, batch: 1 });
		expect(semanticShape(options(['--semantic-batch', '10']))).toEqual({ top: 10, batch: 10 });
	});

	it.each([
		[['--semantic-top', '0']],
		[['--semantic-top', String(MAX_SEMANTIC_TOP + 1)]],
		[['--semantic-top', '2.5']],
		[['--semantic-top', 'many']],
		[['--semantic-top']],
		[['--semantic-top', '5', '--semantic-top', '6']],
		[['--semantic-batch', '0']],
		[['--semantic-batch', String(MAX_SEMANTIC_BATCH + 1)]],
		[['--semantic-batch', '-1']],
		[['--semantic-batch']],
		[['--reach-check=yes']],
		[['--reach-check', '--reach-check']],
	])('reject %j as a usage error', (argv) => {
		expect(() => parseArgs(argv)).toThrow(UsageError);
	});

	it('are named in the help text', () => {
		for (const flag of ['--semantic-top', '--semantic-batch', '--reach-check']) {
			expect(HELP).toContain(flag);
		}
	});

	it('allow the largest semantic request that a real daemon accepts, and the daemon refuses one step more', async () => {
		const daemon = await startDaemon();
		try {
			const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
			const send = (body: string) =>
				call(daemon.url, '/v1/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
			const largest = { top: MAX_SEMANTIC_TOP, batch: MAX_SEMANTIC_BATCH };
			const planned = (shape: { top: number; batch: number }): string =>
				planRequest('semantic', corpus, createRandom(3), shape).body;

			const accepted = await send(planned(largest));
			const tooManyQueries = await send(planned({ ...largest, batch: MAX_SEMANTIC_BATCH + 1 }));
			const tooDeep = await send(planned({ ...largest, top: MAX_SEMANTIC_TOP + 1 }));

			// The limits of the options are the daemon's: the request the options allow at most is a 200, and a
			// request past either limit is refused by the daemon itself, with the error that names the field.
			expect(accepted.status).toBe(200);
			expect(accepted.json.results).toHaveLength(MAX_SEMANTIC_BATCH);
			expect(tooManyQueries.status).toBe(400);
			expect(tooManyQueries.json.error.code).toBe('BATCH_TOO_LARGE');
			expect(tooManyQueries.json.error.details).toMatchObject({ field: 'queries', max: MAX_SEMANTIC_BATCH });
			expect(tooDeep.status).toBe(400);
			expect(tooDeep.json.error.code).toBe('INVALID_REQUEST');
			expect(tooDeep.json.error.message).toContain('top');
		} finally {
			await daemon.stop();
		}
	});

	it('shape the semantic request and no other, from real text', () => {
		const corpus = loadCorpus(DEFAULT_CORPUS_PATH);
		const shape = { top: 50, batch: 7 };

		const semantic = JSON.parse(planRequest('semantic', corpus, createRandom(9), shape).body);
		const defaulted = JSON.parse(planRequest('semantic', corpus, createRandom(9)).body);

		expect(semantic.queries).toHaveLength(7);
		expect(semantic.queries.every((query: string) => corpus.queries.includes(query))).toBe(true);
		expect(semantic.top).toBe(50);
		expect(semantic.semantic).toBe(true);
		expect(defaulted.queries).toHaveLength(1);
		expect(defaulted.top).toBe(10);
		for (const endpoint of ['suggest', 'validate'] as const) {
			expect(planRequest(endpoint, corpus, createRandom(9), shape)).toEqual(
				planRequest(endpoint, corpus, createRandom(9)),
			);
		}
		expect(JSON.parse(planRequest('suggest', corpus, createRandom(9), shape).body).top).toBe(10);
	});
});

describe('summarizeReach', () => {
	it('counts the queries with fewer than top suggestions, from counts worked out by hand', () => {
		// Seven queries at top 10: 3, 0, 9, and 7 are below it; 10 is not; one query has no answer.
		const report = summarizeReach(10, [10, 3, 0, 9, 10, null, 7]);

		expect(report).toEqual({ top: 10, queries: 7, answered: 6, belowTop: 4, share: 0.6667, errors: 1 });
	});

	it('gives a share of 0 when every query fills the list, and 1 when none does', () => {
		expect(summarizeReach(5, [5, 5, 6]).share).toBe(0);
		expect(summarizeReach(5, [4, 0, 1]).share).toBe(1);
	});

	it('gives no share, and counts every query as an error, when nothing was answered', () => {
		expect(summarizeReach(10, [null, null])).toEqual({
			top: 10,
			queries: 2,
			answered: 0,
			belowTop: 0,
			share: null,
			errors: 2,
		});
		expect(summarizeReach(10, [])).toMatchObject({ queries: 0, answered: 0, share: null, errors: 0 });
	});
});

describe('the reach check', () => {
	it('sends every corpus query once with semantic search off, in batches, from a client of its own', async () => {
		const daemon = await startDaemon();
		try {
			const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

			const reach = await runReachCheck(new URL(daemon.url), corpus, 10);

			expect(reach.top).toBe(10);
			expect(reach.queries).toBe(206);
			expect(reach.answered).toBe(206);
			expect(reach.errors).toBe(0);
			expect(reach.belowTop).toBeGreaterThan(0);
			expect(reach.belowTop).toBeLessThan(206);
			expect(reach.share).toBe(Math.round((reach.belowTop / 206) * 10_000) / 10_000);
			const posts = daemon.logLines().filter((line) => line.msg === 'request' && line.method === 'POST');
			expect(posts).toHaveLength(Math.ceil(206 / REACH_BATCH));
			expect(posts.reduce((sum, line) => sum + Number(line.items), 0)).toBe(206);
			// Semantic search was off in every request: no log line carries a semantic status.
			expect(posts.every((line) => line.semantic === undefined && line.status === 200)).toBe(true);
			// The address is outside the range of the load clients, so the check spends none of their budget.
			expect(net.isIPv4(REACH_CLIENT)).toBe(true);
			expect(Array.from({ length: MAX_CLIENTS }, (_, i) => clientAddress(i))).not.toContain(REACH_CLIENT);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('finds that a larger top sends more of the real queries to the embedder', async () => {
		const daemon = await startDaemon();
		try {
			const corpus = loadCorpus(DEFAULT_CORPUS_PATH);

			const atTen = await runReachCheck(new URL(daemon.url), corpus, 10);
			const atFifty = await runReachCheck(new URL(daemon.url), corpus, 50);

			// On the real engine and the 206 real queries, about a quarter of the queries fall short of 10
			// results and nearly all of them fall short of 50.
			expect(atTen.share).toBeGreaterThan(0.1);
			expect(atTen.share).toBeLessThan(0.45);
			expect(atFifty.share).toBeGreaterThan(0.9);
			// A few queries do fill 50 results. A request sent without its top would get at most 10 and make
			// every query look short of 50, so a share below 1 shows that the top went to the daemon.
			expect(atFifty.belowTop).toBeLessThan(atFifty.answered);
			// A query short of 10 results is short of 50 as well, so the count can only grow.
			expect(atFifty.belowTop).toBeGreaterThan(atTen.belowTop);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('counts the queries as errors when the daemon refuses them', async () => {
		// The bundled test configuration allows 20 queries in a request; this daemon allows 5 and rejects each batch.
		const daemon = await startDaemon({ HED_LSP_MAX_QUERIES: '5' });
		try {
			const reach = await runReachCheck(new URL(daemon.url), loadCorpus(DEFAULT_CORPUS_PATH), 10);

			expect(reach).toEqual({ top: 10, queries: 206, answered: 0, belowTop: 0, share: null, errors: 206 });
		} finally {
			await daemon.stop();
		}
	}, 60_000);
});

interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run the compiled harness with these arguments and wait for it to exit. */
function runHarness(args: string[]): Promise<ProcessResult> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[compiled('loadTest.js'), ...args],
			{ env: childEnv(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error ? ((error as { code?: unknown }).code as number | null) : 0;
				resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
			},
		);
	});
}

describe('the compiled harness', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('runs two seconds at concurrency two against a real daemon and writes a complete JSON report', async () => {
		const daemon = await startDaemon();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-load-'));
		dirs.push(dir);
		const out = path.join(dir, 'report.json');
		try {
			const result = await runHarness([
				'--url',
				daemon.url,
				'--concurrency',
				'2',
				'--duration',
				'2',
				'--clients',
				'3',
				'--out',
				out,
			]);

			expect(result.code).toBe(0);
			// The report goes to the file, and standard output stays empty.
			expect(result.stdout).toBe('');
			expect(result.stderr).toMatch(/requests in/);
			const report = JSON.parse(fs.readFileSync(out, 'utf-8'));

			expect(report.tool).toBe('hed-lsp-daemon-load-test');
			expect(Number.isNaN(Date.parse(report.startedAt))).toBe(false);
			expect(report.elapsedSeconds).toBeGreaterThanOrEqual(2);
			expect(report.elapsedSeconds).toBeLessThan(15);
			expect(report.params).toMatchObject({
				url: daemon.url,
				concurrency: 2,
				durationSeconds: 2,
				mix: { suggest: 60, validate: 30, semantic: 10 },
				clients: 3,
				corpus: { queries: 206, strings: 206 },
				batch: { suggest: 5, validate: 10, semantic: 1 },
			});
			expect(report.params.corpus.file).toBe(DEFAULT_CORPUS_PATH);

			for (const when of ['before', 'after']) {
				expect(report.health[when].status).toBe(200);
				expect(report.health[when].body.status).toBe('ok');
				expect(report.health[when].body.apiVersion).toBe('1.0');
			}

			expect(Object.keys(report.endpoints).sort()).toEqual(['semantic', 'suggest', 'validate']);
			for (const name of ENDPOINTS) {
				const endpoint = report.endpoints[name];
				expect(endpoint.requests, name).toBeGreaterThan(0);
				expect(endpoint.ok, name).toBe(endpoint.requests);
				expect(endpoint.errors, name).toBe(0);
				expect(endpoint.errorRate, name).toBe(0);
				expect(endpoint.status, name).toEqual({ '200': endpoint.requests });
				expect(endpoint.rejections, name).toEqual({ '429': {}, '503': {} });
				expect(endpoint.withoutRetryAfter, name).toEqual({ '429': {}, '503': {} });
				const { p50, p95, p99, max } = endpoint.latencyMs;
				for (const value of [p50, p95, p99, max]) {
					expect(typeof value).toBe('number');
				}
				expect(p50).toBeGreaterThan(0);
				expect(p50).toBeLessThanOrEqual(p95);
				expect(p95).toBeLessThanOrEqual(p99);
				expect(p99).toBeLessThanOrEqual(max);
				expect(endpoint.throughputRps, name).toBeGreaterThan(0);
			}
			// Semantic search is off on this daemon, so its requests are answered, and say so.
			expect(report.endpoints.semantic.semanticStatus).toEqual({ disabled: report.endpoints.semantic.requests });
			expect(report.endpoints.suggest.semanticStatus).toBeUndefined();

			const total = ENDPOINTS.reduce((sum, name) => sum + report.endpoints[name].requests, 0);
			expect(report.overall.requests).toBe(total);
			expect(report.overall.ok).toBe(total);
			expect(report.overall.errorRate).toBe(0);
			expect(report.overall.latencyMs.p99).toBeGreaterThan(0);
			expect(report.overall.throughputRps).toBeGreaterThan(0);

			// The daemon saw each request the harness counted, no more and no fewer.
			const posts = (): number =>
				daemon.logLines().filter((line) => line.msg === 'request' && line.method === 'POST').length;
			await waitFor(() => posts() === total, 5000, 'the daemon to log every request');
			expect(posts()).toBe(total);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('writes the report to standard output when there is no --out, and exits 2 with a message for a bad option', async () => {
		const daemon = await startDaemon();
		try {
			const run = await runHarness(['--url', daemon.url, '--duration', '0.3', '--mix', 'validate=1']);
			const bad = await runHarness(['--mix', 'search=1']);
			const help = await runHarness(['--help']);

			expect(run.code).toBe(0);
			const report = JSON.parse(run.stdout);
			expect(Object.keys(report.endpoints)).toEqual(['validate']);
			expect(report.endpoints.validate.requests).toBeGreaterThan(0);
			expect(bad.code).toBe(2);
			expect(bad.stdout).toBe('');
			expect(bad.stderr).toContain('"search"');
			expect(help.code).toBe(0);
			expect(help.stdout).toBe(HELP);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('reports the reach and the semantic shape when asked, and no reach when not asked', async () => {
		const daemon = await startDaemon();
		try {
			const asked = await runHarness([
				'--url',
				daemon.url,
				'--duration',
				'0.5',
				'--mix',
				'semantic=1',
				'--semantic-top',
				'50',
				'--semantic-batch',
				'7',
				'--reach-check',
			]);
			const plain = await runHarness(['--url', daemon.url, '--duration', '0.3', '--mix', 'validate=1']);

			expect(asked.code).toBe(0);
			const report = JSON.parse(asked.stdout);
			expect(report.reach).toMatchObject({ top: 50, queries: 206, answered: 206, errors: 0 });
			expect(report.reach.share).toBeGreaterThan(0.9);
			expect(report.params.semanticTop).toBe(50);
			expect(report.params.batch).toEqual({ suggest: 5, validate: 10, semantic: 7 });
			expect(asked.stderr).toMatch(/reach at top 50: \d+(\.\d)?% of 206 answered queries/);
			// Each semantic request of the run carried 7 queries.
			const semanticPosts = daemon
				.logLines()
				.filter((line) => line.msg === 'request' && line.method === 'POST' && line.semantic !== undefined);
			expect(semanticPosts.length).toBe(report.endpoints.semantic.requests);
			expect(semanticPosts.every((line) => line.items === 7)).toBe(true);

			expect(plain.code).toBe(0);
			const plainReport = JSON.parse(plain.stdout);
			expect(plainReport).not.toHaveProperty('reach');
			expect(plainReport.params.semanticTop).toBe(10);
			expect(plainReport.params.batch).toEqual({ suggest: 5, validate: 10, semantic: 1 });
			expect(plain.stderr).not.toMatch(/reach at top/);
		} finally {
			await daemon.stop();
		}
	}, 60_000);

	it('records the Retry-After of the refusals of a real daemon, the 429 answers and the OVERLOADED 503 answers', async () => {
		// One request at a time on a bucket of 50 units, at 10 units a request, is limited from the sixth request on.
		const limiting = await startDaemon({ HED_LSP_RATE_ITEMS_PER_SEC: '1', HED_LSP_RATE_ITEMS_BURST: '50' });
		// One request in flight for each client, and sixteen workers that share one address.
		const crowded = await startDaemon({ HED_LSP_MAX_IN_FLIGHT_PER_CLIENT: '1' });
		try {
			const limited = await runHarness([
				'--url',
				limiting.url,
				'--duration',
				'1',
				'--concurrency',
				'1',
				'--mix',
				'validate=1',
			]);
			const overloaded = await runHarness([
				'--url',
				crowded.url,
				'--duration',
				'1.5',
				'--concurrency',
				'16',
				'--clients',
				'1',
				'--mix',
				'suggest=1',
			]);

			const rate = JSON.parse(limited.stdout).endpoints.validate;
			const busy = JSON.parse(overloaded.stdout).endpoints.suggest;
			// The refusals are real, and the daemon sent each of them a Retry-After of at least one second.
			expect(rate.rejections['429'].RATE_LIMITED).toBeGreaterThan(0);
			expect(rate.withoutRetryAfter).toEqual({ '429': {}, '503': {} });
			expect(busy.rejections['503'].OVERLOADED).toBeGreaterThan(0);
			expect(busy.withoutRetryAfter).toEqual({ '429': {}, '503': {} });
		} finally {
			await limiting.stop();
			await crowded.stop();
		}
	}, 60_000);

	it('exits 1, after writing the report, when nothing answers', async () => {
		// A port that was just free and is closed again, so connections to it are refused.
		const closed = await new Promise<number>((resolve, reject) => {
			const probe = net.createServer();
			probe.once('error', reject);
			probe.listen(0, '127.0.0.1', () => {
				const { port } = probe.address() as net.AddressInfo;
				probe.close(() => resolve(port));
			});
		});

		const result = await runHarness([
			'--url',
			`http://127.0.0.1:${closed}`,
			'--duration',
			'0.3',
			'--mix',
			'validate=1',
		]);

		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.health.before).toHaveProperty('error');
		expect(report.endpoints.validate.status).toEqual({ network: report.endpoints.validate.requests });
		expect(report.endpoints.validate.errorRate).toBe(1);
		expect(report.endpoints.validate.latencyMs.p50).toBeNull();
	}, 60_000);
});
