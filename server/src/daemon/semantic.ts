/**
 * Semantic search state for the daemon. The daemon owns the model: when semantic search is
 * enabled, a warm-up starts in the background after the server listens, so no request pays for the
 * model load or a download. A failed load is retried on a backoff, never on a request, and a request
 * that asks for semantic search while the model is not ready still gets its keyword and schema
 * results. The engine's own warm-up inside `suggestBatch` is never used.
 *
 * States: `disabled` (the flag is off), `loading` (the first warm-up has not finished), `ready`,
 * and `unavailable` (a warm-up failed; the next retry runs in the background).
 */

import { EMBEDDING_SCHEMA_VERSION, embeddingsManager, type SemanticStep } from '../engine/index.js';
import type { DaemonConfig } from './config.js';
import { WorkCancelled } from './limits.js';
import { errorDetail, type Logger } from './log.js';
import { ApiError, type SemanticState, type SemanticStatus } from './protocol.js';

/** The wait after the first failed warm-up, and the longest wait. The wait doubles each failure. */
export const SEMANTIC_BACKOFF_BASE_MS = 30_000;
export const SEMANTIC_BACKOFF_MAX_MS = 900_000;

export interface SemanticBackoff {
	baseMs: number;
	maxMs: number;
}

const DEFAULT_BACKOFF: SemanticBackoff = { baseMs: SEMANTIC_BACKOFF_BASE_MS, maxMs: SEMANTIC_BACKOFF_MAX_MS };

/** Milliseconds to wait before the next warm-up after `failures` failures in a row. */
export function semanticBackoffMs(failures: number, backoff: SemanticBackoff = DEFAULT_BACKOFF): number {
	return Math.min(backoff.baseMs * 2 ** Math.max(0, failures - 1), backoff.maxMs);
}

/**
 * The status of a request that ran semantic search, from what the engine reported for each query:
 * `unavailable` when the semantic step failed for any query, `ok` otherwise (it ran, or no query
 * needed it). The model can be ready when the request starts and still fail during it.
 */
export function semanticStatusOf(steps: readonly SemanticStep[]): SemanticStatus {
	return steps.includes('failed') ? 'unavailable' : 'ok';
}

/** Seconds a client is told to wait when the semantic slot and its queue are both full. */
export const SEMANTIC_BUSY_RETRY_SECONDS = 5;

interface Waiter {
	grant: () => void;
	signal: AbortSignal;
	onAbort: () => void;
}

/**
 * The semantic slots and the queue behind them. Inference runs on the event loop, so
 * `SEMANTIC_CONCURRENCY` (default 1) bounds how many semantic requests run at once, and
 * `SEMANTIC_QUEUE` bounds how many wait for a slot. A request that finds both full is refused with
 * SEMANTIC_BUSY. A waiting request leaves the queue the moment its signal aborts, so the time it
 * spends queued counts toward its timeout, and the next in line is served in order.
 */
export class SemanticGate {
	private active = 0;
	private readonly waiting: Waiter[] = [];

	constructor(
		private readonly concurrency: number,
		private readonly queueLimit: number,
	) {
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new RangeError('concurrency must be a positive integer');
		}
		if (!Number.isInteger(queueLimit) || queueLimit < 0) {
			throw new RangeError('queueLimit must be a non-negative integer');
		}
	}

	/** Requests holding a slot. */
	get running(): number {
		return this.active;
	}

	/** Requests waiting for a slot. */
	get queued(): number {
		return this.waiting.length;
	}

	/**
	 * Take a slot, waiting in the queue if none is free. Resolves with the function that gives the
	 * slot back, which does nothing the second time. Rejects with SEMANTIC_BUSY when the queue is
	 * full, and with WorkCancelled when `signal` aborts first.
	 */
	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) {
			return Promise.reject(new WorkCancelled());
		}
		if (this.active < this.concurrency && this.waiting.length === 0) {
			this.active++;
			return Promise.resolve(this.releaser());
		}
		if (this.waiting.length >= this.queueLimit) {
			return Promise.reject(
				new ApiError('SEMANTIC_BUSY', 'semantic search is busy; try again shortly', {
					retryAfterSeconds: SEMANTIC_BUSY_RETRY_SECONDS,
				}),
			);
		}
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				signal,
				// A slot handed to a waiter stays counted as active, so it is never free for a newcomer.
				grant: () => {
					signal.removeEventListener('abort', waiter.onAbort);
					resolve(this.releaser());
				},
				onAbort: () => {
					const at = this.waiting.indexOf(waiter);
					if (at !== -1) {
						this.waiting.splice(at, 1);
					}
					reject(new WorkCancelled());
				},
			};
			signal.addEventListener('abort', waiter.onAbort, { once: true });
			this.waiting.push(waiter);
		});
	}

	private releaser(): () => void {
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const next = this.waiting.shift();
			if (next) {
				next.grant();
			} else {
				this.active--;
			}
		};
	}
}

export interface SemanticSnapshot {
	state: SemanticState;
	/** Consecutive failed warm-ups; zero once the model is ready. */
	failures: number;
	/** The schema set the embedding index was built against. */
	index: string;
}

export interface SemanticOptions {
	logger?: Logger;
	/** Retry timing. Defaults to 30 seconds doubling to 15 minutes. */
	backoff?: SemanticBackoff;
}

export class SemanticService {
	private state: SemanticState;
	private failures = 0;
	private timer: NodeJS.Timeout | undefined;
	private started = false;
	private stopped = false;
	private readonly backoff: SemanticBackoff;
	private readonly logger: Logger | undefined;

	constructor(
		private readonly config: Pick<DaemonConfig, 'semantic' | 'onnxThreads' | 'modelDownload'>,
		options: SemanticOptions = {},
	) {
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.logger = options.logger;
		this.state = config.semantic ? 'loading' : 'disabled';
	}

	snapshot(): SemanticSnapshot {
		return { state: this.state, failures: this.failures, index: EMBEDDING_SCHEMA_VERSION };
	}

	/** Whether semantic search can run right now. */
	get ready(): boolean {
		return this.state === 'ready';
	}

	/**
	 * What a request that asked for semantic search is told: `ok` when it ran, otherwise the state
	 * (`disabled`, `loading`, or `unavailable`).
	 */
	statusForRequest(): SemanticStatus {
		return this.state === 'ready' ? 'ok' : this.state;
	}

	/** Begin warm-up in the background. Does nothing when disabled, or when already started. */
	start(): void {
		if (!this.config.semantic || this.started || this.stopped) {
			return;
		}
		this.started = true;
		void this.attempt();
	}

	/** Cancel the pending retry, so a closed daemon leaves no timer behind. */
	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private async attempt(): Promise<void> {
		let loaded = false;
		try {
			embeddingsManager.setRuntimeOptions({
				threads: this.config.onnxThreads,
				allowDownload: this.config.modelDownload,
			});
			// A failed load switches the engine's embeddings off, so each attempt turns them back on.
			embeddingsManager.setEnabled(true);
			loaded = (await embeddingsManager.loadEmbeddings()) && (await embeddingsManager.initializeModel());
		} catch (error) {
			this.logger?.error('semantic warm-up threw', errorDetail(error));
		}
		if (this.stopped) {
			return;
		}
		if (loaded) {
			this.state = 'ready';
			this.failures = 0;
			this.logger?.info('semantic search is ready');
			return;
		}
		this.failures++;
		this.state = 'unavailable';
		const waitMs = semanticBackoffMs(this.failures, this.backoff);
		this.logger?.warn('semantic warm-up failed', {
			failures: this.failures,
			retryAfterSeconds: Math.ceil(waitMs / 1000),
		});
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.attempt();
		}, waitMs);
		// A pending retry must not keep a process alive that is otherwise done.
		this.timer.unref();
	}
}
