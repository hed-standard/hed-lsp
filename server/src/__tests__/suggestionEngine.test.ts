/**
 * Tests for the shared suggestion engine that backs both the
 * `hed-suggest` CLI and the `hed/suggest` LSP request handler.
 *
 * Uses real HED schema loading via schemaManager; no mocks.
 */

import { describe, expect, it } from 'vitest';
import { embeddingsManager } from '../engine/embeddings.js';
import { setLogger } from '../engine/log.js';
import { schemaManager } from '../engine/schemaManager.js';
import { DEFAULT_HED_SCHEMA } from '../engine/schemaVersion.js';
import { findSuggestions, suggestBatch } from '../engine/suggestionEngine.js';

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

describe('suggestBatch result contract', () => {
	// The map shape is what `hed-suggest --json` prints and what `hed/suggest` returns. Schema 8.4.0 is
	// bundled with hed-validator, so these checks run offline.
	const opts = { schema: '8.4.0', top: 5 };

	it('keys the result by query in input order, with each value equal to findSuggestions', async () => {
		const queries = ['walk', 'red square', 'button press', 'house'];

		const output = await suggestBatch(queries, opts);

		expect(Object.keys(output)).toEqual(queries);
		expect(output).toEqual({
			walk: ['Walk', 'Ambulate', 'Move'],
			'red square': ['Square', 'Rectangle', '2D-shape', 'Red-color', 'Red'],
			'button press': ['Button', 'Response-button', 'Mouse-button', 'Press', 'Push'],
			house: ['Building', 'Residence', 'Structure'],
		});
		for (const query of queries) {
			expect(output[query]).toEqual((await findSuggestions(query, opts)).suggestions);
		}
	});

	it('collapses duplicate queries to one key at the first position', async () => {
		const output = await suggestBatch(['red', 'walk', 'red'], opts);

		expect(Object.keys(output)).toEqual(['red', 'walk']);
		expect(output.red).toEqual(['Red-color', 'Red', 'Predict', 'Manufactured-material', 'Tired']);
	});

	it('keeps __proto__ and constructor as own keys with their values', async () => {
		const output = await suggestBatch(['__proto__', 'constructor', 'walk'], opts);

		expect(Object.keys(output)).toEqual(['__proto__', 'constructor', 'walk']);
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
		expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toEqual([]);
		expect(Object.getOwnPropertyDescriptor(output, 'constructor')?.value).toEqual([]);
		expect(output.walk).toEqual(['Walk', 'Ambulate', 'Move']);
	});

	it('honors top', async () => {
		const query = 'button press';
		const full = ['Button', 'Response-button', 'Mouse-button', 'Press', 'Push', 'Press-foot', 'Push-button'];

		expect((await suggestBatch([query], { schema: '8.4.0', top: 1 }))[query]).toEqual(full.slice(0, 1));
		expect((await suggestBatch([query], { schema: '8.4.0', top: 3 }))[query]).toEqual(full.slice(0, 3));
		expect((await suggestBatch([query], { schema: '8.4.0', top: 10 }))[query]).toEqual(full);
	});

	it('uses the default schema for a blank schema, not the schema manager current version', async () => {
		const previous = schemaManager.getCurrentVersion();
		// The current version names SCORE, so a blank schema that fell through to it would find sc:Modulator.
		schemaManager.setCurrentVersion('8.4.0,sc:score_2.1.0');
		try {
			const blank = await suggestBatch(['modulator'], { schema: '   ' });

			expect(blank).toEqual({ modulator: [] });
			expect(blank).toEqual(await suggestBatch(['modulator'], { schema: DEFAULT_HED_SCHEMA }));
			expect((await suggestBatch(['modulator'], { schema: '8.4.0,sc:score_2.1.0' })).modulator).toContain(
				'sc:Modulator',
			);
		} finally {
			schemaManager.setCurrentVersion(previous);
		}
	});

	it('never loads the model when semantic is false', async () => {
		const lines: string[] = [];
		const previousSink = setLogger({ info: (message) => lines.push(message), error: (message) => lines.push(message) });
		// An enabled manager must still stay idle: the semantic option, not the manager flag, decides.
		embeddingsManager.setEnabled(true);
		try {
			await suggestBatch(['red square', 'xyzzy nonsense'], { ...opts, semantic: false });
		} finally {
			embeddingsManager.setEnabled(false);
			setLogger(previousSink);
		}

		expect(embeddingsManager.isModelLoaded()).toBe(false);
		expect(embeddingsManager.size()).toBe(0);
		expect(lines.filter((line) => line.startsWith('[HED Embeddings]'))).toEqual([]);
	});
});

describe('suggestBatch with a failing query', () => {
	const schema = '8.4.0,sc:score_2.1.0';

	it('keeps the other queries and omits the one that failed', async () => {
		const lines: string[] = [];
		const previousSink = setLogger({ info: (message) => lines.push(message), error: (message) => lines.push(message) });
		let output: Record<string, string[]>;
		try {
			// A number is not a valid query; JSON clients can send one.
			output = await suggestBatch(['red square', 42, 'modulator'] as unknown as string[], { schema, top: 5 });
		} finally {
			setLogger(previousSink);
		}

		expect(Object.keys(output)).toEqual(['red square', 'modulator']);
		expect(output['red square']).toContain('Red');
		expect(output.modulator).toContain('sc:Modulator');
		// The line names the failing query by its position and the error by its type, not its message.
		expect(lines.filter((line) => line.includes('Suggestions failed'))).toEqual([
			'[HED] Suggestions failed for query 2 of 3: TypeError',
		]);
	});
	it('still rejects when the schema cannot be loaded', async () => {
		// The engine logs the failed load to stderr; keep that out of the test output.
		const previousSink = setLogger({ info: () => {}, error: () => {} });
		try {
			await expect(suggestBatch(['red square'], { schema: '9.9.9' })).rejects.toThrow();
		} finally {
			setLogger(previousSink);
		}
	});
});

describe('engine log lines', () => {
	it('logs the type of a failed schema search and not its message, which quotes the schema and the network', async () => {
		const lines: string[] = [];
		const previousSink = setLogger({ info: (message) => lines.push(message), error: (message) => lines.push(message) });
		let result: Awaited<ReturnType<typeof findSuggestions>>;
		try {
			// The library 9.9.9 does not exist, so its load fails for real, online with a 404 and offline with
			// a network error, and the schema search that needs it fails with an error whose message is long.
			result = await findSuggestions('red square', { schema: '8.4.0,sc:score_9.9.9', top: 10 });
		} finally {
			setLogger(previousSink);
		}

		expect(result.suggestions.length).toBeGreaterThan(0);
		const warnings = lines.filter((line) => line.startsWith('Warning: Schema search failed'));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/^Warning: Schema search failed: \w+$/);
		expect(warnings[0]).not.toContain('9.9.9');
		expect(warnings[0]).not.toContain('SCHEMA_LOAD_FAILED');
	});
});
