/**
 * Tests for POST /v1/validate: a real server on a real socket with the real engine and the bundled
 * schemas, so they run offline. Responses are compared with `engine.validate` for the same
 * strings. A spec that fails to load is a real one (`8.4.0,sc:score_9.9.9` does not exist). A string
 * that makes the validator throw is a real one too: thousands of nested parentheses run it out of
 * stack, and the engine reports that exception as an issue whose text is the exception's message.
 * The item-level INTERNAL_ERROR for any other failure is checked on the function that maps an
 * unexpected failure to its item. No mocks.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_ISSUE_MESSAGE_CHARS } from '../daemon/config.js';
import { createLogger } from '../daemon/log.js';
import {
	cutMessage,
	discardLimitBytes,
	isEngineException,
	itemFailure,
	VALIDATION_FAILED,
	validateItem,
} from '../daemon/server.js';
import { validate } from '../engine/index.js';
import {
	BUNDLED,
	BUNDLED_WITH_LIBRARIES,
	call,
	postJson,
	type RunningDaemon,
	startDaemon,
	waitFor,
} from './daemonHarness.js';

const VALID = 'Sensory-event, Visual-presentation';
/** A spec that does not exist, so loading it fails for real. */
const MISSING = '8.4.0,sc:score_9.9.9';
const INVALID = 'Sensory-event, Not-a-real-tag-xyz';

/** The fields of a validate item that the budget tests read from a response. */
interface ValidateItemWire {
	index: number;
	valid: boolean;
	issues: { code: string; message: string }[];
	issueCount: number;
	truncated: boolean;
}

/** The item for a string with no issues. */
function clean(index: number): Record<string, unknown> {
	return { index, valid: true, issues: [], issueCount: 0, truncated: false };
}

/** What the daemon returns for an engine issue whose message is within the limit. */
function wire(issue: Awaited<ReturnType<typeof validate>>[number]): Record<string, unknown> {
	return {
		code: issue.hedCode,
		level: issue.level,
		message: issue.message,
		...(issue.bounds ? { bounds: issue.bounds } : {}),
	};
}

/** A daemon that runs for the whole file, for cases that need no special configuration. */
let shared: RunningDaemon;
beforeAll(async () => {
	shared = await startDaemon();
});
afterAll(async () => {
	await shared.stop();
});

async function withDaemon(
	overrides: Record<string, string>,
	run: (daemon: RunningDaemon) => Promise<void>,
	options: Parameters<typeof startDaemon>[1] = {},
): Promise<void> {
	const daemon = await startDaemon(overrides, options);
	try {
		await run(daemon);
	} finally {
		await daemon.stop();
	}
}

describe('POST /v1/validate results', () => {
	it('reports a valid string and an invalid one with its bounds, in request order', async () => {
		const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID, INVALID, VALID], schema: BUNDLED });

		expect(reply.status).toBe(200);
		expect(reply.json.apiVersion).toBe('1.0');
		expect(reply.json.schema).toEqual({ requested: BUNDLED, used: BUNDLED });
		expect(reply.json.results).toHaveLength(3);
		expect(reply.json.results.map((result: { index: number }) => result.index)).toEqual([0, 1, 2]);
		expect(reply.json.results[0]).toEqual(clean(0));
		expect(reply.json.results[2]).toEqual(clean(2));

		const invalid = reply.json.results[1];
		expect(invalid.valid).toBe(false);
		expect(invalid.issues).toHaveLength(1);
		expect(invalid.issues[0]).toMatchObject({ code: 'TAG_INVALID', level: 'error' });
		const [start, end] = invalid.issues[0].bounds;
		expect(INVALID.slice(start, end)).toBe('Not-a-real-tag-xyz');
	});

	it('never exposes the internal code of an issue', async () => {
		const reply = await postJson(shared.url, '/v1/validate', { strings: [INVALID, '(Red, Blue'], schema: BUNDLED });

		expect(reply.text).not.toContain('internalCode');
		for (const result of reply.json.results) {
			for (const issue of result.issues) {
				expect(Object.keys(issue).sort()).toEqual(
					issue.bounds === undefined ? ['code', 'level', 'message'] : ['bounds', 'code', 'level', 'message'],
				);
			}
		}
	});

	it('counts a string with only warnings as valid, and keeps the warning', async () => {
		const warned = 'Sensory-event, Item/Marmoset-thing';

		const reply = await postJson(shared.url, '/v1/validate', { strings: [warned], schema: BUNDLED });

		expect(reply.json.results[0].valid).toBe(true);
		expect(reply.json.results[0].issues).toEqual([expect.objectContaining({ code: 'TAG_EXTENDED', level: 'warning' })]);
		expect(reply.json.results[0].issues[0].bounds).toBeUndefined();
	});

	it('gives the same issues as engine.validate for the same strings, when no limit applies', async () => {
		const strings = [
			VALID,
			INVALID,
			'Sensory-event, sc:Modulator',
			'Sensory-event, (Red, Square',
			'Sensory-event, Label/{column}',
			'Sensory-event, {column}',
			'{column}',
			'({column}, Red)',
			'',
			'   ',
			'Sensory-event, Item/Marmoset-thing',
			'Sensory-event, Duration/3 parsecs',
		];

		const reply = await postJson(shared.url, '/v1/validate', { strings, schema: BUNDLED });

		expect(reply.status).toBe(200);
		for (const [index, hed] of strings.entries()) {
			const expected = await validate(hed, { schema: BUNDLED });
			// The premise: every message of these strings is within the default limit of 1024 characters.
			for (const issue of expected) {
				expect(issue.message.length, JSON.stringify(hed)).toBeLessThanOrEqual(shared.config.maxIssueMessageChars);
			}
			expect(reply.json.results[index], JSON.stringify(hed)).toEqual({
				index,
				valid: !expected.some((issue) => issue.level === 'error'),
				issues: expected.map(wire),
				issueCount: expected.length,
				truncated: false,
			});
		}
	});

	it("leaves a full batch of ordinary strings whole: no item is truncated and every issue is the engine's", async () => {
		const sidecar = 'Sensory-event, Experimental-stimulus, Visual-presentation, (Image, Face), Not-a-real-tag-xyz';
		const mix = [VALID, INVALID, sidecar, 'Sensory-event, (Red, Square', 'Item/Marmoset-thing'];
		const strings = Array.from({ length: 100 }, (_, i) => mix[i % mix.length]);

		const reply = await postJson(shared.url, '/v1/validate', { strings, schema: BUNDLED });

		expect(reply.status).toBe(200);
		for (const [index, hed] of strings.entries()) {
			const expected = await validate(hed, { schema: BUNDLED });
			expect(reply.json.results[index], `${index} ${hed}`).toEqual({
				index,
				valid: !expected.some((issue) => issue.level === 'error'),
				issues: expected.map(wire),
				issueCount: expected.length,
				truncated: false,
			});
		}
	});

	it('does not truncate a normal sidecar-style string, and returns its issues unchanged', async () => {
		const sidecar = 'Sensory-event, Experimental-stimulus, Visual-presentation, (Image, Face), Not-a-real-tag-xyz';
		const expected = await validate(sidecar, { schema: BUNDLED });
		expect(expected).toHaveLength(1);
		// The premise: this engine message is within the default limit, so nothing has to be cut.
		expect(expected[0].message.length).toBeLessThanOrEqual(shared.config.maxIssueMessageChars);

		const reply = await postJson(shared.url, '/v1/validate', { strings: [sidecar, VALID], schema: BUNDLED });

		expect(reply.json.results[0]).toEqual({
			index: 0,
			valid: false,
			issues: expected.map(wire),
			issueCount: 1,
			truncated: false,
		});
		expect(reply.json.results[1]).toEqual(clean(1));
	});

	it('skips a string that is only a placeholder and validates the rest of one that has placeholders', async () => {
		const reply = await postJson(shared.url, '/v1/validate', {
			strings: ['{column}', '{a}, {b}', 'Sensory-event, {column}', INVALID],
			schema: BUNDLED,
		});

		expect(reply.json.results[0]).toEqual(clean(0));
		expect(reply.json.results[1]).toEqual(clean(1));
		expect(reply.json.results[2]).toEqual(clean(2));
		expect(reply.json.results[3].issues[0].code).toBe('TAG_INVALID');
	});

	it('keeps the order of a full batch', async () => {
		const strings = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? VALID : INVALID));

		const reply = await postJson(shared.url, '/v1/validate', { strings, schema: BUNDLED });

		expect(reply.status).toBe(200);
		expect(reply.json.results).toHaveLength(100);
		reply.json.results.forEach((result: { index: number; valid: boolean }, i: number) => {
			expect(result.index).toBe(i);
			expect(result.valid).toBe(i % 2 === 0);
		});
	});

	it('answers an empty strings array with 200 and no results', async () => {
		const reply = await postJson(shared.url, '/v1/validate', { strings: [] });

		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			apiVersion: '1.0',
			schema: { requested: BUNDLED, used: BUNDLED },
			results: [],
		});
	});
});

describe('POST /v1/validate items', () => {
	it('reports INVALID_STRING for a non-string and for one over the limit, beside successes', async () => {
		await withDaemon({ HED_LSP_MAX_STRING_CHARS: '40' }, async (daemon) => {
			const atLimit = `Sensory-event, ${'a'.repeat(25)}`;
			expect(atLimit).toHaveLength(40);

			const reply = await postJson(daemon.url, '/v1/validate', {
				strings: [VALID, 42, null, { x: 1 }, ['a'], true, `${atLimit}b`, atLimit, VALID],
			});

			expect(reply.status).toBe(200);
			const results = reply.json.results;
			expect(results[0]).toEqual(clean(0));
			for (const index of [1, 2, 3, 4, 5, 6]) {
				expect(results[index], `item ${index}`).toEqual({
					index,
					error: { code: 'INVALID_STRING', message: 'must be a string of at most 40 characters' },
				});
			}
			expect(results[7].valid).toBe(false);
			expect(results[7].error).toBeUndefined();
			expect(results[8]).toEqual(clean(8));
		});
	});

	it('reports an unexpected failure of one string as INTERNAL_ERROR, and keeps its text out of the log', () => {
		const marker = 'SECRET-hed-text-91c4';
		const lines: string[] = [];
		const logger = createLogger((line) => lines.push(line));

		const item = itemFailure(logger, 'req-9', 3, new Error(`cannot read Sensory-event, ${marker}`), VALIDATION_FAILED);

		expect(item).toEqual({ code: 'INTERNAL_ERROR', message: 'validation failed' });
		expect(JSON.stringify(item)).not.toContain(marker);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain(marker);
		expect(JSON.parse(lines[0])).toMatchObject({
			level: 'error',
			msg: 'validation failed for one string',
			requestId: 'req-9',
			index: 3,
			errorType: 'Error',
		});
	});
});

describe('POST /v1/validate with a string that makes the validator throw', () => {
	/** `depth` nested pairs of parentheses around a tag. The validator recurses once per level. */
	const nested = (depth: number): string => `${'('.repeat(depth)}Event${')'.repeat(depth)}`;
	/** Deep enough to run the validator out of stack on any Node version, and past the default string limit. */
	const DEPTH = 4000;

	it('reports the string as INTERNAL_ERROR "validation failed" beside the others, with no exception text', async () => {
		await withDaemon({ HED_LSP_MAX_STRING_CHARS: '16384' }, async (daemon) => {
			const hed = nested(DEPTH);
			// The premise: the engine does not throw, it returns the exception's message as an issue.
			const engine = await validate(hed, { schema: BUNDLED });
			expect(engine).toHaveLength(1);
			expect(engine[0].message).toMatch(/^Validation error: .*call stack/);
			expect(engine.some(isEngineException)).toBe(true);

			const reply = await postJson(daemon.url, '/v1/validate', { strings: [VALID, hed, INVALID], schema: BUNDLED });

			expect(reply.status).toBe(200);
			expect(reply.json.results[0]).toEqual(clean(0));
			expect(reply.json.results[1]).toEqual({
				index: 1,
				error: { code: 'INTERNAL_ERROR', message: 'validation failed' },
			});
			expect(reply.json.results[2].issues[0].code).toBe('TAG_INVALID');
			for (const text of [reply.text, daemon.rawLines.join('\n')]) {
				expect(text).not.toContain('call stack');
				expect(text).not.toContain('Validation error');
			}
			const line = daemon.logLines().find((entry) => entry.msg === 'validation failed for one string');
			expect(line).toMatchObject({ level: 'error', requestId: reply.headers['x-request-id'], index: 1 });
			expect(Object.keys(line ?? {}).sort()).toEqual(['index', 'level', 'msg', 'requestId', 'time']);
		});
	});

	it('reports a string with a repeated tag as the validator issue it is, not as a failure', async () => {
		// The validator throws an issue for a repeated tag instead of returning it, and the engine reports it
		// with the validator's code and message, so the daemon returns it as it does any other issue.
		const engine = await validate('Red, Red', { schema: BUNDLED });
		expect(engine).toHaveLength(1);
		expect(engine[0].hedCode).toBe('TAG_EXPRESSION_REPEATED');
		expect(isEngineException(engine[0])).toBe(false);

		const reply = await postJson(shared.url, '/v1/validate', { strings: ['Red, Red', 'Red, Blue'], schema: BUNDLED });

		expect(reply.status).toBe(200);
		expect(reply.json.results[0]).toEqual({
			index: 0,
			valid: false,
			issues: [wire(engine[0])],
			issueCount: 1,
			truncated: false,
		});
		expect(reply.json.results[0].issues[0].code).toBe('TAG_EXPRESSION_REPEATED');
		expect(reply.json.results[0].issues[0].message).toContain('Duplicate tags');
		expect(reply.json.results[1]).toEqual(clean(1));
		expect(reply.text).not.toContain('Validation error');
		expect(reply.text).not.toContain('validation failed');
		expect(reply.text).not.toContain('INTERNAL_ERROR');
	});

	it('tells an exception from the issues of a string that is only invalid or repeats a tag', async () => {
		const ordinary = await validate('(Red, Blue', { schema: BUNDLED });
		const repeated = await validate('Red, Red', { schema: BUNDLED });
		const crashed = await validate(nested(DEPTH), { schema: BUNDLED });

		expect(ordinary.length).toBeGreaterThan(0);
		expect(ordinary.some(isEngineException)).toBe(false);
		expect(repeated.some(isEngineException)).toBe(false);
		expect(crashed.every(isEngineException)).toBe(true);
	});

	it('does the same at the default limit of 4096 characters, where the string is accepted', async () => {
		const hed = nested(2045);
		expect(hed.length).toBeLessThanOrEqual(shared.config.maxStringChars);
		const engine = await validate(hed, { schema: BUNDLED });
		// How deep the validator goes before it runs out of stack differs with the Node version and the
		// state of the compiler, so a string this close to the limit may or may not make it throw.
		const throws = engine.some(isEngineException);

		const reply = await postJson(shared.url, '/v1/validate', { strings: [hed], schema: BUNDLED });

		expect(reply.status).toBe(200);
		if (throws) {
			expect(reply.json.results[0]).toEqual({
				index: 0,
				error: { code: 'INTERNAL_ERROR', message: 'validation failed' },
			});
		}
		expect(reply.text).not.toContain('call stack');
	});
});

describe('POST /v1/validate bounded output', () => {
	/** n open parentheses: about n + 2 issues, each quoting the whole string, so the answer grows with n squared. */
	const parens = (n: number): string => '('.repeat(n);

	it('bounds a string of 4096 open parentheses to 100 issues and under 200 KB, and reports the true count', async () => {
		const hed = parens(4096);
		expect(hed).toHaveLength(shared.config.maxStringChars);
		const expected = await validate(hed, { schema: BUNDLED });
		expect(expected.length).toBeGreaterThan(4000);

		const reply = await postJson(shared.url, '/v1/validate', { strings: [hed], schema: BUNDLED });

		expect(reply.status).toBe(200);
		expect(Buffer.byteLength(reply.text)).toBeLessThan(200 * 1024);
		const item = reply.json.results[0];
		expect(item.truncated).toBe(true);
		expect(item.issueCount).toBe(expected.length);
		expect(item.issueCount).toBeGreaterThan(4000);
		expect(item.issues).toHaveLength(100);
		// `valid` describes every issue the engine found, not only the ones kept.
		expect(item.valid).toBe(!expected.some((issue) => issue.level === 'error'));
		// The issues kept are the first ones in the engine's order, and only their messages are cut.
		const limit = shared.config.maxIssueMessageChars;
		let cut = 0;
		for (const [i, issue] of item.issues.entries()) {
			expect(issue.code).toBe(expected[i].hedCode);
			expect(issue.level).toBe(expected[i].level);
			expect(issue.bounds).toEqual(expected[i].bounds);
			expect(issue.message).toBe(cutMessage(expected[i].message, limit));
			expect(issue.message.length).toBeLessThanOrEqual(limit);
			if (expected[i].message.length > limit) {
				expect(issue.message.endsWith('...')).toBe(true);
				cut++;
			}
		}
		expect(cut).toBeGreaterThan(0);
	});

	it('bounds a batch of strings of 4096 open parentheses to MAX_ISSUE_TEXT_CHARS of message text and a proportional response, with a true issueCount on every item', async () => {
		// The property does not depend on the size of the budget, so the budget is a quarter of the default,
		// 262,144 characters, and six strings are enough to spend it: two whole items, one that crosses the
		// budget, and three empty ones. The response is bounded in proportion, 1.2 MB for the default budget
		// and 300 KB for this one. The batch of a hundred strings that this test first used took a container
		// over 30 seconds; this one takes a small fraction of that, and the explicit limit is for a host
		// that is slower still, since the validator needs about 12 ms a string on a fast desktop computer.
		const hed = parens(4096);
		const expected = await validate(hed, { schema: BUNDLED });
		expect(expected.length).toBeGreaterThan(4000);
		const budget = 1_048_576 / 4;
		const bound = (1_200_000 / 1_048_576) * budget;

		await withDaemon({ HED_LSP_MAX_ISSUE_TEXT_CHARS: String(budget) }, async (daemon) => {
			const reply = await postJson(daemon.url, '/v1/validate', {
				strings: Array.from({ length: 6 }, () => hed),
				schema: BUNDLED,
			});
			const single = await postJson(daemon.url, '/v1/validate', { strings: [hed], schema: BUNDLED });

			expect(reply.status).toBe(200);
			expect(Buffer.byteLength(reply.text)).toBeLessThan(bound);
			const results: ValidateItemWire[] = reply.json.results;
			expect(results).toHaveLength(6);
			// The budget is spent by message text only, and it is spent: the response holds all of it.
			const messageChars = results.flatMap((item) => item.issues).reduce((sum, issue) => sum + issue.message.length, 0);
			expect(messageChars).toBeLessThanOrEqual(budget);
			expect(budget - messageChars).toBeLessThan(MIN_ISSUE_MESSAGE_CHARS);
			// Items fill in order: whole ones, then the one that crossed the budget, then empty ones.
			const firstEmpty = results.findIndex((item) => item.issues.length === 0);
			expect(firstEmpty).toBeGreaterThan(1);
			expect(firstEmpty).toBeLessThan(6);
			for (const [i, item] of results.entries()) {
				expect(item.index).toBe(i);
				expect(item.issueCount).toBe(expected.length);
				expect(item.valid).toBe(!expected.some((issue) => issue.level === 'error'));
				expect(item.truncated).toBe(true);
				if (i < firstEmpty - 1) {
					expect({ ...item, index: 0 }, `item ${i} is whole`).toEqual(single.json.results[0]);
				} else if (i === firstEmpty - 1) {
					expect(item.issues.length).toBeGreaterThan(0);
					expect(item.issues.length).toBeLessThanOrEqual(100);
				} else {
					expect(item.issues, `item ${i} comes after the budget was spent`).toEqual([]);
				}
			}
		});
	}, 60_000);
	it('spends the message budget on the first items in order, cuts the issue that crosses it, and never spends it on a clean string', async () => {
		const expected = await validate(INVALID, { schema: BUNDLED });
		expect(expected).toHaveLength(1);
		const length = expected[0].message.length;
		expect(length).toBeGreaterThan(40);

		// Room for one whole message and the first ten characters of the next.
		await withDaemon({ HED_LSP_MAX_ISSUE_TEXT_CHARS: String(length + 10) }, async (daemon) => {
			const reply = await postJson(daemon.url, '/v1/validate', {
				strings: [INVALID, INVALID, VALID, INVALID],
				schema: BUNDLED,
			});

			expect(reply.status).toBe(200);
			const [whole, crossing, noIssues, spent] = reply.json.results;
			expect(whole).toEqual({ index: 0, valid: false, issues: expected.map(wire), issueCount: 1, truncated: false });
			expect(crossing.valid).toBe(false);
			expect(crossing.issueCount).toBe(1);
			expect(crossing.truncated).toBe(true);
			expect(crossing.issues).toHaveLength(1);
			expect(crossing.issues[0].code).toBe(expected[0].hedCode);
			expect(crossing.issues[0].message).toBe(cutMessage(expected[0].message, 10));
			expect(crossing.issues[0].message).toHaveLength(10);
			// A string with no issues has no message to spend the budget on, so it is not truncated.
			expect(noIssues).toEqual(clean(2));
			expect(spent).toEqual({ index: 3, valid: false, issues: [], issueCount: 1, truncated: true });
		});
	});

	it('refuses a string of 4097 characters as INVALID_STRING and validates one of 4096, beside a clean one', async () => {
		const reply = await postJson(shared.url, '/v1/validate', {
			strings: [parens(4096), 'a'.repeat(4097), VALID],
			schema: BUNDLED,
		});

		expect(reply.status).toBe(200);
		expect(reply.json.results[0].issueCount).toBeGreaterThan(4000);
		expect(reply.json.results[1]).toEqual({
			index: 1,
			error: { code: 'INVALID_STRING', message: 'must be a string of at most 4096 characters' },
		});
		expect(reply.json.results[2]).toEqual(clean(2));
	});

	it('keeps the first MAX_ISSUES_PER_STRING issues, and cuts messages at MAX_ISSUE_MESSAGE_CHARS with a "..." ending', async () => {
		await withDaemon({ HED_LSP_MAX_ISSUES_PER_STRING: '2', HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '40' }, async (daemon) => {
			const hed = parens(10);
			const expected = await validate(hed, { schema: BUNDLED });
			expect(expected.length).toBeGreaterThan(2);

			const reply = await postJson(daemon.url, '/v1/validate', { strings: [hed], schema: BUNDLED });

			const item = reply.json.results[0];
			expect(item.issues).toHaveLength(2);
			expect(item.issueCount).toBe(expected.length);
			expect(item.truncated).toBe(true);
			for (const [i, issue] of item.issues.entries()) {
				expect(issue.code).toBe(expected[i].hedCode);
				expect(issue.message).toHaveLength(40);
				expect(issue.message.endsWith('...')).toBe(true);
				expect(issue.message).toBe(cutMessage(expected[i].message, 40));
			}
		});
	});

	it('sets truncated for a cut message alone and for a dropped issue alone, and not at exactly the limits', async () => {
		const expectedInvalid = await validate(INVALID, { schema: BUNDLED });
		expect(expectedInvalid).toHaveLength(1);

		// One issue, so nothing is dropped, but its message is longer than 40 characters.
		await withDaemon({ HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '40' }, async (daemon) => {
			const reply = await postJson(daemon.url, '/v1/validate', { strings: [INVALID, VALID], schema: BUNDLED });

			const item = reply.json.results[0];
			expect(item.issues).toHaveLength(1);
			expect(item.issueCount).toBe(1);
			expect(item.truncated).toBe(true);
			expect(item.issues[0].message).toHaveLength(40);
			expect(reply.json.results[1]).toEqual(clean(1));
		});

		// Messages are whole, but only the first of several issues is kept.
		await withDaemon(
			{ HED_LSP_MAX_ISSUES_PER_STRING: '1', HED_LSP_MAX_ISSUE_MESSAGE_CHARS: '100000' },
			async (daemon) => {
				const hed = parens(5);
				const expected = await validate(hed, { schema: BUNDLED });
				const reply = await postJson(daemon.url, '/v1/validate', { strings: [hed, INVALID], schema: BUNDLED });

				const dropped = reply.json.results[0];
				expect(dropped.issues).toEqual([wire(expected[0])]);
				expect(dropped.issueCount).toBe(expected.length);
				expect(dropped.truncated).toBe(true);
				// One issue at a limit of one issue, with a whole message, is not truncated.
				expect(reply.json.results[1]).toEqual({
					index: 1,
					valid: false,
					issues: expectedInvalid.map(wire),
					issueCount: 1,
					truncated: false,
				});
			},
		);
	});
});

describe('validateItem', () => {
	it('takes valid from every issue, so kept warnings do not hide an error that was left out', async () => {
		const warnings = await validate('Item/Marmoset-thing', { schema: BUNDLED });
		const errors = await validate(INVALID, { schema: BUNDLED });
		expect(warnings.map((issue) => issue.level)).toEqual(['warning']);
		expect(errors.map((issue) => issue.level)).toEqual(['error']);

		const item = validateItem(4, [...warnings, ...errors], { maxIssuesPerString: 1, maxIssueMessageChars: 100_000 });

		expect(item).toEqual({
			index: 4,
			valid: false,
			issues: warnings.map(wire),
			issueCount: 2,
			truncated: true,
		});
	});

	it('counts a string with only warnings as valid, even when some of them are left out', async () => {
		const warnings = [
			...(await validate('Item/Marmoset-thing', { schema: BUNDLED })),
			...(await validate('Item/Gibbon-thing', { schema: BUNDLED })),
		];

		const item = validateItem(0, warnings, { maxIssuesPerString: 1, maxIssueMessageChars: 100_000 });

		expect(item.valid).toBe(true);
		expect(item.issueCount).toBe(2);
		expect(item.truncated).toBe(true);
	});
});

describe('validateItem with a message budget', () => {
	const limits = { maxIssuesPerString: 100, maxIssueMessageChars: 100_000 };

	async function twoIssues(): Promise<Awaited<ReturnType<typeof validate>>> {
		const issues = await validate('('.repeat(10), { schema: BUNDLED });
		expect(issues.length).toBeGreaterThanOrEqual(2);
		return issues.slice(0, 2);
	}

	it('keeps whole every message the budget covers, and does not truncate an item that uses exactly all of it', async () => {
		const issues = await twoIssues();
		const total = issues[0].message.length + issues[1].message.length;
		const budget = { remaining: total };

		const item = validateItem(0, issues, limits, budget);

		expect(item).toEqual({ index: 0, valid: false, issues: issues.map(wire), issueCount: 2, truncated: false });
		expect(budget.remaining).toBe(0);
	});

	it('cuts the message that crosses the budget to what is left, ending with "...", and drops the issues after it', async () => {
		const issues = await twoIssues();
		const budget = { remaining: issues[0].message.length + 10 };

		const item = validateItem(0, issues, limits, budget);

		expect(item.issues).toEqual([wire(issues[0]), { ...wire(issues[1]), message: cutMessage(issues[1].message, 10) }]);
		expect(item.issues[1].message).toHaveLength(10);
		expect(item.issues[1].message.endsWith('...')).toBe(true);
		expect(item.issueCount).toBe(2);
		expect(item.truncated).toBe(true);
		expect(budget.remaining).toBe(0);
	});

	it('drops a crossing issue whose room is too small for a cut message, and still spends the budget', async () => {
		const issues = await twoIssues();
		const budget = { remaining: issues[0].message.length + MIN_ISSUE_MESSAGE_CHARS - 1 };

		const item = validateItem(0, issues, limits, budget);

		expect(item.issues).toEqual([wire(issues[0])]);
		expect(item.truncated).toBe(true);
		expect(budget.remaining).toBe(0);
	});

	it('gives an item after the spent budget no issues, keeps its valid and issueCount, and leaves a clean item alone', async () => {
		const issues = await twoIssues();
		const budget = { remaining: 0 };

		const later = validateItem(5, issues, limits, budget);
		const cleanItem = validateItem(6, [], limits, budget);

		expect(later).toEqual({ index: 5, valid: false, issues: [], issueCount: 2, truncated: true });
		expect(cleanItem).toEqual(clean(6));
	});

	it('has no budget unless one is given', async () => {
		const issues = await twoIssues();

		expect(validateItem(0, issues, limits).issues).toEqual(issues.map(wire));
	});
});

describe('cutMessage', () => {
	it('leaves a message of exactly the limit alone, and cuts one character more to the limit, ending with "..."', () => {
		expect(cutMessage('abcdefghij', 10)).toBe('abcdefghij');
		expect(cutMessage('abcdefghijk', 10)).toBe('abcdefg...');
		expect(cutMessage('abcdef', 4)).toBe('a...');
		expect(cutMessage('', 4)).toBe('');
	});

	it('does not leave half of a surrogate pair before the "..."', () => {
		// Index 1 is the first half of a pair, so a cut after two characters would split it.
		const cut = cutMessage('a\u{1F600}\u{1F600}\u{1F600}', 5);

		expect(cut).toBe('a...');
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut)).toBe(false);
		// A cut that falls between two whole pairs keeps the pair before it.
		expect(cutMessage('ab\u{1F600}\u{1F600}\u{1F600}', 7)).toBe('ab\u{1F600}...');
	});
});

describe('POST /v1/validate schemas', () => {
	it('treats an omitted, null, blank, or empty-array schema as the default', async () => {
		for (const schema of [undefined, null, '', '   ', []]) {
			const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID], schema });

			expect(reply.status, JSON.stringify(schema)).toBe(200);
			expect(reply.json.schema).toEqual({ requested: BUNDLED, used: BUNDLED });
		}
	});

	it('accepts sc:Modulator with the library set and refuses it under 8.4.0', async () => {
		const hed = 'Sensory-event, sc:Modulator';

		const withLibraries = await postJson(shared.url, '/v1/validate', {
			strings: [hed],
			schema: BUNDLED_WITH_LIBRARIES,
		});
		const bare = await postJson(shared.url, '/v1/validate', { strings: [hed], schema: BUNDLED });

		expect(withLibraries.json.schema).toEqual({ requested: BUNDLED_WITH_LIBRARIES, used: BUNDLED_WITH_LIBRARIES });
		expect(withLibraries.json.results[0]).toEqual(clean(0));
		expect(bare.json.results[0].valid).toBe(false);
		expect(bare.json.results[0].issues[0].code).toBe('TAG_NAMESPACE_PREFIX_INVALID');
	});

	it('maps reordered and array forms of a spec to the same schema', async () => {
		const forms = [
			'la:lang_1.1.0, sc:score_2.1.0 ,8.4.0',
			['sc:score_2.1.0', 'la:lang_1.1.0', '8.4.0'],
			['8.4.0,sc:score_2.1.0', 'la:lang_1.1.0'],
		];
		for (const schema of forms) {
			const reply = await postJson(shared.url, '/v1/validate', { strings: ['Sensory-event, sc:Modulator'], schema });

			expect(reply.status, JSON.stringify(schema)).toBe(200);
			expect(reply.json.schema).toEqual({ requested: BUNDLED_WITH_LIBRARIES, used: BUNDLED_WITH_LIBRARIES });
			expect(reply.json.results[0].valid).toBe(true);
		}
	});

	it('answers UNKNOWN_SCHEMA with the allowed list for a spec outside the allowlist', async () => {
		for (const schema of ['8.5.0', '9.9.9', '8.4.0,sc:score_2.0.0', '__proto__', '8.4.0,8.4.0']) {
			const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID], schema });

			expect(reply.status, schema).toBe(400);
			expect(reply.json.error.code).toBe('UNKNOWN_SCHEMA');
			expect(reply.json.error.details).toEqual({ allowed: [BUNDLED, BUNDLED_WITH_LIBRARIES] });
			expect(reply.json.requestId).toBe(reply.headers['x-request-id']);
		}
	});

	it('answers UNKNOWN_SCHEMA for a schema longer than 256 characters, a string or an array, and accepts 256', async () => {
		const wide = (length: number): string => BUNDLED.padEnd(length, ' ');
		const refused = [wide(257), ','.repeat(300_000), Array.from({ length: 100_000 }, () => 'a')];

		for (const schema of refused) {
			const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID], schema });

			expect(reply.status).toBe(400);
			expect(reply.json.error.code).toBe('UNKNOWN_SCHEMA');
			expect(reply.json.error.details).toEqual({ allowed: [BUNDLED, BUNDLED_WITH_LIBRARIES] });
		}
		const suggest = await postJson(shared.url, '/v1/suggest', { queries: ['red'], schema: wide(257) });
		const at = await postJson(shared.url, '/v1/validate', { strings: [VALID], schema: wide(256) });

		expect(suggest.json.error.code).toBe('UNKNOWN_SCHEMA');
		expect(at.status).toBe(200);
		expect(at.json.schema).toEqual({ requested: BUNDLED, used: BUNDLED });
	});

	it('answers INVALID_REQUEST when the schema is not a string or an array of strings', async () => {
		for (const schema of [5, true, {}, [1], ['8.4.0', null]]) {
			const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID], schema });

			expect(reply.status, JSON.stringify(schema)).toBe(400);
			expect(reply.json.error.code).toBe('INVALID_REQUEST');
		}
	});

	it('answers 503 SCHEMA_UNAVAILABLE with a whole-second Retry-After for a spec that failed to load', async () => {
		// The second spec does not exist, so its load fails for real, online with a 404 and offline with a network error.
		await withDaemon({ HED_LSP_SCHEMAS: `${BUNDLED};${MISSING}` }, async (daemon) => {
			await waitFor(
				async () => (await call(daemon.url, '/v1/schemas')).json.schemas[1].status === 'failed',
				5000,
				'the spec to fail',
			);

			const reply = await postJson(daemon.url, '/v1/validate', { strings: [VALID], schema: MISSING });

			expect(reply.status).toBe(503);
			expect(reply.json.error.code).toBe('SCHEMA_UNAVAILABLE');
			expect(reply.headers['retry-after']).toMatch(/^[1-9]\d*$/);
			// The default spec still answers.
			expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID] })).status).toBe(200);
		});
	});
});

describe('POST /v1/validate request checks', () => {
	it.each([
		[undefined, 'no Content-Type'],
		['text/plain', 'text/plain'],
		['application/json-patch+json', 'a JSON patch type'],
		['application/x-www-form-urlencoded', 'a form'],
		['application/json; charset=iso-8859-1', 'a non-UTF-8 charset'],
		['application/json; charset="utf-16"', 'a quoted non-UTF-8 charset'],
	])('answers 415 for %s (%s)', async (contentType, _label) => {
		const reply = await call(shared.url, '/v1/validate', {
			method: 'POST',
			headers: contentType ? { 'Content-Type': contentType } : {},
			body: JSON.stringify({ strings: [VALID] }),
		});

		expect(reply.status).toBe(415);
		expect(reply.json.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
	});

	it.each([
		'application/json',
		'application/json; charset=utf-8',
		'application/json;charset=UTF-8',
		'APPLICATION/JSON; Charset="utf-8"',
		'application/json; charset=utf-8; boundary=x',
	])('accepts the Content-Type %s', async (contentType) => {
		const reply = await postJson(shared.url, '/v1/validate', { strings: [VALID] }, { 'Content-Type': contentType });

		expect(reply.status).toBe(200);
	});

	it.each([
		['', 'an empty body'],
		['{', 'a truncated object'],
		['{"strings": [}', 'a syntax error'],
		['strings', 'plain text'],
		["{'strings': []}", 'single quotes'],
	])('answers INVALID_JSON for %j (%s)', async (body, _label) => {
		const reply = await postJson(shared.url, '/v1/validate', body);

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_JSON');
		// The parser's own message can quote the body, so it is not passed on.
		expect(reply.text).not.toContain('Unexpected');
	});

	it('answers INVALID_JSON for a body that is not valid UTF-8', async () => {
		const reply = await call(shared.url, '/v1/validate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
		});

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_JSON');
	});

	it('reads a UTF-8 body with non-ASCII text and a byte order mark', async () => {
		const body = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from(JSON.stringify({ strings: ['Event, Label/café'] })),
		]);

		const reply = await call(shared.url, '/v1/validate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
		});

		expect(reply.status).toBe(200);
		expect(reply.json.results).toHaveLength(1);
	});

	it.each([
		['[]', 'an array'],
		['["a"]', 'an array of strings'],
		['null', 'null'],
		['"strings"', 'a string'],
		['7', 'a number'],
		['true', 'a boolean'],
	])('answers INVALID_REQUEST for a top-level %s (%s)', async (body, _label) => {
		const reply = await postJson(shared.url, '/v1/validate', body);

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_REQUEST');
	});

	it.each([
		[{}, 'strings missing'],
		[{ strings: null }, 'null strings'],
		[{ strings: 'Event' }, 'a string for strings'],
		[{ strings: { 0: 'Event' } }, 'an object for strings'],
		[{ strings: 5 }, 'a number for strings'],
	])('answers INVALID_REQUEST for %j (%s)', async (body, _label) => {
		const reply = await postJson(shared.url, '/v1/validate', body);

		expect(reply.status).toBe(400);
		expect(reply.json.error.code).toBe('INVALID_REQUEST');
	});

	it('answers UNKNOWN_FIELD for a key other than strings and schema, __proto__ and constructor included', async () => {
		const bodies = [
			'{"strings": [], "queryFormat": "qwen"}',
			'{"strings": [], "queries": []}',
			'{"strings": [], "__proto__": {"strings": ["x"]}}',
			'{"strings": [], "constructor": {"prototype": {}}}',
			'{"__proto__": 1}',
			'{"strings": [], "Strings": []}',
		];
		for (const body of bodies) {
			const reply = await postJson(shared.url, '/v1/validate', body);

			expect(reply.status, body).toBe(400);
			expect(reply.json.error.code, body).toBe('UNKNOWN_FIELD');
			expect(reply.json.error.details.allowed).toEqual(['strings', 'schema']);
		}
		const proto = await postJson(shared.url, '/v1/validate', '{"strings": [], "__proto__": 1}');
		expect(proto.json.error.details.fields).toEqual(['__proto__']);
	});

	it('answers BATCH_TOO_LARGE past MAX_STRINGS, and accepts exactly MAX_STRINGS', async () => {
		await withDaemon({ HED_LSP_MAX_STRINGS: '3' }, async (daemon) => {
			const ok = await postJson(daemon.url, '/v1/validate', { strings: [VALID, VALID, VALID] });
			const tooMany = await postJson(daemon.url, '/v1/validate', { strings: [VALID, VALID, VALID, VALID] });

			expect(ok.status).toBe(200);
			expect(tooMany.status).toBe(400);
			expect(tooMany.json.error.code).toBe('BATCH_TOO_LARGE');
			expect(tooMany.json.error.details).toEqual({ field: 'strings', max: 3 });
		});
	});

	it('answers 405 with Allow for GET and HEAD, and 204 for OPTIONS', async () => {
		const get = await call(shared.url, '/v1/validate');
		const head = await call(shared.url, '/v1/validate', { method: 'HEAD' });
		const options = await call(shared.url, '/v1/validate', { method: 'OPTIONS' });

		expect(get.status).toBe(405);
		expect(get.headers.allow).toBe('POST, OPTIONS');
		expect(get.json.error.code).toBe('METHOD_NOT_ALLOWED');
		expect(head.status).toBe(405);
		expect(head.headers.allow).toBe('POST, OPTIONS');
		expect(options.status).toBe(204);
		expect(options.headers.allow).toBe('POST, OPTIONS');
		expect(options.headers['access-control-allow-origin']).toBe('*');
	});
});

describe('POST /v1/validate body size', () => {
	// A keep-alive client, as a browser or an HTTP library would be. The daemon reads and discards the
	// rest of a refused body instead of closing the socket on unread data, so these clients always
	// get to read the 413. A client that sends `Connection: close` while still writing a large body
	// can see a reset, as with any Node HTTP server, so these cases do not use one.
	let agent: http.Agent;
	beforeAll(() => {
		agent = new http.Agent({ keepAlive: true });
	});
	afterAll(() => {
		agent.destroy();
	});

	const JSON_TYPE = { 'Content-Type': 'application/json' };

	/** A JSON body of exactly `bytes` bytes holding one string. */
	function bodyOfSize(bytes: number): string {
		const overhead = '{"strings":[""]}'.length;
		return `{"strings":["${'a'.repeat(bytes - overhead)}"]}`;
	}

	/**
	 * POST a chunked body of `pieces` pieces of `bytes` bytes each, pausing between them, so the
	 * daemon sees the body arrive over time as it does from a client that keeps sending even after
	 * the 413 has come back. It uses the keep-alive agent, because a client that asks for the
	 * connection to close is closed on after the 413 whatever it is still sending. Resolves with the
	 * status of the response once all the pieces have been sent, or with 'reset' when the connection
	 * was cut before a response arrived.
	 */
	function trickle(base: string, path: string, pieces: number, bytes: number): Promise<number | 'reset'> {
		return new Promise((resolve) => {
			let status: number | undefined;
			let broken = false;
			const req = http.request(
				`${base}${path}`,
				{ method: 'POST', headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' }, agent },
				(res) => {
					status = res.statusCode;
					res.resume();
				},
			);
			req.on('error', () => {
				broken = true;
			});
			void (async () => {
				for (let piece = 0; piece < pieces && !broken; piece++) {
					req.write('a'.repeat(bytes));
					await new Promise((pause) => setTimeout(pause, 3));
				}
				if (!broken) {
					req.end();
				}
				await new Promise((pause) => setTimeout(pause, 50));
				resolve(status ?? 'reset');
			})();
		});
	}

	it('answers 413 by Content-Length before reading the body', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const reply = await call(daemon.url, '/v1/validate', {
				agent,
				method: 'POST',
				headers: { ...JSON_TYPE, 'Content-Length': '1001' },
				body: bodyOfSize(1001),
			});

			expect(reply.status).toBe(413);
			expect(reply.json.error.code).toBe('PAYLOAD_TOO_LARGE');
			expect(reply.json.error.details).toEqual({ maxBytes: 1000 });
			expect(reply.headers['access-control-allow-origin']).toBe('*');
		});
	});

	it('answers 413 from the declared length alone, without waiting for a body that never comes', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const reply = await call(daemon.url, '/v1/validate', {
				agent,
				method: 'POST',
				headers: { ...JSON_TYPE, 'Content-Length': '1001' },
			});

			expect(reply.status).toBe(413);
		});
	});

	// Explicit limit: the test starts a daemon, sends eight small requests, and closes it. The work takes 4 to 11 ms on an
	// idle host, in a container too, and close waits at most its 2 s grace and 1 s for work to stop. Under act, in a
	// Docker VM close to its memory limit, it once took 6.8 s against the 5 s default and could not be reproduced, so
	// a starved host gets room.
	it('answers 411 LENGTH_REQUIRED for a chunked POST, whatever its size, without reading it', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const small = JSON.stringify({ strings: [VALID] });

			for (const path of ['/v1/validate', '/v1/suggest']) {
				const tiny = await call(daemon.url, path, {
					agent,
					method: 'POST',
					headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' },
					body: [small.slice(0, 5), small.slice(5)],
				});
				const large = await call(daemon.url, path, {
					agent,
					method: 'POST',
					headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' },
					body: Array.from({ length: 5 }, () => 'a'.repeat(300)),
				});

				for (const reply of [tiny, large]) {
					expect(reply.status, path).toBe(411);
					expect(reply.json.error.code).toBe('LENGTH_REQUIRED');
					expect(reply.json.requestId).toBe(reply.headers['x-request-id']);
					expect(reply.headers['access-control-allow-origin']).toBe('*');
				}
			}
			const line = daemon.logLines().find((entry) => entry.msg === 'request' && entry.status === 411);
			expect(line).toMatchObject({ method: 'POST', path: '/v1/validate', error: 'LENGTH_REQUIRED' });
		});
	}, 30_000);

	it('answers 411 for a POST that sends no body and no Content-Length, and accepts Content-Length: 0 as an empty body', async () => {
		const socket = (headers: string): Promise<string> =>
			new Promise((resolve, reject) => {
				const connection = net.connect(Number(new URL(shared.url).port), '127.0.0.1', () => {
					connection.write(`POST /v1/validate HTTP/1.1\r\nHost: localhost\r\n${headers}Connection: close\r\n\r\n`);
				});
				let text = '';
				connection.on('data', (chunk) => {
					text += chunk.toString('latin1');
				});
				connection.on('close', () => resolve(text));
				connection.on('error', reject);
			});

		const missing = await socket('Content-Type: application/json\r\n');
		const empty = await socket('Content-Type: application/json\r\nContent-Length: 0\r\n');

		expect(missing.split('\r\n')[0]).toBe('HTTP/1.1 411 Length Required');
		expect(empty.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
		expect(empty).toContain('INVALID_JSON');
	});

	it('does not ask a GET, an OPTIONS, or a POST to a route that is not POST for a length', async () => {
		const get = await call(shared.url, '/v1/health');
		const options = await call(shared.url, '/v1/validate', { method: 'OPTIONS' });
		const wrongMethod = await call(shared.url, '/v1/schemas', {
			method: 'POST',
			headers: { 'Transfer-Encoding': 'chunked' },
			body: ['x'],
		});
		const missing = await call(shared.url, '/v1/nothing', {
			method: 'POST',
			headers: { 'Transfer-Encoding': 'chunked' },
			body: ['x'],
		});

		expect([get.status, options.status, wrongMethod.status, missing.status]).toEqual([200, 204, 405, 404]);
	});

	it('accepts a body of exactly the limit and refuses one byte more', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const exact = bodyOfSize(1000);
			expect(Buffer.byteLength(exact)).toBe(1000);

			const at = await call(daemon.url, '/v1/validate', { agent, method: 'POST', headers: JSON_TYPE, body: exact });
			const over = await call(daemon.url, '/v1/validate', {
				agent,
				method: 'POST',
				headers: JSON_TYPE,
				body: bodyOfSize(1001),
			});

			expect(at.status).toBe(200);
			expect(over.status).toBe(413);
		});
	});

	it('answers 413 for a body three times the default limit sent in full, within the discard bound', async () => {
		const reply = await call(shared.url, '/v1/validate', {
			agent,
			method: 'POST',
			headers: JSON_TYPE,
			body: bodyOfSize(3 * 524_288),
		});

		expect(reply.status).toBe(413);
		expect(reply.json.error.details).toEqual({ maxBytes: 524288 });
	});

	it('answers 411 for a chunked stream three times the default limit, within the discard bound', async () => {
		const chunk = 'a'.repeat(64 * 1024);

		const reply = await call(shared.url, '/v1/validate', {
			agent,
			method: 'POST',
			headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' },
			body: Array.from({ length: 24 }, () => chunk),
		});

		expect(reply.status).toBe(411);
	});

	it('bounds the discard at four times the body limit, which is 2 MiB by default', () => {
		expect(discardLimitBytes(1000)).toBe(4000);
		expect(discardLimitBytes(shared.config.maxBodyBytes)).toBe(2 * 1024 * 1024);
	});

	it('reads and discards the rest of a refused body, so the same connection serves the next request', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const single = new http.Agent({ keepAlive: true, maxSockets: 1 });
			try {
				const options = { agent: single, method: 'POST', headers: JSON_TYPE };

				const refused = await call(daemon.url, '/v1/validate', { ...options, body: bodyOfSize(3500) });
				const chunked = await call(daemon.url, '/v1/validate', {
					...options,
					headers: { ...JSON_TYPE, 'Transfer-Encoding': 'chunked' },
					body: Array.from({ length: 10 }, () => 'a'.repeat(350)),
				});
				const next = await call(daemon.url, '/v1/validate', { ...options, body: JSON.stringify({ strings: [VALID] }) });

				expect(refused.status).toBe(413);
				expect(chunked.status).toBe(411);
				expect(next.status).toBe(200);
				expect(refused.localPort).toBeDefined();
				expect(chunked.localPort).toBe(refused.localPort);
				expect(next.localPort).toBe(refused.localPort);
			} finally {
				single.destroy();
			}
		});
	});

	it('cuts off a client that keeps sending past the discard bound, logs it, and keeps serving others', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			// Five times the discard bound, sent in pieces over time, with no declared length.
			const pieces = (5 * discardLimitBytes(1000)) / 500;

			// The reset can reach the client before it has read the 411, so the client may see either.
			const flood = await trickle(daemon.url, '/v1/validate', pieces, 500);

			expect([411, 'reset']).toContain(flood);
			await waitFor(
				() => daemon.rawLines.some((line) => line.includes('connection closed because a refused body kept arriving')),
				5000,
				'the cut-off to be logged',
			);
			expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID] })).status).toBe(200);
			expect(daemon.rawLines.filter((line) => line.includes('kept arriving'))).toHaveLength(1);
		});
	});

	it('does not cut off a client whose refused body, sent in pieces, stays within the discard bound', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			// 3500 bytes in all: past the limit of 1000, under the bound of 4000.
			const reply = await trickle(daemon.url, '/v1/validate', 7, 500);

			expect(reply).toBe(411);
			expect(daemon.rawLines.some((line) => line.includes('kept arriving'))).toBe(false);
		});
	});

	it('cuts off by the configured limit: a body that one daemon discards is too much for a stricter one', async () => {
		const body = bodyOfSize(3900);
		const send = (daemon: RunningDaemon): Promise<number | string> =>
			call(daemon.url, '/v1/validate', { agent, method: 'POST', headers: JSON_TYPE, body }).then(
				(reply) => reply.status,
				() => 'reset',
			);

		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (lenient) => {
			// 3900 bytes is under four times 1000, so the body is discarded and the client reads the 413.
			expect(await send(lenient)).toBe(413);
			expect(lenient.rawLines.some((line) => line.includes('kept arriving'))).toBe(false);
		});
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '500' }, async (strict) => {
			// The same body is nearly eight times 500, so this daemon cuts the connection.
			expect([413, 'reset']).toContain(await send(strict));
			await waitFor(
				() => strict.rawLines.some((line) => line.includes('kept arriving')),
				5000,
				'the cut-off to be logged',
			);
		});
	});

	it('does not cut off a client that stays within the discard bound after a refusal', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const reply = await call(daemon.url, '/v1/validate', {
				agent,
				method: 'POST',
				headers: JSON_TYPE,
				body: bodyOfSize(3900),
			});

			expect(reply.status).toBe(413);
			expect(daemon.rawLines.some((line) => line.includes('kept arriving'))).toBe(false);
		});
	});

	it('answers a refusal for a client that closes the connection, once the body is small enough to arrive whole', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const reply = await call(daemon.url, '/v1/validate', {
				method: 'POST',
				headers: JSON_TYPE,
				body: bodyOfSize(1500),
			});

			expect(reply.status).toBe(413);
			expect((await postJson(daemon.url, '/v1/validate', { strings: [VALID] })).status).toBe(200);
		});
	});

	it('answers 415 before 413 for a large body of the wrong type', async () => {
		await withDaemon({ HED_LSP_MAX_BODY_BYTES: '1000' }, async (daemon) => {
			const reply = await call(daemon.url, '/v1/validate', {
				agent,
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: bodyOfSize(5000),
			});

			expect(reply.status).toBe(415);
		});
	});
});

describe('POST /v1/validate logging', () => {
	it('logs the item count and schema of the request and none of its text', async () => {
		await withDaemon({}, async (daemon) => {
			const marker = 'SECRET-string-5d2e';
			const reply = await postJson(daemon.url, '/v1/validate', {
				strings: [`Sensory-event, ${marker}`, VALID, 3],
				schema: BUNDLED,
			});

			const line = daemon
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
			expect(line).toMatchObject({ method: 'POST', path: '/v1/validate', status: 200, items: 3, schema: BUNDLED });
			expect(daemon.rawLines.join('\n')).not.toContain(marker);
			expect(daemon.rawLines.join('\n')).not.toContain('Visual-presentation');
		});
	});

	it('logs the error code of a refused request', async () => {
		await withDaemon({}, async (daemon) => {
			const reply = await postJson(daemon.url, '/v1/validate', { strings: [], extra: 1 });

			const line = daemon
				.logLines()
				.find((entry) => entry.msg === 'request' && entry.requestId === reply.headers['x-request-id']);
			expect(line).toMatchObject({ status: 400, error: 'UNKNOWN_FIELD' });
		});
	});
});
