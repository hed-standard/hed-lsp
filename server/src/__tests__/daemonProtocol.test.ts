/**
 * Tests for the v1 wire contract helpers: the error envelope, the status of each code, the field
 * whitelist, and the CORS header set. Real functions on real values; no mocks.
 */

import { describe, expect, it } from 'vitest';
import {
	API_VERSION,
	ApiError,
	assertKnownFields,
	CORS_HEADERS,
	ERROR_STATUS,
	errorBody,
	isPlainObject,
	unknownFields,
} from '../daemon/protocol.js';

describe('error envelope', () => {
	it('carries the version, the code and message, and the request ID', () => {
		const body = errorBody('req-1', new ApiError('INVALID_REQUEST', 'strings is required'));

		expect(body).toEqual({
			apiVersion: API_VERSION,
			error: { code: 'INVALID_REQUEST', message: 'strings is required' },
			requestId: 'req-1',
		});
	});

	it('includes details only when given', () => {
		const body = errorBody(
			'req-2',
			new ApiError('UNKNOWN_SCHEMA', 'unknown schema', { details: { allowed: ['8.4.0'] } }),
		);

		expect(body.error.details).toEqual({ allowed: ['8.4.0'] });
		expect('details' in errorBody('req-3', new ApiError('NOT_FOUND', 'no such route')).error).toBe(false);
	});

	it('gives each code the status the contract lists', () => {
		expect(ERROR_STATUS).toEqual({
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
		});
		expect(new ApiError('RATE_LIMITED', 'slow down').status).toBe(429);
	});
});

describe('field whitelist', () => {
	it('lists the keys outside the whitelist, in body order', () => {
		expect(unknownFields({ strings: [], extra: 1, schema: 'x', other: 2 }, ['strings', 'schema'])).toEqual([
			'extra',
			'other',
		]);
	});

	it('reports a JSON key named __proto__ and constructor as unknown fields', () => {
		const parsed = JSON.parse('{"strings": [], "__proto__": {"polluted": true}, "constructor": 1}');

		expect(unknownFields(parsed, ['strings'])).toEqual(['__proto__', 'constructor']);
		expect(() => assertKnownFields(parsed, ['strings'])).toThrow(ApiError);
	});

	it('throws UNKNOWN_FIELD naming the fields, with the allowed list in the details', () => {
		let thrown: unknown;
		try {
			assertKnownFields({ queryFormat: 'qwen', queries: [] }, ['queries', 'top']);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ApiError);
		const error = thrown as ApiError;
		expect(error.code).toBe('UNKNOWN_FIELD');
		expect(error.status).toBe(400);
		expect(error.message).toContain('queryFormat');
		expect(error.options.details).toEqual({ fields: ['queryFormat'], allowed: ['queries', 'top'] });
	});

	it('bounds how many field names, and how long, it echoes', () => {
		const body = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${'k'.repeat(200)}${i}`, i]));
		let thrown: ApiError | undefined;
		try {
			assertKnownFields(body, []);
		} catch (error) {
			thrown = error as ApiError;
		}

		const fields = thrown?.options.details?.fields as string[];
		expect(fields).toHaveLength(10);
		expect(fields.every((field) => field.length <= 64)).toBe(true);
	});

	it('accepts a body whose keys are all allowed', () => {
		expect(() => assertKnownFields({ strings: [] }, ['strings', 'schema'])).not.toThrow();
	});
});

describe('isPlainObject', () => {
	it('accepts objects and rejects arrays, null, and scalars', () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject('x')).toBe(false);
		expect(isPlainObject(1)).toBe(false);
	});
});

describe('CORS headers', () => {
	it('allow any origin for GET, POST, and OPTIONS without credentials', () => {
		expect(CORS_HEADERS).toEqual({
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Expose-Headers': 'Retry-After, X-Request-Id',
		});
		expect(Object.keys(CORS_HEADERS)).not.toContain('Access-Control-Allow-Credentials');
	});
});
