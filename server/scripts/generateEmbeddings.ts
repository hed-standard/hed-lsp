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

	// =====================
	// SPATIAL RELATIONS (only non-HED terms)
	// =====================
	'left-of': ['Left-of'],
	'right-of': ['Right-of'],
	'near': ['Near-to'],
	'far': ['Far-from'],
	'adjacent': ['Adjacent-to'],
	'inside': ['Inside'],
	'outside': ['Outside'],
	'in-front': ['In-front-of'],
	'beside': ['Beside'],
	'center': ['Center-of'],
	'top': ['Top-of'],
	'bottom': ['Bottom-of'],
	'under': ['Under'],

	// =====================
	// TEMPORAL RELATIONS (only non-HED terms)
	// =====================
	'simultaneous': ['Synchronous-with'],
	'synchronous': ['Synchronous-with'],
	'asynchronous': ['Asynchronous-with'],
	'concurrent': ['Synchronous-with'],
	'sequential': ['After'],
	'following': ['After'],
	'preceding': ['Before'],

	// =====================
	// EXTENDED BODY PARTS (only non-HED terms)
	// =====================
	'lips': ['Lip'],
	'jaw': ['Jaw'],
	'scalp': ['Hair'],
	'chest': ['Torso'],
	'back': ['Torso'],
	'stomach': ['Abdomen'],

	// =====================
	// DATA ARTIFACTS & SIGNAL QUALITY (only non-HED terms)
	// =====================
	'artifact': ['Artifact'],
	'artefact': ['Artifact'],
	'noise-artifact': ['Artifact'],
	'muscle-artifact': ['Artifact'],
	'electrode-artifact': ['Artifact'],
	'noisy': ['Artifact'],
	'clean': ['Normal'],
	'corrupted': ['Artifact'],

	// =====================
	// SCORE LIBRARY - EEG/CLINICAL (sc: prefix)
	// =====================
	// Sleep stages
	'rem': ['sc:Sleep-stage-R'],
	'rem-sleep': ['sc:Sleep-stage-R'],
	'nrem': ['sc:Sleep-stage-N1', 'sc:Sleep-stage-N2', 'sc:Sleep-stage-N3'],
	'stage-1': ['sc:Sleep-stage-N1'],
	'stage-2': ['sc:Sleep-stage-N2'],
	'stage-3': ['sc:Sleep-stage-N3'],
	'n1': ['sc:Sleep-stage-N1'],
	'n2': ['sc:Sleep-stage-N2'],
	'n3': ['sc:Sleep-stage-N3'],
	'slow-wave-sleep': ['sc:Sleep-stage-N3'],
	'deep-sleep': ['sc:Sleep-stage-N3'],
	// Sleep features
	'spindle': ['sc:Sleep-spindle'],
	'sleep-spindle': ['sc:Sleep-spindle'],
	'k-complex': ['sc:K-complex'],
	// EEG rhythms
	'alpha-rhythm': ['sc:Alpha-activity'],
	'beta-rhythm': ['sc:Beta-activity'],
	'theta-rhythm': ['sc:Theta-activity'],
	'delta-rhythm': ['sc:Delta-activity'],
	'alpha-activity': ['sc:Alpha-activity'],
	'beta-activity': ['sc:Beta-activity'],
	'theta-activity': ['sc:Theta-activity'],
	'delta-activity': ['sc:Delta-activity'],
	// Clinical events
	'seizure': ['sc:Seizure'],
	'epileptic': ['sc:Epileptiform-activity'],
	'epileptiform': ['sc:Epileptiform-activity'],
	'spike-wave': ['sc:Spike-and-wave'],
	'sharp-wave': ['sc:Sharp-wave'],
	'interictal': ['sc:Interictal-finding'],
	'ictal': ['sc:Ictal-finding'],

	// =====================
	// ENVIRONMENTAL CONTEXT (only non-HED terms)
	// =====================
	'outdoor': ['Outdoors'],
	'indoor': ['Indoors'],
	'virtual-reality': ['Virtual-world'],
	'vr': ['Virtual-world'],
	'ar': ['Augmented-reality'],
	'underwater': ['Underwater'],
	'daytime': ['Daytime'],
	'nighttime': ['Nighttime'],
	'day': ['Daytime'],
	'night': ['Nighttime'],

	// =====================
	// INFORMATIONAL PROPERTIES (only non-HED terms)
	// =====================
	'difficult': ['Difficult'],
	'easy': ['Easy'],
	'hard': ['Difficult'],
	'predictable': ['Expected'],
	'unpredictable': ['Unexpected'],
	'meaningless': ['Nonsensical'],
	'nonsense': ['Nonsensical'],

	// =====================
	// COGNITIVE ACTIONS (only non-HED terms)
	// =====================
	'decide': ['Decide'],
	'decision': ['Decide'],
	'choose': ['Decide'],
	'choice': ['Decide'],
	'imagining': ['Imagine'],
	'mental-imagery': ['Imagine'],
	'prediction': ['Predict'],
	'expect': ['Expect'],
	'expecting': ['Expect'],
	'anticipate': ['Expect'],
	'counting': ['Count'],
	'calculate': ['Count'],
	'estimate': ['Estimate'],
	'judgment': ['Judge'],
	'attend': ['Attend-to'],
	'attending': ['Attend-to'],
	'notice': ['Attend-to'],
	'detecting': ['Detect'],
	'recognition': ['Recognize'],
	'categorize': ['Discriminate'],
	'compare': ['Compare'],
	'comparing': ['Compare'],
	'evaluate': ['Evaluate'],

	// =====================
	// LANGUAGE & LINGUISTIC TERMS (only non-HED terms)
	// =====================
	'words': ['Word'],
	'sentences': ['Sentence'],
	'text': ['Character'],
	'letters': ['Character'],
	'morpheme': ['Morpheme'],
	'reading': ['Read'],
	'writing': ['Write'],
	'spelling': ['Spell'],
	'naming': ['Communicate-vocally'],
	'comprehension': ['Hear', 'Read'],
	'language': ['Communicate'],
	'verbal': ['Communicate-vocally'],
	'nonverbal': ['Communicate-gesturally'],

	// =====================
	// COLORS (only non-HED terms - most colors are HED tags)
	// =====================
	'grey': ['Gray'],
	'colour': ['CSS-color'],
	'colored': ['CSS-color'],
	'coloured': ['CSS-color'],

	// =====================
	// VISUAL PROPERTIES (only non-HED terms)
	// =====================
	'bright': ['High-contrast'],
	'dim': ['Low-contrast'],
	'contrast': ['High-contrast'],
	'luminous': ['High-contrast'],
	'dark': ['Low-contrast'],
	'opaque': ['Opaque'],
	'transparent': ['Transparent'],
	'blurry': ['Blurry'],
	'clear': ['Clear'],
	'monochrome': ['Grayscale'],

	// =====================
	// SHAPES & GEOMETRY (only non-HED terms)
	// =====================
	'circle': ['Ellipse'],
	'circular': ['Ellipse'],
	'line': ['Line'],
	'checkerboard': ['Checkerboard'],
	'grating': ['Grating'],
	'gabor': ['Gabor-patch'],
	'dot': ['Ellipse'],

	// =====================
	// ADDITIONAL TASK TYPES (only non-HED terms)
	// =====================
	'stroop': ['Experimental-stimulus'],
	'n-back': ['Experimental-stimulus'],
	'nback': ['Experimental-stimulus'],
	'working-memory': ['Attentive'],
	'memory-task': ['Experimental-stimulus'],
	'detection': ['Experimental-stimulus', 'Target'],
	'discrimination': ['Experimental-stimulus'],
	'localization': ['Experimental-stimulus'],
	'search': ['Experimental-stimulus', 'See'],
	'visual-search': ['Experimental-stimulus', 'See'],
	'antisaccade': ['Saccade', 'Experimental-stimulus'],
	'prosaccade': ['Saccade', 'Experimental-stimulus'],
	'pursuit': ['Move-eyes'],
	'smooth-pursuit': ['Move-eyes'],

	// =====================
	// COMMUNICATION & SOCIAL (only non-HED terms)
	// =====================
	'communication': ['Communicate'],
	'talk': ['Communicate-vocally'],
	'talking': ['Communicate-vocally'],
	'chat': ['Communicate-vocally'],
	'sign': ['Communicate-gesturally'],
	'signing': ['Communicate-gesturally'],
	'facial-expression': ['Move-face'],
	'expression': ['Move-face'],
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
