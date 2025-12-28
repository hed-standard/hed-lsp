/**
 * HED Tag Embeddings Module
 * Provides semantic similarity search using pre-computed embeddings.
 *
 * Embeddings are generated from tag names and descriptions using
 * character n-grams and word decomposition for a simple but effective
 * similarity measure that works offline.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Embedding entry for a HED tag.
 */
export interface TagEmbedding {
	/** Tag short form (e.g., "Building") */
	tag: string;
	/** Tag long form path */
	longForm: string;
	/** The embedding vector */
	vector: number[];
	/** Words extracted from the tag name */
	words: string[];
}

/**
 * Embeddings database.
 */
interface EmbeddingsDatabase {
	version: string;
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
	similarity: number;
	matchedWords: string[];
}

/**
 * Embeddings Manager for semantic search.
 */
class EmbeddingsManager {
	private embeddings: Map<string, TagEmbedding> = new Map();
	private loaded = false;
	private dimensions = 100; // Dimension of embedding vectors

	/**
	 * Load pre-computed embeddings from file.
	 */
	async loadEmbeddings(): Promise<boolean> {
		if (this.loaded) return true;

		try {
			const embeddingsPath = path.join(__dirname, '..', 'data', 'embeddings.json');
			if (fs.existsSync(embeddingsPath)) {
				const data = fs.readFileSync(embeddingsPath, 'utf-8');
				const db: EmbeddingsDatabase = JSON.parse(data);

				for (const entry of db.tags) {
					this.embeddings.set(entry.tag.toLowerCase(), entry);
				}

				this.dimensions = db.dimensions;
				this.loaded = true;
				console.log(`[HED Embeddings] Loaded ${this.embeddings.size} tag embeddings`);
				return true;
			}
		} catch (error) {
			console.error('[HED Embeddings] Failed to load embeddings:', error);
		}

		// If no pre-computed embeddings, we'll compute on-the-fly
		console.log('[HED Embeddings] No pre-computed embeddings found, using on-the-fly computation');
		return false;
	}

	/**
	 * Generate embedding for a query string.
	 * Uses character n-grams and word decomposition.
	 */
	generateQueryEmbedding(query: string): number[] {
		const words = this.extractWords(query);
		const ngrams = this.extractNgrams(query.toLowerCase(), 3);

		// Create a simple hash-based embedding
		const vector = new Array(this.dimensions).fill(0);

		// Add word contributions
		for (const word of words) {
			const hash = this.hashString(word);
			for (let i = 0; i < this.dimensions; i++) {
				vector[i] += Math.sin(hash * (i + 1)) * 0.5;
			}
		}

		// Add n-gram contributions
		for (const ngram of ngrams) {
			const hash = this.hashString(ngram);
			const idx = Math.abs(hash) % this.dimensions;
			vector[idx] += 1;
		}

		// Normalize
		return this.normalize(vector);
	}

	/**
	 * Generate embedding for a HED tag (name + description).
	 */
	generateTagEmbedding(tagName: string, description: string = ''): TagEmbedding {
		const words = this.extractWords(tagName);
		const descWords = description ? this.extractWords(description).slice(0, 10) : [];
		const allWords = [...words, ...descWords];

		const text = `${tagName} ${description}`.toLowerCase();
		const ngrams = this.extractNgrams(text, 3);

		const vector = new Array(this.dimensions).fill(0);

		// Word contributions (higher weight for tag name words)
		for (let i = 0; i < words.length; i++) {
			const hash = this.hashString(words[i]);
			for (let j = 0; j < this.dimensions; j++) {
				vector[j] += Math.sin(hash * (j + 1)) * (1.0 - i * 0.1);
			}
		}

		// Description word contributions (lower weight)
		for (const word of descWords) {
			const hash = this.hashString(word);
			for (let j = 0; j < this.dimensions; j++) {
				vector[j] += Math.sin(hash * (j + 1)) * 0.3;
			}
		}

		// N-gram contributions
		for (const ngram of ngrams) {
			const hash = this.hashString(ngram);
			const idx = Math.abs(hash) % this.dimensions;
			vector[idx] += 0.5;
		}

		return {
			tag: tagName,
			longForm: '',
			vector: this.normalize(vector),
			words: allWords
		};
	}

	/**
	 * Find semantically similar tags to a query.
	 */
	async findSimilar(query: string, topK: number = 10): Promise<SemanticMatch[]> {
		await this.loadEmbeddings();

		const queryWords = this.extractWords(query);
		const queryWordsLower = queryWords.map(w => w.toLowerCase());
		const queryEmbedding = this.generateQueryEmbedding(query);

		const results: SemanticMatch[] = [];

		for (const [_key, entry] of this.embeddings) {
			// Compute cosine similarity
			const similarity = this.cosineSimilarity(queryEmbedding, entry.vector);

			// Find matched words
			const matchedWords = entry.words.filter(w =>
				queryWordsLower.some(qw =>
					w.toLowerCase().includes(qw) || qw.includes(w.toLowerCase())
				)
			);

			// Boost score for word matches
			const wordBoost = matchedWords.length * 0.2;

			results.push({
				tag: entry.tag,
				longForm: entry.longForm,
				similarity: similarity + wordBoost,
				matchedWords
			});
		}

		// Sort by similarity and return top K
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, topK);
	}

	/**
	 * Find similar tags using on-the-fly embedding generation.
	 * Used when pre-computed embeddings aren't available.
	 */
	findSimilarOnTheFly(
		query: string,
		tags: Array<{ shortForm: string; longForm: string; description: string }>,
		topK: number = 10
	): SemanticMatch[] {
		const queryWords = this.extractWords(query);
		const queryWordsLower = queryWords.map(w => w.toLowerCase());
		const queryEmbedding = this.generateQueryEmbedding(query);

		const results: SemanticMatch[] = [];

		for (const tag of tags) {
			const tagEmbedding = this.generateTagEmbedding(tag.shortForm, tag.description);
			const similarity = this.cosineSimilarity(queryEmbedding, tagEmbedding.vector);

			// Find matched words
			const matchedWords = tagEmbedding.words.filter(w =>
				queryWordsLower.some(qw =>
					w.toLowerCase().includes(qw) || qw.includes(w.toLowerCase())
				)
			);

			// Boost for word matches
			const wordBoost = matchedWords.length * 0.2;

			results.push({
				tag: tag.shortForm,
				longForm: tag.longForm,
				similarity: similarity + wordBoost,
				matchedWords
			});
		}

		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, topK);
	}

	/**
	 * Check if embeddings are loaded.
	 */
	isLoaded(): boolean {
		return this.loaded && this.embeddings.size > 0;
	}

	/**
	 * Get the number of loaded embeddings.
	 */
	size(): number {
		return this.embeddings.size;
	}

	// --- Helper methods ---

	/**
	 * Extract words from a camelCase or hyphenated string.
	 */
	private extractWords(text: string): string[] {
		// Split on hyphens, underscores, spaces
		let words = text.split(/[-_\s]+/);

		// Also split camelCase
		const expanded: string[] = [];
		for (const word of words) {
			// Split camelCase: "SensoryEvent" -> ["Sensory", "Event"]
			const camelWords = word.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
			expanded.push(...camelWords);
		}

		// Filter out short words and normalize
		return expanded
			.filter(w => w.length > 2)
			.map(w => w.toLowerCase());
	}

	/**
	 * Extract character n-grams from text.
	 */
	private extractNgrams(text: string, n: number): string[] {
		const ngrams: string[] = [];
		const cleaned = text.replace(/[^a-z0-9]/g, '');

		for (let i = 0; i <= cleaned.length - n; i++) {
			ngrams.push(cleaned.slice(i, i + n));
		}

		return ngrams;
	}

	/**
	 * Simple string hash function.
	 */
	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return hash;
	}

	/**
	 * Normalize a vector to unit length.
	 */
	private normalize(vector: number[]): number[] {
		const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
		if (magnitude === 0) return vector;
		return vector.map(v => v / magnitude);
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

		// Vectors are already normalized, so this is the cosine similarity
		return dotProduct;
	}
}

// Export singleton instance
export const embeddingsManager = new EmbeddingsManager();
