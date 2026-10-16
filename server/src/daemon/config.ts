/**
 * Daemon configuration: every `HED_LSP_*` variable, parsed and validated once at startup.
 *
 * A bad value stops the process before it listens, with an error that names the variable. The
 * parser reads only the environment object it is given, so tests pass their own. Unset variables
 * take the documented defaults; a variable that is set but empty is an error, except for the
 * trusted-proxy list (empty means no proxy is trusted) and the commit label.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeIp } from './limits.js';

/** Prefix of every daemon environment variable. */
export const ENV_PREFIX = 'HED_LSP_';

/** A configuration value that is missing or malformed. `variable` is the full environment name. */
export class ConfigError extends Error {
	constructor(
		readonly variable: string,
		detail: string,
	) {
		super(`${variable} ${detail}`);
		this.name = 'ConfigError';
	}
}

export interface DaemonConfig {
	host: string;
	port: number;
	/** Normalized addresses whose X-Forwarded-For header is believed. */
	trustedProxies: string[];
	semantic: boolean;
	onnxThreads: number;
	modelDownload: boolean;
	/** The schema allowlist, each spec written once in its canonical form, in configured order. */
	schemas: string[];
	/** The allowlisted spec used when a request names none. */
	defaultSchema: string;
	schemaLoadTimeoutMs: number;
	maxBodyBytes: number;
	maxStrings: number;
	/** The longest string a validate item may hold; a longer one is refused as INVALID_STRING. */
	maxStringChars: number;
	/** The most issues one validate item returns, in engine order; its `issueCount` stays the true total. */
	maxIssuesPerString: number;
	/** The longest issue message returned; a longer one is cut and ends with "...". */
	maxIssueMessageChars: number;
	/**
	 * The message characters one validate response may carry in all. Items are filled in order; once
	 * the total is spent, each later item keeps `valid` and `issueCount` and returns no issues.
	 */
	maxIssueTextChars: number;
	maxQueries: number;
	maxSemanticQueries: number;
	maxQueryChars: number;
	rateItemsPerSec: number;
	rateItemsBurst: number;
	semanticRatePerSec: number;
	semanticRateBurst: number;
	/**
	 * Characters per unit of rate charge: a string or query costs `max(1, ceil(length / this))` units,
	 * so long text, which takes longer to validate, costs more than short text.
	 */
	chargeCharsPerUnit: number;
	/** Requests running at once, all clients together. */
	maxInFlight: number;
	/** Requests running at once for one client, so one client cannot take every slot. */
	maxInFlightPerClient: number;
	/** Always 1: see `readSemanticConcurrency`. */
	semanticConcurrency: number;
	semanticQueue: number;
	requestTimeoutMs: number;
	/** How long after its headers a request body may take to arrive in full. */
	bodyTimeoutMs: number;
	headersTimeoutMs: number;
	keepAliveTimeoutMs: number;
	maxConnections: number;
	maxClients: number;
	clientIdleMs: number;
	/** The source revision shown in health, or "unknown". */
	commit: string;
}

/** The allowlist when `HED_LSP_SCHEMAS` is unset. */
export const DEFAULT_SCHEMAS: readonly string[] = [
	'8.5.0',
	'8.5.0,sc:score_2.1.0,la:lang_1.1.0',
	'8.4.0',
	'8.4.0,sc:score_2.1.0,la:lang_1.1.0',
	'8.3.0',
];

/** The default schema when `HED_LSP_DEFAULT_SCHEMA` is unset: the standard schema alone. */
export const DEFAULT_SCHEMA = '8.5.0';

/** Trusted proxies when `HED_LSP_TRUSTED_PROXIES` is unset: the local machine. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ['127.0.0.1', '::1'];

/**
 * The default `MAX_STRING_CHARS`. A string of n open parentheses gives about n + 2 issues, and each
 * message quotes the string, so the answer grows with n squared: 4096 characters make 18 MB of JSON
 * before the issue and message limits, 16384 would make about 280 MB. The longest string in the
 * evaluation set is 381 characters, so this leaves a tenfold margin.
 */
export const DEFAULT_MAX_STRING_CHARS = 4096;

/** The shortest `MAX_ISSUE_MESSAGE_CHARS`: room for one character and the "..." that marks a cut. */
export const MIN_ISSUE_MESSAGE_CHARS = 4;

/**
 * The longest schema spec a request may name, in characters, and the longest allowlist entry. The
 * longest default entry is 34. Parsing a spec splits and sorts its parts, which costs time in
 * proportion to its length, so a spec past this is refused without being parsed.
 */
export const MAX_SCHEMA_SPEC_CHARS = 256;

/**
 * Whether a `schema` value is longer than MAX_SCHEMA_SPEC_CHARS: for a string, its length; for an
 * array of strings, the length of its parts joined by commas. It reads each length once, stops as
 * soon as the total passes the limit, and never joins, splits, or trims anything. A value of any
 * other kind, or an array that holds something besides strings, is not long: it is refused later
 * as the wrong type.
 */
export function schemaSpecTooLong(value: unknown): boolean {
	if (typeof value === 'string') {
		return value.length > MAX_SCHEMA_SPEC_CHARS;
	}
	if (!Array.isArray(value)) {
		return false;
	}
	let joined = -1;
	for (const part of value) {
		if (typeof part !== 'string') {
			return false;
		}
		joined += part.length + 1;
		if (joined > MAX_SCHEMA_SPEC_CHARS) {
			return true;
		}
	}
	return false;
}

/** A schema spec read from a string or an array of strings. */
export type ParsedSpec =
	| { kind: 'blank' }
	| { kind: 'spec'; text: string; key: string }
	| { kind: 'invalid'; reason: 'type' | 'duplicate' };

/**
 * Read a schema spec the way the engine does, plus the checks the daemon needs. A string or an
 * array of strings is split on commas, trimmed, and stripped of blanks. `text` is the parts joined
 * in the given order, which is the engine's cache key; `key` is the sorted set of parts, so two
 * orders of the same parts share one key. Comparison is case sensitive. Null, undefined, and an
 * empty result are blank. Anything but a string or an array of strings is a type error, and a part
 * given twice is a duplicate.
 */
export function parseSchemaSpec(value: unknown): ParsedSpec {
	if (value === null || value === undefined) {
		return { kind: 'blank' };
	}
	let text: string;
	if (typeof value === 'string') {
		text = value;
	} else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
		text = value.join(',');
	} else {
		return { kind: 'invalid', reason: 'type' };
	}
	const parts = text
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		return { kind: 'blank' };
	}
	if (new Set(parts).size !== parts.length) {
		return { kind: 'invalid', reason: 'duplicate' };
	}
	return { kind: 'spec', text: parts.join(','), key: [...parts].sort().join(',') };
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
	return env[`${ENV_PREFIX}${name}`];
}

function fail(name: string, detail: string): never {
	throw new ConfigError(`${ENV_PREFIX}${name}`, detail);
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
	const raw = read(env, name);
	if (raw === undefined) {
		return fallback;
	}
	const text = raw.trim();
	const value = Number(text);
	if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
		return fail(name, `must be an integer from ${min} to ${max}, got "${raw}"`);
	}
	return value;
}

function readPositive(env: Env, name: string, fallback: number): number {
	const raw = read(env, name);
	if (raw === undefined) {
		return fallback;
	}
	const text = raw.trim();
	const value = Number(text);
	if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text) || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
		return fail(name, `must be a number above 0 and at most 1000000, got "${raw}"`);
	}
	return value;
}

function readFlag(env: Env, name: string, fallback: boolean): boolean {
	const raw = read(env, name);
	if (raw === undefined) {
		return fallback;
	}
	const text = raw.trim().toLowerCase();
	if (text === '1' || text === 'true') {
		return true;
	}
	if (text === '0' || text === 'false') {
		return false;
	}
	return fail(name, `must be 0, 1, true, or false, got "${raw}"`);
}

function readHost(env: Env): string {
	const raw = read(env, 'HOST');
	if (raw === undefined) {
		return '127.0.0.1';
	}
	const text = raw.trim();
	if (!/^[^\s/]+$/.test(text)) {
		return fail('HOST', `must be a host name or an IP address, got "${raw}"`);
	}
	return text;
}

function readTrustedProxies(env: Env): string[] {
	const raw = read(env, 'TRUSTED_PROXIES');
	if (raw === undefined) {
		return DEFAULT_TRUSTED_PROXIES.map((address) => normalizeIp(address) as string);
	}
	const proxies: string[] = [];
	for (const entry of raw.split(',')) {
		const text = entry.trim();
		if (text === '') {
			continue;
		}
		const normalized = normalizeIp(text);
		if (normalized === null) {
			return fail('TRUSTED_PROXIES', `must be a comma-separated list of IP addresses, got "${text}"`);
		}
		if (!proxies.includes(normalized)) {
			proxies.push(normalized);
		}
	}
	return proxies;
}

/**
 * Semantic calls at once. The daemon tells which semantic step failed by watching the engine's
 * failure counter around each `findSuggestions` call, and a failure of another call running at the
 * same time would be counted there too. That attribution is exact for one call at a time, so one is
 * the only accepted value until inference runs on a worker thread.
 */
function readSemanticConcurrency(env: Env): number {
	const raw = read(env, 'SEMANTIC_CONCURRENCY');
	if (raw === undefined) {
		return 1;
	}
	const text = raw.trim();
	if (!/^\d+$/.test(text) || Number(text) !== 1) {
		return fail(
			'SEMANTIC_CONCURRENCY',
			`must be 1, got "${raw}": the daemon runs one semantic call at a time until a worker thread exists, ` +
				'because a failed semantic step is attributed by the engine failure counter, which is exact for one call only',
		);
	}
	return 1;
}

/** The allowlist and the default, checked together: the default must be one of the entries. */
function readSchemas(env: Env): { schemas: string[]; defaultSchema: string } {
	const rawList = read(env, 'SCHEMAS');
	const entries = rawList === undefined ? [...DEFAULT_SCHEMAS] : rawList.split(';');
	const schemas = new Map<string, string>();
	for (const entry of entries) {
		if (schemaSpecTooLong(entry)) {
			return fail(
				'SCHEMAS',
				`has an entry longer than ${MAX_SCHEMA_SPEC_CHARS} characters, which no request could name`,
			);
		}
		const parsed = parseSchemaSpec(entry);
		if (parsed.kind === 'blank') {
			continue;
		}
		if (parsed.kind === 'invalid') {
			return fail('SCHEMAS', `has an entry that repeats a schema, got "${entry}"`);
		}
		if (schemas.has(parsed.key)) {
			return fail('SCHEMAS', `lists the same schema set twice, got "${entry}"`);
		}
		schemas.set(parsed.key, parsed.text);
	}
	if (schemas.size === 0) {
		return fail('SCHEMAS', 'must list at least one schema, with entries separated by ";"');
	}

	const rawDefault = read(env, 'DEFAULT_SCHEMA');
	const parsedDefault = parseSchemaSpec(rawDefault ?? DEFAULT_SCHEMA);
	if (parsedDefault.kind !== 'spec') {
		return fail('DEFAULT_SCHEMA', `must name a schema, got "${rawDefault}"`);
	}
	const defaultSchema = schemas.get(parsedDefault.key);
	if (defaultSchema === undefined) {
		return fail(
			'DEFAULT_SCHEMA',
			`must be one of HED_LSP_SCHEMAS (${[...schemas.values()].join('; ')}), got "${parsedDefault.text}"`,
		);
	}
	return { schemas: [...schemas.values()], defaultSchema };
}

function readCommit(env: Env): string {
	const text = read(env, 'COMMIT')?.trim();
	return text ? text : 'unknown';
}

const MAX_INT = 2_147_483_647;

/**
 * How far Node's own request timer is set past `REQUEST_TIMEOUT_MS`. The daemon's timer answers a
 * slow request with a 503 TIMEOUT, so Node's socket timer, which closes the connection without a
 * response, must never fire first.
 */
export const NODE_REQUEST_TIMEOUT_MARGIN_MS = 5000;

/** The two timeouts together: Node refuses a headers timeout longer than its request timeout. */
function readTimeouts(env: Env): { requestTimeoutMs: number; headersTimeoutMs: number } {
	const requestTimeoutMs = readInt(env, 'REQUEST_TIMEOUT_MS', 30_000, 1, MAX_INT - NODE_REQUEST_TIMEOUT_MARGIN_MS);
	const headersTimeoutMs = readInt(env, 'HEADERS_TIMEOUT_MS', 10_000, 1, MAX_INT);
	if (headersTimeoutMs > requestTimeoutMs + NODE_REQUEST_TIMEOUT_MARGIN_MS) {
		return fail(
			'HEADERS_TIMEOUT_MS',
			`must not exceed HED_LSP_REQUEST_TIMEOUT_MS plus ${NODE_REQUEST_TIMEOUT_MARGIN_MS} (${requestTimeoutMs + NODE_REQUEST_TIMEOUT_MARGIN_MS}), got "${read(env, 'HEADERS_TIMEOUT_MS')}"`,
		);
	}
	return { requestTimeoutMs, headersTimeoutMs };
}

/**
 * Parse the daemon configuration from an environment, by default the process environment. Throws a
 * ConfigError for the first bad variable.
 */
export function loadConfig(env: Env = process.env): DaemonConfig {
	const { schemas, defaultSchema } = readSchemas(env);
	const { requestTimeoutMs, headersTimeoutMs } = readTimeouts(env);
	return {
		host: readHost(env),
		port: readInt(env, 'PORT', 38530, 0, 65535),
		trustedProxies: readTrustedProxies(env),
		semantic: readFlag(env, 'SEMANTIC', false),
		onnxThreads: readInt(env, 'ONNX_THREADS', 1, 1, 1024),
		modelDownload: readFlag(env, 'MODEL_DOWNLOAD', true),
		schemas,
		defaultSchema,
		schemaLoadTimeoutMs: readInt(env, 'SCHEMA_LOAD_TIMEOUT_MS', 60_000, 1, MAX_INT),
		maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 524_288, 1, MAX_INT),
		maxStrings: readInt(env, 'MAX_STRINGS', 100, 1, MAX_INT),
		maxStringChars: readInt(env, 'MAX_STRING_CHARS', DEFAULT_MAX_STRING_CHARS, 1, MAX_INT),
		maxIssuesPerString: readInt(env, 'MAX_ISSUES_PER_STRING', 100, 1, MAX_INT),
		maxIssueMessageChars: readInt(env, 'MAX_ISSUE_MESSAGE_CHARS', 1024, MIN_ISSUE_MESSAGE_CHARS, MAX_INT),
		maxIssueTextChars: readInt(env, 'MAX_ISSUE_TEXT_CHARS', 1_048_576, 1, MAX_INT),
		maxQueries: readInt(env, 'MAX_QUERIES', 50, 1, MAX_INT),
		maxSemanticQueries: readInt(env, 'MAX_SEMANTIC_QUERIES', 20, 1, MAX_INT),
		maxQueryChars: readInt(env, 'MAX_QUERY_CHARS', 512, 1, MAX_INT),
		rateItemsPerSec: readPositive(env, 'RATE_ITEMS_PER_SEC', 100),
		rateItemsBurst: readInt(env, 'RATE_ITEMS_BURST', 1000, 1, MAX_INT),
		semanticRatePerSec: readPositive(env, 'SEMANTIC_RATE_PER_SEC', 1),
		semanticRateBurst: readInt(env, 'SEMANTIC_RATE_BURST', 20, 1, MAX_INT),
		chargeCharsPerUnit: readInt(env, 'CHARGE_CHARS_PER_UNIT', 256, 1, MAX_INT),
		maxInFlight: readInt(env, 'MAX_IN_FLIGHT', 8, 1, MAX_INT),
		maxInFlightPerClient: readInt(env, 'MAX_IN_FLIGHT_PER_CLIENT', 4, 1, MAX_INT),
		semanticConcurrency: readSemanticConcurrency(env),
		semanticQueue: readInt(env, 'SEMANTIC_QUEUE', 8, 0, MAX_INT),
		requestTimeoutMs,
		bodyTimeoutMs: readInt(env, 'BODY_TIMEOUT_MS', 10_000, 1, MAX_INT),
		headersTimeoutMs,
		keepAliveTimeoutMs: readInt(env, 'KEEPALIVE_TIMEOUT_MS', 65_000, 1, MAX_INT),
		maxConnections: readInt(env, 'MAX_CONNECTIONS', 256, 1, MAX_INT),
		maxClients: readInt(env, 'MAX_CLIENTS', 10_000, 1, MAX_INT),
		clientIdleMs: readInt(env, 'CLIENT_IDLE_MS', 600_000, 1, MAX_INT),
		commit: readCommit(env),
	};
}

/** Whether a listen host is the local machine only. */
function isLoopbackHost(host: string): boolean {
	const lower = host.toLowerCase();
	if (lower === 'localhost') {
		return true;
	}
	const normalized = normalizeIp(lower.replace(/^\[|\]$/g, ''));
	return normalized !== null && (normalized.startsWith('127.') || normalized === '0:0:0:0:0:0:0:1');
}

/**
 * Startup warnings about a configuration that is valid but probably wrong. When the daemon listens
 * beyond loopback and trusts only the default local proxies, every client reaches it through some
 * other address, so X-Forwarded-For is ignored and all clients share one rate-limit key.
 */
export function configWarnings(config: DaemonConfig): string[] {
	const defaults = DEFAULT_TRUSTED_PROXIES.map((address) => normalizeIp(address));
	const usesDefaultProxies =
		config.trustedProxies.length === defaults.length && config.trustedProxies.every((p) => defaults.includes(p));
	if (isLoopbackHost(config.host) || !usesDefaultProxies) {
		return [];
	}
	return [
		`listening on ${config.host} with the default trusted proxies (${DEFAULT_TRUSTED_PROXIES.join(', ')}): ` +
			'clients that arrive through another address share one rate-limit key; ' +
			'set HED_LSP_TRUSTED_PROXIES to the address of the proxy in front of the daemon',
	];
}

/**
 * The version in the nearest package.json at or above `startDir`, or "unknown" when there is none
 * or it cannot be read. The daemon reads it once at startup.
 */
export function readPackageVersion(startDir: string): string {
	let dir = path.resolve(startDir);
	for (;;) {
		const file = path.join(dir, 'package.json');
		if (fs.existsSync(file)) {
			try {
				const version: unknown = JSON.parse(fs.readFileSync(file, 'utf-8')).version;
				return typeof version === 'string' && version ? version : 'unknown';
			} catch {
				return 'unknown';
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return 'unknown';
		}
		dir = parent;
	}
}
