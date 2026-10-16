/**
 * The v1 wire contract of the daemon: response shapes, error codes and the error envelope, the
 * field whitelist, and the CORS header set. Nothing here touches the network, so the same shapes
 * can be checked by a client or a test without starting a server.
 */

/** Carried in every response body. The path holds the major version; this marks additive fields. */
export const API_VERSION = '1.0';

/** `top` for suggestions: an integer in this range, ten by default. */
export const TOP_MIN = 1;
export const TOP_MAX = 50;
export const TOP_DEFAULT = 10;

/** Codes for a request that failed as a whole, each with its HTTP status. */
export const ERROR_STATUS = {
	INVALID_JSON: 400,
	INVALID_REQUEST: 400,
	UNKNOWN_FIELD: 400,
	BATCH_TOO_LARGE: 400,
	UNKNOWN_SCHEMA: 400,
	NOT_FOUND: 404,
	METHOD_NOT_ALLOWED: 405,
	REQUEST_TIMEOUT: 408,
	LENGTH_REQUIRED: 411,
	PAYLOAD_TOO_LARGE: 413,
	UNSUPPORTED_MEDIA_TYPE: 415,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
	STARTING: 503,
	OVERLOADED: 503,
	SEMANTIC_BUSY: 503,
	SCHEMA_UNAVAILABLE: 503,
	TIMEOUT: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Codes for one item of a batch, reported inside a 200 response. */
export type ItemErrorCode = 'INVALID_STRING' | 'INVALID_QUERY' | 'INTERNAL_ERROR';

export interface ItemError {
	code: ItemErrorCode;
	message: string;
}

export interface ErrorBody {
	apiVersion: typeof API_VERSION;
	error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
	requestId: string;
}

export interface ApiErrorOptions {
	/** Extra fields for the client, such as the allowed schemas. */
	details?: Record<string, unknown>;
	/** Sent as the Retry-After header, in whole seconds. */
	retryAfterSeconds?: number;
	/** Sent as the Allow header. */
	allow?: readonly string[];
}

/**
 * A request-level failure. Throwing it anywhere in a handler produces the error envelope with the
 * code's status. The message is written for the client and never carries an exception's text.
 */
export class ApiError extends Error {
	readonly status: number;

	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly options: ApiErrorOptions = {},
	) {
		super(message);
		this.name = 'ApiError';
		this.status = ERROR_STATUS[code];
	}
}

/** The error envelope for a request. */
export function errorBody(requestId: string, error: ApiError): ErrorBody {
	const body: ErrorBody = {
		apiVersion: API_VERSION,
		error: { code: error.code, message: error.message },
		requestId,
	};
	if (error.options.details) {
		body.error.details = error.options.details;
	}
	return body;
}

/** A plain JSON object: not null and not an array. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The most field names echoed back in an UNKNOWN_FIELD error, and the longest one kept. */
const MAX_REPORTED_FIELDS = 10;
const MAX_REPORTED_FIELD_LENGTH = 64;

/**
 * The keys of a parsed body that are not in `allowed`, in body order. Own keys only: a JSON key
 * named `__proto__` is an own key of the parsed object and is reported like any other.
 */
export function unknownFields(body: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(body).filter((key) => !allowed.includes(key));
}

/** Throw UNKNOWN_FIELD when the body carries a key outside `allowed`. */
export function assertKnownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = unknownFields(body, allowed);
	if (unknown.length === 0) {
		return;
	}
	const shown = unknown.slice(0, MAX_REPORTED_FIELDS).map((key) => key.slice(0, MAX_REPORTED_FIELD_LENGTH));
	throw new ApiError('UNKNOWN_FIELD', `unknown field: ${shown.join(', ')}`, {
		details: { fields: shown, allowed: [...allowed] },
	});
}

/**
 * CORS: the API is public and stateless, so any origin may call it with GET, POST, or OPTIONS and
 * no credentials. Clients can read the request ID and Retry-After.
 */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Expose-Headers': 'Retry-After, X-Request-Id',
};

/**
 * How long a browser may keep the answer to a preflight, in seconds. The answer never changes, so a
 * browser that asks once need not ask again for each request; browsers cap this, some at 10 minutes.
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

export type HealthStatus = 'starting' | 'ok' | 'degraded';
export type SemanticState = 'disabled' | 'loading' | 'ready' | 'unavailable';
export type SchemaStatus = 'loading' | 'loaded' | 'failed';

export interface HealthResponse {
	apiVersion: typeof API_VERSION;
	status: HealthStatus;
	version: string;
	commit: string;
	schemas: { default: string; degraded: string[] };
	semantic: { state: SemanticState; failures: number; index: string };
	uptimeSeconds: number;
}

export interface SchemaListing {
	spec: string;
	status: SchemaStatus;
	/** The version that loaded, which is not the same as `spec` when the bundled fallback ran. */
	used?: string;
	/** For a failed schema, the seconds until a request may try it again. */
	retryAfterSeconds?: number;
}

export interface SchemasResponse {
	apiVersion: typeof API_VERSION;
	default: string;
	schemas: SchemaListing[];
}

export interface SchemaUsed {
	requested: string;
	used: string;
}

export interface ValidateIssue {
	code: string;
	level: 'error' | 'warning';
	/** Cut to `MAX_ISSUE_MESSAGE_CHARS` characters, ending with "...", when it is longer. */
	message: string;
	bounds?: [number, number];
}

/**
 * The outcome for one string. `valid` means no issue with level `error` among all the issues the
 * engine found, not only the ones returned. `issues` holds the first `MAX_ISSUES_PER_STRING` in the
 * engine's order, with long messages cut, and fewer when the response has used up its
 * `MAX_ISSUE_TEXT_CHARS` of message text: an item after that point has `issues: []`. `issueCount` is
 * the true number of issues found, and `truncated` is true when an issue was left out or a message
 * was cut. Both are always present.
 */
export interface ValidateItem {
	index: number;
	valid: boolean;
	issues: ValidateIssue[];
	issueCount: number;
	truncated: boolean;
}

export type ValidateResult = ValidateItem | { index: number; error: ItemError };

export interface ValidateResponse {
	apiVersion: typeof API_VERSION;
	schema: SchemaUsed;
	results: ValidateResult[];
}

export type SemanticStatus = 'ok' | 'disabled' | 'loading' | 'unavailable';

export type SuggestResult =
	| { index: number; query: string; suggestions: { tag: string }[] }
	| { index: number; query?: string; error: ItemError };

export interface SuggestResponse {
	apiVersion: typeof API_VERSION;
	schema: SchemaUsed;
	/** Present only when the request set `semantic: true`. */
	semantic?: { requested: true; status: SemanticStatus };
	results: SuggestResult[];
}
