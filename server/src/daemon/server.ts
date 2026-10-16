/**
 * The HTTP adapter for the HED engine: routing, the v1 envelope, and the endpoints. A request gets
 * a fresh ID, CORS headers, and exactly one JSON response; a failure is an ApiError that becomes
 * the error envelope, and anything else becomes a generic 500 with the detail in the log. Nothing
 * logged or returned carries request text.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { TextDecoder } from 'node:util';
import { setLogger, type ValidationIssue, validate } from '../engine/index.js';
import { type DaemonConfig, MIN_ISSUE_MESSAGE_CHARS, readPackageVersion } from './config.js';
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
	type ValidateIssue,
	type ValidateItem,
	type ValidateResponse,
	type ValidateResult,
} from './protocol.js';
import { SchemaRegistry } from './schemas.js';
import { SemanticService } from './semantic.js';

export interface DaemonOptions {
	/** Receives each JSON log line. Defaults to stderr. */
	write?: LineWriter;
	/**
	 * Start loading the schema allowlist when the daemon is created. Defaults to true. A caller that
	 * sets it to false decides when startup begins by calling `preload()`; until then the daemon
	 * answers as it does while starting.
	 */
	autoPreload?: boolean;
	/** Clock in milliseconds, used for schema backoff. Defaults to Date.now. */
	now?: () => number;
	/** The version shown in health. Defaults to the nearest package.json. */
	version?: string;
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

/** What one request records for its log line. */
interface RequestContext {
	id: string;
	method: string;
	path: string;
	startedAt: number;
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
	onCutoff: () => void,
): Promise<Buffer> {
	const tooLarge = (): ApiError =>
		new ApiError('PAYLOAD_TOO_LARGE', `the request body is larger than ${limit} bytes`, {
			details: { maxBytes: limit },
		});
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
	onCutoff: () => void,
): Promise<Record<string, unknown>> {
	checkContentType(req.headers['content-type']);
	const raw = await readBody(req, limit, discardLimit, onCutoff);
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
	const semantic = new SemanticService();
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

	function schemas(): Reply {
		const body: SchemasResponse = {
			apiVersion: API_VERSION,
			default: registry.defaultSpec,
			schemas: registry.list(),
		};
		return { status: 200, body };
	}

	/** The JSON object body of a POST, within MAX_BODY_BYTES. */
	function readBodyOf(req: http.IncomingMessage, ctx: RequestContext): Promise<Record<string, unknown>> {
		return readJsonObject(req, config.maxBodyBytes, discardLimitBytes(config.maxBodyBytes), () =>
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
		const used = await registry.ensure(spec);
		ctx.schemaUsed = used;

		const results: ValidateResult[] = [];
		// One budget of message text for the whole response, spent by the items in order.
		const budget: TextBudget = { remaining: config.maxIssueTextChars };
		for (const [index, value] of strings.entries()) {
			if (index > 0) {
				await yieldToEventLoop();
			}
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

	const routes = new Map<string, Route>([
		['/v1/health', { methods: ['GET'], gated: false, handler: health }],
		['/v1/schemas', { methods: ['GET'], gated: true, handler: schemas }],
		['/v1/validate', { methods: ['POST'], gated: true, handler: validateStrings }],
	]);

	function allowHeader(route: Route): string {
		return [...route.methods, 'OPTIONS'].join(', ');
	}

	async function dispatch(req: http.IncomingMessage, ctx: RequestContext): Promise<Reply> {
		const route = routes.get(ctx.path);
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
		return route.handler(req, ctx);
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
		const ctx: RequestContext = {
			id: crypto.randomUUID(),
			method: req.method ?? 'GET',
			path: query === -1 ? rawUrl : rawUrl.slice(0, query),
			startedAt: performance.now(),
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

		let reply: Reply;
		try {
			reply = await dispatch(req, ctx);
		} catch (error) {
			if (error instanceof ClientAborted) {
				// Nobody is left to answer; the close handler logs the request as aborted.
				return;
			}
			reply = replyToFailure(error, ctx);
		}
		if (res.destroyed || res.headersSent) {
			return;
		}
		send(res, reply);
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			// handle() answers every failure itself; this guards the logging and response code.
			logger.error('request handler crashed', errorDetail(error));
			res.destroy();
		});
	});
	server.on('listening', () => semantic.start());

	async function close(graceMs = 10_000): Promise<void> {
		closing = true;
		semantic.stop();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => server.closeAllConnections(), graceMs);
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
