#!/usr/bin/env npx ts-node
/**
 * Generate Embeddings Script
 * Pre-computes embeddings for all HED tags using Qwen3-Embedding-0.6B.
 *
 * Usage: npx ts-node server/scripts/generateEmbeddings.ts
 */

import { buildSchemasFromVersion } from 'hed-validator';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const SCHEMA_VERSION = '8.4.0,sc:score_2.1.0,la:lang_1.1.0';
const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DTYPE = 'q8';
const BATCH_SIZE = 32;
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'tag-embeddings.json');

/**
 * Semantic enrichment for category tags.
 * Adds common examples/synonyms so users can find them with natural terms.
 * Key format: tag short name (case-sensitive)
 */
const SEMANTIC_ENRICHMENT: Record<string, string> = {
	// Living things
	'Animal': 'animal dog cat horse bird mouse monkey fish snake lizard frog rat pig cow sheep goat deer rabbit squirrel marmoset primate mammal',
	'Animal-agent': 'animal agent creature beast dog cat horse bird mouse monkey',
	'Human-agent': 'human person people man woman child adult',
	'Human': 'human person people body',
	'Plant': 'plant tree flower grass bush shrub vegetation flora',
	'Organism': 'organism living creature being life',

	// Structures
	'Building': 'building house home office school hospital church store shop factory warehouse residence apartment',
	'Building-part': 'building part room wall floor ceiling door window roof',
	'Room': 'room bedroom bathroom kitchen living office',

	// Objects
	'Device': 'device machine equipment apparatus tool gadget',
	'Computer-mouse': 'computer mouse pointer cursor click',
	'Furniture': 'furniture chair table desk bed sofa couch shelf',
	'Vehicle': 'vehicle car truck bus train plane boat ship motorcycle bicycle',
	'Clothing': 'clothing clothes shirt pants dress shoes hat coat jacket',
	'Tool': 'tool hammer screwdriver wrench pliers saw drill',

	// Food and drink
	'Food': 'food meal dish cuisine eat eating edible snack',
	'Drink': 'drink beverage liquid water juice soda coffee tea',
	'Fruit': 'fruit apple orange banana grape berry melon',
	'Vegetable': 'vegetable carrot potato tomato lettuce onion',

	// Sounds
	'Sound': 'sound audio noise tone voice music',
	'Musical-sound': 'musical sound music melody rhythm beat tune song',
	'Environmental-sound': 'environmental sound ambient background noise',

	// Actions
	'Move': 'move motion movement walk run jump',
	'Communicate': 'communicate talk speak say tell conversation',
	'Think': 'think thought mental cognitive brain mind',
	'Perceive': 'perceive sense feel detect notice observe',

	// Properties
	'Color': 'color colour hue shade tint',
	'Size': 'size dimension measure big small large tiny huge',
	'Shape': 'shape form figure outline contour',

	// Events
	'Event': 'event occurrence happening incident',
	'Sensory-event': 'sensory event stimulus perception',
};

interface TagInfo {
	tag: string;
	longForm: string;
	prefix: string;
	description: string;
}

interface TagEmbedding {
	tag: string;
	longForm: string;
	prefix: string;
	vector: number[];
}

interface EmbeddingsDatabase {
	version: string;
	modelId: string;
	schemaVersion: string;
	dimensions: number;
	generatedAt: string;
	tags: TagEmbedding[];
}

async function getAllTags(): Promise<TagInfo[]> {
	console.log(`Loading schema: ${SCHEMA_VERSION}`);
	const schemas = await buildSchemasFromVersion(SCHEMA_VERSION);
	const tags: TagInfo[] = [];

	// Helper to get all schema objects
	const schemaList: Array<{ schema: any; prefix: string }> = [];

	if (schemas.baseSchema) {
		schemaList.push({ schema: schemas.baseSchema, prefix: '' });
	}

	if (schemas.schemas) {
		for (const [prefix, schema] of schemas.schemas) {
			if (prefix && schema !== schemas.baseSchema) {
				schemaList.push({ schema, prefix: prefix + ':' });
			}
		}
	}

	// Extract tags from each schema
	for (const { schema, prefix } of schemaList) {
		if (schema?.entries?.tags) {
			for (const [_key, entry] of schema.entries.tags) {
				// Filter: only show tags that belong to this schema
				const inLibrary = entry.getAttributeValue?.('inLibrary');
				if (!prefix && inLibrary) continue; // Skip library tags in base schema
				if (prefix && !inLibrary) continue; // Skip base tags in library schemas

				const description = entry.getAttributeValue?.('description') || '';
				const tagName = entry.name || '';
				const longForm = entry.longTagName || entry.longName || tagName;

				tags.push({
					tag: tagName,
					longForm: prefix + longForm,
					prefix,
					description
				});
			}
		}
	}

	console.log(`Found ${tags.length} tags`);
	return tags;
}

function createEmbeddingText(tag: TagInfo): string {
	// Check if this tag has semantic enrichment
	const enrichment = SEMANTIC_ENRICHMENT[tag.tag];
	if (enrichment) {
		// Use enriched text for category tags
		return enrichment.toLowerCase();
	}

	// Default: use tag short form, expanded and lowercased
	// e.g., "Banana" → "banana", "Line-noise" → "line noise"
	return tag.tag
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/-/g, ' ')
		.toLowerCase();
}

async function generateEmbeddings(tags: TagInfo[]): Promise<{ embeddings: TagEmbedding[]; dimensions: number }> {
	console.log(`Loading embedding model: ${MODEL_ID}`);
	console.log('(This may take a few minutes on first run to download the model)');

	// Dynamic import for ES module
	const { pipeline } = await import('@huggingface/transformers');

	const extractor = await pipeline('feature-extraction', MODEL_ID, {
		dtype: DTYPE
	});

	console.log('Model loaded, generating embeddings...');

	const embeddings: TagEmbedding[] = [];
	let dimensions = 0;

	// Process in batches
	for (let i = 0; i < tags.length; i += BATCH_SIZE) {
		const batch = tags.slice(i, i + BATCH_SIZE);
		const texts = batch.map(createEmbeddingText);

		try {
			const output = await extractor(texts, {
				pooling: 'last_token',
				normalize: true
			});

			const data = Array.from(output.data as Float32Array);
			dimensions = data.length / batch.length;

			for (let j = 0; j < batch.length; j++) {
				const start = j * dimensions;
				const vector = data.slice(start, start + dimensions);

				embeddings.push({
					tag: batch[j].tag,
					longForm: batch[j].longForm,
					prefix: batch[j].prefix,
					vector: Array.from(vector)
				});
			}

			const progress = Math.min(i + BATCH_SIZE, tags.length);
			process.stdout.write(`\rProgress: ${progress}/${tags.length} (${Math.round(progress / tags.length * 100)}%)`);
		} catch (error) {
			console.error(`\nError processing batch at ${i}:`, error);
		}
	}

	console.log(`\nGenerated ${embeddings.length} embeddings with ${dimensions} dimensions`);
	return { embeddings, dimensions };
}

async function saveEmbeddings(embeddings: TagEmbedding[], dimensions: number): Promise<void> {
	const outputDir = path.dirname(OUTPUT_PATH);
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	const db: EmbeddingsDatabase = {
		version: '2.0',
		modelId: MODEL_ID,
		schemaVersion: SCHEMA_VERSION,
		dimensions,
		generatedAt: new Date().toISOString(),
		tags: embeddings
	};

	// Save full version (pretty printed)
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2));
	console.log(`Saved embeddings to ${OUTPUT_PATH}`);

	// Calculate file size
	const stats = fs.statSync(OUTPUT_PATH);
	console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

	// Save compact version (minified, rounded vectors)
	const compactPath = OUTPUT_PATH.replace('.json', '.compact.json');
	const compactDb: EmbeddingsDatabase = {
		...db,
		tags: embeddings.map(e => ({
			...e,
			// Round vectors to 6 decimal places to reduce size
			vector: e.vector.map(v => Math.round(v * 1000000) / 1000000)
		}))
	};
	fs.writeFileSync(compactPath, JSON.stringify(compactDb));
	const compactStats = fs.statSync(compactPath);
	console.log(`Compact file size: ${(compactStats.size / 1024 / 1024).toFixed(2)} MB`);
}

async function main(): Promise<void> {
	console.log('=== HED Tag Embeddings Generator (Qwen3-Embedding) ===\n');

	try {
		// Get all tags from schema
		const tags = await getAllTags();

		// Generate embeddings
		const { embeddings, dimensions } = await generateEmbeddings(tags);

		// Save to file
		await saveEmbeddings(embeddings, dimensions);

		console.log('\nDone!');
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
