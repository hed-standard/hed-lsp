/**
 * HED tag suggestion engine.
 *
 * Shared between the CLI (`hed-suggest`) and the LSP server's
 * `hed/suggest` JSON-RPC request handler. Centralizes keyword-mapping,
 * schema-substring, and semantic-embedding cascades so callers don't
 * have to re-implement the order or re-load the schema per query.
 */

import type { QueryFormat } from './embeddingConfig.js';
import { embeddingsManager } from './embeddings.js';
import { lookupOwn } from './keywordLookup.js';
import { log } from './log.js';
import { schemaManager } from './schemaManager.js';
import { DEFAULT_HED_SCHEMA, resolveSchemaOption } from './schemaVersion.js';
import { SEMANTIC_MAPPINGS } from './semanticMappings.js';

export interface SuggestionOptions {
	schema: string;
	top: number;
	semantic: boolean;
	/** How the query is wrapped before embedding; defaults to the raw query. */
	queryFormat?: QueryFormat;
}

/**
 * What the semantic step did for one query. `ran`: the step was attempted and every embedding it
 * needed was computed. `skipped`: the caller did not ask for it, or the keyword and schema steps
 * already filled `top`. `failed`: the caller asked for it and it was needed, but it did not run to
 * completion, because the embeddings are not available or an embedding could not be computed. The
 * step never throws, so this is how a caller learns that a missing semantic result is a failure and
 * not an empty answer.
 */
export type SemanticStep = 'ran' | 'skipped' | 'failed';

export interface SuggestionResult {
	query: string;
	suggestions: string[];
	source: 'keyword' | 'schema' | 'semantic';
	/** Whether the semantic step ran, was skipped, or failed. */
	semanticStep: SemanticStep;
}

const DEFAULT_OPTIONS: SuggestionOptions = {
	schema: DEFAULT_HED_SCHEMA,
	top: 10,
	semantic: false,
};

/**
 * Merge caller options over the defaults. Every option the caller passes is kept, so a field added
 * to SuggestionOptions later is not dropped. An undefined or null field counts as absent, and so
 * does a blank schema; JSON clients may send null for a field they omit.
 */
function withDefaults(options: Partial<SuggestionOptions> | null | undefined): SuggestionOptions {
	const given = options ?? {};
	return {
		...DEFAULT_OPTIONS,
		...given,
		schema: resolveSchemaOption(given.schema, DEFAULT_OPTIONS.schema),
		top: given.top ?? DEFAULT_OPTIONS.top,
		semantic: given.semantic ?? DEFAULT_OPTIONS.semantic,
		queryFormat: given.queryFormat ?? undefined,
	};
}

/**
 * Find suggestions for a single query using the cascade:
 *   1. keyword mappings (exact word match in SEMANTIC_MAPPINGS),
 *   2. schema substring search,
 *   3. semantic embedding similarity (only if `semantic` is true and the
 *      model is loaded).
 *
 * The caller is responsible for loading the schema and warming the
 * embedding model. For multi-query workloads prefer `suggestBatch` which
 * does both once per batch. The result's `semanticStep` says whether the
 * semantic step ran, was skipped, or failed.
 */
export async function findSuggestions(
	query: string,
	options: Partial<SuggestionOptions> | null = {},
): Promise<SuggestionResult> {
	const opts = withDefaults(options);
	const normalizedQuery = query.toLowerCase().trim();
	const suggestions: string[] = [];
	let source: 'keyword' | 'schema' | 'semantic' = 'schema';

	const words = normalizedQuery.split(/\s+/);
	for (const word of words) {
		const mapped = lookupOwn(SEMANTIC_MAPPINGS, word);
		if (mapped) {
			suggestions.push(...mapped);
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
			log.error(`Warning: Schema search failed: ${error instanceof Error ? error.name : typeof error}`);
		}
	}

	let semanticStep: SemanticStep = 'skipped';
	if (opts.semantic && suggestions.length < opts.top) {
		// Needed and asked for: it stays failed unless the step runs to completion.
		semanticStep = 'failed';
		try {
			if (embeddingsManager.isAvailable()) {
				// findSimilar reports a failed embedding by returning no matches, which looks like an empty
				// answer, so a rise in the manager's failure count across the call is how a failure is told
				// apart. A failure of another semantic call running at the same time is counted here too, so a
				// caller that needs exact attribution runs one semantic call at a time, as the daemon does
				// by default.
				const failuresBefore = embeddingsManager.embedFailureCount();
				const semanticResults = await embeddingsManager.findSimilar(normalizedQuery, opts.top, opts.queryFormat);
				for (const result of semanticResults) {
					if (!suggestions.includes(result.tag)) {
						suggestions.push(result.tag);
						source = 'semantic';
					}
				}
				if (embeddingsManager.embedFailureCount() === failuresBefore) {
					semanticStep = 'ran';
				}
			}
		} catch (error) {
			log.error(`Warning: Semantic search failed: ${error instanceof Error ? error.name : typeof error}`);
		}
	}

	return {
		query,
		suggestions: [...new Set(suggestions)].slice(0, opts.top),
		source,
		semanticStep,
	};
}

/**
 * Run `findSuggestions` over a list of queries, loading the schema and
 * (when requested) initializing the embedding model once for the whole
 * batch. Returns a `{ query: [suggestion, ...] }` map matching the JSON
 * shape that `hed-suggest --json` emits today.
 *
 * A query that fails is logged and left out of the map, so the other queries still return: an
 * absent key means the query failed, and an empty list means it found no matches. A failure that
 * affects the whole request, such as a schema that cannot be loaded, still rejects.
 */
export async function suggestBatch(
	queries: string[],
	options: Partial<SuggestionOptions> | null = {},
): Promise<Record<string, string[]>> {
	const opts = withDefaults(options);

	if (queries.length === 0) {
		return {};
	}

	await schemaManager.getSchema(opts.schema);

	if (opts.semantic) {
		embeddingsManager.setEnabled(true);
		await embeddingsManager.initializeModel();
	}

	const entries: [string, string[]][] = [];
	for (const [index, query] of queries.entries()) {
		try {
			const result = await findSuggestions(query, opts);
			entries.push([query, result.suggestions]);
		} catch (error) {
			// The position identifies the failing query, so the log line does not repeat the query text.
			log.error(
				`[HED] Suggestions failed for query ${index + 1} of ${queries.length}: ${error instanceof Error ? error.name : typeof error}`,
			);
		}
	}
	// Object.fromEntries defines own properties, so a query named `__proto__` stays a key.
	return Object.fromEntries(entries);
}
