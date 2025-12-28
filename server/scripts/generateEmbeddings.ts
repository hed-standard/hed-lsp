#!/usr/bin/env npx ts-node
/**
 * Generate Embeddings Script
 * Pre-computes embeddings for all HED tags and saves to JSON.
 *
 * Usage: npx ts-node scripts/generateEmbeddings.ts
 */

import { buildSchemasFromVersion } from 'hed-validator';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_VERSION = '8.4.0';
const LIBRARY_SCHEMAS = ['sc:score_2.1.0', 'la:lang_1.1.0'];
const DIMENSIONS = 100;

interface TagEmbedding {
	tag: string;
	longForm: string;
	vector: number[];
	words: string[];
}

interface EmbeddingsDatabase {
	version: string;
	schemaVersion: string;
	dimensions: number;
	generatedAt: string;
	tags: TagEmbedding[];
}

/**
 * Extract words from a camelCase or hyphenated string.
 */
function extractWords(text: string): string[] {
	let words = text.split(/[-_\s]+/);
	const expanded: string[] = [];

	for (const word of words) {
		const camelWords = word.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
		expanded.push(...camelWords);
	}

	return expanded.filter(w => w.length > 2).map(w => w.toLowerCase());
}

/**
 * Extract character n-grams from text.
 */
function extractNgrams(text: string, n: number): string[] {
	const ngrams: string[] = [];
	const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, '');

	for (let i = 0; i <= cleaned.length - n; i++) {
		ngrams.push(cleaned.slice(i, i + n));
	}

	return ngrams;
}

/**
 * Simple string hash function.
 */
function hashString(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return hash;
}

/**
 * Normalize a vector to unit length.
 */
function normalize(vector: number[]): number[] {
	const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
	if (magnitude === 0) return vector;
	return vector.map(v => v / magnitude);
}

/**
 * Generate embedding for a HED tag.
 */
function generateEmbedding(tagName: string, description: string = ''): TagEmbedding {
	const words = extractWords(tagName);
	const descWords = description ? extractWords(description).slice(0, 10) : [];
	const allWords = [...words, ...descWords];

	const text = `${tagName} ${description}`.toLowerCase();
	const ngrams = extractNgrams(text, 3);

	const vector = new Array(DIMENSIONS).fill(0);

	// Word contributions
	for (let i = 0; i < words.length; i++) {
		const hash = hashString(words[i]);
		for (let j = 0; j < DIMENSIONS; j++) {
			vector[j] += Math.sin(hash * (j + 1)) * (1.0 - i * 0.1);
		}
	}

	// Description word contributions
	for (const word of descWords) {
		const hash = hashString(word);
		for (let j = 0; j < DIMENSIONS; j++) {
			vector[j] += Math.sin(hash * (j + 1)) * 0.3;
		}
	}

	// N-gram contributions
	for (const ngram of ngrams) {
		const hash = hashString(ngram);
		const idx = Math.abs(hash) % DIMENSIONS;
		vector[idx] += 0.5;
	}

	return {
		tag: tagName,
		longForm: '',
		vector: normalize(vector),
		words: allWords
	};
}

async function main() {
	console.log('Generating HED tag embeddings...');

	const fullVersion = [DEFAULT_VERSION, ...LIBRARY_SCHEMAS].join(',');
	console.log(`Loading schema: ${fullVersion}`);

	try {
		const schemas = await buildSchemasFromVersion(fullVersion);
		const embeddings: TagEmbedding[] = [];

		// Process base schema
		if (schemas.baseSchema?.entries?.tags) {
			console.log('Processing base schema tags...');
			for (const [_key, entry] of schemas.baseSchema.entries.tags) {
				const name = entry.shortTagName || entry.name || '';
				const longForm = entry.longTagName || (entry as any).longName || entry.name || '';
				const description = entry.valueAttributeNames?.get?.('description') || '';

				if (name) {
					const embedding = generateEmbedding(name, description);
					embedding.longForm = longForm;
					embeddings.push(embedding);
				}
			}
		}

		// Process library schemas
		if (schemas.schemas) {
			for (const [prefix, schema] of schemas.schemas) {
				if (prefix && schema !== schemas.baseSchema && schema?.entries?.tags) {
					console.log(`Processing library schema: ${prefix}`);
					for (const [_key, entry] of schema.entries.tags) {
						// Check if tag belongs to this library
						const inLibrary = entry.valueAttributeNames?.get?.('inLibrary');
						if (!inLibrary) continue;

						const prefixClean = prefix.toLowerCase();
						let belongsToLib = false;

						if (typeof inLibrary === 'string') {
							belongsToLib = inLibrary.toLowerCase() === prefixClean;
						} else if (Array.isArray(inLibrary)) {
							belongsToLib = inLibrary.some((lib: any) =>
								typeof lib === 'string' && lib.toLowerCase() === prefixClean
							);
						}

						if (!belongsToLib) continue;

						const name = entry.shortTagName || entry.name || '';
						const longForm = entry.longTagName || (entry as any).longName || entry.name || '';
						const description = entry.valueAttributeNames?.get?.('description') || '';

						if (name) {
							const fullName = `${prefix}:${name}`;
							const embedding = generateEmbedding(fullName, description);
							embedding.tag = fullName;
							embedding.longForm = `${prefix}:${longForm}`;
							embeddings.push(embedding);
						}
					}
				}
			}
		}

		console.log(`Generated ${embeddings.length} embeddings`);

		// Create output directory
		const outputDir = path.join(__dirname, '..', 'data');
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		// Save embeddings
		const database: EmbeddingsDatabase = {
			version: '1.0.0',
			schemaVersion: fullVersion,
			dimensions: DIMENSIONS,
			generatedAt: new Date().toISOString(),
			tags: embeddings
		};

		const outputPath = path.join(outputDir, 'embeddings.json');
		fs.writeFileSync(outputPath, JSON.stringify(database, null, 2));
		console.log(`Saved embeddings to ${outputPath}`);

		// Also save a compact version (smaller file size)
		const compactDatabase = {
			...database,
			tags: embeddings.map(e => ({
				tag: e.tag,
				longForm: e.longForm,
				// Round vectors to 4 decimal places to reduce size
				vector: e.vector.map(v => Math.round(v * 10000) / 10000),
				words: e.words
			}))
		};

		const compactPath = path.join(outputDir, 'embeddings.compact.json');
		fs.writeFileSync(compactPath, JSON.stringify(compactDatabase));
		console.log(`Saved compact embeddings to ${compactPath}`);

		// Print some stats
		const fullSize = fs.statSync(outputPath).size;
		const compactSize = fs.statSync(compactPath).size;
		console.log(`\nFile sizes:`);
		console.log(`  Full: ${(fullSize / 1024).toFixed(1)} KB`);
		console.log(`  Compact: ${(compactSize / 1024).toFixed(1)} KB`);

	} catch (error) {
		console.error('Error generating embeddings:', error);
		process.exit(1);
	}
}

main();
