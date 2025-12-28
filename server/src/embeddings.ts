/**
 * HED Tag Embeddings Module
 * Provides semantic similarity search using Qwen3-Embedding-0.6B.
 *
 * Uses @huggingface/transformers to run the model locally.
 * Model is downloaded on first use and cached.
 */

import * as fs from 'fs';
import * as path from 'path';

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
 * Embeddings database stored on disk.
 */
interface EmbeddingsDatabase {
	version: string;
	modelId: string;
	schemaVersion: string;
	dimensions: number;
	tags: TagEmbedding[];
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
	/** Data type for model (fp32, fp16, q8) */
	dtype: 'fp32' | 'fp16' | 'q8';
	/** Whether embeddings are enabled */
	enabled: boolean;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
	modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
	dtype: 'q8', // Quantized for speed and smaller size
	enabled: true
};

/**
 * Keyword index for direct semantic mappings.
 * Maps search terms to HED tags that should be suggested.
 * This bypasses the embedding model for known relationships.
 */
const KEYWORD_INDEX: Record<string, string[]> = {
	// Animals → Animal, Animal-agent
	'dog': ['Animal', 'Animal-agent'],
	'cat': ['Animal', 'Animal-agent'],
	'horse': ['Animal', 'Animal-agent'],
	'bird': ['Animal', 'Animal-agent'],
	'mouse': ['Animal', 'Animal-agent', 'Computer-mouse'],
	'monkey': ['Animal', 'Animal-agent'],
	'fish': ['Animal', 'Animal-agent'],
	'snake': ['Animal', 'Animal-agent'],
	'rat': ['Animal', 'Animal-agent'],
	'pig': ['Animal', 'Animal-agent'],
	'cow': ['Animal', 'Animal-agent'],
	'sheep': ['Animal', 'Animal-agent'],
	'goat': ['Animal', 'Animal-agent'],
	'deer': ['Animal', 'Animal-agent'],
	'rabbit': ['Animal', 'Animal-agent'],
	'squirrel': ['Animal', 'Animal-agent'],
	'marmoset': ['Animal', 'Animal-agent'],
	'primate': ['Animal', 'Animal-agent'],
	'mammal': ['Animal', 'Animal-agent'],
	'creature': ['Animal', 'Animal-agent', 'Organism'],
	'beast': ['Animal', 'Animal-agent'],
	'pet': ['Animal', 'Animal-agent'],

	// People → Human, Human-agent
	'person': ['Human', 'Human-agent'],
	'people': ['Human', 'Human-agent'],
	'man': ['Human', 'Human-agent'],
	'woman': ['Human', 'Human-agent'],
	'child': ['Human', 'Human-agent'],
	'adult': ['Human', 'Human-agent'],
	'human': ['Human', 'Human-agent'],

	// Buildings → Building
	'house': ['Building'],
	'home': ['Building'],
	'office': ['Building'],
	'school': ['Building'],
	'hospital': ['Building'],
	'church': ['Building'],
	'store': ['Building'],
	'shop': ['Building'],
	'factory': ['Building'],
	'warehouse': ['Building'],
	'residence': ['Building'],
	'apartment': ['Building'],

	// Vehicles → Vehicle
	'car': ['Vehicle'],
	'truck': ['Vehicle'],
	'bus': ['Vehicle'],
	'train': ['Vehicle'],
	'plane': ['Vehicle'],
	'boat': ['Vehicle'],
	'ship': ['Vehicle'],
	'motorcycle': ['Vehicle'],
	'bicycle': ['Vehicle'],
	'bike': ['Vehicle'],

	// Food/Drink
	'food': ['Food'],
	'meal': ['Food'],
	'eat': ['Food'],
	'eating': ['Food'],
	'drink': ['Drink'],
	'beverage': ['Drink'],
	'juice': ['Drink', 'Food'],
	'water': ['Drink'],
	'coffee': ['Drink'],
	'tea': ['Drink'],

	// Plants
	'tree': ['Plant'],
	'flower': ['Plant'],
	'grass': ['Plant'],
	'plant': ['Plant'],
	'vegetation': ['Plant'],

	// Furniture
	'chair': ['Furniture'],
	'table': ['Furniture'],
	'desk': ['Furniture'],
	'bed': ['Furniture'],
	'sofa': ['Furniture'],
	'couch': ['Furniture'],

	// Sounds
	'music': ['Musical-sound', 'Sound'],
	'noise': ['Sound', 'Environmental-sound'],
	'audio': ['Sound'],
};

/**
 * Embeddings Manager for semantic search using Qwen3-Embedding.
 */
class EmbeddingsManager {
	private embeddings: Map<string, TagEmbedding> = new Map();
	private config: EmbeddingConfig = DEFAULT_CONFIG;
	private modelLoaded = false;
	private embeddingsLoaded = false;
	private dimensions = 1024; // Qwen3-Embedding-0.6B output dimension
	private loading: Promise<boolean> | null = null;

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

			// Dynamic import of ES module
			const transformers = await import('@huggingface/transformers');
			pipeline = transformers.pipeline;

			// Create the feature extraction pipeline
			extractor = await pipeline(
				'feature-extraction',
				this.config.modelId,
				{ dtype: this.config.dtype }
			);

			this.modelLoaded = true;
			console.log('[HED Embeddings] Model loaded successfully');
			return true;
		} catch (error) {
			console.error('[HED Embeddings] Failed to load model:', error);
			this.config.enabled = false;
			return false;
		}
	}

	/**
	 * Load pre-computed embeddings from file.
	 */
	async loadEmbeddings(): Promise<boolean> {
		if (this.embeddingsLoaded) return true;

		try {
			// Try compact version first (smaller file), then full version
			let embeddingsPath = path.join(__dirname, '..', 'data', 'tag-embeddings.compact.json');
			if (!fs.existsSync(embeddingsPath)) {
				embeddingsPath = path.join(__dirname, '..', 'data', 'tag-embeddings.json');
			}
			if (fs.existsSync(embeddingsPath)) {
				const data = fs.readFileSync(embeddingsPath, 'utf-8');
				const db: EmbeddingsDatabase = JSON.parse(data);

				for (const entry of db.tags) {
					const key = `${entry.prefix}${entry.tag}`.toLowerCase();
					this.embeddings.set(key, entry);
				}

				this.dimensions = db.dimensions;
				this.embeddingsLoaded = true;
				console.log(`[HED Embeddings] Loaded ${this.embeddings.size} pre-computed embeddings`);
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
		const embeddingsPath = path.join(__dirname, '..', 'data', 'tag-embeddings.json');
		const dataDir = path.dirname(embeddingsPath);

		if (!fs.existsSync(dataDir)) {
			fs.mkdirSync(dataDir, { recursive: true });
		}

		const db: EmbeddingsDatabase = {
			version: '1.0',
			modelId: this.config.modelId,
			schemaVersion,
			dimensions: this.dimensions,
			tags: Array.from(this.embeddings.values())
		};

		fs.writeFileSync(embeddingsPath, JSON.stringify(db));
		console.log(`[HED Embeddings] Saved ${this.embeddings.size} embeddings to disk`);
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embed(text: string): Promise<number[] | null> {
		if (!this.modelLoaded) {
			const loaded = await this.initializeModel();
			if (!loaded) return null;
		}

		try {
			const output = await extractor(text, {
				pooling: 'last_token',
				normalize: true
			});

			// Convert to regular array
			const embedding = Array.from(output.data as Float32Array);
			return embedding.slice(0, this.dimensions);
		} catch (error) {
			console.error('[HED Embeddings] Embedding failed:', error);
			return null;
		}
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
				pooling: 'last_token',
				normalize: true
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
		this.embeddings.set(key, { tag, longForm, prefix, vector });
	}

	/**
	 * Find tags matching a keyword from the index.
	 * Returns tags with boosted similarity (0.95) for keyword matches.
	 */
	findByKeyword(query: string): SemanticMatch[] {
		const normalizedQuery = query.toLowerCase().trim();
		const matchingTags = KEYWORD_INDEX[normalizedQuery];

		if (!matchingTags) {
			return [];
		}

		const results: SemanticMatch[] = [];
		for (const tagName of matchingTags) {
			// Find the tag in our embeddings to get full info
			const key = tagName.toLowerCase();
			const entry = this.embeddings.get(key);
			if (entry) {
				results.push({
					tag: entry.tag,
					longForm: entry.longForm,
					prefix: entry.prefix,
					similarity: 0.95 // High similarity for keyword matches
				});
			}
		}

		return results;
	}

	/**
	 * Find semantically similar tags to a query.
	 * First checks keyword index, then falls back to embedding search.
	 */
	async findSimilar(query: string, topK: number = 10): Promise<SemanticMatch[]> {
		// Try to load pre-computed embeddings first
		await this.loadEmbeddings();

		if (this.embeddings.size === 0) {
			console.log('[HED Embeddings] No embeddings available for search');
			return [];
		}

		// First, check keyword index for direct matches
		const keywordMatches = this.findByKeyword(query);
		const keywordTagNames = new Set(keywordMatches.map(m => m.tag));

		// Generate query embedding for semantic search (lowercase)
		const queryEmbedding = await this.embed(query.toLowerCase());
		if (!queryEmbedding) {
			// Return keyword matches if embedding fails
			return keywordMatches.slice(0, topK);
		}

		// Compute similarities for embedding-based search
		const embeddingResults: SemanticMatch[] = [];

		for (const [_key, entry] of this.embeddings) {
			// Skip tags already matched by keyword
			if (keywordTagNames.has(entry.tag)) continue;

			const similarity = this.cosineSimilarity(queryEmbedding, entry.vector);
			embeddingResults.push({
				tag: entry.tag,
				longForm: entry.longForm,
				prefix: entry.prefix,
				similarity
			});
		}

		// Sort embedding results by similarity
		embeddingResults.sort((a, b) => b.similarity - a.similarity);

		// Combine: keyword matches first, then top embedding results
		const combined = [...keywordMatches, ...embeddingResults];
		return combined.slice(0, topK);
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
	 * Get the number of loaded embeddings.
	 */
	size(): number {
		return this.embeddings.size;
	}

	/**
	 * Enable or disable embeddings.
	 */
	setEnabled(enabled: boolean): void {
		this.config.enabled = enabled;
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
