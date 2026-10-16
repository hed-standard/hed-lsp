/**
 * Tests for the engine facade: `validate` returns the same issues as the lower-level
 * validator for the same schema, and it never changes the schema manager's current version.
 * Real schema and real validator; no mocks.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as engine from '../engine/index.js';
import { log, setLogger } from '../engine/log.js';
import { schemaManager } from '../engine/schemaManager.js';
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

describe('suggestion options', () => {
	it('treats undefined, null, and blank options as absent', async () => {
		const omitted = await engine.suggestBatch(['red square'], {});
		const undefinedValues = await engine.suggestBatch(['red square'], {
			schema: undefined,
			top: undefined,
			semantic: undefined,
		});
		// JSON clients send null, not undefined, for a field they leave out.
		const jsonNulls = await engine.suggestBatch(['red square'], JSON.parse('{"schema":"","top":null,"semantic":null}'));

		expect(undefinedValues).toEqual(omitted);
		expect(jsonNulls).toEqual(omitted);
	});

	it('returns schema-stage tags for the default options', async () => {
		const omitted = await engine.suggestBatch(['red square'], {});

		expect(omitted['red square']).toContain('Red-color');
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

	it('passes log arguments to the sink unchanged', () => {
		const seen: unknown[][] = [];
		const previous = setLogger({
			info: (...args) => seen.push(args),
			error: (...args) => seen.push(args),
		});
		try {
			const cause = new Error('boom');
			log.error('Failed to parse /d/set%d0/x:', cause);

			expect(seen).toHaveLength(1);
			expect(seen[0][0]).toBe('Failed to parse /d/set%d0/x:');
			expect(seen[0][1]).toBe(cause);
		} finally {
			setLogger(previous);
		}
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
