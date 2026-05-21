/**
 * HED tag suggestion engine.
 *
 * Shared between the CLI (`hed-suggest`) and the LSP server's
 * `hed/suggest` JSON-RPC request handler. Centralizes keyword-mapping,
 * schema-substring, and semantic-embedding cascades so callers don't
 * have to re-implement the order or re-load the schema per query.
 */

import { embeddingsManager } from './embeddings.js';
import { schemaManager } from './schemaManager.js';
import { SEMANTIC_MAPPINGS } from './semanticMappings.js';

export interface SuggestionOptions {
	schema: string;
	top: number;
	semantic: boolean;
}

export interface SuggestionResult {
	query: string;
	suggestions: string[];
	source: 'keyword' | 'schema' | 'semantic';
}

const DEFAULT_OPTIONS: SuggestionOptions = {
	schema: '8.4.0',
	top: 10,
	semantic: false,
};

/**
 * Find suggestions for a single query using the cascade:
 *   1. keyword mappings (exact word match in SEMANTIC_MAPPINGS),
 *   2. schema substring search,
 *   3. semantic embedding similarity (only if `semantic` is true and the
 *      model is loaded).
 *
 * The caller is responsible for loading the schema and warming the
 * embedding model. For multi-query workloads prefer `suggestBatch` which
 * does both once per batch.
 */
export async function findSuggestions(
	query: string,
	options: Partial<SuggestionOptions> = {},
): Promise<SuggestionResult> {
	const opts: SuggestionOptions = { ...DEFAULT_OPTIONS, ...options };
	const normalizedQuery = query.toLowerCase().trim();
	const suggestions: string[] = [];
	let source: 'keyword' | 'schema' | 'semantic' = 'schema';

	const words = normalizedQuery.split(/\s+/);
	for (const word of words) {
		if (SEMANTIC_MAPPINGS[word]) {
			suggestions.push(...SEMANTIC_MAPPINGS[word]);
			source = 'keyword';
		}
	}

	if (suggestions.length < opts.top) {
		try {
			const schemaTags = await schemaManager.searchTagsContaining(normalizedQuery, opts.schema);
			for (const tag of schemaTags) {
				if (!suggestions.includes(tag.shortForm)) {
					suggestions.push(tag.shortForm);
				}
			}
		} catch (error) {
			console.error(`Warning: Schema search failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	if (opts.semantic && suggestions.length < opts.top) {
		try {
			if (embeddingsManager.isAvailable()) {
				const semanticResults = await embeddingsManager.findSimilar(normalizedQuery, opts.top);
				for (const result of semanticResults) {
					if (!suggestions.includes(result.tag)) {
						suggestions.push(result.tag);
						source = 'semantic';
					}
				}
			}
		} catch (error) {
			console.error(`Warning: Semantic search failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	return {
		query,
		suggestions: [...new Set(suggestions)].slice(0, opts.top),
		source,
	};
}

/**
 * Run `findSuggestions` over a list of queries, loading the schema and
 * (when requested) initializing the embedding model once for the whole
 * batch. Returns a `{ query: [suggestion, ...] }` map matching the JSON
 * shape that `hed-suggest --json` emits today.
 */
export async function suggestBatch(
	queries: string[],
	options: Partial<SuggestionOptions> = {},
): Promise<Record<string, string[]>> {
	const opts: SuggestionOptions = { ...DEFAULT_OPTIONS, ...options };

	if (queries.length === 0) {
		return {};
	}

	await schemaManager.getSchema(opts.schema);

	if (opts.semantic) {
		embeddingsManager.setEnabled(true);
		await embeddingsManager.initializeModel();
	}

	const output: Record<string, string[]> = {};
	for (const query of queries) {
		const result = await findSuggestions(query, opts);
		output[query] = result.suggestions;
	}
	return output;
}
