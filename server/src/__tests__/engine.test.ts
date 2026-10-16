/**
 * Tests for the engine facade: `validate` returns the same issues as the lower-level
 * validator for the same schema, and it never changes the schema manager's current version.
 * Real schema and real validator; no mocks.
 */

import { describe, expect, it } from 'vitest';
import * as engine from '../engine/index.js';
import { schemaManager } from '../engine/schemaManager.js';
import { validateHedString } from '../engine/validation.js';

const samples = [
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

	it('does not change the schema manager current version', async () => {
		schemaManager.setCurrentVersion('8.4.0');
		const before = schemaManager.getCurrentVersion();

		await engine.validate('Sensory-event', { schema: '8.5.0' });

		expect(schemaManager.getCurrentVersion()).toBe(before);
	});

	it('exposes the public surface', () => {
		expect(typeof engine.validate).toBe('function');
		expect(typeof engine.suggestBatch).toBe('function');
		expect(typeof engine.findSuggestions).toBe('function');
		expect(engine.embeddingsManager).toBeDefined();
		expect(engine.schemaManager).toBe(schemaManager);
	});
});
