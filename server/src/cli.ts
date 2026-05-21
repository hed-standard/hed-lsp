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

import { type SuggestionOptions, suggestBatch } from './suggestionEngine.js';

interface CliOptions extends SuggestionOptions {
	json: boolean;
	help: boolean;
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
			if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
				i++;
				options.schema = args[i];
			} else {
				console.error('Warning: --schema requires a version argument, using default 8.4.0');
			}
		} else if (arg === '--top' || arg === '-n') {
			if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
				i++;
				const val = parseInt(args[i], 10);
				options.top = !Number.isNaN(val) && val > 0 ? val : 10;
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

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { options, queries } = parseArgs(args);

	if (options.help || queries.length === 0) {
		printHelp();
		process.exit(options.help ? 0 : 1);
	}

	try {
		const output = await suggestBatch(queries, {
			schema: options.schema,
			top: options.top,
			semantic: options.semantic,
		});

		if (options.json) {
			console.log(JSON.stringify(output, null, 2));
		} else {
			for (const query of queries) {
				const suggestions = output[query] ?? [];
				if (queries.length > 1) {
					console.log(`\n${query}:`);
				}
				if (suggestions.length === 0) {
					console.log('(no suggestions found)');
				} else {
					console.log(suggestions.join(', '));
				}
			}
		}
	} catch (error) {
		console.error('Error:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main();
