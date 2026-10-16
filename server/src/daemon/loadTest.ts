#!/usr/bin/env node

/**
 * The load harness for the daemon. It sends a weighted mix of suggest, validate, and semantic
 * suggest requests, built from real text, at a fixed concurrency for a fixed time, and reports for
 * each endpoint and for the whole run the latency percentiles, the error rate, the 429 and 503
 * answers by error code, and the throughput, with the daemon's health before and after. It measures
 * a daemon that is already running, such as the one in the container image, and it is the tool the
 * limits are calibrated with. It uses only node built-ins, and the daemon boundary test checks it.
 *
 * The text is the evaluation set of the repository (`server/eval/hed-examples-pairs.json`): the
 * descriptions are the suggest and semantic queries, and the HED strings are the validate input.
 * Nothing is generated. A run is repeatable: the choice of endpoint, text, and client comes from a
 * seeded generator, so two runs with the same options send the same requests in the same order per
 * worker, though the timing between them differs.
 *
 * Exit codes: 0 when the run finished, 2 for bad options, 1 when no request got any answer, which
 * means the target could not be reached.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

/** The three kinds of request. Semantic is a suggest request with `semantic: true`. */
export const ENDPOINTS = ['suggest', 'validate', 'semantic'] as const;
export type EndpointName = (typeof ENDPOINTS)[number];

/** The relative share of each endpoint. A share of 0 means the endpoint is not sent. */
export type Mix = Record<EndpointName, number>;

export const DEFAULT_URL = 'http://127.0.0.1:38530';
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_DURATION_SECONDS = 60;
export const DEFAULT_MIX = 'suggest=60,validate=30,semantic=10';
export const DEFAULT_CLIENTS = 1;

export const MAX_CONCURRENCY = 1024;
export const MAX_DURATION_SECONDS = 86_400;
export const MAX_CLIENTS = 60_000;
const MAX_WEIGHT = 1_000_000;

/** Items in one request of each endpoint: queries for suggest, strings for validate. */
export const BATCH: Readonly<Record<EndpointName, number>> = { suggest: 5, validate: 10, semantic: 1 };

/** The seed of the generator that chooses requests; worker `n` uses SEED + n. */
export const SEED = 1;

/** How long the harness waits for one answer, past the daemon's own request timeout of 30 seconds. */
const REQUEST_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;

/** The evaluation set of the repository, found from the compiled or the source location alike. */
export const DEFAULT_CORPUS_PATH = path.resolve(__dirname, '..', '..', 'eval', 'hed-examples-pairs.json');

export const HELP = `Usage: node out/daemon/loadTest.js [options]

Send a mix of requests to a running daemon and report latency, errors, and throughput as JSON.

Options:
  --url URL          Base URL of the daemon, with its path prefix if it has one
                     (default ${DEFAULT_URL})
  --concurrency N    Requests in flight at once, 1 to ${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY})
  --duration SECONDS How long to send requests, above 0 (default ${DEFAULT_DURATION_SECONDS})
  --mix SPEC         Relative share of each endpoint, as name=weight pairs separated by commas,
                     from suggest, validate, and semantic (default ${DEFAULT_MIX}).
                     Weights are whole numbers, an endpoint left out is not sent, and any other
                     name, a repeated name, or a stray space is an error.
  --clients N        Number of distinct X-Forwarded-For addresses to send, 1 to ${MAX_CLIENTS}
                     (default ${DEFAULT_CLIENTS}). The daemon rate-limits each address on its own.
                     The target uses the header only when this machine's address is one of its
                     trusted proxies (HED_LSP_TRUSTED_PROXIES; the default trusts 127.0.0.1 and ::1).
                     Otherwise it ignores the header, and every request shares one rate-limit key.
  --out FILE         Write the JSON report to FILE instead of standard output
  --corpus FILE      JSON file with a "pairs" array of {"query", "hed"} objects
                     (default: the 206 evaluation pairs in server/eval)
  -h, --help         Show this text

Each suggest request carries ${BATCH.suggest} queries, each validate request ${BATCH.validate} strings, and each
semantic request ${BATCH.semantic} query. Latency percentiles use the nearest-rank method over the
answers with a 2xx status; the error rate counts every other outcome, rejections included.
`;

/** A bad command line or corpus. The message is written for the person who typed the command. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

function isEndpoint(name: string): name is EndpointName {
	return (ENDPOINTS as readonly string[]).includes(name);
}

/**
 * Read a `--mix` value such as `suggest=60,validate=30,semantic=10`. The syntax is strict: each
 * entry is a known endpoint name, an equals sign, and a whole number, with no spaces; a name may
 * appear once; and at least one weight must be above 0. An endpoint left out has weight 0.
 */
export function parseMix(text: string): Mix {
	const mix: Mix = { suggest: 0, validate: 0, semantic: 0 };
	const seen = new Set<string>();
	for (const entry of text.split(',')) {
		const match = /^([a-z]+)=(\d+)$/.exec(entry);
		if (!match) {
			throw new UsageError(`--mix entry "${entry}" must look like name=weight, such as suggest=60`);
		}
		const [, name, digits] = match;
		if (!isEndpoint(name)) {
			throw new UsageError(`--mix names "${name}", which is not an endpoint; use ${ENDPOINTS.join(', ')}`);
		}
		if (seen.has(name)) {
			throw new UsageError(`--mix names "${name}" more than once`);
		}
		const weight = Number(digits);
		if (!Number.isSafeInteger(weight) || weight > MAX_WEIGHT) {
			throw new UsageError(`--mix weight for "${name}" must be a whole number up to ${MAX_WEIGHT}, got "${digits}"`);
		}
		seen.add(name);
		mix[name] = weight;
	}
	if (ENDPOINTS.every((name) => mix[name] === 0)) {
		throw new UsageError('--mix needs at least one weight above 0');
	}
	return mix;
}

/**
 * The endpoint for a draw `unit` from 0 up to, but not including, 1: the shares lay end to end, in
 * the order suggest, validate, semantic, and the draw lands in one of them. An endpoint with weight
 * 0 is never chosen.
 */
export function pickEndpoint(mix: Mix, unit: number): EndpointName {
	let remaining = unit * ENDPOINTS.reduce((sum, name) => sum + mix[name], 0);
	let last: EndpointName = ENDPOINTS[0];
	for (const name of ENDPOINTS) {
		if (mix[name] === 0) {
			continue;
		}
		last = name;
		if (remaining < mix[name]) {
			return name;
		}
		remaining -= mix[name];
	}
	return last;
}

/**
 * The p-th percentile of values sorted in ascending order, by the nearest-rank method: the value at
 * rank ceil(p / 100 * n), counting from 1, so a percentile is always one of the values measured.
 * Null when there are no values.
 */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
	if (!(p >= 0 && p <= 100)) {
		throw new RangeError('p must be from 0 to 100');
	}
	const n = sortedAscending.length;
	if (n === 0) {
		return null;
	}
	// The small allowance keeps a product such as 99.9 * 1000 / 100 from rounding up to the next rank.
	const rank = Math.min(n, Math.max(1, Math.ceil((p * n) / 100 - 1e-9)));
	return sortedAscending[rank - 1];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export interface LatencySummary {
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
}

/** The latency percentiles and the maximum of `valuesMs`, in milliseconds to two decimals. */
export function summarizeLatencies(valuesMs: readonly number[]): LatencySummary {
	const sorted = [...valuesMs].sort((a, b) => a - b);
	const at = (p: number): number | null => {
		const value = percentile(sorted, p);
		return value === null ? null : round2(value);
	};
	const max = sorted.length === 0 ? null : round2(sorted[sorted.length - 1]);
	return { p50: at(50), p95: at(95), p99: at(99), max };
}

/** What one request came to. */
export interface Sample {
	/** The HTTP status, or null when no answer arrived. */
	status: number | null;
	/** Milliseconds from sending the request to the end of the answer, or to the failure. */
	ms: number;
	/** The daemon's error code for an answer that is not 2xx, or the reason no answer arrived. */
	errorCode?: string;
	/** The semantic status a 200 answer to a semantic request carried. */
	semanticStatus?: string;
}

export interface EndpointReport {
	/** Requests that finished, with or without an answer. */
	requests: number;
	/** Requests answered with a 2xx status. */
	ok: number;
	/** Everything else: other statuses, including 429 and 503, and requests with no answer. */
	errors: number;
	errorRate: number;
	/** Requests by HTTP status; "network" counts the requests that got no answer. */
	status: Record<string, number>;
	/** The 429 and 503 answers by the daemon's error code. */
	rejections: { '429': Record<string, number>; '503': Record<string, number> };
	/** Over the answers with a 2xx status. */
	latencyMs: LatencySummary;
	throughputRps: number;
	/** For the semantic endpoint, the semantic status of the answers that reported one. */
	semanticStatus?: Record<string, number>;
}

function count(into: Record<string, number>, key: string): void {
	into[key] = (into[key] ?? 0) + 1;
}

/** Summarize samples taken over `elapsedSeconds`. */
export function summarizeSamples(samples: readonly Sample[], elapsedSeconds: number): EndpointReport {
	const status: Record<string, number> = {};
	const rejections: EndpointReport['rejections'] = { '429': {}, '503': {} };
	const semanticStatus: Record<string, number> = {};
	const okLatencies: number[] = [];
	for (const sample of samples) {
		count(status, sample.status === null ? 'network' : String(sample.status));
		if (sample.status !== null && sample.status >= 200 && sample.status < 300) {
			okLatencies.push(sample.ms);
		}
		if (sample.status === 429 || sample.status === 503) {
			count(rejections[sample.status === 429 ? '429' : '503'], sample.errorCode ?? 'UNKNOWN');
		}
		if (sample.semanticStatus !== undefined) {
			count(semanticStatus, sample.semanticStatus);
		}
	}
	const requests = samples.length;
	const errors = requests - okLatencies.length;
	const report: EndpointReport = {
		requests,
		ok: okLatencies.length,
		errors,
		errorRate: requests === 0 ? 0 : round4(errors / requests),
		status,
		rejections,
		latencyMs: summarizeLatencies(okLatencies),
		throughputRps: elapsedSeconds > 0 ? round2(requests / elapsedSeconds) : 0,
	};
	if (Object.keys(semanticStatus).length > 0) {
		report.semanticStatus = semanticStatus;
	}
	return report;
}

/** The real text a run draws from. */
export interface Corpus {
	/** Descriptions, sent as suggest and semantic queries. */
	queries: string[];
	/** HED strings, sent for validation. */
	strings: string[];
}

/**
 * Read a corpus file: a JSON object with a `pairs` array of objects that each have a non-blank
 * string `query` and `hed`, as the evaluation set does. Any other shape is a usage error.
 */
export function loadCorpus(file: string): Corpus {
	let data: unknown;
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch (error) {
		throw new UsageError(`cannot read the corpus ${file}: ${(error as Error).message}`);
	}
	const pairs = typeof data === 'object' && data !== null ? (data as { pairs?: unknown }).pairs : undefined;
	if (!Array.isArray(pairs) || pairs.length === 0) {
		throw new UsageError(`the corpus ${file} must be a JSON object with a non-empty "pairs" array`);
	}
	const corpus: Corpus = { queries: [], strings: [] };
	for (const [index, pair] of pairs.entries()) {
		const { query, hed } = (typeof pair === 'object' && pair !== null ? pair : {}) as {
			query?: unknown;
			hed?: unknown;
		};
		if (typeof query !== 'string' || query.trim() === '' || typeof hed !== 'string' || hed.trim() === '') {
			throw new UsageError(`pair ${index} of the corpus ${file} needs a non-blank string "query" and "hed"`);
		}
		corpus.queries.push(query);
		corpus.strings.push(hed);
	}
	return corpus;
}

/** A small seeded generator (mulberry32): draws from 0 up to, but not including, 1. */
export function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export interface RequestPlan {
	endpoint: EndpointName;
	/** The route, such as /v1/validate, appended to the base URL. */
	route: string;
	body: string;
}

/** The request for one draw of `endpoint`: its items are chosen from the corpus with `random`. */
export function planRequest(endpoint: EndpointName, corpus: Corpus, random: () => number): RequestPlan {
	const pick = (items: readonly string[]): string[] =>
		Array.from({ length: BATCH[endpoint] }, () => items[Math.floor(random() * items.length)]);
	switch (endpoint) {
		case 'validate':
			return { endpoint, route: '/v1/validate', body: JSON.stringify({ strings: pick(corpus.strings) }) };
		case 'suggest':
			return { endpoint, route: '/v1/suggest', body: JSON.stringify({ queries: pick(corpus.queries), top: 10 }) };
		case 'semantic':
			return {
				endpoint,
				route: '/v1/suggest',
				body: JSON.stringify({ queries: pick(corpus.queries), top: 10, semantic: true }),
			};
	}
}

/**
 * The address of synthetic client `index`, from the 198.18.0.0/15 block that is set aside for
 * benchmarking and is never routed on the internet. Distinct for every index below MAX_CLIENTS.
 */
export function clientAddress(index: number): string {
	return `198.18.${Math.floor(index / 254)}.${(index % 254) + 1}`;
}

export interface LoadOptions {
	url: string;
	concurrency: number;
	durationSeconds: number;
	mix: Mix;
	clients: number;
	/** Where the JSON report goes; standard output when absent. */
	out?: string;
	corpus: string;
}

const VALUE_FLAGS = ['--url', '--concurrency', '--duration', '--mix', '--clients', '--out', '--corpus'] as const;

function wholeNumber(flag: string, text: string, min: number, max: number): number {
	const value = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new UsageError(`${flag} must be a whole number from ${min} to ${max}, got "${text}"`);
	}
	return value;
}

/**
 * Read the command line. Returns "help" for -h or --help. A flag takes its value as the next
 * argument or after an equals sign, may appear once, and an unknown flag is an error.
 */
export function parseArgs(argv: readonly string[]): LoadOptions | 'help' {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			return 'help';
		}
		const equals = arg.indexOf('=');
		const flag = arg.startsWith('--') && equals !== -1 ? arg.slice(0, equals) : arg;
		if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
			throw new UsageError(`unknown option "${arg}"; run with --help for the options`);
		}
		if (values.has(flag)) {
			throw new UsageError(`${flag} is given more than once`);
		}
		let value: string | undefined;
		if (flag !== arg) {
			value = arg.slice(equals + 1);
		} else {
			value = argv[++i];
		}
		if (value === undefined) {
			throw new UsageError(`${flag} needs a value`);
		}
		values.set(flag, value);
	}

	const url = values.get('--url') ?? DEFAULT_URL;
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new UsageError(`--url must be an http or https URL, got "${url}"`);
	}
	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new UsageError(`--url must be an http or https URL, got "${url}"`);
	}
	const duration = values.get('--duration') ?? String(DEFAULT_DURATION_SECONDS);
	const durationSeconds = Number(duration);
	if (!/^(?:\d+\.?\d*|\.\d+)$/.test(duration) || !(durationSeconds > 0) || durationSeconds > MAX_DURATION_SECONDS) {
		throw new UsageError(
			`--duration must be a number of seconds above 0 and at most ${MAX_DURATION_SECONDS}, got "${duration}"`,
		);
	}
	return {
		url,
		concurrency: wholeNumber(
			'--concurrency',
			values.get('--concurrency') ?? String(DEFAULT_CONCURRENCY),
			1,
			MAX_CONCURRENCY,
		),
		durationSeconds,
		mix: parseMix(values.get('--mix') ?? DEFAULT_MIX),
		clients: wholeNumber('--clients', values.get('--clients') ?? String(DEFAULT_CLIENTS), 1, MAX_CLIENTS),
		out: values.get('--out'),
		corpus: values.get('--corpus') ?? DEFAULT_CORPUS_PATH,
	};
}

/** The daemon's answer to /v1/health, or why there was none. */
export type HealthSnapshot = { status: number; body: unknown } | { error: string };

function transportFor(url: URL): typeof http | typeof https {
	return url.protocol === 'https:' ? https : http;
}

/** The URL of `route` under the base URL, keeping any path prefix the base has. */
export function routeUrl(base: URL, route: string): URL {
	const url = new URL(base.href);
	url.pathname = base.pathname.replace(/\/+$/, '') + route;
	url.search = '';
	url.hash = '';
	return url;
}

function getHealth(base: URL): Promise<HealthSnapshot> {
	return new Promise((resolve) => {
		const request = transportFor(base).get(
			routeUrl(base, '/v1/health'),
			{ agent: false, timeout: HEALTH_TIMEOUT_MS },
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf-8');
					try {
						resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
					} catch {
						resolve({ error: `health answered ${response.statusCode} with a body that is not JSON` });
					}
				});
				response.on('error', (error) => resolve({ error: error.message }));
			},
		);
		request.on('timeout', () => {
			request.destroy();
			resolve({ error: `health did not answer within ${HEALTH_TIMEOUT_MS} ms` });
		});
		request.on('error', (error) => resolve({ error: error.message }));
	});
}

/** What a finished answer says: the daemon's error code, or the semantic status of a 200. */
function readAnswer(
	endpoint: EndpointName,
	status: number,
	body: Buffer,
): Pick<Sample, 'errorCode' | 'semanticStatus'> {
	let json: { error?: { code?: unknown }; semantic?: { status?: unknown } } | undefined;
	try {
		json = JSON.parse(body.toString('utf-8'));
	} catch {
		json = undefined;
	}
	if (status >= 200 && status < 300) {
		const semanticStatus = json?.semantic?.status;
		return endpoint === 'semantic' && typeof semanticStatus === 'string' ? { semanticStatus } : {};
	}
	const code = json?.error?.code;
	return { errorCode: typeof code === 'string' ? code : 'UNKNOWN' };
}

function send(agent: http.Agent, url: URL, plan: RequestPlan, client: string): Promise<Sample> {
	return new Promise((resolve) => {
		const started = performance.now();
		let settled = false;
		const finish = (outcome: Omit<Sample, 'ms'>): void => {
			if (!settled) {
				settled = true;
				resolve({ ...outcome, ms: performance.now() - started });
			}
		};
		const request = transportFor(url).request(
			url,
			{
				method: 'POST',
				agent,
				timeout: REQUEST_TIMEOUT_MS,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(plan.body),
					'X-Forwarded-For': client,
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () => {
					const status = response.statusCode ?? 0;
					finish({ status, ...readAnswer(plan.endpoint, status, Buffer.concat(chunks)) });
				});
				response.on('error', () => finish({ status: null, errorCode: 'RESPONSE_ERROR' }));
				response.on('close', () => {
					if (!response.complete) {
						finish({ status: null, errorCode: 'CONNECTION_CLOSED' });
					}
				});
			},
		);
		request.on('timeout', () => {
			request.destroy();
			finish({ status: null, errorCode: 'CLIENT_TIMEOUT' });
		});
		request.on('error', (error: NodeJS.ErrnoException) =>
			finish({ status: null, errorCode: error.code ?? 'REQUEST_ERROR' }),
		);
		request.end(plan.body);
	});
}

export interface LoadReport {
	tool: 'hed-lsp-daemon-load-test';
	startedAt: string;
	elapsedSeconds: number;
	params: {
		url: string;
		concurrency: number;
		durationSeconds: number;
		mix: Mix;
		clients: number;
		corpus: { file: string; queries: number; strings: number };
		batch: Readonly<Record<EndpointName, number>>;
		seed: number;
	};
	health: { before: HealthSnapshot; after: HealthSnapshot };
	overall: EndpointReport;
	endpoints: Partial<Record<EndpointName, EndpointReport>>;
}

/**
 * Run the load: `concurrency` workers each send one request at a time until `durationSeconds` have
 * passed, and the requests still in flight then finish. Health is read before and after.
 */
export async function runLoadTest(options: LoadOptions, corpus: Corpus): Promise<LoadReport> {
	const base = new URL(options.url);
	const healthBefore = await getHealth(base);
	const clients = Array.from({ length: options.clients }, (_, index) => clientAddress(index));
	const agent = new (transportFor(base).Agent)({ keepAlive: true, maxSockets: options.concurrency });
	const samples: Record<EndpointName, Sample[]> = { suggest: [], validate: [], semantic: [] };

	const startedAt = new Date();
	const start = performance.now();
	const deadline = start + options.durationSeconds * 1000;
	await Promise.all(
		Array.from({ length: options.concurrency }, async (_, worker) => {
			const random = createRandom(SEED + worker);
			while (performance.now() < deadline) {
				const endpoint = pickEndpoint(options.mix, random());
				const plan = planRequest(endpoint, corpus, random);
				const client = clients[Math.floor(random() * clients.length)];
				samples[endpoint].push(await send(agent, routeUrl(base, plan.route), plan, client));
			}
		}),
	);
	const elapsedSeconds = (performance.now() - start) / 1000;
	agent.destroy();
	const healthAfter = await getHealth(base);

	const endpoints: LoadReport['endpoints'] = {};
	for (const name of ENDPOINTS) {
		if (options.mix[name] > 0) {
			endpoints[name] = summarizeSamples(samples[name], elapsedSeconds);
		}
	}
	return {
		tool: 'hed-lsp-daemon-load-test',
		startedAt: startedAt.toISOString(),
		elapsedSeconds: round2(elapsedSeconds),
		params: {
			url: options.url,
			concurrency: options.concurrency,
			durationSeconds: options.durationSeconds,
			mix: options.mix,
			clients: options.clients,
			corpus: { file: options.corpus, queries: corpus.queries.length, strings: corpus.strings.length },
			batch: BATCH,
			seed: SEED,
		},
		health: { before: healthBefore, after: healthAfter },
		overall: summarizeSamples(Object.values(samples).flat(), elapsedSeconds),
		endpoints,
	};
}

/** Run the command line. Returns the exit code; the caller sets it, so standard output drains first. */
export async function main(argv: readonly string[]): Promise<number> {
	let options: LoadOptions | 'help';
	let corpus: Corpus | undefined;
	try {
		options = parseArgs(argv);
		if (options !== 'help') {
			corpus = loadCorpus(options.corpus);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n`);
			return 2;
		}
		throw error;
	}
	if (options === 'help' || !corpus) {
		process.stdout.write(HELP);
		return 0;
	}

	const report = await runLoadTest(options, corpus);
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (options.out) {
		fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
		fs.writeFileSync(options.out, json);
	} else {
		process.stdout.write(json);
	}
	const { overall } = report;
	process.stderr.write(
		`${overall.requests} requests in ${report.elapsedSeconds} s (${overall.throughputRps} per second), ` +
			`error rate ${overall.errorRate}, p95 ${overall.latencyMs.p95} ms\n`,
	);
	return overall.requests > 0 && overall.status.network === overall.requests ? 1 : 0;
}

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
			process.exitCode = 1;
		},
	);
}
