#!/usr/bin/env bun

/**
 * Generate Embeddings Script
 * Pre-computes embeddings for HED tags AND keyword anchors using Qwen3-Embedding-0.6B.
 *
 * Creates two embedding sets:
 * 1. Tag embeddings - for direct HED tag matching
 * 2. Keyword embeddings - curated terms that point to HED tags (anchors)
 *
 * Usage: bun server/scripts/generateEmbeddings.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSchemasFromVersion } from 'hed-validator';
import { ANCHOR_KEYWORDS } from '../src/anchorKeywords.js';

// Configuration
const SCHEMA_VERSION = '8.4.0,sc:score_2.1.0,la:lang_1.1.0';
const MODEL_ID = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
const DTYPE = 'q8';
const BATCH_SIZE = 32;
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'tag-embeddings.json');

// ============ Types ============

interface TagInfo {
	tag: string;
	longForm: string;
	prefix: string;
}

interface TagEmbedding {
	tag: string;
	longForm: string;
	prefix: string;
	vector: number[];
}

interface KeywordEmbedding {
	keyword: string;
	targets: string[];
	vector: number[];
}

interface EmbeddingsDatabase {
	version: string;
	modelId: string;
	schemaVersion: string;
	dimensions: number;
	generatedAt: string;
	tags: TagEmbedding[];
	keywords: KeywordEmbedding[];
}

// ============ Functions ============

async function getAllTags(): Promise<TagInfo[]> {
	console.log(`Loading schema: ${SCHEMA_VERSION}`);
	const schemas = await buildSchemasFromVersion(SCHEMA_VERSION);
	const tags: TagInfo[] = [];

	const schemaList: Array<{ schema: any; prefix: string }> = [];

	if (schemas.baseSchema) {
		schemaList.push({ schema: schemas.baseSchema, prefix: '' });
	}

	if (schemas.schemas) {
		for (const [prefix, schema] of schemas.schemas) {
			if (prefix && schema !== schemas.baseSchema) {
				schemaList.push({ schema, prefix: `${prefix}:` });
			}
		}
	}

	for (const { schema, prefix } of schemaList) {
		if (schema?.entries?.tags) {
			for (const [_key, entry] of schema.entries.tags) {
				const inLibrary = entry.getAttributeValue?.('inLibrary');
				if (!prefix && inLibrary) continue;
				if (prefix && !inLibrary) continue;

				const tagName = entry.name || '';
				const longForm = entry.longTagName || entry.longName || tagName;

				tags.push({
					tag: tagName,
					longForm: prefix + longForm,
					prefix,
				});
			}
		}
	}

	console.log(`Found ${tags.length} tags`);
	return tags;
}

function expandTagName(tag: string): string {
	// Expand camelCase and hyphens, lowercase
	return tag
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/-/g, ' ')
		.toLowerCase();
}

async function generateEmbeddings(
	tags: TagInfo[],
	keywords: string[],
): Promise<{ tagEmbeddings: TagEmbedding[]; keywordEmbeddings: KeywordEmbedding[]; dimensions: number }> {
	console.log(`\nLoading embedding model: ${MODEL_ID}`);
	console.log('(This may take a few minutes on first run to download the model)');

	const { pipeline } = await import('@huggingface/transformers');

	const extractor = await pipeline('feature-extraction', MODEL_ID, {
		dtype: DTYPE,
	});

	console.log('Model loaded.\n');

	// ---- Generate tag embeddings ----
	console.log(`Generating embeddings for ${tags.length} HED tags...`);
	const tagEmbeddings: TagEmbedding[] = [];
	let dimensions = 0;

	for (let i = 0; i < tags.length; i += BATCH_SIZE) {
		const batch = tags.slice(i, i + BATCH_SIZE);
		const texts = batch.map((t) => expandTagName(t.tag));

		try {
			const output = await extractor(texts, {
				pooling: 'last_token',
				normalize: true,
			});

			const data = Array.from(output.data as Float32Array);
			dimensions = data.length / batch.length;

			for (let j = 0; j < batch.length; j++) {
				const start = j * dimensions;
				const vector = data.slice(start, start + dimensions);

				tagEmbeddings.push({
					tag: batch[j].tag,
					longForm: batch[j].longForm,
					prefix: batch[j].prefix,
					vector: Array.from(vector),
				});
			}

			const progress = Math.min(i + BATCH_SIZE, tags.length);
			process.stdout.write(`\rTags: ${progress}/${tags.length} (${Math.round((progress / tags.length) * 100)}%)`);
		} catch (error) {
			console.error(`\nError processing tag batch at ${i}:`, error);
		}
	}
	console.log(`\nGenerated ${tagEmbeddings.length} tag embeddings.`);

	// ---- Generate keyword embeddings ----
	console.log(`\nGenerating embeddings for ${keywords.length} keywords...`);
	const keywordEmbeddings: KeywordEmbedding[] = [];

	for (let i = 0; i < keywords.length; i += BATCH_SIZE) {
		const batch = keywords.slice(i, i + BATCH_SIZE);

		try {
			const output = await extractor(batch, {
				pooling: 'last_token',
				normalize: true,
			});

			const data = Array.from(output.data as Float32Array);

			for (let j = 0; j < batch.length; j++) {
				const start = j * dimensions;
				const vector = data.slice(start, start + dimensions);
				const keyword = batch[j];

				keywordEmbeddings.push({
					keyword,
					targets: ANCHOR_KEYWORDS[keyword] || [],
					vector: Array.from(vector),
				});
			}

			const progress = Math.min(i + BATCH_SIZE, keywords.length);
			process.stdout.write(
				`\rKeywords: ${progress}/${keywords.length} (${Math.round((progress / keywords.length) * 100)}%)`,
			);
		} catch (error) {
			console.error(`\nError processing keyword batch at ${i}:`, error);
		}
	}
	console.log(`\nGenerated ${keywordEmbeddings.length} keyword embeddings.`);

	return { tagEmbeddings, keywordEmbeddings, dimensions };
}

async function saveEmbeddings(
	tagEmbeddings: TagEmbedding[],
	keywordEmbeddings: KeywordEmbedding[],
	dimensions: number,
): Promise<void> {
	const outputDir = path.dirname(OUTPUT_PATH);
	if (!fs.existsSync(outputDir)) {
		fs.mkdirSync(outputDir, { recursive: true });
	}

	const db: EmbeddingsDatabase = {
		version: '3.0',
		modelId: MODEL_ID,
		schemaVersion: SCHEMA_VERSION,
		dimensions,
		generatedAt: new Date().toISOString(),
		tags: tagEmbeddings,
		keywords: keywordEmbeddings,
	};

	// Save full version
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2));
	console.log(`\nSaved embeddings to ${OUTPUT_PATH}`);

	const stats = fs.statSync(OUTPUT_PATH);
	console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

	// Save compact version
	const compactPath = OUTPUT_PATH.replace('.json', '.compact.json');
	const roundVector = (v: number[]) => v.map((x) => Math.round(x * 1000000) / 1000000);

	const compactDb: EmbeddingsDatabase = {
		...db,
		tags: tagEmbeddings.map((e) => ({ ...e, vector: roundVector(e.vector) })),
		keywords: keywordEmbeddings.map((e) => ({ ...e, vector: roundVector(e.vector) })),
	};
	fs.writeFileSync(compactPath, JSON.stringify(compactDb));

	const compactStats = fs.statSync(compactPath);
	console.log(`Compact file size: ${(compactStats.size / 1024 / 1024).toFixed(2)} MB`);
}

async function main(): Promise<void> {
	console.log('=== HED Embeddings Generator (Tags + Keywords) ===\n');

	try {
		// Get all HED tags
		const tags = await getAllTags();

		// Get all keywords
		const keywords = Object.keys(ANCHOR_KEYWORDS);
		console.log(`Found ${keywords.length} keywords in index`);

		// Generate embeddings for both
		const { tagEmbeddings, keywordEmbeddings, dimensions } = await generateEmbeddings(tags, keywords);

		// Save to file
		await saveEmbeddings(tagEmbeddings, keywordEmbeddings, dimensions);

		console.log('\nDone!');
		console.log(
			`Total: ${tagEmbeddings.length} tags + ${keywordEmbeddings.length} keywords = ${tagEmbeddings.length + keywordEmbeddings.length} embeddings`,
		);
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
