/**
 * The HTTP adapter for the HED engine: routing, the v1 envelope, the endpoints, and the limits. A
 * request gets a fresh ID, CORS headers, and exactly one JSON response; a failure is an ApiError
 * that becomes the error envelope, and anything else becomes a generic 500 with the detail in the
 * log. Every request except a GET or HEAD of health pays at the door against its client's rate bucket
 * before anything else happens: one unit, or for a POST one unit for each 4096 bytes of body it
 * declares, so refusals, unknown paths, and OPTIONS requests are limited like other traffic. A POST
 * must declare its length, and a request then pays for what it asks, by the length of its text. A
 * charge is for the request, not its result, and nothing is ever refunded. Every request that
 * reaches a handler except health also holds an in-flight slot from the moment its headers arrive
 * until its work stops, and is answered with a 503 TIMEOUT when it runs past REQUEST_TIMEOUT_MS; its
 * work looks for that between items. A response is written in pieces and its connection is reset
 * when the write makes no progress for WRITE_STALL_MS. Nothing logged or returned carries request text.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { TextDecoder } from 'node:util';
import { findSuggestions, type SemanticStep, setLogger, type ValidationIssue, validate } from '../engine/index.js';
import {
	type DaemonConfig,
	MIN_ISSUE_MESSAGE_CHARS,
	NODE_REQUEST_TIMEOUT_MARGIN_MS,
	readPackageVersion,
} from './config.js';
import {
	abortable,
	batchCost,
	ClientTable,
	clientKey,
	monotonicNow,
	SlotLimiter,
	type TakeResult,
	TokenBucket,
	throwIfCancelled,
	WorkCancelled,
} from './limits.js';
import { createLogger, engineSink, errorDetail, type LineWriter, type Logger } from './log.js';
import {
	API_VERSION,
	ApiError,
	assertKnownFields,
	CORS_HEADERS,
	errorBody,
	type HealthResponse,
	type HealthStatus,
	isPlainObject,
	PREFLIGHT_MAX_AGE_SECONDS,
	type SchemasResponse,
	type SemanticStatus,
	type SuggestResponse,
	type SuggestResult,
	TOP_DEFAULT,
	TOP_MAX,
	TOP_MIN,
	type ValidateIssue,
	type ValidateItem,
	type ValidateResponse,
	type ValidateResult,
} from './protocol.js';
import { SchemaRegistry } from './schemas.js';
import { type SemanticBackoff, SemanticGate, SemanticService, semanticStatusOf } from './semantic.js';

export interface DaemonOptions {
	/** Receives each JSON log line. Defaults to stderr. */
	write?: LineWriter;
	/**
	 * Start loading the schema allowlist when the daemon is created. Defaults to true. A caller that
	 * sets it to false decides when startup begins by calling `preload()`; until then the daemon
	 * answers as it does while starting.
	 */
	autoPreload?: boolean;
	/**
	 * Clock in milliseconds, used for schema backoff, the rate buckets, and the client table. Defaults to
	 * a monotonic clock, so a change of the wall clock cannot stop a bucket from refilling.
	 */
	now?: () => number;
	/** The version shown in health. Defaults to the nearest package.json. */
	version?: string;
	/** Retry timing for a failed semantic warm-up. Defaults to 30 seconds doubling to 15 minutes. */
	semanticBackoff?: SemanticBackoff;
}

export interface Daemon {
	/** Not listening yet: the caller chooses the address, so a test can use port 0. */
	server: http.Server;
	/**
	 * Resolves when the default schema has loaded or failed, so requests are answered. Never rejects.
	 * With `autoPreload` off it does not resolve before `preload()` is called.
	 */
	ready: Promise<void>;
	/**
	 * Load every allowlisted schema. Resolves when each has loaded or failed; never rejects. A call
	 * while a load is running shares it, and a spec that failed stays on its backoff.
	 */
	preload(): Promise<void>;
	/** Stop accepting, let in-flight requests finish for `graceMs`, then close what remains. */
	close(graceMs?: number): Promise<void>;
}

/** What a handler returns; the framework turns it into the HTTP response. */
interface Reply {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** What one request records for its log line, and what its work needs to be limited and cancelled. */
interface RequestContext {
	id: string;
	method: string;
	path: string;
	startedAt: number;
	/** The rate-limit key of the client: its address, or the one a trusted proxy forwarded. */
	client: string;
	/** Aborts when the request times out, so its work stops between items. */
	signal: AbortSignal;
	/** The bytes of the request body read so far; the discard of an unread body counts on from here. */
	body: BodyProgress;
	/** The units the door took from the client's general bucket, which count toward the request's charge. */
	doorUnits: number;
	items?: number;
	schemaUsed?: string;
	semanticStatus?: string;
	errorCode?: string;
}

type Handler = (req: http.IncomingMessage, ctx: RequestContext) => Promise<Reply> | Reply;

interface Route {
	methods: readonly string[];
	/** Whether the route waits for the default schema; health reports its own startup instead. */
	gated: boolean;
	/**
	 * Whether the route is subject to the in-flight cap and the rate limits. A GET of a route that is
	 * not, which is health alone, is exempt from every limit; any other request to it is charged.
	 */
	limited: boolean;
	handler: Handler;
}

/** What a failed request answers with: the status, the error envelope, the headers, and the code. */
export interface FailureReply {
	status: number;
	body: ReturnType<typeof errorBody>;
	headers: Record<string, string>;
	code: ApiError['code'];
}

/**
 * Map a failure to its reply. Only an ApiError reaches the client as itself. Anything else is an
 * unexpected error: the client gets a generic 500, and the log gets the error's type and stack
 * frames with the request ID, never its message, which can quote the request.
 */
export function failureReply(error: unknown, requestId: string, logger: Logger): FailureReply {
	let apiError: ApiError;
	if (error instanceof ApiError) {
		apiError = error;
	} else {
		logger.error('request failed', { requestId, ...errorDetail(error) });
		apiError = new ApiError('INTERNAL_ERROR', 'internal error');
	}
	const headers: Record<string, string> = {};
	if (apiError.options.retryAfterSeconds !== undefined) {
		headers['Retry-After'] = String(apiError.options.retryAfterSeconds);
	}
	if (apiError.options.allow) {
		headers.Allow = apiError.options.allow.join(', ');
	}
	return { status: apiError.status, body: errorBody(requestId, apiError), headers, code: apiError.code };
}

/** How one item that failed unexpectedly is reported: the log line, and the message the client sees. */
export interface ItemFailureText {
	log: string;
	message: string;
}

export const VALIDATION_FAILED: ItemFailureText = {
	log: 'validation failed for one string',
	message: 'validation failed',
};

export const SUGGESTIONS_FAILED: ItemFailureText = {
	log: 'suggestions failed for one query',
	message: 'suggestions failed',
};

/**
 * The error for one batch item that failed unexpectedly, inside a response that is still a 200.
 * The log names the item by its position and keeps the error's type and stack frames; the error's
 * message can quote the item, so neither the log nor the client gets it.
 */
export function itemFailure(
	logger: Logger,
	requestId: string,
	index: number,
	error: unknown,
	text: ItemFailureText,
): { code: 'INTERNAL_ERROR'; message: string } {
	logger.error(text.log, { requestId, index, ...errorDetail(error) });
	return { code: 'INTERNAL_ERROR', message: text.message };
}

/**
 * Whether an issue from the engine stands for an exception it caught while validating a string,
 * such as a string nested so deeply that the validator runs out of stack. The engine reports it as an
 * issue with the code INTERNAL_ERROR and the internal code `internalError`, and the text of the
 * issue is the exception's message, which can quote the string. Such an issue is never returned.
 */
export function isEngineException(issue: ValidationIssue): boolean {
	return issue.hedCode === 'INTERNAL_ERROR' && issue.internalCode === 'internalError';
}

/**
 * The error for one item whose validation threw inside the engine, which reports the exception as
 * an issue and not as an exception: only the position of the item is logged, and nothing of the
 * exception is, because all that is left of it is its message, which can quote the string.
 */
export function itemFailureWithoutDetail(
	logger: Logger,
	requestId: string,
	index: number,
	text: ItemFailureText,
): { code: 'INTERNAL_ERROR'; message: string } {
	logger.error(text.log, { requestId, index });
	return { code: 'INTERNAL_ERROR', message: text.message };
}

/** What the log says in place of the path of a request for a route that does not exist. */
export const UNKNOWN_ROUTE_LABEL = 'unknown route';

/** Bytes of declared body that cost one unit at the door. */
export const DOOR_BYTES_PER_UNIT = 4096;

/**
 * The units a request pays at the door, before anything about it is known but its headers. A POST
 * pays by the body it declares, one unit for each DOOR_BYTES_PER_UNIT bytes rounded up and at least
 * one, so a client cannot make the daemon read or discard large bodies for a unit each. Anything
 * else pays one unit. A POST without a usable Content-Length pays one unit and is refused.
 */
export function doorCost(method: string, contentLength: string | undefined): number {
	if (method !== 'POST') {
		return 1;
	}
	const bytes = contentLength !== undefined && /^\d+$/.test(contentLength) ? Number(contentLength) : 0;
	return Math.max(1, Math.ceil(bytes / DOOR_BYTES_PER_UNIT));
}

/** The client closed the connection before the request was complete; there is nobody to answer. */
class ClientAborted extends Error {
	constructor() {
		super('the client closed the connection');
		this.name = 'ClientAborted';
	}
}

/**
 * Bytes of a response handed to the socket at a time. The body is written in pieces, each after the
 * socket has taken the one before, so a client that reads it slowly but steadily keeps making
 * progress, where a single write would show none until its last byte was out.
 */
export const WRITE_CHUNK_BYTES = 64 * 1024;

/**
 * End a response whose headers are written, with `body` as its body. When `stallMs` milliseconds
 * pass with no progress, call `onStall` and reset the connection. Node's socket timeout does not fire
 * while a write is in progress, so without this a client that sends a request and then stops reading
 * can hold its connection for two to three timeouts.
 *
 * The body is written one piece at a time, waiting for the socket to drain before the next. Progress
 * is a drain, or a piece written out. The watchdog runs only while the response is pending: it
 * starts here and is cleared on `finish`, on `close`, and on an error of the socket or of a write. It
 * measures the time since the last progress that the event loop saw, so a loop blocked for longer
 * than `stallMs` counts as a stall.
 */
function endWithinStallLimit(
	res: http.ServerResponse,
	body: Buffer | undefined,
	stallMs: number,
	onStall: () => void,
): void {
	const socket = res.socket;
	let timer: NodeJS.Timeout | undefined;
	let done = false;
	const stop = (): void => {
		done = true;
		clearTimeout(timer);
		socket?.off('error', stop);
	};
	const arm = (): void => {
		clearTimeout(timer);
		if (done) {
			return;
		}
		timer = setTimeout(() => {
			stop();
			onStall();
			if (socket && !socket.destroyed) {
				// An RST, so the kernel drops what the client never read instead of holding it.
				socket.resetAndDestroy();
			}
		}, stallMs);
	};
	const progress = (error?: Error | null): void => (error ? stop() : arm());

	socket?.once('error', stop);
	res.once('finish', stop);
	res.once('close', stop);
	res.on('drain', arm);
	arm();

	if (body === undefined || body.length === 0) {
		res.end();
		return;
	}
	let offset = 0;
	const pump = (): void => {
		while (!done && offset < body.length) {
			const chunk = body.subarray(offset, offset + WRITE_CHUNK_BYTES);
			offset += chunk.length;
			if (offset >= body.length) {
				res.end(chunk, progress);
				return;
			}
			if (!res.write(chunk, progress)) {
				res.once('drain', pump);
				return;
			}
		}
	};
	pump();
}

/** Let other requests and timers run, so a long batch does not hold the event loop. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Require a JSON body: the media type must be application/json, and a charset parameter, if any,
 * must be UTF-8, because the body is decoded as UTF-8.
 */
function checkContentType(header: string | undefined): void {
	const unsupported = new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
	if (header === undefined) {
		throw unsupported;
	}
	const [type, ...params] = header.split(';');
	if (type.trim().toLowerCase() !== 'application/json') {
		throw unsupported;
	}
	for (const param of params) {
		const equals = param.indexOf('=');
		if (equals !== -1 && param.slice(0, equals).trim().toLowerCase() === 'charset') {
			const charset = param
				.slice(equals + 1)
				.trim()
				.replace(/^"|"$/g, '')
				.toLowerCase();
			if (charset !== 'utf-8') {
				throw unsupported;
			}
		}
	}
}

/**
 * How much of a body that is not read is still read and thrown away, as a multiple of the body
 * limit, so the client can finish sending and read the answer. Closing a socket that holds unread
 * data resets the connection, and the client may then never see the response. A client whose body
 * keeps arriving past the bound is cut off. The bound follows the configuration: 2 MiB by default.
 */
export const DISCARD_FACTOR = 4;

/** The bytes of an unread body that are read and discarded before the connection is cut. */
export function discardLimitBytes(maxBodyBytes: number): number {
	return DISCARD_FACTOR * maxBodyBytes;
}

/** How much of a request body has been consumed so far, which the bounded discard counts from. */
interface BodyProgress {
	bytes: number;
}

/**
 * Read and drop the rest of a request body that no handler will read. `alreadyRead` counts the
 * bytes consumed before this call, so `discardLimit` bounds the whole body, not only what comes
 * after. Past the bound the connection is cut.
 */
function discardRest(req: http.IncomingMessage, discardLimit: number, alreadyRead: number, onCutoff: () => void): void {
	let discarded = alreadyRead;
	req.on('data', (chunk: Buffer) => {
		discarded += chunk.length;
		if (discarded > discardLimit && !req.destroyed) {
			onCutoff();
			req.destroy();
		}
	});
	req.resume();
}

/**
 * Read the request body, refusing more than `limit` bytes: by Content-Length before reading a
 * byte, and by counting while streaming. A POST without a length never gets here and Node holds a
 * declared length to its word, so the count is a second line of defense.
 * Nothing past the limit is kept. `progress` counts the bytes consumed, so the discard that
 * follows a refusal continues the count.
 */
function readBody(
	req: http.IncomingMessage,
	limit: number,
	signal: AbortSignal,
	progress: BodyProgress,
): Promise<Buffer> {
	const tooLarge = (): ApiError =>
		new ApiError('PAYLOAD_TOO_LARGE', `the request body is larger than ${limit} bytes`, {
			details: { maxBytes: limit },
		});
	if (signal.aborted) {
		return Promise.reject(new WorkCancelled());
	}
	const declared = req.headers['content-length'];
	if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
		return Promise.reject(tooLarge());
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let finished = false;
		const settle = (action: () => void): void => {
			if (finished) {
				return;
			}
			finished = true;
			req.off('data', onData);
			req.off('end', onEnd);
			req.off('error', onError);
			req.off('close', onClose);
			signal.removeEventListener('abort', onAbort);
			action();
		};
		const onData = (chunk: Buffer): void => {
			size += chunk.length;
			progress.bytes += chunk.length;
			if (size > limit) {
				settle(() => reject(tooLarge()));
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = (): void => settle(() => resolve(Buffer.concat(chunks, size)));
		const onError = (): void => settle(() => reject(new ClientAborted()));
		const onClose = (): void => settle(() => reject(new ClientAborted()));
		// A request that times out while its body is still arriving stops reading it.
		const onAbort = (): void => settle(() => reject(new WorkCancelled()));
		signal.addEventListener('abort', onAbort, { once: true });
		req.on('data', onData);
		req.on('end', onEnd);
		req.on('error', onError);
		req.on('close', onClose);
	});
}

/** The body of a POST as a JSON object, after the media type, size, and syntax checks. */
async function readJsonObject(
	req: http.IncomingMessage,
	limit: number,
	signal: AbortSignal,
	progress: BodyProgress,
): Promise<Record<string, unknown>> {
	checkContentType(req.headers['content-type']);
	const raw = await readBody(req, limit, signal, progress);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
	} catch {
		// The parser's message can quote the body, so the client gets a fixed one.
		throw new ApiError('INVALID_JSON', 'the request body is not valid JSON in UTF-8');
	}
	if (!isPlainObject(value)) {
		throw new ApiError('INVALID_REQUEST', 'the request body must be a JSON object');
	}
	return value;
}

/** `top` for suggestions: an integer from 1 to 50, ten when absent. Null is not absent. */
function parseTop(value: unknown): number {
	if (value === undefined) {
		return TOP_DEFAULT;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < TOP_MIN || value > TOP_MAX) {
		throw new ApiError('INVALID_REQUEST', `top must be an integer from ${TOP_MIN} to ${TOP_MAX}`);
	}
	return value;
}

/** `semantic` for suggestions: a boolean, false when absent. Null is not absent. */
function parseSemantic(value: unknown): boolean {
	if (value === undefined) {
		return false;
	}
	if (typeof value !== 'boolean') {
		throw new ApiError('INVALID_REQUEST', 'semantic must be true or false');
	}
	return value;
}

/** Ends a message that was cut. */
const CUT_MARK = '...';

/**
 * A message of at most `max` characters, counting the mark: a longer one is cut and ends with
 * "...". The cut never leaves half of a surrogate pair, which JSON cannot carry as text.
 */
export function cutMessage(message: string, max: number): string {
	if (message.length <= max) {
		return message;
	}
	let end = Math.max(0, max - CUT_MARK.length);
	const last = message.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
		end--;
	}
	return message.slice(0, end) + CUT_MARK;
}

function toIssue(issue: ValidationIssue, maxMessageChars: number): ValidateIssue {
	const mapped: ValidateIssue = {
		code: issue.hedCode,
		level: issue.level,
		message: cutMessage(issue.message, maxMessageChars),
	};
	if (issue.bounds) {
		mapped.bounds = [issue.bounds[0], issue.bounds[1]];
	}
	return mapped;
}

/**
 * The message characters a validate response may still carry, shared by its items, which are filled
 * in order. Only message text spends it: an item with no issues costs nothing.
 */
export interface TextBudget {
	remaining: number;
}

/**
 * The item for one validated string. A string of n open parentheses gives about n + 2 issues that
 * each quote the string, so what is returned is bounded: the first `maxIssuesPerString` issues in
 * engine order, with long messages cut, and no more message text than the response's `budget` has
 * left. The issue whose message crosses the budget keeps as much of it as is left, when that is
 * enough for a cut message, and the budget is then spent: nothing after it is kept, in this item or
 * a later one. `valid` and `issueCount` describe every issue found, and `truncated` says whether
 * an issue was left out or a message was cut.
 */
export function validateItem(
	index: number,
	issues: ValidationIssue[],
	limits: Pick<DaemonConfig, 'maxIssuesPerString' | 'maxIssueMessageChars'>,
	budget: TextBudget = { remaining: Number.POSITIVE_INFINITY },
): ValidateItem {
	const kept: ValidateIssue[] = [];
	for (const issue of issues.slice(0, limits.maxIssuesPerString)) {
		const mapped = toIssue(issue, limits.maxIssueMessageChars);
		if (mapped.message.length > budget.remaining) {
			if (budget.remaining >= MIN_ISSUE_MESSAGE_CHARS) {
				mapped.message = cutMessage(mapped.message, budget.remaining);
				kept.push(mapped);
			}
			budget.remaining = 0;
			break;
		}
		budget.remaining -= mapped.message.length;
		kept.push(mapped);
	}
	const messageCut = kept.some((issue, i) => issue.message.length !== issues[i].message.length);
	return {
		index,
		valid: !issues.some((issue) => issue.level === 'error'),
		issues: kept,
		issueCount: issues.length,
		truncated: issues.length > kept.length || messageCut,
	};
}

export function createDaemon(config: DaemonConfig, options: DaemonOptions = {}): Daemon {
	const logger = createLogger(options.write);
	const previousSink = setLogger(engineSink(logger));
	const startedAt = Date.now();
	const version = options.version ?? readPackageVersion(__dirname);
	const registry = new SchemaRegistry(config, { now: options.now, logger });
	const semantic = new SemanticService(config, { logger, backoff: options.semanticBackoff });
	const clock = options.now ?? monotonicNow;
	// Per-client buckets, by unit of text: one for everything, one more for what runs semantic search.
	const clients = new ClientTable({
		maxClients: config.maxClients,
		idleMs: config.clientIdleMs,
		create: (now) => ({
			items: new TokenBucket(config.rateItemsPerSec, config.rateItemsBurst, now),
			semantic: new TokenBucket(config.semanticRatePerSec, config.semanticRateBurst, now),
			// A client that is evicted while its requests run keeps releasing into the entry it took
			// its slots from, and comes back with fresh slots, which the table size bounds.
			slots: new SlotLimiter(config.maxInFlightPerClient),
		}),
	});
	const inFlight = new SlotLimiter(config.maxInFlight);
	const semanticGate = new SemanticGate(config.semanticConcurrency, config.semanticQueue);
	// The abort controller of every request that is running, so a close past its grace can stop them.
	const running = new Set<AbortController>();
	let closing = false;

	// Preload runs in the background; every failure is recorded in the registry and the log.
	const preload = (): Promise<void> => registry.preload();
	if (options.autoPreload ?? true) {
		void preload();
	}
	const ready = registry.whenDefaultSettled();

	function health(): Reply {
		const degraded = registry.degraded();
		const starting = !registry.defaultReady;
		const status: HealthStatus = starting ? 'starting' : degraded.length > 0 ? 'degraded' : 'ok';
		const body: HealthResponse = {
			apiVersion: API_VERSION,
			status,
			version,
			commit: config.commit,
			schemas: { default: registry.defaultSpec, degraded },
			semantic: semantic.snapshot(),
			uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
		};
		return starting ? { status: 503, body, headers: { 'Retry-After': '1' } } : { status: 200, body };
	}

	/** A schemas request costs the one unit it paid at the door. */
	function schemas(): Reply {
		const body: SchemasResponse = {
			apiVersion: API_VERSION,
			default: registry.defaultSpec,
			schemas: registry.list(),
		};
		return { status: 200, body };
	}

	function rateLimited(retryAfterSeconds: number): ApiError {
		return new ApiError('RATE_LIMITED', 'too many requests; slow down', { retryAfterSeconds });
	}

	/**
	 * The door: every request except a GET of health pays against its client's general bucket before
	 * anything else is done with it, so a flood of refusals, unknown paths, and OPTIONS requests is
	 * limited like any other traffic. A POST pays by the length it declares (see `doorCost`), the
	 * rest one unit, and a charge over the burst is the whole burst. The door is never refunded:
	 * whatever happens to the request afterward, it has paid at least this. A bucket too empty for it
	 * answers 429 with the wait, and takes nothing.
	 */
	function admit(ctx: RequestContext, req: http.IncomingMessage): void {
		const now = clock();
		const bucket = clients.get(ctx.client, now).items;
		const cost = doorCost(ctx.method, req.headers['content-length']);
		const taken = bucket.take(cost, now);
		if (!taken.allowed) {
			throw rateLimited(taken.retryAfterSeconds);
		}
		ctx.doorUnits = Math.min(cost, bucket.burst);
	}

	/**
	 * Charge a request for its items once they are known, in `units`: what its strings or queries cost
	 * together, one unit for each CHARGE_CHARS_PER_UNIT characters of each, and at least one unit for
	 * each. The request costs the larger of that and what the door took, never more than the burst,
	 * so the general bucket pays only what is left after the door, and an empty batch is not free.
	 * When the request will run semantic search, the full number of units is charged against the
	 * semantic bucket as well. Both buckets are checked before either is charged. A charge is for the
	 * request, not for its result: a refusal keeps everything the request has paid, the door
	 * included, and throws RATE_LIMITED. Its wait is the time after which the same request would pass,
	 * which counts the door that an attempt pays again.
	 */
	function charge(ctx: RequestContext, units: number, semanticSearch: boolean): void {
		const now = clock();
		const bucket = clients.get(ctx.client, now);
		const cost = Math.max(1, units);
		const total = Math.min(cost, bucket.items.burst);
		const extra = Math.max(0, total - ctx.doorUnits);
		const general = bucket.items.check(extra, now);
		const semanticCheck: TakeResult = semanticSearch ? bucket.semantic.check(cost, now) : { allowed: true };
		if (!general.allowed || !semanticCheck.allowed) {
			const nextAttempt = bucket.items.check(total, now);
			const waits = [nextAttempt, semanticCheck].map((result) => (result.allowed ? 0 : result.retryAfterSeconds));
			throw rateLimited(Math.max(...waits));
		}
		bucket.items.take(extra, now);
		if (semanticSearch) {
			bucket.semantic.take(cost, now);
		}
	}

	/** The JSON object body of a POST, within MAX_BODY_BYTES. */
	function readBodyOf(req: http.IncomingMessage, ctx: RequestContext): Promise<Record<string, unknown>> {
		return readJsonObject(req, config.maxBodyBytes, ctx.signal, ctx.body);
	}

	async function validateStrings(req: http.IncomingMessage, ctx: RequestContext): Promise<Reply> {
		const body = await readBodyOf(req, ctx);
		assertKnownFields(body, ['strings', 'schema']);
		const { strings } = body;
		if (!Array.isArray(strings)) {
			throw new ApiError('INVALID_REQUEST', 'strings must be an array');
		}
		ctx.items = strings.length;
		if (strings.length > config.maxStrings) {
			throw new ApiError('BATCH_TOO_LARGE', `strings holds at most ${config.maxStrings} items`, {
				details: { field: 'strings', max: config.maxStrings },
			});
		}
		const spec = registry.resolve(body.schema);
		charge(ctx, batchCost(strings, config.chargeCharsPerUnit), false);
		const used = await abortable(registry.ensure(spec), ctx.signal);
		ctx.schemaUsed = used;

		const results: ValidateResult[] = [];
		// One budget of message text for the whole response, spent by the items in order.
		const budget: TextBudget = { remaining: config.maxIssueTextChars };
		for (const [index, value] of strings.entries()) {
			if (index > 0) {
				await yieldToEventLoop();
			}
			// A request that timed out stops here, between strings, and gives its slot back.
			throwIfCancelled(ctx.signal);
			if (typeof value !== 'string' || value.length > config.maxStringChars) {
				results.push({
					index,
					error: {
						code: 'INVALID_STRING',
						message: `must be a string of at most ${config.maxStringChars} characters`,
					},
				});
				continue;
			}
			try {
				const issues = await validate(value, { schema: spec });
				results.push(
					issues.some(isEngineException)
						? { index, error: itemFailureWithoutDetail(logger, ctx.id, index, VALIDATION_FAILED) }
						: validateItem(index, issues, config, budget),
				);
			} catch (error) {
				results.push({ index, error: itemFailure(logger, ctx.id, index, error, VALIDATION_FAILED) });
			}
		}
		const response: ValidateResponse = { apiVersion: API_VERSION, schema: { requested: spec, used }, results };
		return { status: 200, body: response };
	}

	async function suggest(req: http.IncomingMessage, ctx: RequestContext): Promise<Reply> {
		const body = await readBodyOf(req, ctx);
		assertKnownFields(body, ['queries', 'top', 'schema', 'semantic']);
		const { queries } = body;
		if (!Array.isArray(queries)) {
			throw new ApiError('INVALID_REQUEST', 'queries must be an array');
		}
		ctx.items = queries.length;
		const top = parseTop(body.top);
		const wantsSemantic = parseSemantic(body.semantic);
		if (queries.length > config.maxQueries) {
			throw new ApiError('BATCH_TOO_LARGE', `queries holds at most ${config.maxQueries} items`, {
				details: { field: 'queries', max: config.maxQueries },
			});
		}
		// The semantic limit applies whenever a request asks for semantic search, whatever the server's
		// state, so whether a request is valid never depends on whether the model has loaded.
		if (wantsSemantic && queries.length > config.maxSemanticQueries) {
			throw new ApiError(
				'BATCH_TOO_LARGE',
				`queries holds at most ${config.maxSemanticQueries} items when semantic is true`,
				{ details: { field: 'queries', max: config.maxSemanticQueries, semantic: true } },
			);
		}
		const spec = registry.resolve(body.schema);
		// The state is read once, so a warm-up that finishes mid-request changes nothing for this one.
		const semanticStatus = semantic.statusForRequest();
		const runSemantic = wantsSemantic && semantic.ready;
		if (wantsSemantic) {
			ctx.semanticStatus = semanticStatus;
		}
		charge(ctx, batchCost(queries, config.chargeCharsPerUnit), runSemantic);
		const used = await abortable(registry.ensure(spec), ctx.signal);
		ctx.schemaUsed = used;

		// Semantic requests take turns: one slot, a queue behind it, and the wait counts toward the timeout.
		const releaseSlot = runSemantic ? await semanticGate.acquire(ctx.signal) : undefined;
		try {
			return await suggestEach(queries, ctx, { spec, used, top, runSemantic, wantsSemantic, semanticStatus });
		} finally {
			releaseSlot?.();
		}
	}

	interface SuggestPlan {
		spec: string;
		used: string;
		top: number;
		runSemantic: boolean;
		wantsSemantic: boolean;
		semanticStatus: SemanticStatus;
	}

	/** Run the queries one at a time, so a timeout can stop the batch between two of them. */
	async function suggestEach(queries: unknown[], ctx: RequestContext, plan: SuggestPlan): Promise<Reply> {
		const { spec, used, top, runSemantic, wantsSemantic, semanticStatus } = plan;
		const results: SuggestResult[] = [];
		const steps: SemanticStep[] = [];
		for (const [index, query] of queries.entries()) {
			if (index > 0) {
				await yieldToEventLoop();
			}
			// A request that timed out stops here, between queries, and gives its slots back.
			throwIfCancelled(ctx.signal);
			if (typeof query !== 'string' || query.trim() === '' || query.length > config.maxQueryChars) {
				const error = {
					code: 'INVALID_QUERY' as const,
					message: `must be a non-empty string of at most ${config.maxQueryChars} characters`,
				};
				results.push(typeof query === 'string' ? { index, query, error } : { index, error });
				continue;
			}
			try {
				const found = await findSuggestions(query, { schema: spec, top, semantic: runSemantic });
				steps.push(found.semanticStep);
				results.push({ index, query, suggestions: found.suggestions.map((tag) => ({ tag })) });
			} catch (error) {
				results.push({ index, query, error: itemFailure(logger, ctx.id, index, error, SUGGESTIONS_FAILED) });
			}
		}
		const response: SuggestResponse = { apiVersion: API_VERSION, schema: { requested: spec, used }, results };
		if (wantsSemantic) {
			// The model was ready when the request started; the status says whether it held up.
			const status = runSemantic ? semanticStatusOf(steps) : semanticStatus;
			ctx.semanticStatus = status;
			response.semantic = { requested: true, status };
		}
		return { status: 200, body: response };
	}

	const routes = new Map<string, Route>([
		['/v1/health', { methods: ['GET'], gated: false, limited: false, handler: health }],
		['/v1/schemas', { methods: ['GET'], gated: true, limited: true, handler: schemas }],
		['/v1/validate', { methods: ['POST'], gated: true, limited: true, handler: validateStrings }],
		['/v1/suggest', { methods: ['POST'], gated: true, limited: true, handler: suggest }],
	]);

	/** The methods a route answers: its own, HEAD when it answers GET, and OPTIONS. */
	function allowedMethods(route: Route): string[] {
		return [...route.methods, ...(route.methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'];
	}

	async function dispatch(req: http.IncomingMessage, ctx: RequestContext): Promise<Reply> {
		const route = routes.get(ctx.path);
		// A route that answers GET answers HEAD the same way, and the response leaves out the body.
		const method = ctx.method === 'HEAD' && route?.methods.includes('GET') ? 'GET' : ctx.method;
		// Health is the one exemption: a GET of it pays nothing, and any other request pays at the door.
		if (!(route && !route.limited && method === 'GET')) {
			admit(ctx, req);
		}
		if (!route) {
			throw new ApiError('NOT_FOUND', 'no such route');
		}
		if (method === 'OPTIONS') {
			return {
				status: 204,
				headers: {
					Allow: allowedMethods(route).join(', '),
					'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
				},
			};
		}
		if (!route.methods.includes(method)) {
			throw new ApiError('METHOD_NOT_ALLOWED', 'method not allowed', { allow: allowedMethods(route) });
		}
		// A POST says how long its body is, so the daemon knows the cost before it reads a byte, and a
		// body of unknown length (chunked) is refused without being read.
		if (method === 'POST' && req.headers['content-length'] === undefined) {
			throw new ApiError('LENGTH_REQUIRED', 'a POST needs a Content-Length header; chunked bodies are not accepted');
		}
		if (route.gated && !registry.defaultReady) {
			throw new ApiError('STARTING', 'the daemon is starting; try again shortly', { retryAfterSeconds: 1 });
		}
		if (!route.limited) {
			return route.handler(req, ctx);
		}
		// The slot is held from here, when the headers have arrived, until the work has stopped, so a
		// slow body holds it too, and so does a request that timed out until its work notices.
		// The client's own cap comes first, so a client at its cap takes no slot from the others.
		const releaseClient = clients.get(ctx.client, clock()).slots.tryAcquire();
		if (!releaseClient) {
			throw new ApiError('OVERLOADED', 'too many of your requests are in flight; try again shortly', {
				retryAfterSeconds: 1,
			});
		}
		const releaseShared = inFlight.tryAcquire();
		if (!releaseShared) {
			releaseClient();
			throw new ApiError('OVERLOADED', 'the daemon is at its limit of requests in flight; try again shortly', {
				retryAfterSeconds: 1,
			});
		}
		const release = (): void => {
			releaseShared();
			releaseClient();
		};
		const work = Promise.resolve().then(() => route.handler(req, ctx));
		work.then(release, release);
		return work;
	}

	/** The reply for a failure, with its code recorded for the request log. */
	function replyToFailure(error: unknown, ctx: RequestContext): Reply {
		const failure = failureReply(error, ctx.id, logger);
		ctx.errorCode = failure.code;
		return failure;
	}

	/**
	 * Write the reply. A HEAD response has the headers of the GET response, Content-Length included, and no body.
	 * The write is bounded by WRITE_STALL_MS: a client that stops reading loses its connection.
	 */
	function send(res: http.ServerResponse, reply: Reply, headOnly: boolean, ctx: RequestContext): void {
		const headers: Record<string, string | number> = { 'Cache-Control': 'no-store', ...reply.headers };
		const payload = reply.body === undefined ? undefined : Buffer.from(JSON.stringify(reply.body), 'utf-8');
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json; charset=utf-8';
			headers['Content-Length'] = payload.length;
		}
		if (closing) {
			headers.Connection = 'close';
		}
		res.writeHead(reply.status, headers);
		endWithinStallLimit(res, headOnly ? undefined : payload, config.writeStallMs, () =>
			logger.warn('connection closed because a response write stalled', { requestId: ctx.id }),
		);
	}

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const rawUrl = req.url ?? '/';
		const query = rawUrl.indexOf('?');
		const work = new AbortController();
		const forwarded = req.headers['x-forwarded-for'];
		const ctx: RequestContext = {
			id: crypto.randomUUID(),
			method: req.method ?? 'GET',
			path: query === -1 ? rawUrl : rawUrl.slice(0, query),
			startedAt: performance.now(),
			client: clientKey(
				req.socket.remoteAddress,
				Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
				config.trustedProxies,
			),
			signal: work.signal,
			body: { bytes: 0 },
			doorUnits: 0,
		};
		res.setHeader('X-Request-Id', ctx.id);
		for (const [name, value] of Object.entries(CORS_HEADERS)) {
			res.setHeader(name, value);
		}
		res.once('close', () => {
			// A request that was cut off before its answer was written has no status to report.
			const aborted = !res.writableFinished;
			logger.info('request', {
				requestId: ctx.id,
				method: ctx.method,
				// The path of a route is a fixed string. Any other path is the client's text, so only a label is logged.
				path: routes.has(ctx.path) ? ctx.path : UNKNOWN_ROUTE_LABEL,
				status: aborted ? undefined : res.statusCode,
				ms: Math.round((performance.now() - ctx.startedAt) * 10) / 10,
				items: ctx.items,
				schema: ctx.schemaUsed,
				semantic: ctx.semanticStatus,
				error: ctx.errorCode,
				aborted: aborted ? true : undefined,
			});
		});

		// One timer for the whole request, from the headers to the last item, so time spent reading the
		// body or waiting in the semantic queue counts. It answers first; the work stops at its next
		// item and gives its slots back then.
		// A second timer covers the body alone: a body still incomplete BODY_TIMEOUT_MS after the headers
		// is answered 408 and the connection is closed, so a slow sender holds a slot for 10 seconds and
		// not for the whole request timeout. Either timer stops the work between items.
		let timer: NodeJS.Timeout | undefined;
		let bodyTimer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				work.abort();
				reject(new ApiError('TIMEOUT', 'the request took too long', { retryAfterSeconds: 1 }));
			}, config.requestTimeoutMs);
			bodyTimer = setTimeout(() => {
				if (!req.complete) {
					work.abort();
					reject(new ApiError('REQUEST_TIMEOUT', 'the request body did not arrive in time'));
				}
			}, config.bodyTimeoutMs);
		});
		running.add(work);

		let reply: Reply;
		try {
			reply = await Promise.race([dispatch(req, ctx), timedOut]);
		} catch (error) {
			if (error instanceof ClientAborted || error instanceof WorkCancelled) {
				// Nobody is left to answer; the close handler logs the request as aborted.
				return;
			}
			reply = replyToFailure(error, ctx);
			if (ctx.errorCode === 'TIMEOUT' || ctx.errorCode === 'REQUEST_TIMEOUT') {
				// The body of a request that timed out may still be arriving, so the connection is not reused.
				reply.headers = { ...reply.headers, Connection: 'close' };
			}
		} finally {
			clearTimeout(timer);
			clearTimeout(bodyTimer);
			running.delete(work);
		}
		if (res.destroyed || res.headersSent) {
			return;
		}
		discardUnreadBody(req, ctx);
		send(res, reply, ctx.method === 'HEAD', ctx);
	}

	/**
	 * Whatever the answer is, a body that is still arriving and that nobody will read is read and
	 * dropped so the client can finish sending and see the answer, up to DISCARD_FACTOR times
	 * MAX_BODY_BYTES counted from the start of the body; past that the connection is cut. This
	 * covers every refusal that is decided before the body is read, such as an unsupported media
	 * type, an unknown path, a wrong method, a rate limit, or a daemon that is busy or starting.
	 */
	function discardUnreadBody(req: http.IncomingMessage, ctx: RequestContext): void {
		if (req.complete || req.destroyed) {
			return;
		}
		discardRest(req, discardLimitBytes(config.maxBodyBytes), ctx.body.bytes, () =>
			logger.warn('connection closed because a refused body kept arriving', { requestId: ctx.id }),
		);
	}

	const server = http.createServer(
		{
			headersTimeout: config.headersTimeoutMs,
			// The daemon's timer answers a slow request first; Node's closes the socket without an answer.
			requestTimeout: config.requestTimeoutMs + NODE_REQUEST_TIMEOUT_MARGIN_MS,
			keepAliveTimeout: config.keepAliveTimeoutMs,
			// Node checks these timeouts on an interval, 30 seconds by default, which would let a slow
			// client hold a connection far past a short timeout; half the headers timeout keeps it close.
			connectionsCheckingInterval: Math.max(100, Math.min(30_000, Math.floor(config.headersTimeoutMs / 2))),
		},
		(req, res) => {
			handle(req, res).catch((error: unknown) => {
				// handle() answers every failure itself; this guards the logging and response code.
				logger.error('request handler crashed', errorDetail(error));
				res.destroy();
			});
		},
	);
	server.maxConnections = config.maxConnections;
	// Node's socket timeout counts time without any read or write on a connection while a request is
	// being handled, and closes the connection when it runs out. It is off by default, so a client that
	// stops reading a response held its connection until the operating system gave up. It is set past
	// the request timeout, because a request that waits its whole timeout in the semantic queue moves
	// no bytes, and the daemon answers it with a 503 first. Between two requests on a kept-alive
	// connection, KEEPALIVE_TIMEOUT_MS replaces it, so the keep-alive window is not shortened. It does
	// not bound a write that has stalled, because Node does not fire it while a write is in progress
	// until a whole period has passed without the write queue moving: that takes two to three periods.
	// The write watchdog (WRITE_STALL_MS, see endWithinStallLimit) bounds the write, and this stays as
	// the backstop for a connection that moves no bytes for another reason.
	server.timeout = config.requestTimeoutMs + NODE_REQUEST_TIMEOUT_MARGIN_MS;
	// The warm-up starts after the listeners of the caller have run, so a caller that announces the
	// address, as the entry point does, announces it before the first semantic work begins.
	server.on('listening', () => setImmediate(() => semantic.start()));

	async function close(graceMs = 10_000): Promise<void> {
		closing = true;
		semantic.stop();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				// Past the grace, the work still running is told to stop, and its connections are closed.
				for (const work of running) {
					work.abort();
				}
				server.closeAllConnections();
			}, graceMs);
			server.close(() => {
				clearTimeout(timer);
				resolve();
			});
			server.closeIdleConnections();
		});
		setLogger(previousSink);
	}

	return { server, ready, preload, close };
}
