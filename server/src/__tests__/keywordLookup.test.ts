/**
 * Regression tests for keyword lookups with prototype-named queries.
 *
 * Plain-object lookups such as `MAP[word]` return inherited members for
 * names like `constructor` or `__proto__`. These tests run the real suggestion
 * engine and embeddings manager; no mocks.
 */

import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { provideCompletions } from '../completion.js';
import { embeddingsManager } from '../embeddings.js';
import { findSuggestions, suggestBatch } from '../suggestionEngine.js';

const PROTOTYPE_NAMED_QUERIES = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];

describe('findSuggestions with prototype-named queries', () => {
	it.each(PROTOTYPE_NAMED_QUERIES)('returns an array of suggestions for %s', async (query) => {
		const result = await findSuggestions(query, { schema: '8.4.0', top: 10 });

		expect(result.query).toBe(query);
		expect(Array.isArray(result.suggestions)).toBe(true);
	});
});

describe('suggestBatch with prototype-named queries', () => {
	it.each(PROTOTYPE_NAMED_QUERIES)('keeps an own key for %s', async (query) => {
		const output = await suggestBatch([query], { schema: '8.4.0', top: 10 });

		expect(Object.hasOwn(output, query)).toBe(true);
		expect(Array.isArray(output[query])).toBe(true);
	});

	it('keeps every prototype-named query through a JSON round trip', async () => {
		const output = await suggestBatch(PROTOTYPE_NAMED_QUERIES, { schema: '8.4.0', top: 5 });
		const roundTripped = JSON.parse(JSON.stringify(output));

		expect(Object.keys(roundTripped).sort()).toEqual([...PROTOTYPE_NAMED_QUERIES].sort());
	});
});

describe('embeddingsManager.findByKeyword with prototype-named queries', () => {
	it.each(PROTOTYPE_NAMED_QUERIES)('returns no keyword matches for %s', (query) => {
		expect(embeddingsManager.findByKeyword(query)).toEqual([]);
	});
});

describe('provideCompletions with prototype-named HED values', () => {
	it.each(PROTOTYPE_NAMED_QUERIES)('completes a sidecar value of %s without throwing', async (word) => {
		const text = `{\n\t"event": {\n\t\t"HED": "${word}"\n\t}\n}`;
		const document = TextDocument.create('file:///keyword-lookup/events.json', 'json', 1, text);
		const line = 2;
		const character = text.split('\n')[line].indexOf(word) + word.length;

		const items = await provideCompletions(document, { line, character });

		expect(Array.isArray(items)).toBe(true);
	});
});
