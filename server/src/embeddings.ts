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
 * Focused on neuroscience/neuroimaging terminology commonly used in BIDS datasets.
 */
const KEYWORD_INDEX: Record<string, string[]> = {
	// =====================
	// LAB ANIMALS (neuroscience research)
	// =====================
	// Primates
	'monkey': ['Animal', 'Animal-agent'],
	'marmoset': ['Animal', 'Animal-agent'],
	'macaque': ['Animal', 'Animal-agent'],
	'rhesus': ['Animal', 'Animal-agent'],
	'chimp': ['Animal', 'Animal-agent'],
	'chimpanzee': ['Animal', 'Animal-agent'],
	'primate': ['Animal', 'Animal-agent'],
	'ape': ['Animal', 'Animal-agent'],
	// Rodents
	'mouse': ['Animal', 'Animal-agent', 'Computer-mouse'],
	'mice': ['Animal', 'Animal-agent'],
	'rat': ['Animal', 'Animal-agent'],
	'rodent': ['Animal', 'Animal-agent'],
	'hamster': ['Animal', 'Animal-agent'],
	'gerbil': ['Animal', 'Animal-agent'],
	'guinea': ['Animal', 'Animal-agent'],  // guinea pig
	// Other lab animals
	'ferret': ['Animal', 'Animal-agent'],
	'rabbit': ['Animal', 'Animal-agent'],
	'cat': ['Animal', 'Animal-agent'],
	'dog': ['Animal', 'Animal-agent'],
	'horse': ['Animal', 'Animal-agent'],
	'pig': ['Animal', 'Animal-agent'],
	'sheep': ['Animal', 'Animal-agent'],
	'cow': ['Animal', 'Animal-agent'],
	'goat': ['Animal', 'Animal-agent'],
	// Model organisms
	'zebrafish': ['Animal', 'Animal-agent'],
	'drosophila': ['Animal', 'Animal-agent'],
	'fly': ['Animal', 'Animal-agent'],
	'worm': ['Animal', 'Animal-agent'],
	'elegans': ['Animal', 'Animal-agent'],  // C. elegans
	// General animal terms
	'animal': ['Animal', 'Animal-agent'],
	'creature': ['Animal', 'Animal-agent', 'Organism'],
	'beast': ['Animal', 'Animal-agent'],
	'mammal': ['Animal', 'Animal-agent'],
	'bird': ['Animal', 'Animal-agent'],
	'fish': ['Animal', 'Animal-agent'],
	'pet': ['Animal', 'Animal-agent'],

	// =====================
	// HUMAN PARTICIPANTS
	// =====================
	'subject': ['Human-agent', 'Experiment-participant'],
	'participant': ['Human-agent', 'Experiment-participant'],
	'volunteer': ['Human-agent', 'Experiment-participant'],
	'patient': ['Human-agent', 'Experiment-participant'],
	'person': ['Human', 'Human-agent'],
	'people': ['Human', 'Human-agent'],
	'human': ['Human', 'Human-agent'],
	'man': ['Human', 'Human-agent'],
	'woman': ['Human', 'Human-agent'],
	'child': ['Human', 'Human-agent'],
	'adult': ['Human', 'Human-agent'],
	'infant': ['Human', 'Human-agent'],
	'baby': ['Human', 'Human-agent'],
	'toddler': ['Human', 'Human-agent'],
	'adolescent': ['Human', 'Human-agent'],
	'teenager': ['Human', 'Human-agent'],
	'elderly': ['Human', 'Human-agent'],

	// =====================
	// EXPERIMENTAL PARADIGM TERMS
	// =====================
	// Stimuli
	'stimulus': ['Experimental-stimulus', 'Sensory-event'],
	'stimuli': ['Experimental-stimulus', 'Sensory-event'],
	'stim': ['Experimental-stimulus', 'Sensory-event'],
	'target': ['Target', 'Experimental-stimulus'],
	'distractor': ['Distractor', 'Experimental-stimulus'],
	'probe': ['Experimental-stimulus', 'Cue'],
	'prime': ['Experimental-stimulus', 'Cue'],
	'mask': ['Experimental-stimulus'],
	'flanker': ['Distractor', 'Experimental-stimulus'],
	// Trial structure
	'trial': ['Experimental-trial'],
	'block': ['Time-block'],
	'run': ['Time-block'],
	'session': ['Time-block'],
	'epoch': ['Time-block'],
	// Timing
	'onset': ['Onset'],
	'offset': ['Offset'],
	'duration': ['Duration'],
	'delay': ['Delay'],
	'iti': ['Experimental-intertrial'],
	'isi': ['Experimental-intertrial'],
	'soa': ['Delay'],  // stimulus onset asynchrony
	// Cues and instructions
	'cue': ['Cue', 'Experimental-stimulus'],
	'go': ['Go-signal', 'Cue'],
	'nogo': ['Cue', 'Experimental-stimulus'],
	'stop': ['Cue', 'Halt'],
	'instruction': ['Instructional'],
	'prompt': ['Cue', 'Instructional'],
	// Responses
	'response': ['Participant-response'],
	'answer': ['Participant-response'],
	'reaction': ['Participant-response'],
	'rt': ['Participant-response'],  // reaction time
	// Feedback
	'feedback': ['Feedback'],
	'correct': ['Feedback'],
	'incorrect': ['Feedback'],
	'error': ['Feedback'],
	'accuracy': ['Feedback'],

	// =====================
	// REWARD & MOTIVATION (common in animal/human neuroscience)
	// =====================
	'reward': ['Reward'],
	'punishment': ['Feedback'],
	'reinforcement': ['Reward', 'Feedback'],
	'incentive': ['Reward'],
	'juice': ['Reward', 'Drink'],  // common reward in primate studies
	'sugar': ['Reward', 'Sweet'],
	'sucrose': ['Reward', 'Sweet'],
	'money': ['Reward'],
	'monetary': ['Reward'],
	'win': ['Reward'],
	'loss': ['Feedback'],
	'gain': ['Reward'],

	// =====================
	// COGNITIVE STATES & PROCESSES
	// =====================
	// Attention
	'attention': ['Attentive', 'Focused-attention'],
	'attentive': ['Attentive'],
	'focus': ['Focused-attention', 'Attentive'],
	'focused': ['Focused-attention'],
	'concentrate': ['Focused-attention', 'Attentive'],
	'distracted': ['Distracted'],
	'vigilance': ['Attentive', 'Alert'],
	'orienting': ['Orienting-attention'],
	'covert': ['Covert-attention'],
	'overt': ['Overt-attention'],
	// Alertness/Arousal
	'alert': ['Alert'],
	'awake': ['Awake'],
	'asleep': ['Asleep'],
	'sleep': ['Asleep'],
	'drowsy': ['Drowsy'],
	'aroused': ['Aroused'],
	'arousal': ['Aroused'],
	// Rest/Baseline
	'rest': ['Rest', 'Resting'],
	'resting': ['Resting', 'Rest'],
	'baseline': ['Rest'],
	'fixation': ['Fixate'],
	'fixate': ['Fixate'],
	// Memory-related (map to cognitive states)
	'remember': ['Attentive'],
	'recall': ['Attentive'],
	'encode': ['Attentive'],
	'retrieve': ['Attentive'],

	// =====================
	// EMOTIONAL STATES
	// =====================
	'happy': ['Happy'],
	'sad': ['Sad'],
	'angry': ['Angry'],
	'fear': ['Fearful'],
	'fearful': ['Fearful'],
	'afraid': ['Fearful'],
	'scared': ['Fearful'],
	'disgusted': ['Disgusted'],
	'disgust': ['Disgusted'],
	'surprised': ['Excited'],
	'neutral': ['Emotionally-neutral'],
	'emotional': ['Agent-emotional-state'],
	'emotion': ['Agent-emotional-state'],
	'mood': ['Agent-emotional-state'],
	'anxious': ['Stressed', 'Fearful'],
	'stressed': ['Stressed'],
	'relaxed': ['Content', 'Resting'],
	'excited': ['Excited'],
	'frustrated': ['Frustrated'],
	'bored': ['Passive'],

	// =====================
	// SENSORY MODALITIES
	// =====================
	// Visual
	'visual': ['See', 'Visual-presentation'],
	'see': ['See'],
	'look': ['See', 'Fixate'],
	'watch': ['See'],
	'view': ['See', 'Visual-presentation'],
	'image': ['Image', 'Visual-presentation'],
	'picture': ['Image', 'Photograph'],
	'photo': ['Photograph', 'Image'],
	'photograph': ['Photograph'],
	'video': ['Audiovisual-clip'],
	'movie': ['Audiovisual-clip'],
	'face': ['Face', 'Move-face'],
	'scene': ['Image', 'Visual-presentation'],
	'flash': ['Visual-presentation', 'Sensory-event'],
	'flicker': ['Visual-presentation'],
	// Auditory
	'auditory': ['Hear', 'Auditory-presentation'],
	'hear': ['Hear'],
	'listen': ['Hear'],
	'sound': ['Sound'],
	'audio': ['Sound', 'Auditory-presentation'],
	'tone': ['Tone', 'Sound'],
	'beep': ['Beep', 'Sound'],
	'noise': ['Sound', 'Signal-noise'],
	'music': ['Musical-sound'],
	'speech': ['Vocalized-sound', 'Communicate-vocally'],
	'voice': ['Vocalized-sound'],
	'click': ['Sound', 'Beep', 'Press', 'Push-button'],  // both sound and action
	// Tactile/Somatosensory
	'touch': ['Touch', 'Sense-by-touch'],
	'tactile': ['Tactile-presentation', 'Sense-by-touch'],
	'vibration': ['Tactile-vibration'],
	'pressure': ['Tactile-pressure'],
	'pain': ['Pain'],
	'painful': ['Pain'],
	'thermal': ['Tactile-temperature'],
	'temperature': ['Tactile-temperature'],
	'hot': ['Tactile-temperature'],
	'cold': ['Tactile-temperature'],
	// Other senses
	'smell': ['Smell', 'Olfactory-presentation'],
	'odor': ['Smell', 'Olfactory-presentation'],
	'taste': ['Taste', 'Gustatory-presentation'],
	'sweet': ['Sweet', 'Taste'],
	'bitter': ['Bitter', 'Taste'],
	'salty': ['Salty', 'Taste'],
	'sour': ['Sour', 'Taste'],

	// =====================
	// MOTOR ACTIONS & RESPONSES
	// =====================
	// Eye movements
	'saccade': ['Saccade', 'Move-eyes'],
	'blink': ['Blink'],
	// 'fixation' defined above in cognitive states
	'gaze': ['Fixate', 'Move-eyes'],
	'eye': ['Move-eyes', 'Eye'],
	'pupil': ['Eye'],
	// Hand/Button responses
	'button': ['Push-button', 'Press'],
	'press': ['Press', 'Push-button'],
	'keypress': ['Press', 'Push-button'],
	// 'click' defined above in auditory (combines sound and press)
	'tap': ['Press', 'Touch'],
	'grip': ['Grasp'],
	'grasp': ['Grasp'],
	'reach': ['Move-body-part', 'Move-upper-extremity'],
	'point': ['Move-upper-extremity'],
	// Body movements
	'walk': ['Walk'],
	'move': ['Move', 'Move-body'],
	'movement': ['Move', 'Move-body'],
	'motion': ['Move', 'Move-body'],
	'gesture': ['Communicate-gesturally'],
	'nod': ['Nod-head'],
	'head': ['Head', 'Move-head'],
	// Speech production
	'speak': ['Communicate-vocally', 'Vocalize'],
	'say': ['Communicate-vocally'],
	'vocalize': ['Vocalize'],
	'articulate': ['Communicate-vocally'],

	// =====================
	// EQUIPMENT & DEVICES
	// =====================
	'screen': ['Computer-screen', 'Display-device'],
	'monitor': ['Computer-screen', 'Display-device'],
	'display': ['Display-device', 'Computer-screen'],
	'headphones': ['Headphones'],
	'earphones': ['Headphones'],
	'speaker': ['Loudspeaker'],
	'keyboard': ['Keyboard'],
	'joystick': ['Joystick'],
	'trackball': ['Trackball'],
	'touchscreen': ['Touchscreen'],

	// =====================
	// BRAIN & NEUROANATOMY
	// =====================
	'brain': ['Brain'],
	'cortex': ['Brain', 'Brain-region'],
	'frontal': ['Frontal-lobe', 'Brain-region'],
	'parietal': ['Parietal-lobe', 'Brain-region'],
	'temporal': ['Temporal-lobe', 'Brain-region'],
	'occipital': ['Occipital-lobe', 'Brain-region'],
	'cerebellum': ['Cerebellum', 'Brain-region'],

	// =====================
	// BODY PARTS (for annotations)
	// =====================
	'hand': ['Hand'],
	'finger': ['Finger'],
	'arm': ['Arm'],
	'leg': ['Leg'],
	'foot': ['Foot'],
	'body': ['Body'],

	// =====================
	// CELLULAR & NETWORK NEUROSCIENCE
	// =====================
	'neuron': ['Brain', 'Brain-region'],
	'cell': ['Brain', 'Brain-region'],
	'spike': ['Data-feature', 'Measurement-event'],
	'firing': ['Data-feature', 'Measurement-event'],
	'unit': ['Data-feature'],  // single unit
	'single-cell': ['Data-feature', 'Measurement-event'],
	'multi-unit': ['Data-feature', 'Measurement-event'],
	'network': ['Brain', 'Brain-region'],
	'neural': ['Brain', 'Brain-region'],
	'neuronal': ['Brain', 'Brain-region'],
	'circuit': ['Brain', 'Brain-region'],
	'ensemble': ['Brain', 'Brain-region'],
	'lfp': ['Data-feature', 'Measurement-event'],  // local field potential
	'oscillation': ['Data-feature'],
	'gamma': ['Data-feature'],
	'theta': ['Data-feature'],
	'alpha': ['Data-feature'],
	'beta': ['Data-feature'],
	'delta': ['Data-feature'],

	// =====================
	// RECORDING MODALITIES & NEUROIMAGING
	// =====================
	'eeg': ['Measurement-event', 'Data-feature'],
	'meg': ['Measurement-event', 'Data-feature'],
	'fmri': ['Measurement-event', 'Data-feature'],
	'mri': ['Measurement-event'],
	'pet-scan': ['Measurement-event'],  // 'pet' is used for animal pet
	'nirs': ['Measurement-event', 'Data-feature'],
	'fnirs': ['Measurement-event', 'Data-feature'],
	'electrophysiology': ['Measurement-event', 'Data-feature'],
	'imaging': ['Measurement-event'],
	'recording': ['Measurement-event', 'Data-feature'],
	'scan': ['Measurement-event'],
	'acquisition': ['Measurement-event'],
	'trigger': ['Cue', 'Experimental-stimulus'],
	'pulse': ['Sensory-event', 'Measurement-event'],
	'tr': ['Time-block'],  // repetition time

	// =====================
	// NATURALISTIC & ECOLOGICAL PARADIGMS
	// =====================
	'naturalistic': ['Sensory-event', 'Experimental-stimulus'],
	'ecological': ['Sensory-event'],
	'real-world': ['Sensory-event'],
	'free-viewing': ['See', 'Sensory-event'],
	'narrative': ['Audiovisual-clip', 'Sensory-event'],
	'story': ['Audiovisual-clip', 'Hear'],
	'social': ['Human-agent', 'Sensory-event'],
	'interaction': ['Communicate', 'Agent-action'],
	'conversation': ['Communicate-vocally', 'Hear'],
	'dialogue': ['Communicate-vocally', 'Hear'],

	// =====================
	// GENERAL OBJECTS & PLACES
	// =====================
	// Buildings
	'house': ['Building'],
	'home': ['Building'],
	'building': ['Building'],
	'room': ['Room'],
	'office': ['Building'],
	'lab': ['Building', 'Room'],
	'laboratory': ['Building', 'Room'],
	// Vehicles
	'car': ['Vehicle'],
	'vehicle': ['Vehicle'],
	// Furniture
	'chair': ['Furniture'],
	'table': ['Furniture'],
	'desk': ['Furniture'],
	// Food (also as stimuli)
	'food': ['Food'],
	'fruit': ['Fruit'],
	'apple': ['Apple', 'Fruit'],
	'banana': ['Banana', 'Fruit'],
};

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
	 * Loads both tag embeddings and keyword embeddings for dual-embedding search.
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
		const embeddingsPath = path.join(__dirname, '..', 'data', 'tag-embeddings.json');
		const dataDir = path.dirname(embeddingsPath);

		if (!fs.existsSync(dataDir)) {
			fs.mkdirSync(dataDir, { recursive: true });
		}

		const db: EmbeddingsDatabase = {
			version: '3.0',
			modelId: this.config.modelId,
			schemaVersion,
			dimensions: this.dimensions,
			tags: Array.from(this.tagEmbeddings.values()),
			keywords: this.keywordEmbeddings
		};

		fs.writeFileSync(embeddingsPath, JSON.stringify(db));
		console.log(`[HED Embeddings] Saved ${this.tagEmbeddings.size} tag embeddings and ${this.keywordEmbeddings.length} keyword embeddings to disk`);
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
		this.tagEmbeddings.set(key, { tag, longForm, prefix, vector });
	}

	/**
	 * Find tags matching a keyword from the deterministic index.
	 * Returns tags with boosted similarity (0.95) for exact keyword matches.
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
			const entry = this.tagEmbeddings.get(key);
			if (entry) {
				results.push({
					tag: entry.tag,
					longForm: entry.longForm,
					prefix: entry.prefix,
					similarity: 0.95 // High similarity for exact keyword matches
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
	async findSimilar(query: string, topK: number = 10): Promise<SemanticMatch[]> {
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
		const queryEmbedding = await this.embed(query.toLowerCase());
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
		const combinedScores: Map<string, {
			entry: TagEmbedding;
			keywordVotes: number;
			keywordSimilarity: number;
			directSimilarity: number;
			combinedScore: number;
		}> = new Map();

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
					combinedScore
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
					combinedScore: similarity
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
			similarity: Math.min(data.combinedScore, 0.94)
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
