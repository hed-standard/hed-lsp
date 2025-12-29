#!/usr/bin/env npx ts-node
/**
 * Generate Embeddings Script
 * Pre-computes embeddings for HED tags AND keyword anchors using Qwen3-Embedding-0.6B.
 *
 * Creates two embedding sets:
 * 1. Tag embeddings - for direct HED tag matching
 * 2. Keyword embeddings - curated terms that point to HED tags (anchors)
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
 * Keyword index - maps search terms to HED tags.
 * Each keyword will get its own embedding.
 * Must be kept in sync with KEYWORD_INDEX in embeddings.ts
 */
const KEYWORD_INDEX: Record<string, string[]> = {
	// LAB ANIMALS
	'monkey': ['Animal', 'Animal-agent'],
	'marmoset': ['Animal', 'Animal-agent'],
	'macaque': ['Animal', 'Animal-agent'],
	'rhesus': ['Animal', 'Animal-agent'],
	'chimp': ['Animal', 'Animal-agent'],
	'chimpanzee': ['Animal', 'Animal-agent'],
	'primate': ['Animal', 'Animal-agent'],
	'mouse': ['Animal', 'Animal-agent', 'Computer-mouse'],
	'mice': ['Animal', 'Animal-agent'],
	'rat': ['Animal', 'Animal-agent'],
	'rodent': ['Animal', 'Animal-agent'],
	'hamster': ['Animal', 'Animal-agent'],
	'ferret': ['Animal', 'Animal-agent'],
	'rabbit': ['Animal', 'Animal-agent'],
	'cat': ['Animal', 'Animal-agent'],
	'dog': ['Animal', 'Animal-agent'],
	'zebrafish': ['Animal', 'Animal-agent'],
	'drosophila': ['Animal', 'Animal-agent'],
	'fly': ['Animal', 'Animal-agent'],
	'worm': ['Animal', 'Animal-agent'],
	'animal': ['Animal', 'Animal-agent'],
	'creature': ['Animal', 'Animal-agent', 'Organism'],
	'mammal': ['Animal', 'Animal-agent'],
	'bird': ['Animal', 'Animal-agent'],
	'fish': ['Animal', 'Animal-agent'],

	// HUMAN PARTICIPANTS
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

	// EXPERIMENTAL PARADIGM
	'stimulus': ['Experimental-stimulus', 'Sensory-event'],
	'stimuli': ['Experimental-stimulus', 'Sensory-event'],
	'target': ['Target', 'Experimental-stimulus'],
	'distractor': ['Distractor', 'Experimental-stimulus'],
	'probe': ['Experimental-stimulus', 'Cue'],
	'cue': ['Cue', 'Experimental-stimulus'],
	'trial': ['Experimental-trial'],
	'block': ['Time-block'],
	'run': ['Time-block'],
	'session': ['Time-block'],
	'onset': ['Onset'],
	'offset': ['Offset'],
	'duration': ['Duration'],
	'delay': ['Delay'],
	'response': ['Participant-response'],
	'feedback': ['Feedback'],
	'instruction': ['Instructional'],

	// REWARD & MOTIVATION
	'reward': ['Reward'],
	'punishment': ['Feedback'],
	'juice': ['Reward', 'Drink'],
	'sugar': ['Reward', 'Sweet'],
	'money': ['Reward'],

	// COGNITIVE STATES
	'attention': ['Attentive', 'Focused-attention'],
	'focus': ['Focused-attention', 'Attentive'],
	'alert': ['Alert'],
	'awake': ['Awake'],
	'asleep': ['Asleep'],
	'sleep': ['Asleep'],
	'drowsy': ['Drowsy'],
	'rest': ['Rest', 'Resting'],
	'resting': ['Resting', 'Rest'],
	'baseline': ['Rest'],
	'fixation': ['Fixate'],

	// EMOTIONAL STATES
	'happy': ['Happy'],
	'sad': ['Sad'],
	'angry': ['Angry'],
	'fear': ['Fearful'],
	'fearful': ['Fearful'],
	'disgusted': ['Disgusted'],
	'neutral': ['Emotionally-neutral'],
	'emotion': ['Agent-emotional-state'],
	'stressed': ['Stressed'],
	'excited': ['Excited'],

	// SENSORY - VISUAL
	'visual': ['See', 'Visual-presentation'],
	'see': ['See'],
	'look': ['See', 'Fixate'],
	'watch': ['See'],
	'image': ['Image', 'Visual-presentation'],
	'picture': ['Image', 'Photograph'],
	'photo': ['Photograph', 'Image'],
	'video': ['Audiovisual-clip'],
	'movie': ['Audiovisual-clip'],
	'face': ['Face', 'Move-face'],
	'scene': ['Image', 'Visual-presentation'],

	// SENSORY - AUDITORY
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

	// SENSORY - TACTILE
	'touch': ['Touch', 'Sense-by-touch'],
	'tactile': ['Tactile-presentation', 'Sense-by-touch'],
	'vibration': ['Tactile-vibration'],
	'pressure': ['Tactile-pressure'],
	'pain': ['Pain'],
	'temperature': ['Tactile-temperature'],

	// SENSORY - OTHER
	'smell': ['Smell', 'Olfactory-presentation'],
	'taste': ['Taste', 'Gustatory-presentation'],
	'sweet': ['Sweet', 'Taste'],
	'bitter': ['Bitter', 'Taste'],

	// MOTOR ACTIONS
	'saccade': ['Saccade', 'Move-eyes'],
	'blink': ['Blink'],
	'gaze': ['Fixate', 'Move-eyes'],
	'eye': ['Move-eyes', 'Eye'],
	'button': ['Push-button', 'Press'],
	'press': ['Press', 'Push-button'],
	'keypress': ['Press', 'Push-button'],
	'click': ['Sound', 'Beep', 'Press', 'Push-button'],
	'tap': ['Press', 'Touch'],
	'grasp': ['Grasp'],
	'reach': ['Move-body-part', 'Move-upper-extremity'],
	'walk': ['Walk'],
	'move': ['Move', 'Move-body'],
	'movement': ['Move', 'Move-body'],
	'gesture': ['Communicate-gesturally'],
	'speak': ['Communicate-vocally', 'Vocalize'],

	// EQUIPMENT
	'screen': ['Computer-screen', 'Display-device'],
	'monitor': ['Computer-screen', 'Display-device'],
	'display': ['Display-device', 'Computer-screen'],
	'headphones': ['Headphones'],
	'speaker': ['Loudspeaker'],
	'keyboard': ['Keyboard'],
	'joystick': ['Joystick'],

	// BRAIN & NEUROANATOMY
	'brain': ['Brain'],
	'cortex': ['Brain', 'Brain-region'],
	'frontal': ['Frontal-lobe', 'Brain-region'],
	'parietal': ['Parietal-lobe', 'Brain-region'],
	'temporal': ['Temporal-lobe', 'Brain-region'],
	'occipital': ['Occipital-lobe', 'Brain-region'],
	'cerebellum': ['Cerebellum', 'Brain-region'],

	// CELLULAR & NETWORK
	'neuron': ['Brain', 'Brain-region'],
	'cell': ['Brain', 'Brain-region'],
	'spike': ['Data-feature', 'Measurement-event'],
	'firing': ['Data-feature', 'Measurement-event'],
	'network': ['Brain', 'Brain-region'],
	'neural': ['Brain', 'Brain-region'],
	'oscillation': ['Data-feature'],

	// RECORDING MODALITIES
	'eeg': ['Measurement-event', 'Data-feature'],
	'meg': ['Measurement-event', 'Data-feature'],
	'fmri': ['Measurement-event', 'Data-feature'],
	'mri': ['Measurement-event'],
	'electrophysiology': ['Measurement-event', 'Data-feature'],
	'recording': ['Measurement-event', 'Data-feature'],
	'scan': ['Measurement-event'],
	'trigger': ['Cue', 'Experimental-stimulus'],

	// NATURALISTIC
	'naturalistic': ['Sensory-event', 'Experimental-stimulus'],
	'narrative': ['Audiovisual-clip', 'Sensory-event'],
	'story': ['Audiovisual-clip', 'Hear'],
	'social': ['Human-agent', 'Sensory-event'],
	'conversation': ['Communicate-vocally', 'Hear'],

	// GENERAL OBJECTS
	'house': ['Building'],
	'home': ['Building'],
	'building': ['Building'],
	'room': ['Room'],
	'car': ['Vehicle'],
	'vehicle': ['Vehicle'],
	'chair': ['Furniture'],
	'table': ['Furniture'],
	'food': ['Food'],
	'fruit': ['Fruit'],

	// BODY PARTS
	'hand': ['Hand'],
	'finger': ['Finger'],
	'arm': ['Arm'],
	'leg': ['Leg'],
	'foot': ['Foot'],
	'body': ['Body'],
	'head': ['Head', 'Move-head'],
};

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
				schemaList.push({ schema, prefix: prefix + ':' });
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
					prefix
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
	keywords: string[]
): Promise<{ tagEmbeddings: TagEmbedding[]; keywordEmbeddings: KeywordEmbedding[]; dimensions: number }> {
	console.log(`\nLoading embedding model: ${MODEL_ID}`);
	console.log('(This may take a few minutes on first run to download the model)');

	const { pipeline } = await import('@huggingface/transformers');

	const extractor = await pipeline('feature-extraction', MODEL_ID, {
		dtype: DTYPE
	});

	console.log('Model loaded.\n');

	// ---- Generate tag embeddings ----
	console.log(`Generating embeddings for ${tags.length} HED tags...`);
	const tagEmbeddings: TagEmbedding[] = [];
	let dimensions = 0;

	for (let i = 0; i < tags.length; i += BATCH_SIZE) {
		const batch = tags.slice(i, i + BATCH_SIZE);
		const texts = batch.map(t => expandTagName(t.tag));

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

				tagEmbeddings.push({
					tag: batch[j].tag,
					longForm: batch[j].longForm,
					prefix: batch[j].prefix,
					vector: Array.from(vector)
				});
			}

			const progress = Math.min(i + BATCH_SIZE, tags.length);
			process.stdout.write(`\rTags: ${progress}/${tags.length} (${Math.round(progress / tags.length * 100)}%)`);
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
				normalize: true
			});

			const data = Array.from(output.data as Float32Array);

			for (let j = 0; j < batch.length; j++) {
				const start = j * dimensions;
				const vector = data.slice(start, start + dimensions);
				const keyword = batch[j];

				keywordEmbeddings.push({
					keyword,
					targets: KEYWORD_INDEX[keyword] || [],
					vector: Array.from(vector)
				});
			}

			const progress = Math.min(i + BATCH_SIZE, keywords.length);
			process.stdout.write(`\rKeywords: ${progress}/${keywords.length} (${Math.round(progress / keywords.length * 100)}%)`);
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
	dimensions: number
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
		keywords: keywordEmbeddings
	};

	// Save full version
	fs.writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2));
	console.log(`\nSaved embeddings to ${OUTPUT_PATH}`);

	const stats = fs.statSync(OUTPUT_PATH);
	console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

	// Save compact version
	const compactPath = OUTPUT_PATH.replace('.json', '.compact.json');
	const roundVector = (v: number[]) => v.map(x => Math.round(x * 1000000) / 1000000);

	const compactDb: EmbeddingsDatabase = {
		...db,
		tags: tagEmbeddings.map(e => ({ ...e, vector: roundVector(e.vector) })),
		keywords: keywordEmbeddings.map(e => ({ ...e, vector: roundVector(e.vector) }))
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
		const keywords = Object.keys(KEYWORD_INDEX);
		console.log(`Found ${keywords.length} keywords in index`);

		// Generate embeddings for both
		const { tagEmbeddings, keywordEmbeddings, dimensions } = await generateEmbeddings(tags, keywords);

		// Save to file
		await saveEmbeddings(tagEmbeddings, keywordEmbeddings, dimensions);

		console.log('\nDone!');
		console.log(`Total: ${tagEmbeddings.length} tags + ${keywordEmbeddings.length} keywords = ${tagEmbeddings.length + keywordEmbeddings.length} embeddings`);
	} catch (error) {
		console.error('Error:', error);
		process.exit(1);
	}
}

main();
