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
import type { HedTag } from './types.js';

/**
 * Semantic word mappings: common terms to their HED equivalents.
 * Copied from completion.ts for standalone CLI use.
 */
const SEMANTIC_MAPPINGS: Record<string, string[]> = {
	// Buildings and places
	house: ['Building', 'Residence', 'Structure'],
	home: ['Building', 'Residence'],
	room: ['Room', 'Indoor-place'],
	office: ['Building', 'Workplace'],

	// People
	person: ['Human', 'Agent', 'Human-agent'],
	man: ['Human', 'Male', 'Adult'],
	woman: ['Human', 'Female', 'Adult'],
	child: ['Human', 'Youth'],

	// Actions
	walk: ['Walk', 'Ambulate', 'Move'],
	run: ['Run', 'Move-quickly'],
	speak: ['Speak', 'Vocalize', 'Communicate'],
	look: ['Fixate', 'Attend-to', 'View'],
	see: ['View', 'Perceive', 'Detect'],
	hear: ['Hear', 'Listen', 'Perceive'],
	touch: ['Touch', 'Feel', 'Tactile-action'],
	push: ['Push', 'Press', 'Move'],
	pull: ['Pull', 'Move'],
	click: ['Press', 'Click', 'Mouse-button-press'],
	press: ['Press', 'Push'],
	type: ['Keyboard-key-press', 'Type'],

	// Sensory
	sound: ['Sound', 'Auditory-presentation', 'Noise'],
	noise: ['Noise', 'Sound', 'Signal-noise'],
	music: ['Music', 'Sound', 'Auditory-presentation'],
	light: ['Light', 'Illumination', 'Visual-presentation'],
	color: ['Color', 'Hue'],
	image: ['Image', 'Picture', 'Visual-presentation'],
	picture: ['Image', 'Picture', 'Photograph'],
	video: ['Video', 'Movie', 'Motion-picture'],
	flash: ['Flash', 'Flickering', 'Visual-presentation'],

	// Shapes
	square: ['Square', 'Rectangle', '2D-shape'],
	triangle: ['Triangle', '2D-shape'],
	circle: ['Circle', 'Ellipse', '2D-shape'],

	// Time
	start: ['Onset', 'Start', 'Beginning'],
	end: ['Offset', 'End', 'Termination'],
	begin: ['Onset', 'Start', 'Beginning'],
	stop: ['Offset', 'Stop', 'Termination'],
	pause: ['Pause', 'Break'],

	// Experiment
	trial: ['Trial', 'Experimental-trial'],
	block: ['Block', 'Experimental-block'],
	stimulus: ['Stimulus', 'Experimental-stimulus', 'Sensory-event'],
	response: ['Response', 'Participant-response'],
	feedback: ['Feedback', 'Informational-stimulus'],
	cue: ['Cue', 'Warning', 'Signal'],
	target: ['Target', 'Goal'],

	// Equipment
	button: ['Button', 'Response-button', 'Mouse-button'],
	keyboard: ['Keyboard', 'Keyboard-key'],
	mouse: ['Mouse', 'Computer-mouse'],
	screen: ['Screen', 'Computer-screen', 'Display'],

	// Body parts
	eye: ['Eye', 'Eyes'],
	hand: ['Hand', 'Hands'],
	finger: ['Finger', 'Fingers'],
	face: ['Face', 'Head'],
	head: ['Head'],
};

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
			options.schema = args[++i] || '8.4.0';
		} else if (arg === '--top' || arg === '-n') {
			options.top = parseInt(args[++i], 10) || 10;
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
			// Schema search failed, continue with what we have
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
			// Semantic search failed, continue with what we have
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
				console.log(result.suggestions.join(', '));
			}
		}
	} catch (error) {
		console.error('Error:', error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

main();
