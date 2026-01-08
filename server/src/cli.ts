#!/usr/bin/env node
/**
 * HED Tag Suggestion CLI
 * Provides tag suggestions for external tools like OSA.
 *
 * Usage:
 *   hed-suggest "button press"
 *   hed-suggest --json "button press" "visual flash"
 *   hed-suggest --schema 8.4.0 --top 5 "response"
 */

import { schemaManager } from './schemaManager.js';
import { embeddingsManager } from './embeddings.js';
import { SEMANTIC_MAPPINGS } from './semanticMappings.js';

interface CliOptions {
	json: boolean;
	schema: string;
	top: number;
	semantic: boolean;
	help: boolean;
}

interface SuggestionResult {
	query: string;
	suggestions: string[];
	source: 'keyword' | 'schema' | 'semantic';
}

function parseArgs(args: string[]): { options: CliOptions; queries: string[] } {
	const options: CliOptions = {
		json: false,
		schema: '8.4.0',
		top: 10,
		semantic: false,
		help: false,
	};
	const queries: string[] = [];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === '--json' || arg === '-j') {
			options.json = true;
		} else if (arg === '--schema' || arg === '-s') {
			// Check bounds before reading value
			if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
				i++;
				options.schema = args[i];
			} else {
				console.error('Warning: --schema requires a version argument, using default 8.4.0');
			}
		} else if (arg === '--top' || arg === '-n') {
			// Check bounds before reading value
			if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
				i++;
				const val = parseInt(args[i], 10);
				options.top = !isNaN(val) && val > 0 ? val : 10;
			} else {
				console.error('Warning: --top requires a number argument, using default 10');
			}
		} else if (arg === '--semantic') {
			options.semantic = true;
		} else if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (!arg.startsWith('-')) {
			queries.push(arg);
		}
		i++;
	}

	return { options, queries };
}

function printHelp(): void {
	console.log(`
HED Tag Suggestion CLI

Usage:
  hed-suggest [options] <query> [query2] [query3] ...

Options:
  -j, --json         Output results as JSON
  -s, --schema VER   Use specific schema version (default: 8.4.0)
  -n, --top N        Return top N suggestions (default: 10)
  --semantic         Use semantic search (requires model download)
  -h, --help         Show this help message

Examples:
  hed-suggest "button press"
  hed-suggest --json "button press" "visual flash" "response"
  hed-suggest --schema 8.3.0 --top 5 "stimulus"
`);
}

/**
 * Find suggestions for a query using keyword mappings and schema search.
 */
async function findSuggestions(
	query: string,
	options: CliOptions
): Promise<SuggestionResult> {
	const normalizedQuery = query.toLowerCase().trim();
	const suggestions: string[] = [];
	let source: 'keyword' | 'schema' | 'semantic' = 'schema';

	// 1. Check semantic mappings first (exact word matches)
	const words = normalizedQuery.split(/\s+/);
	for (const word of words) {
		if (SEMANTIC_MAPPINGS[word]) {
			suggestions.push(...SEMANTIC_MAPPINGS[word]);
			source = 'keyword';
		}
	}

	// 2. Search schema for tags containing the query
	if (suggestions.length < options.top) {
		try {
			const schemaTags = await schemaManager.searchTagsContaining(
				normalizedQuery,
				options.schema
			);
			for (const tag of schemaTags) {
				if (!suggestions.includes(tag.shortForm)) {
					suggestions.push(tag.shortForm);
				}
			}
		} catch (error) {
			// Log warning but continue with keyword results
			console.error(
				`Warning: Schema search failed: ${error instanceof Error ? error.message : error}`
			);
		}
	}

	// 3. Try semantic search if enabled and available
	if (options.semantic && suggestions.length < options.top) {
		try {
			if (embeddingsManager.isAvailable()) {
				const semanticResults = await embeddingsManager.findSimilar(
					normalizedQuery,
					options.top
				);
				for (const result of semanticResults) {
					if (!suggestions.includes(result.tag)) {
						suggestions.push(result.tag);
						source = 'semantic';
					}
				}
			}
		} catch (error) {
			// Log warning but continue with other results
			console.error(
				`Warning: Semantic search failed: ${error instanceof Error ? error.message : error}`
			);
		}
	}

	// Deduplicate and limit
	const uniqueSuggestions = [...new Set(suggestions)].slice(0, options.top);

	return {
		query,
		suggestions: uniqueSuggestions,
		source,
	};
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { options, queries } = parseArgs(args);

	if (options.help || queries.length === 0) {
		printHelp();
		process.exit(options.help ? 0 : 1);
	}

	try {
		// Load schema
		await schemaManager.getSchema(options.schema);

		// Process all queries
		const results: SuggestionResult[] = [];
		for (const query of queries) {
			const result = await findSuggestions(query, options);
			results.push(result);
		}

		// Output results
		if (options.json) {
			const output: Record<string, string[]> = {};
			for (const result of results) {
				output[result.query] = result.suggestions;
			}
			console.log(JSON.stringify(output, null, 2));
		} else {
			for (const result of results) {
				if (queries.length > 1) {
					console.log(`\n${result.query}:`);
				}
				if (result.suggestions.length === 0) {
					console.log('(no suggestions found)');
				} else {
					console.log(result.suggestions.join(', '));
				}
			}
		}
	} catch (error) {
		console.error('Error:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main();
