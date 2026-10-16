/**
 * Tests for the daemon configuration parser: defaults, overrides, and a failure that names the bad
 * variable. The parser reads the environment object it is given, so each case passes its own. The
 * package-version reader runs against real temporary directories. No mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ConfigError,
	configWarnings,
	DEFAULT_SCHEMA,
	DEFAULT_SCHEMAS,
	loadConfig,
	parseSchemaSpec,
	readPackageVersion,
} from '../daemon/config.js';
import { DEFAULT_HED_SCHEMA } from '../engine/index.js';

function failure(env: Record<string, string>): ConfigError {
	try {
		loadConfig(env);
	} catch (error) {
		if (error instanceof ConfigError) {
			return error;
		}
		throw error;
	}
	throw new Error(`expected loadConfig to reject ${JSON.stringify(env)}`);
}

describe('loadConfig defaults', () => {
	it('matches the documented defaults', () => {
		const config = loadConfig({});

		expect(config).toEqual({
			host: '127.0.0.1',
			port: 38530,
			trustedProxies: ['127.0.0.1', '0:0:0:0:0:0:0:1'],
			semantic: false,
			onnxThreads: 1,
			modelDownload: true,
			schemas: [...DEFAULT_SCHEMAS],
			defaultSchema: '8.5.0',
			schemaLoadTimeoutMs: 60000,
			maxBodyBytes: 524288,
			maxStrings: 100,
			maxStringChars: 4096,
			maxIssuesPerString: 100,
			maxIssueMessageChars: 1024,
			maxIssueTextChars: 1048576,
			maxQueries: 50,
			maxSemanticQueries: 20,
			maxQueryChars: 512,
			rateItemsPerSec: 100,
			rateItemsBurst: 1000,
			semanticRatePerSec: 1,
			semanticRateBurst: 20,
			chargeCharsPerUnit: 256,
			maxInFlight: 32,
			semanticConcurrency: 1,
			semanticQueue: 8,
			requestTimeoutMs: 30000,
			headersTimeoutMs: 10000,
			keepAliveTimeoutMs: 65000,
			maxConnections: 256,
			maxClients: 10000,
			clientIdleMs: 600000,
			commit: 'unknown',
		});
	});

	it('keeps the default schema equal to the engine default, as the CLI and engine.validate use', () => {
		expect(DEFAULT_SCHEMA).toBe(DEFAULT_HED_SCHEMA);
		expect(DEFAULT_SCHEMAS).toEqual([
			'8.5.0',
			'8.5.0,sc:score_2.1.0,la:lang_1.1.0',
			'8.4.0',
			'8.4.0,sc:score_2.1.0,la:lang_1.1.0',
			'8.3.0',
		]);
	});

	it('reads the process environment when none is given', () => {
		const before = process.env.HED_LSP_PORT;
		process.env.HED_LSP_PORT = '4242';
		try {
			expect(loadConfig().port).toBe(4242);
		} finally {
			if (before === undefined) {
				delete process.env.HED_LSP_PORT;
			} else {
				process.env.HED_LSP_PORT = before;
			}
		}
	});
});

describe('loadConfig overrides', () => {
	it('reads every variable', () => {
		const config = loadConfig({
			HED_LSP_HOST: '0.0.0.0',
			HED_LSP_PORT: '0',
			HED_LSP_TRUSTED_PROXIES: '172.30.56.1, ::ffff:10.0.0.2',
			HED_LSP_SEMANTIC: '1',
			HED_LSP_ONNX_THREADS: '4',
			HED_LSP_MODEL_DOWNLOAD: '0',
			HED_LSP_SCHEMAS: '8.4.0;8.4.0,sc:score_2.1.0',
			HED_LSP_DEFAULT_SCHEMA: '8.4.0',
			HED_LSP_SCHEMA_LOAD_TIMEOUT_MS: '5000',
			HED_LSP_MAX_BODY_BYTES: '1000',
			HED_LSP_MAX_STRINGS: '2',
			HED_LSP_MAX_STRING_CHARS: '30',
			HED_LSP_MAX_ISSUES_PER_STRING: '5',
			HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '40',
			HED_LSP_MAX_ISSUE_TEXT_CHARS: '5000',
			HED_LSP_MAX_QUERIES: '3',
			HED_LSP_MAX_SEMANTIC_QUERIES: '2',
			HED_LSP_MAX_QUERY_CHARS: '40',
			HED_LSP_RATE_ITEMS_PER_SEC: '0.5',
			HED_LSP_RATE_ITEMS_BURST: '7',
			HED_LSP_SEMANTIC_RATE_PER_SEC: '2.5',
			HED_LSP_SEMANTIC_RATE_BURST: '9',
			HED_LSP_CHARGE_CHARS_PER_UNIT: '100',
			HED_LSP_MAX_IN_FLIGHT: '1',
			HED_LSP_SEMANTIC_CONCURRENCY: '1',
			HED_LSP_SEMANTIC_QUEUE: '0',
			HED_LSP_REQUEST_TIMEOUT_MS: '1',
			HED_LSP_HEADERS_TIMEOUT_MS: '2',
			HED_LSP_KEEPALIVE_TIMEOUT_MS: '3',
			HED_LSP_MAX_CONNECTIONS: '4',
			HED_LSP_MAX_CLIENTS: '2',
			HED_LSP_CLIENT_IDLE_MS: '5',
			HED_LSP_COMMIT: 'abc1234',
		});

		expect(config).toMatchObject({
			host: '0.0.0.0',
			port: 0,
			trustedProxies: ['172.30.56.1', '10.0.0.2'],
			semantic: true,
			onnxThreads: 4,
			modelDownload: false,
			schemas: ['8.4.0', '8.4.0,sc:score_2.1.0'],
			defaultSchema: '8.4.0',
			schemaLoadTimeoutMs: 5000,
			maxBodyBytes: 1000,
			maxStrings: 2,
			maxStringChars: 30,
			maxIssuesPerString: 5,
			maxIssueMessageChars: 40,
			maxIssueTextChars: 5000,
			maxQueries: 3,
			maxSemanticQueries: 2,
			maxQueryChars: 40,
			rateItemsPerSec: 0.5,
			rateItemsBurst: 7,
			semanticRatePerSec: 2.5,
			semanticRateBurst: 9,
			chargeCharsPerUnit: 100,
			maxInFlight: 1,
			semanticConcurrency: 1,
			semanticQueue: 0,
			requestTimeoutMs: 1,
			headersTimeoutMs: 2,
			keepAliveTimeoutMs: 3,
			maxConnections: 4,
			maxClients: 2,
			clientIdleMs: 5,
			commit: 'abc1234',
		});
	});

	it('accepts true and false for the flags, in any case', () => {
		expect(loadConfig({ HED_LSP_SEMANTIC: 'TRUE' }).semantic).toBe(true);
		expect(loadConfig({ HED_LSP_MODEL_DOWNLOAD: 'False' }).modelDownload).toBe(false);
	});

	it('lets HED_LSP_MAX_STRING_CHARS raise the default of 4096, and accepts the shortest message and text limits', () => {
		expect(loadConfig({ HED_LSP_MAX_STRING_CHARS: '16384' }).maxStringChars).toBe(16384);
		expect(loadConfig({ HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '4' }).maxIssueMessageChars).toBe(4);
		expect(loadConfig({ HED_LSP_MAX_ISSUE_TEXT_CHARS: '1' }).maxIssueTextChars).toBe(1);
		expect(loadConfig({ HED_LSP_MAX_ISSUES_PER_STRING: '1' }).maxIssuesPerString).toBe(1);
	});

	it('treats an empty trusted-proxy list as trusting nobody, and a blank commit as unknown', () => {
		expect(loadConfig({ HED_LSP_TRUSTED_PROXIES: '' }).trustedProxies).toEqual([]);
		expect(loadConfig({ HED_LSP_COMMIT: '  ' }).commit).toBe('unknown');
	});

	it('accepts a charge of one character per unit, the finest the rate charge can be', () => {
		expect(loadConfig({ HED_LSP_CHARGE_CHARS_PER_UNIT: '1' }).chargeCharsPerUnit).toBe(1);
	});
});

describe('loadConfig failures', () => {
	// One bad value per variable. The error must name the variable, so an operator can find it.
	const bad: [string, string][] = [
		['HOST', ''],
		['HOST', 'a b'],
		['PORT', 'abc'],
		['PORT', '65536'],
		['PORT', '-1'],
		['PORT', '1.5'],
		['PORT', '1e3'],
		['PORT', ''],
		['TRUSTED_PROXIES', 'not-an-ip'],
		['TRUSTED_PROXIES', '127.0.0.1, 999.1.1.1'],
		['SEMANTIC', 'yes'],
		['SEMANTIC', ''],
		['ONNX_THREADS', '0'],
		['ONNX_THREADS', 'many'],
		['MODEL_DOWNLOAD', '2'],
		['SCHEMAS', ''],
		['SCHEMAS', ' ; '],
		['SCHEMAS', '8.4.0;8.4.0'],
		['SCHEMAS', '8.4.0,sc:score_2.1.0;sc:score_2.1.0,8.4.0'],
		['SCHEMAS', '8.4.0,8.4.0'],
		['DEFAULT_SCHEMA', '8.3.1'],
		['DEFAULT_SCHEMA', ''],
		['SCHEMA_LOAD_TIMEOUT_MS', '0'],
		['MAX_BODY_BYTES', '0'],
		['MAX_STRINGS', '-5'],
		['MAX_STRING_CHARS', 'x'],
		['MAX_ISSUES_PER_STRING', '0'],
		['MAX_ISSUES_PER_STRING', 'many'],
		['MAX_ISSUE_MESSAGE_CHARS', '3'],
		['MAX_ISSUE_MESSAGE_CHARS', '0'],
		['MAX_ISSUE_TEXT_CHARS', '0'],
		['MAX_ISSUE_TEXT_CHARS', 'lots'],
		['MAX_QUERIES', '0'],
		['MAX_SEMANTIC_QUERIES', '0'],
		['MAX_QUERY_CHARS', '0'],
		['RATE_ITEMS_PER_SEC', '0'],
		['RATE_ITEMS_PER_SEC', 'fast'],
		['RATE_ITEMS_BURST', '0'],
		['SEMANTIC_RATE_PER_SEC', '-1'],
		['SEMANTIC_RATE_BURST', '1.5'],
		['CHARGE_CHARS_PER_UNIT', '0'],
		['CHARGE_CHARS_PER_UNIT', 'many'],
		['MAX_IN_FLIGHT', '0'],
		['SEMANTIC_CONCURRENCY', '0'],
		['SEMANTIC_QUEUE', '-1'],
		['REQUEST_TIMEOUT_MS', '0'],
		['HEADERS_TIMEOUT_MS', '0'],
		['KEEPALIVE_TIMEOUT_MS', 'soon'],
		['MAX_CONNECTIONS', '0'],
		['MAX_CLIENTS', '0'],
		['CLIENT_IDLE_MS', '0'],
		['MAX_BODY_BYTES', '99999999999'],
	];

	it.each(bad)('names HED_LSP_%s for the value "%s"', (name, value) => {
		const error = failure({ [`HED_LSP_${name}`]: value });

		expect(error.variable).toBe(`HED_LSP_${name}`);
		expect(error.message).toContain(`HED_LSP_${name}`);
	});

	it('names HED_LSP_DEFAULT_SCHEMA when the default is not in the allowlist', () => {
		const error = failure({ HED_LSP_SCHEMAS: '8.4.0', HED_LSP_DEFAULT_SCHEMA: '8.5.0' });

		expect(error.variable).toBe('HED_LSP_DEFAULT_SCHEMA');
		expect(error.message).toContain('8.4.0');
	});

	it.each(['0', '2', '1024', '', 'one'])(
		'rejects HED_LSP_SEMANTIC_CONCURRENCY=%j and says why only one is allowed',
		(value) => {
			const error = failure({ HED_LSP_SEMANTIC_CONCURRENCY: value });

			expect(error.variable).toBe('HED_LSP_SEMANTIC_CONCURRENCY');
			expect(error.message).toContain('HED_LSP_SEMANTIC_CONCURRENCY');
			expect(error.message).toContain('one semantic call at a time until a worker thread exists');
		},
	);

	it('accepts HED_LSP_SEMANTIC_CONCURRENCY=1, and takes it as the default when unset', () => {
		expect(loadConfig({ HED_LSP_SEMANTIC_CONCURRENCY: '1' }).semanticConcurrency).toBe(1);
		expect(loadConfig({ HED_LSP_SEMANTIC_CONCURRENCY: ' 1 ' }).semanticConcurrency).toBe(1);
		expect(loadConfig({}).semanticConcurrency).toBe(1);
	});

	it('accepts a default that is the allowlisted set in another order', () => {
		const config = loadConfig({
			HED_LSP_SCHEMAS: '8.4.0,sc:score_2.1.0',
			HED_LSP_DEFAULT_SCHEMA: 'sc:score_2.1.0, 8.4.0',
		});

		expect(config.defaultSchema).toBe('8.4.0,sc:score_2.1.0');
	});

	it('ignores variables it does not know', () => {
		expect(() => loadConfig({ HED_LSP_DAEMON_URL: 'http://127.0.0.1:1', HED_LSP_NOT_A_SETTING: '1' })).not.toThrow();
	});
});

describe('parseSchemaSpec', () => {
	it('splits, trims, and drops blanks, keeping the given order as the text', () => {
		expect(parseSchemaSpec(' 8.4.0 , ,sc:score_2.1.0 ')).toEqual({
			kind: 'spec',
			text: '8.4.0,sc:score_2.1.0',
			key: '8.4.0,sc:score_2.1.0',
		});
	});

	it('gives reordered and array forms the same key', () => {
		const a = parseSchemaSpec('8.4.0,sc:score_2.1.0,la:lang_1.1.0');
		const b = parseSchemaSpec(['la:lang_1.1.0', 'sc:score_2.1.0,8.4.0']);

		expect(a.kind === 'spec' && b.kind === 'spec' && a.key === b.key).toBe(true);
	});

	it('compares as a case-sensitive set', () => {
		const lower = parseSchemaSpec('8.4.0,sc:score_2.1.0');
		const upper = parseSchemaSpec('8.4.0,SC:score_2.1.0');

		expect(lower.kind === 'spec' && upper.kind === 'spec' && lower.key !== upper.key).toBe(true);
	});

	it.each([null, undefined, '', '  ', ' , ', []])('reads %j as blank', (value) => {
		expect(parseSchemaSpec(value)).toEqual({ kind: 'blank' });
	});

	it.each([5, true, {}, [1], ['8.4.0', 2]])('rejects %j as the wrong type', (value) => {
		expect(parseSchemaSpec(value)).toEqual({ kind: 'invalid', reason: 'type' });
	});

	it('rejects a repeated part', () => {
		expect(parseSchemaSpec('8.4.0,8.4.0')).toEqual({ kind: 'invalid', reason: 'duplicate' });
		expect(parseSchemaSpec(['8.4.0', '8.4.0'])).toEqual({ kind: 'invalid', reason: 'duplicate' });
	});
});

describe('configWarnings', () => {
	it('warns when listening beyond loopback with the default trusted proxies', () => {
		const warnings = configWarnings(loadConfig({ HED_LSP_HOST: '0.0.0.0' }));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('HED_LSP_TRUSTED_PROXIES');
	});

	it('stays quiet on loopback, and when the proxy list is set or empty', () => {
		expect(configWarnings(loadConfig({}))).toEqual([]);
		expect(configWarnings(loadConfig({ HED_LSP_HOST: 'localhost' }))).toEqual([]);
		expect(configWarnings(loadConfig({ HED_LSP_HOST: '::1' }))).toEqual([]);
		expect(configWarnings(loadConfig({ HED_LSP_HOST: '0.0.0.0', HED_LSP_TRUSTED_PROXIES: '172.30.56.1' }))).toEqual([]);
		expect(configWarnings(loadConfig({ HED_LSP_HOST: '0.0.0.0', HED_LSP_TRUSTED_PROXIES: '' }))).toEqual([]);
	});
});

describe('readPackageVersion', () => {
	function withTree(layout: (root: string) => string, check: (start: string) => void): void {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-lsp-version-'));
		try {
			check(layout(root));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	it('reads the nearest package.json at or above the start directory', () => {
		withTree(
			(root) => {
				fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
				fs.mkdirSync(path.join(root, 'server', 'out', 'daemon'), { recursive: true });
				fs.writeFileSync(path.join(root, 'server', 'package.json'), JSON.stringify({ version: '1.2.3' }));
				return path.join(root, 'server', 'out', 'daemon');
			},
			(start) => expect(readPackageVersion(start)).toBe('1.2.3'),
		);
	});

	it('answers unknown for a package.json that cannot be read or has no version', () => {
		withTree(
			(root) => {
				fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
				return root;
			},
			(start) => expect(readPackageVersion(start)).toBe('unknown'),
		);
		withTree(
			(root) => {
				fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
				return root;
			},
			(start) => expect(readPackageVersion(start)).toBe('unknown'),
		);
	});

	it('reads the version of this package from the source directory', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));

		expect(readPackageVersion(path.join(__dirname, '..', 'daemon'))).toBe(pkg.version);
	});
});
