/**
 * The schema allowlist and its load state. A request names a schema spec, which is mapped to an
 * allowlisted spec (the engine's cache key) or refused. The whole allowlist is loaded at startup,
 * each load raced against a timer because the validator's fetch has no timeout, and a spec that
 * fails is retried lazily behind a backoff, so a GitHub outage is not hammered.
 */

import { schemaVersionUsed } from '../engine/index.js';
import { type DaemonConfig, parseSchemaSpec, schemaSpecTooLong } from './config.js';
import { monotonicNow } from './limits.js';
import { errorDetail, type Logger } from './log.js';
import { ApiError, type SchemaListing, type SchemaStatus } from './protocol.js';

/** The wait after the first failure, and the longest wait. The wait doubles with each failure. */
export const SCHEMA_BACKOFF_BASE_MS = 30_000;
export const SCHEMA_BACKOFF_MAX_MS = 600_000;

/** Milliseconds to wait before retrying a spec that has failed `failures` times in a row. */
export function schemaBackoffMs(failures: number): number {
	return Math.min(SCHEMA_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), SCHEMA_BACKOFF_MAX_MS);
}

interface Entry {
	spec: string;
	status: SchemaStatus;
	used?: string;
	failures: number;
	nextRetryAt: number;
	inFlight: Promise<string> | null;
}

export interface SchemaRegistryOptions {
	/** Clock in milliseconds, used for the backoff. Defaults to a monotonic clock. */
	now?: () => number;
	logger?: Logger;
}

/** A load that was still running when its timer ran out. */
export class LoadTimeout extends Error {
	constructor(ms: number) {
		super(`schema load timed out after ${ms} ms`);
		this.name = 'LoadTimeout';
	}
}

/**
 * Settle as `work` does, or reject with LoadTimeout once `ms` milliseconds have passed, whichever
 * comes first. The timer is cleared as soon as `work` settles, and `work` is not stopped: a load
 * that outlives its timer still finishes, and a caller that wants its result can attach to `work`.
 */
export function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new LoadTimeout(ms)), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export class SchemaRegistry {
	/** The allowlisted spec used when a request names none. */
	readonly defaultSpec: string;
	private readonly entries = new Map<string, Entry>();
	private readonly specByKey = new Map<string, string>();
	private readonly now: () => number;
	private readonly logger: Logger | undefined;
	private defaultDone = false;
	private markDefaultDone!: () => void;
	private readonly defaultSettled: Promise<void>;

	constructor(
		private readonly config: Pick<DaemonConfig, 'schemas' | 'defaultSchema' | 'schemaLoadTimeoutMs'>,
		options: SchemaRegistryOptions = {},
	) {
		this.now = options.now ?? monotonicNow;
		this.logger = options.logger;
		this.defaultSpec = config.defaultSchema;
		this.defaultSettled = new Promise<void>((resolve) => {
			this.markDefaultDone = () => {
				this.defaultDone = true;
				resolve();
			};
		});
		for (const spec of config.schemas) {
			const parsed = parseSchemaSpec(spec);
			if (parsed.kind !== 'spec') {
				throw new Error(`allowlist entry is not a schema spec: ${spec}`);
			}
			this.specByKey.set(parsed.key, spec);
			this.entries.set(spec, { spec, status: 'loading', failures: 0, nextRetryAt: 0, inFlight: null });
		}
		if (!this.entries.has(this.defaultSpec)) {
			throw new Error(`default schema is not in the allowlist: ${this.defaultSpec}`);
		}
	}

	/** The allowlisted specs, in configured order. */
	allowed(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * Map the `schema` field of a request to an allowlisted spec. A missing, null, or blank value is
	 * the default. A string or an array of strings is split on commas and compared as a set, so
	 * order and array form do not matter. A value of any other type is a malformed request, and a
	 * spec outside the allowlist is an unknown schema.
	 */
	resolve(value: unknown): string {
		// A spec longer than any allowlist entry is unknown whatever it holds, and it is refused before
		// it is parsed, because parsing costs time in proportion to its length.
		if (schemaSpecTooLong(value)) {
			throw this.unknownSchema();
		}
		const parsed = parseSchemaSpec(value);
		if (parsed.kind === 'blank') {
			return this.defaultSpec;
		}
		if (parsed.kind === 'invalid' && parsed.reason === 'type') {
			throw new ApiError('INVALID_REQUEST', 'schema must be a string or an array of strings');
		}
		if (parsed.kind === 'spec') {
			const spec = this.specByKey.get(parsed.key);
			if (spec !== undefined) {
				return spec;
			}
		}
		throw this.unknownSchema();
	}

	private unknownSchema(): ApiError {
		return new ApiError('UNKNOWN_SCHEMA', 'schema is not one of the allowed schemas', {
			details: { allowed: this.allowed() },
		});
	}

	/**
	 * Make sure an allowlisted spec is loaded and return the version used. Concurrent callers share
	 * one load. A spec that failed answers SCHEMA_UNAVAILABLE until its backoff has passed, then the
	 * next caller tries again.
	 */
	ensure(spec: string): Promise<string> {
		const entry = this.entries.get(spec);
		if (!entry) {
			return Promise.reject(new Error('ensure was called with a spec outside the allowlist'));
		}
		if (entry.status === 'loaded') {
			return Promise.resolve(entry.used as string);
		}
		if (entry.inFlight) {
			return entry.inFlight;
		}
		const waitMs = entry.nextRetryAt - this.now();
		if (entry.status === 'failed' && waitMs > 0) {
			return Promise.reject(this.unavailable(Math.ceil(waitMs / 1000)));
		}
		return this.attempt(entry);
	}

	/** Start loading every allowlisted spec. Resolves when each has loaded or failed. */
	async preload(): Promise<void> {
		await Promise.allSettled(this.allowed().map((spec) => this.ensure(spec)));
	}

	/** Resolves once the default spec has loaded or failed; never rejects. */
	whenDefaultSettled(): Promise<void> {
		return this.defaultSettled;
	}

	/** Whether the default spec has loaded or failed, so the daemon can answer requests. */
	get defaultReady(): boolean {
		return this.defaultDone;
	}

	/** The allowlist with each spec's load status. */
	list(): SchemaListing[] {
		return [...this.entries.values()].map((entry) => {
			const listing: SchemaListing = { spec: entry.spec, status: entry.status };
			if (entry.status === 'loaded') {
				listing.used = entry.used;
			}
			if (entry.status === 'failed') {
				listing.retryAfterSeconds = Math.max(0, Math.ceil((entry.nextRetryAt - this.now()) / 1000));
			}
			return listing;
		});
	}

	/** Specs that failed to load or run on the bundled fallback instead of the version asked for. */
	degraded(): string[] {
		return [...this.entries.values()]
			.filter((entry) => entry.status === 'failed' || (entry.status === 'loaded' && entry.used !== entry.spec))
			.map((entry) => entry.spec);
	}

	private attempt(entry: Entry): Promise<string> {
		entry.status = 'loading';
		const work = Promise.resolve().then(() => schemaVersionUsed(entry.spec));
		// A load that outlives its timer still counts when it finishes, so the spec recovers without
		// waiting for the next retry.
		work.then(
			(used) => this.markLoaded(entry, used),
			() => undefined,
		);
		const flight = raceTimeout(work, this.config.schemaLoadTimeoutMs)
			.catch((error: unknown) => {
				throw this.markFailed(entry, error);
			})
			.finally(() => {
				entry.inFlight = null;
			});
		entry.inFlight = flight;
		return flight;
	}

	private markLoaded(entry: Entry, used: string): void {
		const recovered = entry.status === 'failed';
		entry.status = 'loaded';
		entry.used = used;
		entry.failures = 0;
		entry.nextRetryAt = 0;
		if (used !== entry.spec) {
			this.logger?.warn('schema loaded on the bundled fallback', { spec: entry.spec, used });
		} else if (recovered) {
			this.logger?.info('schema recovered after a failure', { spec: entry.spec });
		}
		this.settleDefault(entry);
	}

	private markFailed(entry: Entry, error: unknown): ApiError {
		entry.failures++;
		const waitMs = schemaBackoffMs(entry.failures);
		entry.status = 'failed';
		entry.nextRetryAt = this.now() + waitMs;
		this.logger?.error('schema load failed', {
			spec: entry.spec,
			failures: entry.failures,
			retryAfterSeconds: Math.ceil(waitMs / 1000),
			...errorDetail(error),
			reason: error instanceof LoadTimeout ? 'timeout' : 'error',
		});
		this.settleDefault(entry);
		return this.unavailable(Math.ceil(waitMs / 1000));
	}

	private settleDefault(entry: Entry): void {
		if (entry.spec === this.defaultSpec) {
			this.markDefaultDone();
		}
	}

	private unavailable(retryAfterSeconds: number): ApiError {
		return new ApiError('SCHEMA_UNAVAILABLE', 'the schema is temporarily unavailable', {
			retryAfterSeconds: Math.max(1, retryAfterSeconds),
		});
	}
}
