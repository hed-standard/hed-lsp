/**
 * The HTTP adapter for the HED engine: routing, the v1 envelope, the endpoints, and the limits. A
 * request gets a fresh ID, CORS headers, and exactly one JSON response; a failure is an ApiError
 * that becomes the error envelope, and anything else becomes a generic 500 with the detail in the
 * log. Every request except a GET of health pays at least one unit against its client's rate bucket
 * before anything else happens, so refusals, unknown paths, and OPTIONS requests are limited like
 * other traffic, and then pays for what it asks, by the length of its text. Every request that reaches a handler except
 * health also holds an in-flight slot from the moment its headers arrive until its work stops, and
 * is answered with a 503 TIMEOUT when it runs past REQUEST_TIMEOUT_MS; its work looks for that
 * between items. Nothing logged or returned carries request text.
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
	/** Clock in milliseconds, used for schema backoff and the rate buckets. Defaults to Date.now. */
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

const MAX_LOGGED_PATH = 120;

/** Units every request except a GET of health pays at the door, before its items are known. */
const DOOR_COST = 1;

/** The client closed the connection before the request was complete; there is nobody to answer. */
class ClientAborted extends Error {
	constructor() {
		super('the client closed the connection');
		this.name = 'ClientAborted';
	}
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
 * How much of a refused body is still read and thrown away, as a multiple of the body limit, so
 * the client can finish sending and read the 413. Closing a socket that holds unread data resets
 * the connection, and the client may then never see the response. A client whose body keeps
 * arriving past the bound is cut off. The bound follows the configuration: 2 MiB by default.
 */
export const DISCARD_FACTOR = 4;

/** The bytes of a refused body that are read and discarded before the connection is cut. */
export function discardLimitBytes(maxBodyBytes: number): number {
	return DISCARD_FACTOR * maxBodyBytes;
}

/**
 * Read and drop the rest of a refused body. `alreadyRead` counts the bytes consumed before the
 * refusal, so `discardLimit` bounds the whole body, not only what comes after the refusal.
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
 * byte, and by counting while streaming for a body that declares no length or lies about it.
 * Nothing past the limit is kept; the rest is discarded as it arrives, until the body as a whole
 * passes `discardLimit` bytes and the connection is cut.
 */
function readBody(
	req: http.IncomingMessage,
	limit: number,
	discardLimit: number,
	signal: AbortSignal,
	onCutoff: () => void,
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
		discardRest(req, discardLimit, 0, onCutoff);
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
			if (size > limit) {
				settle(() => {
					discardRest(req, discardLimit, size, onCutoff);
					reject(tooLarge());
				});
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
	discardLimit: number,
	signal: AbortSignal,
	onCutoff: () => void,
): Promise<Record<string, unknown>> {
	checkContentType(req.headers['content-type']);
	const raw = await readBody(req, limit, discardLimit, signal, onCutoff);
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
	const clock = options.now ?? Date.now;
	// Per-client buckets, by unit of text: one for everything, one more for what runs semantic search.
	const clients = new ClientTable({
		maxClients: config.maxClients,
		idleMs: config.clientIdleMs,
		create: (now) => ({
			items: new TokenBucket(config.rateItemsPerSec, config.rateItemsBurst, now),
			semantic: new TokenBucket(config.semanticRatePerSec, config.semanticRateBurst, now),
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
	 * The door: every request except a GET of health pays one unit against its client's general
	 * bucket before anything else is done with it, so a flood of refusals, unknown paths, and OPTIONS
	 * requests is limited like any other traffic. Whatever happens to the request afterward, it has
	 * paid at least this, which is also what a request refused for its body or shape costs. An empty
	 * bucket answers 429 with the wait, and takes nothing.
	 */
	function admit(ctx: RequestContext): void {
		const now = clock();
		const taken = clients.get(ctx.client, now).items.take(DOOR_COST, now);
		if (!taken.allowed) {
			throw rateLimited(taken.retryAfterSeconds);
		}
	}

	/**
	 * Charge a request for its items once they are known, in `units`: what its strings or queries cost
	 * together, one unit for each CHARGE_CHARS_PER_UNIT characters of each, and at least one unit for
	 * each. The door has taken one unit, which counts toward this charge, so the general bucket pays
	 * the rest of `units`, up to its burst, and a request costs at least one unit, so an empty batch
	 * is not free. When the request will run semantic search, the same number is charged against the
	 * semantic bucket. Both buckets are checked before either is charged. A refusal gives the door
	 * unit back, so a request refused for its rate costs nothing, and throws RATE_LIMITED with the
	 * longer wait.
	 */
	function charge(ctx: RequestContext, units: number, semanticSearch: boolean): void {
		const now = clock();
		const bucket = clients.get(ctx.client, now);
		const cost = Math.max(1, units);
		const rest = Math.min(cost, bucket.items.burst) - DOOR_COST;
		const general = bucket.items.check(rest, now);
		const semanticCheck: TakeResult = semanticSearch ? bucket.semantic.check(cost, now) : { allowed: true };
		if (!general.allowed || !semanticCheck.allowed) {
			bucket.items.refund(DOOR_COST, now);
			const waits = [general, semanticCheck].map((result) => (result.allowed ? 0 : result.retryAfterSeconds));
			throw rateLimited(Math.max(...waits));
		}
		bucket.items.take(rest, now);
		if (semanticSearch) {
			bucket.semantic.take(cost, now);
		}
	}

	/** The JSON object body of a POST, within MAX_BODY_BYTES. */
	function readBodyOf(req: http.IncomingMessage, ctx: RequestContext): Promise<Record<string, unknown>> {
		return readJsonObject(req, config.maxBodyBytes, discardLimitBytes(config.maxBodyBytes), ctx.signal, () =>
			logger.warn('connection closed because a refused body kept arriving', { requestId: ctx.id }),
		);
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
				results.push(validateItem(index, await validate(value, { schema: spec }), config, budget));
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

	function allowHeader(route: Route): string {
		return [...route.methods, 'OPTIONS'].join(', ');
	}

	async function dispatch(req: http.IncomingMessage, ctx: RequestContext): Promise<Reply> {
		const route = routes.get(ctx.path);
		// Health is the one exemption: a GET of it pays nothing, and any other request pays at the door.
		if (!(route && !route.limited && ctx.method === 'GET')) {
			admit(ctx);
		}
		if (!route) {
			throw new ApiError('NOT_FOUND', 'no such route');
		}
		if (ctx.method === 'OPTIONS') {
			return { status: 204, headers: { Allow: allowHeader(route) } };
		}
		if (!route.methods.includes(ctx.method)) {
			throw new ApiError('METHOD_NOT_ALLOWED', 'method not allowed', { allow: [...route.methods, 'OPTIONS'] });
		}
		if (route.gated && !registry.defaultReady) {
			throw new ApiError('STARTING', 'the daemon is starting; try again shortly', { retryAfterSeconds: 1 });
		}
		if (!route.limited) {
			return route.handler(req, ctx);
		}
		// The slot is held from here, when the headers have arrived, until the work has stopped, so a
		// slow body holds it too, and so does a request that timed out until its work notices.
		const release = inFlight.tryAcquire();
		if (!release) {
			throw new ApiError('OVERLOADED', 'the daemon is at its limit of requests in flight; try again shortly', {
				retryAfterSeconds: 1,
			});
		}
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

	function send(res: http.ServerResponse, reply: Reply): void {
		const headers: Record<string, string | number> = { 'Cache-Control': 'no-store', ...reply.headers };
		const payload = reply.body === undefined ? undefined : JSON.stringify(reply.body);
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json; charset=utf-8';
			headers['Content-Length'] = Buffer.byteLength(payload);
		}
		if (closing) {
			headers.Connection = 'close';
		}
		res.writeHead(reply.status, headers);
		res.end(payload);
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
		};
		res.setHeader('X-Request-Id', ctx.id);
		for (const [name, value] of Object.entries(CORS_HEADERS)) {
			res.setHeader(name, value);
		}
		res.once('close', () => {
			logger.info('request', {
				requestId: ctx.id,
				method: ctx.method,
				path: ctx.path.slice(0, MAX_LOGGED_PATH),
				status: res.statusCode,
				ms: Math.round((performance.now() - ctx.startedAt) * 10) / 10,
				items: ctx.items,
				schema: ctx.schemaUsed,
				semantic: ctx.semanticStatus,
				error: ctx.errorCode,
				aborted: res.writableFinished ? undefined : true,
			});
		});

		// One timer for the whole request, from the headers to the last item, so time spent reading the
		// body or waiting in the semantic queue counts. It answers first; the work stops at its next
		// item and gives its slots back then.
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				work.abort();
				reject(new ApiError('TIMEOUT', 'the request took too long', { retryAfterSeconds: 1 }));
			}, config.requestTimeoutMs);
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
			if (ctx.errorCode === 'TIMEOUT') {
				// The body of a request that timed out may still be arriving, so the connection is not reused.
				reply.headers = { ...reply.headers, Connection: 'close' };
			}
		} finally {
			clearTimeout(timer);
			running.delete(work);
		}
		if (res.destroyed || res.headersSent) {
			return;
		}
		send(res, reply);
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
	server.on('listening', () => semantic.start());

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
