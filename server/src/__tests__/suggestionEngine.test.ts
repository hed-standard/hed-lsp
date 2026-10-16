/**
 * Tests for the shared suggestion engine that backs both the
 * `hed-suggest` CLI and the `hed/suggest` LSP request handler.
 *
 * Uses real HED schema loading via schemaManager; no mocks.
 */

import { describe, expect, it } from 'vitest';
import { findSuggestions, suggestBatch } from '../suggestionEngine.js';

describe('findSuggestions', () => {
	it('returns a non-empty list for a canonical color query', async () => {
		const result = await findSuggestions('red square', { schema: '8.5.0', top: 10 });

		expect(result.query).toBe('red square');
		expect(result.suggestions.length).toBeGreaterThan(0);
		expect(result.suggestions).toContain('Red');
	});

	it('respects the top option', async () => {
		const result = await findSuggestions('button', { schema: '8.5.0', top: 3 });

		expect(result.suggestions.length).toBeLessThanOrEqual(3);
	});

	it('returns deduplicated suggestions', async () => {
		const result = await findSuggestions('red square', { schema: '8.5.0', top: 20 });

		const unique = new Set(result.suggestions);
		expect(unique.size).toBe(result.suggestions.length);
	});
});

describe('suggestBatch', () => {
	it('returns a map keyed by each query', async () => {
		const output = await suggestBatch(['red square', 'button press'], {
			schema: '8.5.0',
			top: 5,
		});

		expect(Object.keys(output).sort()).toEqual(['button press', 'red square']);
		expect(output['red square']).toContain('Red');
		expect(output['button press'].length).toBeGreaterThan(0);
	});

	it('returns an empty object for an empty query list', async () => {
		const output = await suggestBatch([], { schema: '8.5.0' });
		expect(output).toEqual({});
	});

	it('produces the same shape as the CLI --json output', async () => {
		const output = await suggestBatch(['red'], { schema: '8.5.0', top: 5 });

		expect(typeof output).toBe('object');
		expect(Array.isArray(output.red)).toBe(true);
		for (const tag of output.red) {
			expect(typeof tag).toBe('string');
			expect(tag.length).toBeGreaterThan(0);
		}
	});
});

describe('characterization of suggestion output', () => {
	// Frozen from the CLI output of unmodified code before the keyword-lookup changes.
	const expected: [string, string[]][] = [
		['red square', ['Square', 'Rectangle', '2D-shape', 'Red-color', 'Red', 'RGB-red', 'RGB-red-#']],
		['button press', ['Button', 'Response-button', 'Mouse-button', 'Press', 'Push', 'Press-foot', 'Push-button']],
		['visual flash', ['Flash', 'Flickering', 'Visual-presentation', 'Visual-attribute']],
		['house', ['Building', 'Residence', 'Structure']],
		['walk', ['Walk', 'Ambulate', 'Move']],
		['run', ['Run', 'Move-quickly', 'Runway']],
		['click', ['Press', 'Click', 'Mouse-button-press']],
		['stop', ['Offset', 'Stop', 'Termination', 'Stop-signal']],
		['xyzzy nonsense', []],
		[
			'red',
			[
				'Red-color',
				'Red',
				'Predict',
				'Manufactured-material',
				'Tired',
				'Computed-prediction',
				'Disordered',
				'Ordered',
				'Leaf-covered-terrain',
				'OrangeRed',
			],
		],
		['block', ['Block', 'Experimental-block', 'Textblock', 'Time-block', 'Time-block-#']],
		['monitor', ['Screen', 'Computer-screen', 'Display']],
		[
			'stimulus response',
			['Stimulus', 'Experimental-stimulus', 'Sensory-event', 'Response', 'Participant-response', 'Task-stimulus-role'],
		],
	];

	it.each(expected)('keeps the suggestions for %s', async (query, tags) => {
		const output = await suggestBatch([query], { schema: '8.5.0', top: 10 });
		expect(output[query]).toEqual(tags);
	});
});
