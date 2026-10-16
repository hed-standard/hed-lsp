/**
 * The HTTP adapter for the HED engine: routing, the v1 envelope, and the endpoints. A request gets
 * a fresh ID, CORS headers, and exactly one JSON response; a failure is an ApiError that becomes
 * the error envelope, and anything else becomes a generic 500 with the detail in the log. Nothing
 * logged or returned carries request text.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { setLogger } from '../engine/index.js';
import { type DaemonConfig, readPackageVersion } from './config.js';
import { createLogger, engineSink, errorDetail, type LineWriter, type Logger } from './log.js';
import {
	API_VERSION,
	ApiError,
	CORS_HEADERS,
	errorBody,
	type HealthResponse,
	type HealthStatus,
	type SchemasResponse,
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

const MAX_LOGGED_PATH = 120;

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

	const routes = new Map<string, Route>([
		['/v1/health', { methods: ['GET'], gated: false, handler: health }],
		['/v1/schemas', { methods: ['GET'], gated: true, handler: schemas }],
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
