/**
 * Tests for the engine: the facade's `validate` (explicit schema versions, concurrent calls, and
 * the current version left alone), suggestion option normalization, schema loading, and the
 * logger. Real schemas and real processes; no mocks.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { describe, expect, it } from 'vitest';
import * as engine from '../engine/index.js';
import { log, setLogger } from '../engine/log.js';
import { schemaManager } from '../engine/schemaManager.js';
import { resolveSchemaOption } from '../engine/schemaVersion.js';
import { validateHedString } from '../engine/validation.js';

const samples = [
	'Sensory-event, sc:Modulator',
	'Sensory-event, Visual-presentation, (Red, Square)',
	'Sensory-event, Not-a-real-tag-xyz',
	'Sensory-event, (Red, Square',
	'Sensory-event, Label/{column}',
];

describe('engine.validate', () => {
	it.each(samples)('matches validateHedString on the same schema for %s', async (hed) => {
		const schemas = await schemaManager.getSchema('8.4.0');

		const viaFacade = await engine.validate(hed, { schema: '8.4.0' });
		const direct = await validateHedString(hed, schemas);

		expect(JSON.parse(JSON.stringify(viaFacade))).toEqual(JSON.parse(JSON.stringify(direct)));
	});

	it('returns no issues for a valid string and reports the invalid tag', async () => {
		expect(await engine.validate('Sensory-event, Visual-presentation', { schema: '8.4.0' })).toEqual([]);

		const invalid = await engine.validate('Sensory-event, Not-a-real-tag-xyz', { schema: '8.4.0' });
		expect(invalid.some((issue) => issue.hedCode === 'TAG_INVALID')).toBe(true);
	});

	it('validates each call against the schema it names, concurrently, and keeps the current version', async () => {
		schemaManager.setCurrentVersion('8.4.0');
		const before = schemaManager.getCurrentVersion();
		const hed = 'Sensory-event, sc:Modulator';

		// sc:Modulator is invalid under bare 8.4.0 and valid once SCORE is named, so a call that
		// ignored its schema option would fail here.
		const pending = [
			engine.validate(hed, { schema: '8.4.0' }),
			engine.validate(hed, { schema: '8.4.0,sc:score_2.1.0' }),
			engine.validate(hed, { schema: '8.4.0' }),
			engine.validate(hed, { schema: '8.4.0,sc:score_2.1.0' }),
		];
		expect(schemaManager.getCurrentVersion()).toBe(before);

		const results = (await Promise.all(pending)).map((issues) => issues.map((issue) => issue.hedCode));
		expect(results).toEqual([['TAG_NAMESPACE_PREFIX_INVALID'], [], ['TAG_NAMESPACE_PREFIX_INVALID'], []]);
		expect(schemaManager.getCurrentVersion()).toBe(before);
	});

	it('exposes the public surface', () => {
		expect(typeof engine.validate).toBe('function');
		expect(typeof engine.suggestBatch).toBe('function');
		expect(typeof engine.findSuggestions).toBe('function');
		expect(engine.embeddingsManager).toBeDefined();
		expect(engine.schemaManager).toBe(schemaManager);
	});

	it('treats a blank schema as the default', async () => {
		const hed = 'Sensory-event, sc:Modulator';
		const blank = await engine.validate(hed, { schema: '   ' });

		expect(blank).toEqual(await engine.validate(hed, { schema: engine.DEFAULT_HED_SCHEMA }));
		expect(blank.map((issue) => issue.hedCode)).toEqual(['TAG_NAMESPACE_PREFIX_INVALID']);
	});
});

describe('engine.validate when the validator throws', () => {
	/** `depth` nested pairs of parentheses around a tag. The validator recurses once per level. */
	const nested = (depth: number): string => `${'('.repeat(depth)}Event${')'.repeat(depth)}`;

	it('reports a repeated tag with the validator code and message, not as an internal error', async () => {
		// hed-validator throws an IssueError for a repeated tag, where it returns the issues of most other mistakes.
		const issues = await engine.validate('Sensory-event, Red, Red', { schema: '8.4.0' });

		expect(issues).toHaveLength(1);
		const [issue] = issues;
		expect(issue.hedCode).toBe('TAG_EXPRESSION_REPEATED');
		expect(issue.hedCode).not.toBe('INTERNAL_ERROR');
		expect(issue.internalCode).toBe('duplicateTag');
		expect(issue.level).toBe('error');
		expect(issue.message.startsWith('Validation error:')).toBe(false);
		expect(issue.message).toContain('[TAG_EXPRESSION_REPEATED]');
		expect(issue.message).toContain('Duplicate tags');
	});

	it('reports a repeated tag inside a group the same way', async () => {
		const issues = await engine.validate('Sensory-event, (Red, Red)', { schema: '8.4.0' });

		expect(issues.map((issue) => issue.hedCode)).toEqual(['TAG_EXPRESSION_REPEATED']);
	});

	it('returns no issues for the same string without the repeat', async () => {
		expect(await engine.validate('Sensory-event, Red', { schema: '8.4.0' })).toEqual([]);
	});

	it('still reports an exception that is not a validator issue as an internal error', async () => {
		// The validator recurses once per level of nesting and runs out of stack on a string this deep.
		const issues = await engine.validate(nested(4000), { schema: '8.4.0' });

		expect(issues).toHaveLength(1);
		const [issue] = issues;
		expect(issue.hedCode).toBe('INTERNAL_ERROR');
		expect(issue.internalCode).toBe('internalError');
		expect(issue.level).toBe('error');
		expect(issue.message).toMatch(/^Validation error: .*call stack/);
	});
});

describe('suggestion options', () => {
	it('treats undefined, null, and blank options as absent', async () => {
		const queries = ['red square', 'modulator'];
		const omitted = await engine.suggestBatch(queries, {});
		const undefinedValues = await engine.suggestBatch(queries, {
			schema: undefined,
			top: undefined,
			semantic: undefined,
		});
		// JSON clients send null, not undefined, for a field they leave out. A blank schema must resolve
		// to the default, which has no SCORE tags; the current schema has them, so 'modulator' tells them apart.
		const jsonNulls = await engine.suggestBatch(queries, JSON.parse('{"schema":"  ","top":null,"semantic":null}'));

		expect(omitted.modulator).toEqual([]);
		expect(undefinedValues).toEqual(omitted);
		expect(jsonNulls).toEqual(omitted);
	});

	it('returns schema-stage tags for the default options', async () => {
		const omitted = await engine.suggestBatch(['red square'], {});

		expect(omitted['red square']).toContain('Red-color');
	});

	it('accepts a schema given as an array of parts', async () => {
		const parts = await engine.suggestBatch(['modulator'], JSON.parse('{"schema":["8.4.0","sc:score_2.1.0"]}'));

		expect(parts.modulator).toContain('sc:Modulator');
	});

	it('accepts null options as absent', async () => {
		const omitted = await engine.suggestBatch(['red square'], {});

		expect(await engine.suggestBatch(['red square'], null)).toEqual(omitted);
	});
});

describe('schema option resolution', () => {
	it('joins arrays, and uses the fallback for missing, blank, and non-string values', () => {
		expect(resolveSchemaOption(['8.4.0', 'sc:score_2.1.0'], 'fallback')).toBe('8.4.0,sc:score_2.1.0');
		expect(resolveSchemaOption(' 8.4.0 ', 'fallback')).toBe('8.4.0');
		expect(resolveSchemaOption('   ', 'fallback')).toBe('fallback');
		expect(resolveSchemaOption(undefined, 'fallback')).toBe('fallback');
		expect(resolveSchemaOption(null, 'fallback')).toBe('fallback');
		expect(resolveSchemaOption(7, 'fallback')).toBe('fallback');
	});
});

describe('engine logging', () => {
	it('keeps stdout free of engine log lines', () => {
		const built = path.join(__dirname, '..', '..', 'out', 'engine', 'embeddings.js');
		if (!existsSync(built)) {
			throw new Error(`${built} is missing; run "bun run compile" before this test`);
		}
		const script = `require(${JSON.stringify(built)}).embeddingsManager.loadEmbeddings();`;

		const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 120000 });

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('[HED Embeddings] Loaded');
	}, 150000);

	it('formats each message once, so a percent sign in a path survives', () => {
		const seen: string[] = [];
		const previous = setLogger({
			info: (message) => seen.push(message),
			error: (message) => seen.push(message),
		});
		try {
			const cause = new Error('boom');
			log.error('Failed to parse /data/100%data/x:', cause);

			expect(seen).toEqual([`Failed to parse /data/100%data/x: ${util.inspect(cause)}`]);
		} finally {
			setLogger(previous);
		}
	});

	it('writes a path with a percent sign to stderr intact', () => {
		const built = path.join(__dirname, '..', '..', 'out', 'engine', 'log.js');
		const script = `require(${JSON.stringify(built)}).log.error('Failed to parse /data/100%data/x:', 'detail');`;

		const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 30000 });

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('Failed to parse /data/100%data/x: detail\n');
	});
});

describe('schema loading', () => {
	it('loads a cold version once for concurrent callers', async () => {
		schemaManager.clearCache();
		const loads: string[] = [];
		const previous = setLogger({
			info: () => {},
			error: (...args) => {
				if (String(args[0]).startsWith('[HED] Loading schema')) {
					loads.push(String(args[0]));
				}
			},
		});
		try {
			await Promise.all([1, 2, 3, 4].map(() => schemaManager.getSchema('8.3.0')));
		} finally {
			setLogger(previous);
		}

		expect(loads).toEqual(['[HED] Loading schema: 8.3.0']);
	});

	it('does not keep a failed load, so a later call tries again', async () => {
		const loads: string[] = [];
		const previous = setLogger({
			info: () => {},
			error: (...args) => {
				if (String(args[0]).startsWith('[HED] Loading schema')) {
					loads.push(String(args[0]));
				}
			},
		});
		try {
			await expect(schemaManager.getSchema('9.9.9')).rejects.toThrow();
			await expect(schemaManager.getSchema('9.9.9')).rejects.toThrow();
		} finally {
			setLogger(previous);
		}

		expect(loads).toEqual(['[HED] Loading schema: 9.9.9', '[HED] Loading schema: 9.9.9']);
	});
});

describe('engine.schemaVersionUsed', () => {
	// Real loads. The bundled 8.4.0 fallback for 8.5.0 is checked by the container smoke test with
	// the network off, because forcing it here would need a fake network.
	it('returns the requested version for a standard schema', async () => {
		expect(await engine.schemaVersionUsed('8.4.0')).toBe('8.4.0');
	});

	it('returns the requested version for a standard schema with partnered libraries', async () => {
		const spec = '8.4.0,sc:score_2.1.0,la:lang_1.1.0';

		expect(await engine.schemaVersionUsed(spec)).toBe(spec);
	});

	it('accepts a schema given as an array of parts', async () => {
		expect(await engine.schemaVersionUsed(['8.4.0', 'sc:score_2.1.0'])).toBe('8.4.0,sc:score_2.1.0');
	});

	it('reports the default, or the bundled fallback when the default cannot load, for a blank spec', async () => {
		const used = await engine.schemaVersionUsed('   ');

		expect([engine.DEFAULT_HED_SCHEMA, engine.FALLBACK_HED_SCHEMA]).toContain(used);
		expect(used).toBe(await engine.schemaVersionUsed(engine.DEFAULT_HED_SCHEMA));
	});

	it('rejects a version that cannot be loaded', async () => {
		const previous = setLogger({ info: () => {}, error: () => {} });
		try {
			await expect(engine.schemaVersionUsed('9.9.9')).rejects.toThrow();
		} finally {
			setLogger(previous);
		}
	});
});

describe('engine logging surface', () => {
	it('re-exports the logger hook and the sink type from the facade', () => {
		const lines: string[] = [];
		const sink: engine.LogSink = { info: (message) => lines.push(message), error: (message) => lines.push(message) };

		expect(engine.setLogger).toBe(setLogger);
		const previous = engine.setLogger(sink);
		try {
			log.info('facade', 'sink');
		} finally {
			engine.setLogger(previous);
		}

		expect(lines).toEqual(['facade sink']);
	});
});
