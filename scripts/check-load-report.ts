#!/usr/bin/env bun

/**
 * Evaluate a report of the daemon load harness (`server/src/daemon/loadTest.ts`) against the
 * acceptance criteria of the hedtools deployment (docs/deployment-hedtools.md), and exit non-zero
 * when one fails.
 *
 * Usage: bun scripts/check-load-report.ts --profile NAME [--host FILE | --no-host] [--rehearsal] [--json] REPORT.json
 *
 * Profiles, one per run of deploy/hedtools/measure.sh:
 *   s0            Semantic search off, concurrency 4 or 8 (the gate is the run at concurrency 4).
 *   s0-overload   Semantic search off, concurrency 12: at least one OVERLOADED 503 answer with a Retry-After,
 *                 and no other 5xx answer; the daemon must answer again within 5 seconds.
 *   s1-mixed      Semantic search on, the 300 s mixed run.
 *   s1-capacity   Semantic search on, semantic requests only; the reach and the capacity C.
 *   s1-realistic  Semantic search on, `--semantic-top 10 --semantic-batch 10`.
 *   s1-soak       Semantic search on, 30 minutes at concurrency 1.
 *
 * The harness report holds the latency and the answers. Memory, out-of-memory kills, restarts, the memory
 * left on the host, the soak drift, the recovery time, and the neighbors come from the file that measure.sh
 * writes beside it (`--host FILE`, by default REPORT with `.host.json` in place of `.json`). A criterion
 * whose data is missing fails; `--no-host` skips the criteria that need the host file and says so. In
 * every profile, each 429 and 503 answer must carry a Retry-After that is an integer of at least 1, and a
 * reach check that left a query without an answer fails.
 *
 * The host file says whether the run was a rehearsal (`measure.sh --rehearsal`), which is practice and not a
 * result. Without `--rehearsal`, a host file of a rehearsal fails. With it, the files are judged as practice
 * and the output says so, and a host file of a real run fails. `--rehearsal` needs the host file, so it
 * excludes `--no-host`.
 * The correctness of the semantic results (issues #70 and #71) is not something a report can show.
 *
 * Exit status: 0 when every criterion passes or is skipped, 1 when one fails, 2 for bad arguments or a
 * report that cannot be read.
 */

import * as fs from 'node:fs';

export const PROFILES = ['s0', 's0-overload', 's1-mixed', 's1-capacity', 's1-realistic', 's1-soak'] as const;
export type Profile = (typeof PROFILES)[number];

/** The limits of the criteria table. */
export const LIMITS = {
	semanticP95Ms: 500,
	semanticP99Ms: 1000,
	nonSemanticP95Ms: 100,
	nonSemanticP99Ms: 300,
	semanticBusyShare: 0.01,
	reachShare: 0.95,
	s0MemoryMiB: 600,
	s1MemoryMiB: 3 * 1024,
	hostAvailableMiB: 1.5 * 1024,
	soakDriftShare: 0.1,
	recoverySeconds: 5,
	loopbackP95Ms: 150,
	apacheP95Ms: 300,
	/** The rate-limit criterion applies to runs with at least this many distinct clients. */
	clientsFor429: 64,
} as const;

/**
 * The services that share the host with the daemon, under the names that neighbor-probe.sh gives them, and
 * for the first three the Docker container that must be watched. A run that watched anything else did not
 * protect them, so a host run fails without all four; a rehearsal may watch other targets.
 */
export const NEIGHBORS: readonly { name: string; kind: 'loopback' | 'apache'; container?: string }[] = [
	{ name: 'osa', kind: 'loopback', container: 'osa' },
	{ name: 'hedit', kind: 'loopback', container: 'hedit' },
	{ name: 'hedtools', kind: 'loopback', container: 'hedtools' },
	{ name: 'hedtools-apache', kind: 'apache' },
];

type Verdict = 'pass' | 'fail' | 'skip';

export interface Result {
	verdict: Verdict;
	criterion: string;
	/** What was measured and what the limit is, in words. */
	detail: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function get(value: unknown, ...keys: string[]): unknown {
	let current = value;
	for (const key of keys) {
		if (!isObject(current)) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** A report or host file that does not have the shape the harness writes. */
export class ReportError extends Error {}

const pass = (criterion: string, detail: string): Result => ({ verdict: 'pass', criterion, detail });
const fail = (criterion: string, detail: string): Result => ({ verdict: 'fail', criterion, detail });
const skip = (criterion: string, detail: string): Result => ({ verdict: 'skip', criterion, detail });

/** `ok` is the verdict; the detail reads "measured, limit". */
function check(criterion: string, ok: boolean, measured: string, limit: string): Result {
	return ok ? pass(criterion, `${measured} (${limit})`) : fail(criterion, `${measured}, over the limit (${limit})`);
}

/** The count of answers with a status in `[low, high]`, from the `status` map of an endpoint report. */
function statusCount(status: unknown, low: number, high: number): number {
	if (!isObject(status)) {
		return 0;
	}
	let total = 0;
	for (const [code, count] of Object.entries(status)) {
		const n = Number(code);
		if (Number.isInteger(n) && n >= low && n <= high && typeof count === 'number') {
			total += count;
		}
	}
	return total;
}

const rejections = (report: Json, code: string): number => {
	const by = get(report, 'overall', 'rejections', '503');
	return isObject(by) && typeof by[code] === 'number' ? (by[code] as number) : 0;
};

/** The sum of the counts in a map such as `{ OVERLOADED: 3 }`; 0 when it is not one. */
function sumCounts(value: unknown): number {
	return isObject(value)
		? Object.values(value).reduce<number>((sum, n) => sum + (typeof n === 'number' ? n : 0), 0)
		: 0;
}

/**
 * Every 429 and every 503 needs a Retry-After that is an integer of at least 1. The harness counts the
 * refusals without one, by error code, in `withoutRetryAfter`.
 */
function retryAfterResult(report: Json): Result {
	const criterion = 'Retry-After on 429 and 503 answers';
	const status = get(report, 'overall', 'status');
	const refused = statusCount(status, 429, 429) + statusCount(status, 503, 503);
	if (refused === 0) {
		return pass(criterion, 'no 429 or 503 answer');
	}
	const without = get(report, 'overall', 'withoutRetryAfter');
	if (!isObject(without)) {
		return fail(
			criterion,
			`${refused} refusals, but the report does not record their Retry-After; run the harness again`,
		);
	}
	const missing = sumCounts(without['429']) + sumCounts(without['503']);
	return missing === 0
		? pass(criterion, `${refused} refusals, each with an integer Retry-After of at least 1 s`)
		: fail(criterion, `${missing} of ${refused} refusals have no integer Retry-After of at least 1 s`);
}

function latencyChecks(report: Json, name: string, p95Max: number, p99Max: number, label: string): Result[] {
	const endpoint = get(report, 'endpoints', name);
	if (!isObject(endpoint)) {
		return [fail(`${label} latency`, `the report has no ${name} requests`)];
	}
	const p95 = num(get(endpoint, 'latencyMs', 'p95'));
	const p99 = num(get(endpoint, 'latencyMs', 'p99'));
	if (p95 === undefined || p99 === undefined) {
		return [fail(`${label} latency`, `no ${name} request was answered with a 2xx status`)];
	}
	return [
		check(`${label} p95`, p95 <= p95Max, `${p95} ms`, `at most ${p95Max} ms`),
		check(`${label} p99`, p99 <= p99Max, `${p99} ms`, `at most ${p99Max} ms`),
	];
}

/** The criteria on the harness report alone. */
export function evaluateReport(profile: Profile, report: Json): Result[] {
	const results: Result[] = [];
	const semantic = profile.startsWith('s1');
	const requests = num(get(report, 'overall', 'requests')) ?? 0;
	const network = num(get(report, 'overall', 'status', 'network')) ?? 0;

	results.push(
		requests > 0 && network === 0
			? pass('the run was answered', `${requests} requests, none without an answer`)
			: fail('the run was answered', `${requests} requests, ${network} without an answer`),
	);

	if (profile === 's0-overload') {
		const status = get(report, 'overall', 'status');
		const others = isObject(status)
			? Object.entries(status).filter(([code]) => code !== '200' && code !== '503' && code !== 'network')
			: [];
		const overloaded = rejections(report, 'OVERLOADED');
		const otherBusy = statusCount(status, 503, 503) - overloaded;
		results.push(
			others.length === 0 && otherBusy === 0
				? pass('only OVERLOADED rejections', `${overloaded} OVERLOADED 503 answers, no other rejection or error`)
				: fail(
						'only OVERLOADED rejections',
						`${otherBusy} other 503 answers and ${others.map(([c, n]) => `${n} with status ${c}`).join(', ') || 'no other status'}`,
					),
		);
		// A step that never overloaded the daemon proves nothing about how it behaves when it is overloaded.
		const without = get(report, 'overall', 'withoutRetryAfter');
		const withoutOverloaded = isObject(without) ? (num(get(without, '503', 'OVERLOADED')) ?? 0) : overloaded;
		const withRetryAfter = overloaded - withoutOverloaded;
		results.push(
			withRetryAfter >= 1
				? pass(
						'the overload was reached',
						`${withRetryAfter} OVERLOADED 503 answers with a Retry-After of at least 1 s`,
					)
				: fail(
						'the overload was reached',
						overloaded === 0
							? 'no OVERLOADED 503 answer: the step never reached a limit of the daemon'
							: isObject(without)
								? `${overloaded} OVERLOADED 503 answers, none with an integer Retry-After of at least 1 s`
								: `${overloaded} OVERLOADED 503 answers, but the report does not record their Retry-After`,
					),
		);
	} else {
		const busy = rejections(report, 'SEMANTIC_BUSY');
		const serverErrors = statusCount(get(report, 'overall', 'status'), 500, 599) - busy;
		results.push(check('5xx other than SEMANTIC_BUSY', serverErrors === 0, `${serverErrors}`, 'none'));
		if (semantic) {
			const semanticRequests = num(get(report, 'endpoints', 'semantic', 'requests')) ?? 0;
			const share = semanticRequests === 0 ? 0 : busy / semanticRequests;
			results.push(
				semanticRequests === 0
					? fail('SEMANTIC_BUSY', 'the report has no semantic requests')
					: check(
							'SEMANTIC_BUSY',
							share <= LIMITS.semanticBusyShare,
							`${busy} of ${semanticRequests} semantic requests, ${(share * 100).toFixed(2)}%`,
							`at most ${LIMITS.semanticBusyShare * 100}%`,
						),
			);
		}
	}

	const clients = num(get(report, 'params', 'clients')) ?? 1;
	const limited = statusCount(get(report, 'overall', 'status'), 429, 429);
	results.push(
		clients < LIMITS.clientsFor429
			? skip(
					'429 answers',
					`${limited} seen, but the run used ${clients} clients and the criterion is for ${LIMITS.clientsFor429}`,
				)
			: check('429 answers', limited === 0, `${limited}`, 'none'),
	);
	results.push(retryAfterResult(report));

	const reachRecord = get(report, 'reach');
	if (isObject(reachRecord)) {
		const errors = num(reachRecord.errors);
		const queries = num(reachRecord.queries);
		results.push(
			errors === undefined
				? fail('reach check answered every query', 'the reach record has no count of queries without an answer')
				: check(
						'reach check answered every query',
						errors === 0,
						`${errors} of ${queries ?? '?'} queries without an answer`,
						'none',
					),
		);
	}

	if (profile === 's0') {
		for (const name of ['suggest', 'validate']) {
			results.push(
				...latencyChecks(report, name, LIMITS.nonSemanticP95Ms, LIMITS.nonSemanticP99Ms, `non-semantic ${name}`),
			);
		}
	}
	if (profile === 's1-mixed') {
		results.push(...latencyChecks(report, 'semantic', LIMITS.semanticP95Ms, LIMITS.semanticP99Ms, 'semantic'));
		for (const name of ['suggest', 'validate']) {
			results.push(
				...latencyChecks(report, name, LIMITS.nonSemanticP95Ms, LIMITS.nonSemanticP99Ms, `non-semantic ${name}`),
			);
		}
	}
	if (semantic) {
		const status = get(report, 'endpoints', 'semantic', 'semanticStatus');
		const notOk = isObject(status)
			? Object.entries(status).filter(([name, n]) => name !== 'ok' && typeof n === 'number' && n > 0)
			: [];
		results.push(
			isObject(status) && notOk.length === 0 && num(status.ok) !== undefined
				? pass('semantic search ran', `${num(status.ok)} answers with semantic status ok`)
				: fail(
						'semantic search ran',
						notOk.length > 0
							? `answers with semantic status ${notOk.map(([name, n]) => `${name} (${n})`).join(', ')}`
							: 'no answer carried a semantic status',
					),
		);
	}
	if (profile === 's1-capacity') {
		const reach = get(report, 'reach');
		const share = num(get(reach, 'share'));
		const top = num(get(reach, 'top'));
		results.push(
			share === undefined
				? fail(
						'reach',
						isObject(reach)
							? 'no query of the reach check was answered'
							: 'the report has no reach; run the harness with --reach-check',
					)
				: check(
						'reach',
						share >= LIMITS.reachShare,
						`${(share * 100).toFixed(1)}% of the queries return fewer than ${top} results`,
						`at least ${LIMITS.reachShare * 100}%`,
					),
		);
		const rps = num(get(report, 'endpoints', 'semantic', 'throughputRps'));
		results.push(
			skip(
				'capacity C',
				rps === undefined ? 'no semantic throughput' : `${rps} semantic requests per second (recorded)`,
			),
		);
	}
	return results;
}

/**
 * The host file says whether the run was a rehearsal. A rehearsal is practice, so it is judged only when
 * the caller says that it is one, and a host file of a real run is never judged as practice, which would
 * let `--rehearsal` excuse a run.
 */
function runKindResult(host: Json, rehearsal: boolean): Result {
	const marked = get(host, 'rehearsal');
	if (typeof marked !== 'boolean') {
		return fail('run kind', 'the host file does not say whether the run was a rehearsal');
	}
	if (marked === rehearsal) {
		return pass('run kind', rehearsal ? 'a rehearsal: practice, not a result' : 'a run on the host');
	}
	return fail(
		'run kind',
		rehearsal
			? 'the host file is of a real run, not a rehearsal; judge it without --rehearsal'
			: 'the host file is of a rehearsal, which is practice and not a result; judge it with --rehearsal',
	);
}

/** The criteria on the summary of the neighbor probe, which the host file holds. */
function neighborResults(neighbors: Json, rehearsal: boolean, need: (criterion: string) => Result): Result[] {
	const results: Result[] = [];
	const aborted = get(neighbors, 'aborted');
	results.push(
		aborted === false
			? pass('neighbor probe', `no breach in ${num(get(neighbors, 'samples')) ?? '?'} samples`)
			: fail('neighbor probe', `aborted: ${String(get(neighbors, 'reason') ?? 'no reason given')}`),
	);

	// Which targets the probe watched, and whether they were the neighbors.
	const found = get(neighbors, 'targets');
	const targets: Json = isObject(found) ? found : {};
	const names = Object.keys(targets);
	const missing = NEIGHBORS.filter((n) => !names.includes(n.name)).map((n) => n.name);
	const wrongKind = NEIGHBORS.filter((n) => names.includes(n.name) && get(targets[n.name], 'kind') !== n.kind).map(
		(n) => n.name,
	);
	const defaults = get(neighbors, 'targetsAreDefault');
	const judged = `judged ${names.join(', ') || 'no target'}`;
	if (names.length === 0) {
		results.push(fail('neighbor targets', 'the probe watched no target'));
	} else if (rehearsal) {
		const other = missing.length > 0 ? ', and a rehearsal may watch other targets than the neighbors' : '';
		results.push(pass('neighbor targets', `${judged}${other}`));
	} else {
		const problems: string[] = [];
		if (missing.length > 0) {
			problems.push(`the probe did not watch ${missing.join(', ')}`);
		}
		if (wrongKind.length > 0) {
			problems.push(`${wrongKind.join(', ')} has the wrong kind of target`);
		}
		if (defaults === false) {
			problems.push('the probe was given other targets than its defaults (--target or HED_LSP_PROBE_TARGETS)');
		} else if (defaults !== true) {
			problems.push('the probe summary does not say whether its targets are the defaults');
		}
		results.push(
			problems.length === 0
				? pass('neighbor targets', `${judged}, the defaults of the probe`)
				: fail('neighbor targets', `${problems.join('; ')}; ${judged}`),
		);
	}
	for (const [name, target] of Object.entries(targets)) {
		// A host run judges a neighbor by the kind it must have, whatever the summary says.
		const kind = rehearsal
			? get(target, 'kind')
			: (NEIGHBORS.find((n) => n.name === name)?.kind ?? get(target, 'kind'));
		const p95 = num(get(target, 'p95Ms'));
		const max = kind === 'apache' ? LIMITS.apacheP95Ms : LIMITS.loopbackP95Ms;
		results.push(
			p95 === undefined
				? need(`neighbor ${name} p95`)
				: check(`neighbor ${name} p95`, p95 <= max, `${p95} ms`, `at most ${max} ms`),
		);
	}

	// Docker health counts only when it was checked, and a host run must have watched the containers.
	const criterion = 'Docker health of the neighbors';
	const checked = get(neighbors, 'dockerChecked');
	const healthy = get(neighbors, 'dockerHealthy');
	const containers = get(neighbors, 'dockerContainers');
	const watched = Array.isArray(containers) ? containers.filter((c): c is string => typeof c === 'string') : [];
	const unwatched = rehearsal
		? []
		: NEIGHBORS.flatMap((n) => (n.container !== undefined && !watched.includes(n.container) ? [n.container] : []));
	if (checked !== true) {
		results.push(
			fail(
				criterion,
				checked === false
					? 'Docker health was not checked: the probe ran without Docker, or saw no running container'
					: 'the probe summary does not say whether Docker health was checked',
			),
		);
	} else if (typeof healthy !== 'boolean') {
		results.push(need(criterion));
	} else if (unwatched.length > 0) {
		results.push(
			fail(
				criterion,
				`the probe did not watch the containers ${unwatched.join(', ')}; it watched ${watched.join(', ')}`,
			),
		);
	} else {
		results.push(
			check(
				criterion,
				healthy,
				healthy ? `${watched.length} containers, all healthy` : 'a container was not healthy',
				'all healthy',
			),
		);
	}
	return results;
}

/** The criteria on the host file that measure.sh writes. */
export function evaluateHost(profile: Profile, host: Json | undefined, rehearsal = false): Result[] {
	const need = (criterion: string): Result => fail(criterion, 'the host file has no value for it');
	if (host === undefined) {
		return [fail('host measurements', 'no host file; run measure.sh, or pass --no-host to skip these criteria')];
	}
	const results: Result[] = [runKindResult(host, rehearsal)];
	const semantic = profile.startsWith('s1');
	const container = get(host, 'container');

	const peak = num(get(container, 'memoryPeakMiB'));
	const limit = semantic ? LIMITS.s1MemoryMiB : LIMITS.s0MemoryMiB;
	results.push(
		peak === undefined
			? need('container memory peak')
			: check('container memory peak', peak <= limit, `${peak} MiB`, `at most ${limit} MiB`),
	);
	const oom = get(container, 'oomKilled');
	results.push(
		typeof oom === 'boolean'
			? check('no out-of-memory kill', !oom, oom ? 'the container was killed' : 'not killed', 'never killed')
			: need('no out-of-memory kill'),
	);
	const restarts = num(get(container, 'restartCount'));
	results.push(
		restarts === undefined ? need('restart count') : check('restart count', restarts === 0, `${restarts}`, 'none'),
	);

	const available = get(host, 'hostAvailableMinMiB');
	results.push(
		available === null
			? rehearsal
				? skip('host available memory', 'a rehearsal on a machine without /proc/meminfo')
				: fail('host available memory', 'the host does not expose /proc/meminfo, so the memory left was not measured')
			: num(available) === undefined
				? need('host available memory')
				: check(
						'host available memory',
						(num(available) as number) >= LIMITS.hostAvailableMiB,
						`lowest ${num(available)} MiB`,
						`at least ${LIMITS.hostAvailableMiB} MiB`,
					),
	);

	if (profile === 's1-soak') {
		const at5 = num(get(container, 'memoryAtMinute5MiB'));
		const end = num(get(container, 'memoryAtEndMiB'));
		if (at5 === undefined || end === undefined || at5 <= 0) {
			results.push(need('memory drift after minute 5'));
		} else {
			const drift = (end - at5) / at5;
			results.push(
				check(
					'memory drift after minute 5',
					drift <= LIMITS.soakDriftShare,
					`${(drift * 100).toFixed(1)}% (${at5} MiB at minute 5, ${end} MiB at the end)`,
					`at most ${LIMITS.soakDriftShare * 100}%`,
				),
			);
		}
	}
	if (profile === 's0-overload') {
		const recovery = num(get(host, 'recoverySeconds'));
		results.push(
			recovery === undefined
				? need('recovery after the overload')
				: check(
						'recovery after the overload',
						recovery < LIMITS.recoverySeconds,
						`${recovery} s`,
						`under ${LIMITS.recoverySeconds} s`,
					),
		);
	}

	const neighbors = get(host, 'neighbors');
	results.push(...(isObject(neighbors) ? neighborResults(neighbors, rehearsal, need) : [need('neighbors')]));
	return results;
}

function readJson(file: string, what: string): Json {
	let data: unknown;
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch (error) {
		throw new ReportError(`cannot read the ${what} ${file}: ${(error as Error).message}`);
	}
	if (!isObject(data)) {
		throw new ReportError(`the ${what} ${file} is not a JSON object`);
	}
	return data;
}

const USAGE = `Usage: bun scripts/check-load-report.ts --profile NAME [--host FILE | --no-host] [--rehearsal] [--json] REPORT.json
Profiles: ${PROFILES.join(', ')}
`;

interface Options {
	profile: Profile;
	report: string;
	host?: string;
	noHost: boolean;
	rehearsal: boolean;
	json: boolean;
}

/** Read the command line; a bad one is a ReportError. */
export function parseArgs(argv: readonly string[]): Options | 'help' {
	let profile: string | undefined;
	let host: string | undefined;
	let noHost = false;
	let rehearsal = false;
	let json = false;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			return 'help';
		}
		if (arg === '--json') {
			json = true;
		} else if (arg === '--no-host') {
			noHost = true;
		} else if (arg === '--rehearsal') {
			rehearsal = true;
		} else if (arg === '--profile' || arg === '--host') {
			const value = argv[++i];
			if (value === undefined) {
				throw new ReportError(`${arg} needs a value`);
			}
			if (arg === '--profile') {
				profile = value;
			} else {
				host = value;
			}
		} else if (arg.startsWith('-')) {
			throw new ReportError(`unknown option ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	if (profile === undefined || !(PROFILES as readonly string[]).includes(profile)) {
		throw new ReportError(`--profile must be one of ${PROFILES.join(', ')}`);
	}
	if (positional.length !== 1) {
		throw new ReportError('give exactly one report file');
	}
	if (noHost && host !== undefined) {
		throw new ReportError('--host and --no-host exclude each other');
	}
	if (noHost && rehearsal) {
		throw new ReportError('--rehearsal judges the host file of a rehearsal, so it excludes --no-host');
	}
	return { profile: profile as Profile, report: positional[0], host, noHost, rehearsal, json };
}

/** Run the command line and return the exit status. */
export function main(argv: readonly string[]): number {
	let options: Options | 'help';
	let results: Result[];
	try {
		options = parseArgs(argv);
		if (options === 'help') {
			process.stdout.write(USAGE);
			return 0;
		}
		const report = readJson(options.report, 'report');
		if (report.tool !== 'hed-lsp-daemon-load-test') {
			throw new ReportError(`${options.report} is not a report of the daemon load harness`);
		}
		results = evaluateReport(options.profile, report);
		if (options.noHost) {
			results.push(skip('host measurements', 'skipped by --no-host'));
		} else {
			const hostFile = options.host ?? options.report.replace(/\.json$/, '.host.json');
			const host = fs.existsSync(hostFile) ? readJson(hostFile, 'host file') : undefined;
			results.push(...evaluateHost(options.profile, host, options.rehearsal));
		}
	} catch (error) {
		if (error instanceof ReportError) {
			process.stderr.write(`${error.message}\n${USAGE}`);
			return 2;
		}
		throw error;
	}

	const failed = results.filter((result) => result.verdict === 'fail').length;
	if (options.json) {
		const summary = { profile: options.profile, rehearsal: options.rehearsal, passed: failed === 0, results };
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	} else {
		if (options.rehearsal) {
			process.stdout.write('REHEARSAL: these files are practice from measure.sh --rehearsal, not a result\n');
		}
		const note = options.rehearsal ? ' (a rehearsal, not a result)' : '';
		for (const result of results) {
			process.stdout.write(`${result.verdict.toUpperCase().padEnd(4)}  ${result.criterion}: ${result.detail}\n`);
		}
		process.stdout.write(
			failed === 0
				? `all criteria of ${options.profile} pass${note}\n`
				: `${failed} criteria of ${options.profile} fail${note}\n`,
		);
	}
	return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
