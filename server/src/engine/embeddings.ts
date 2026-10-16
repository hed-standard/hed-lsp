/**
 * HED Tag Embeddings Module
 * Provides semantic similarity search using Qwen3-Embedding-0.6B.
 *
 * Uses @huggingface/transformers to run the model locally.
 * Model is downloaded on first use and cached.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ANCHOR_KEYWORDS } from './anchorKeywords.js';
import { dataDir } from './dataPath.js';
import {
	DEFAULT_QUERY_FORMAT,
	DTYPE,
	formatQuery,
	MODEL_ID,
	modelCacheDir,
	NORMALIZE,
	POOLING,
	type QueryFormat,
} from './embeddingConfig.js';
import { lookupOwn } from './keywordLookup.js';

// Dynamic import for transformers.js (ES module)
let pipeline: any = null;
let extractor: any = null;

/**
 * Embedding entry for a HED tag.
 */
export interface TagEmbedding {
	/** Tag short form (e.g., "Building") */
	tag: string;
	/** Tag long form path */
	longForm: string;
	/** Library prefix (e.g., "sc:" for SCORE) */
	prefix: string;
	/** The embedding vector */
	vector: number[];
}

/**
 * Embedding entry for a curated keyword.
 * Keywords act as "anchors" that vote for HED tags.
 */
export interface KeywordEmbedding {
	/** The keyword (e.g., "marmoset", "mouse") */
	keyword: string;
	/** HED tags this keyword points to */
	targets: string[];
	/** The embedding vector */
	vector: number[];
}

/**
 * Embeddings database stored on disk.
 * Version 3.0+ includes both tag and keyword embeddings.
 */
interface EmbeddingsDatabase {
	version: string;
	modelId: string;
	schemaVersion: string;
	dimensions: number;
	tags: TagEmbedding[];
	/** Keyword embeddings for dual-embedding search (v3.0+) */
	keywords?: KeywordEmbedding[];
}

/**
 * Semantic search result.
 */
export interface SemanticMatch {
	tag: string;
	longForm: string;
	prefix: string;
	similarity: number;
}

/**
 * Configuration for the embedding service.
 */
export interface EmbeddingConfig {
	/** Model ID on Hugging Face */
	modelId: string;
	/** Data type for model (fp32, fp16, q8, uint8) */
	dtype: 'fp32' | 'fp16' | 'q8' | 'uint8';
	/** Whether embeddings are enabled */
	enabled: boolean;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
	modelId: MODEL_ID,
	dtype: DTYPE,
	enabled: false, // Disabled by default - requires ~600MB model download
};

/**
 * Progress callback for model download.
 */
export type ProgressCallback = (progress: {
	status: 'downloading' | 'loading' | 'ready' | 'error';
	message: string;
	progress?: number; // 0-100
}) => void;

/**
 * Embeddings Manager for semantic search using Qwen3-Embedding.
 * Implements dual-embedding architecture: keywords as anchors + direct tag matching.
 */
class EmbeddingsManager {
	private tagEmbeddings: Map<string, TagEmbedding> = new Map();
	private keywordEmbeddings: KeywordEmbedding[] = [];
	private config: EmbeddingConfig = DEFAULT_CONFIG;
	private modelLoaded = false;
	private embeddingsLoaded = false;
	private embedFailures = 0;
	private dimensions = 1024; // Qwen3-Embedding-0.6B output dimension
	private loading: Promise<boolean> | null = null;
	private progressCallback: ProgressCallback | null = null;

	/**
	 * Set a callback to receive progress updates during model download.
	 */
	setProgressCallback(callback: ProgressCallback | null): void {
		this.progressCallback = callback;
	}

	/**
	 * Initialize the embedding model.
	 * Downloads on first use, then cached by transformers.js
	 */
	async initializeModel(): Promise<boolean> {
		if (!this.config.enabled) {
			console.log('[HED Embeddings] Embeddings disabled in config');
			return false;
		}

		if (this.modelLoaded) return true;

		// Prevent multiple simultaneous loads
		if (this.loading) return this.loading;

		this.loading = this._loadModel();
		const result = await this.loading;
		this.loading = null;
		return result;
	}

	private async _loadModel(): Promise<boolean> {
		try {
			console.log('[HED Embeddings] Loading Qwen3-Embedding model...');
			this.progressCallback?.({
				status: 'loading',
				message: 'Initializing semantic search model...',
			});

			// Dynamic import of ES module
			const transformers = await import('@huggingface/transformers');
			pipeline = transformers.pipeline;

			// Configure cache directory to avoid duplicates
			// Use ~/.cache/huggingface/hub as the single cache location
			const cacheDir = this.getCacheDir();
			if (transformers.env) {
				transformers.env.cacheDir = cacheDir;
				console.log(`[HED Embeddings] Cache directory: ${cacheDir}`);
			}

			// Track download progress
			let lastProgress = 0;
			const progressHandler = (data: { status: string; progress?: number; file?: string }) => {
				if (data.status === 'progress' && data.progress !== undefined) {
					const progress = Math.round(data.progress);
					if (progress !== lastProgress && progress % 5 === 0) {
						lastProgress = progress;
						this.progressCallback?.({
							status: 'downloading',
							message: `Downloading model: ${progress}%`,
							progress,
						});
					}
				} else if (data.status === 'done') {
					this.progressCallback?.({
						status: 'loading',
						message: 'Loading model into memory...',
					});
				}
			};

			// Create the feature extraction pipeline with progress callback
			extractor = await pipeline('feature-extraction', this.config.modelId, {
				dtype: this.config.dtype,
				progress_callback: progressHandler,
			});

			this.modelLoaded = true;
			console.log('[HED Embeddings] Model loaded successfully');
			this.progressCallback?.({
				status: 'ready',
				message: 'Semantic search ready',
			});
			return true;
		} catch (error) {
			console.error('[HED Embeddings] Failed to load model:', error);
			this.progressCallback?.({
				status: 'error',
				message: `Failed to load model: ${error}`,
			});
			this.config.enabled = false;
			return false;
		}
	}

	/**
	 * Load pre-computed embeddings from file.
	 * Loads both tag embeddings and keyword embeddings for dual-embedding search.
	 */
	async loadEmbeddings(): Promise<boolean> {
		if (this.embeddingsLoaded) return true;

		try {
			// Try compact version first (smaller file), then full version
			let embeddingsPath = path.join(dataDir(), 'tag-embeddings.compact.json');
			if (!fs.existsSync(embeddingsPath)) {
				embeddingsPath = path.join(dataDir(), 'tag-embeddings.json');
			}
			if (fs.existsSync(embeddingsPath)) {
				const data = fs.readFileSync(embeddingsPath, 'utf-8');
				const db: EmbeddingsDatabase = JSON.parse(data);

				// Load tag embeddings
				for (const entry of db.tags) {
					const key = `${entry.prefix}${entry.tag}`.toLowerCase();
					this.tagEmbeddings.set(key, entry);
				}

				// Load keyword embeddings (v3.0+)
				if (db.keywords && db.keywords.length > 0) {
					this.keywordEmbeddings = db.keywords;
					console.log(`[HED Embeddings] Loaded ${this.keywordEmbeddings.length} keyword embeddings`);
				}

				this.dimensions = db.dimensions;
				this.embeddingsLoaded = true;
				console.log(`[HED Embeddings] Loaded ${this.tagEmbeddings.size} tag embeddings`);
				return true;
			}
		} catch (error) {
			console.error('[HED Embeddings] Failed to load pre-computed embeddings:', error);
		}

		console.log('[HED Embeddings] No pre-computed embeddings found');
		return false;
	}

	/**
	 * Save embeddings to file for faster future loads.
	 */
	async saveEmbeddings(schemaVersion: string): Promise<void> {
		const embeddingsPath = path.join(dataDir(), 'tag-embeddings.json');
		const outputDir = path.dirname(embeddingsPath);

		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		const db: EmbeddingsDatabase = {
			version: '3.0',
			modelId: this.config.modelId,
			schemaVersion,
			dimensions: this.dimensions,
			tags: Array.from(this.tagEmbeddings.values()),
			keywords: this.keywordEmbeddings,
		};

		fs.writeFileSync(embeddingsPath, JSON.stringify(db));
		console.log(
			`[HED Embeddings] Saved ${this.tagEmbeddings.size} tag embeddings and ${this.keywordEmbeddings.length} keyword embeddings to disk`,
		);
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embed(text: string): Promise<number[] | null> {
		if (!this.modelLoaded) {
			const loaded = await this.initializeModel();
			if (!loaded) {
				this.embedFailures++;
				return null;
			}
		}

		try {
			const output = await extractor(text, {
				pooling: POOLING,
				normalize: NORMALIZE,
			});

			// Convert to regular array
			const embedding = Array.from(output.data as Float32Array);
			return embedding.slice(0, this.dimensions);
		} catch (error) {
			this.embedFailures++;
			console.error('[HED Embeddings] Embedding failed:', error);
			return null;
		}
	}

	/**
	 * Number of embed calls that failed since startup. Callers that must not score a
	 * silent failure (the eval harness) compare this before and after a run.
	 */
	embedFailureCount(): number {
		return this.embedFailures;
	}

	/**
	 * Generate embeddings for multiple texts (batch).
	 */
	async embedBatch(texts: string[]): Promise<number[][] | null> {
		if (!this.modelLoaded) {
			const loaded = await this.initializeModel();
			if (!loaded) return null;
		}

		try {
			const output = await extractor(texts, {
				pooling: POOLING,
				normalize: NORMALIZE,
			});

			// Convert to array of arrays
			const data = Array.from(output.data as Float32Array);
			const embeddings: number[][] = [];

			for (let i = 0; i < texts.length; i++) {
				const start = i * this.dimensions;
				embeddings.push(data.slice(start, start + this.dimensions));
			}

			return embeddings;
		} catch (error) {
			console.error('[HED Embeddings] Batch embedding failed:', error);
			return null;
		}
	}

	/**
	 * Add a tag embedding to the database.
	 */
	addTagEmbedding(tag: string, longForm: string, prefix: string, vector: number[]): void {
		const key = `${prefix}${tag}`.toLowerCase();
		this.tagEmbeddings.set(key, { tag, longForm, prefix, vector });
	}

	/**
	 * Find tags matching a keyword from the deterministic index.
	 * Returns tags with boosted similarity (0.95) for exact keyword matches.
	 */
	findByKeyword(query: string): SemanticMatch[] {
		const normalizedQuery = query.toLowerCase().trim();
		// Try exact match first, then try with spaces converted to hyphens.
		// ANCHOR_KEYWORDS uses hyphens (e.g., "muscle-artifact") but callers may
		// pass spaces (e.g., "muscle artifact").
		const matchingTags =
			lookupOwn(ANCHOR_KEYWORDS, normalizedQuery) || lookupOwn(ANCHOR_KEYWORDS, normalizedQuery.replace(/\s+/g, '-'));

		if (!matchingTags) {
			return [];
		}

		const results: SemanticMatch[] = [];
		for (const tagName of matchingTags) {
			// Find the tag in our embeddings to get full info
			const key = tagName.toLowerCase();
			const entry = this.tagEmbeddings.get(key);
			if (entry) {
				results.push({
					tag: entry.tag,
					longForm: entry.longForm,
					prefix: entry.prefix,
					similarity: 0.95, // High similarity for exact keyword matches
				});
			}
		}

		return results;
	}

	/**
	 * Find semantically similar tags using dual-embedding architecture.
	 *
	 * Algorithm:
	 * 1. Search keyword embeddings - find similar keywords, collect votes for target tags
	 * 2. Search tag embeddings - find similar tags directly
	 * 3. Combine evidence: tags from BOTH sources get boosted confidence
	 *
	 * Example: Query "bird"
	 * - Keyword search finds "bird" close to "dog", "cat" → votes for Animal
	 * - Tag search finds "bird" close to "Animal" directly
	 * - Animal gets evidence from both sources → high confidence
	 */
	async findSimilar(
		query: string,
		topK: number = 10,
		format: QueryFormat = DEFAULT_QUERY_FORMAT,
	): Promise<SemanticMatch[]> {
		// Try to load pre-computed embeddings first
		await this.loadEmbeddings();

		if (this.tagEmbeddings.size === 0) {
			console.log('[HED Embeddings] No embeddings available for search');
			return [];
		}

		// First, check deterministic keyword index for exact matches
		const exactKeywordMatches = this.findByKeyword(query);
		if (exactKeywordMatches.length > 0) {
			// Exact keyword match - return these with highest confidence
			return exactKeywordMatches.slice(0, topK);
		}

		// Generate query embedding for semantic search (lowercase)
		const queryEmbedding = await this.embed(formatQuery(query.toLowerCase(), format));
		if (!queryEmbedding) {
			return [];
		}

		// ============ DUAL-EMBEDDING SEARCH ============

		// 1. Search KEYWORD embeddings - collect votes for tags
		const tagVotes: Map<string, { votes: number; maxSimilarity: number }> = new Map();
		const KEYWORD_THRESHOLD = 0.6; // Minimum similarity to consider a keyword match
		const TOP_KEYWORDS = 10; // Number of similar keywords to consider

		if (this.keywordEmbeddings.length > 0) {
			// Find most similar keywords to query
			const keywordSimilarities: { keyword: KeywordEmbedding; similarity: number }[] = [];

			for (const kw of this.keywordEmbeddings) {
				const similarity = this.cosineSimilarity(queryEmbedding, kw.vector);
				if (similarity >= KEYWORD_THRESHOLD) {
					keywordSimilarities.push({ keyword: kw, similarity });
				}
			}

			// Sort by similarity and take top keywords
			keywordSimilarities.sort((a, b) => b.similarity - a.similarity);
			const topKeywords = keywordSimilarities.slice(0, TOP_KEYWORDS);

			// Each similar keyword votes for its target tags
			for (const { keyword, similarity } of topKeywords) {
				for (const targetTag of keyword.targets) {
					const existing = tagVotes.get(targetTag);
					if (existing) {
						existing.votes++;
						existing.maxSimilarity = Math.max(existing.maxSimilarity, similarity);
					} else {
						tagVotes.set(targetTag, { votes: 1, maxSimilarity: similarity });
					}
				}
			}
		}

		// 2. Search TAG embeddings - find directly similar tags
		const TAG_THRESHOLD = 0.5; // Minimum similarity for direct tag match
		const directMatches: Map<string, { entry: TagEmbedding; similarity: number }> = new Map();

		for (const [_key, entry] of this.tagEmbeddings) {
			const similarity = this.cosineSimilarity(queryEmbedding, entry.vector);
			if (similarity >= TAG_THRESHOLD) {
				directMatches.set(entry.tag, { entry, similarity });
			}
		}

		// 3. Combine evidence - union of keyword votes and direct matches
		const combinedScores: Map<
			string,
			{
				entry: TagEmbedding;
				keywordVotes: number;
				keywordSimilarity: number;
				directSimilarity: number;
				combinedScore: number;
			}
		> = new Map();

		// Add tags from keyword votes
		for (const [tagName, { votes, maxSimilarity }] of tagVotes) {
			const entry = this.tagEmbeddings.get(tagName.toLowerCase());
			if (entry) {
				const directMatch = directMatches.get(tagName);
				const directSim = directMatch?.similarity ?? 0;

				// Combined score: boost when evidence from both sources
				// Base: keyword similarity weighted by vote count
				// Boost: multiply by 1.5 if also matched directly
				const keywordScore = maxSimilarity * (1 + Math.log(votes + 1) * 0.2);
				const boostMultiplier = directSim > 0 ? 1.5 : 1.0;
				const combinedScore = keywordScore * boostMultiplier + directSim * 0.3;

				combinedScores.set(tagName, {
					entry,
					keywordVotes: votes,
					keywordSimilarity: maxSimilarity,
					directSimilarity: directSim,
					combinedScore,
				});
			}
		}

		// Add direct matches that weren't voted for
		for (const [tagName, { entry, similarity }] of directMatches) {
			if (!combinedScores.has(tagName)) {
				combinedScores.set(tagName, {
					entry,
					keywordVotes: 0,
					keywordSimilarity: 0,
					directSimilarity: similarity,
					combinedScore: similarity,
				});
			}
		}

		// Sort by combined score and create results
		const sortedResults = Array.from(combinedScores.entries())
			.sort((a, b) => b[1].combinedScore - a[1].combinedScore)
			.slice(0, topK);

		return sortedResults.map(([_tagName, data]) => ({
			tag: data.entry.tag,
			longForm: data.entry.longForm,
			prefix: data.entry.prefix,
			// Use combined score as similarity (capped at 0.95 since exact keyword would be 0.95)
			similarity: Math.min(data.combinedScore, 0.94),
		}));
	}

	/**
	 * Check if embeddings are available.
	 */
	isAvailable(): boolean {
		return this.config.enabled && (this.modelLoaded || this.embeddingsLoaded);
	}

	/**
	 * Check if model is loaded.
	 */
	isModelLoaded(): boolean {
		return this.modelLoaded;
	}

	/**
	 * Get the number of loaded tag embeddings.
	 */
	size(): number {
		return this.tagEmbeddings.size;
	}

	/**
	 * Get the number of loaded keyword embeddings.
	 */
	keywordCount(): number {
		return this.keywordEmbeddings.length;
	}

	/**
	 * Enable or disable embeddings.
	 */
	setEnabled(enabled: boolean): void {
		this.config.enabled = enabled;
	}

	/**
	 * Get the cache directory path for the model.
	 */
	getCacheDir(): string {
		return modelCacheDir();
	}

	/**
	 * Delete the cached model to free up disk space.
	 * Returns true if deletion was successful.
	 */
	async deleteCache(cacheDir: string = this.getCacheDir()): Promise<boolean> {
		try {
			// Same layout isModelCached checks: <cacheDir>/<org>/<name>.
			const modelDir = path.join(cacheDir, ...this.config.modelId.split('/'));

			if (fs.existsSync(modelDir)) {
				fs.rmSync(modelDir, { recursive: true, force: true });
				console.log(`[HED Embeddings] Deleted cache: ${modelDir}`);
				this.modelLoaded = false;
				extractor = null;
				return true;
			}
			console.log('[HED Embeddings] No cache to delete');
			return false;
		} catch (error) {
			console.error('[HED Embeddings] Failed to delete cache:', error);
			return false;
		}
	}

	/**
	 * Check if the model is cached locally.
	 */
	isModelCached(): boolean {
		// transformers.js caches under <cacheDir>/<org>/<name>, not the Hub's models--org--name layout.
		const modelDir = path.join(this.getCacheDir(), ...this.config.modelId.split('/'));
		return fs.existsSync(modelDir);
	}

	/**
	 * Compute cosine similarity between two vectors.
	 */
	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) return 0;

		let dotProduct = 0;
		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
		}

		// Vectors are already normalized
		return dotProduct;
	}
}

// Export singleton instance
export const embeddingsManager = new EmbeddingsManager();
