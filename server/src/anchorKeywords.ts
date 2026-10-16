/**
 * Curated keyword anchors for HED semantic search.
 *
 * Each keyword is embedded by server/scripts/generateEmbeddings.ts and votes for
 * its target tags at query time. server/data/tag-embeddings.compact.json must hold
 * the same keys and targets; anchorKeywords.test.ts enforces that.
 *
 * Maps search terms to HED tags that should be suggested.
 * Focused on neuroscience/neuroimaging terminology commonly used in BIDS datasets.
 */

export const ANCHOR_KEYWORDS: Record<string, string[]> = {
	// =====================
	// LAB ANIMALS (neuroscience research)
	// =====================
	// Primates
	monkey: ['Animal', 'Animal-agent'],
	marmoset: ['Animal', 'Animal-agent'],
	macaque: ['Animal', 'Animal-agent'],
	rhesus: ['Animal', 'Animal-agent'],
	chimp: ['Animal', 'Animal-agent'],
	chimpanzee: ['Animal', 'Animal-agent'],
	primate: ['Animal', 'Animal-agent'],
	ape: ['Animal', 'Animal-agent'],
	// Rodents
	mouse: ['Animal', 'Animal-agent', 'Computer-mouse'],
	mice: ['Animal', 'Animal-agent'],
	rat: ['Animal', 'Animal-agent'],
	rodent: ['Animal', 'Animal-agent'],
	hamster: ['Animal', 'Animal-agent'],
	gerbil: ['Animal', 'Animal-agent'],
	guinea: ['Animal', 'Animal-agent'], // guinea pig
	// Other lab animals
	ferret: ['Animal', 'Animal-agent'],
	rabbit: ['Animal', 'Animal-agent'],
	cat: ['Animal', 'Animal-agent'],
	dog: ['Animal', 'Animal-agent'],
	horse: ['Animal', 'Animal-agent'],
	pig: ['Animal', 'Animal-agent'],
	sheep: ['Animal', 'Animal-agent'],
	cow: ['Animal', 'Animal-agent'],
	goat: ['Animal', 'Animal-agent'],
	// Model organisms
	zebrafish: ['Animal', 'Animal-agent'],
	drosophila: ['Animal', 'Animal-agent'],
	fly: ['Animal', 'Animal-agent'],
	worm: ['Animal', 'Animal-agent'],
	elegans: ['Animal', 'Animal-agent'], // C. elegans
	// General animal terms
	animal: ['Animal', 'Animal-agent'],
	creature: ['Animal', 'Animal-agent', 'Organism'],
	beast: ['Animal', 'Animal-agent'],
	mammal: ['Animal', 'Animal-agent'],
	bird: ['Animal', 'Animal-agent'],
	fish: ['Animal', 'Animal-agent'],
	pet: ['Animal', 'Animal-agent'],

	// =====================
	// HUMAN PARTICIPANTS
	// =====================
	subject: ['Human-agent', 'Experiment-participant'],
	participant: ['Human-agent', 'Experiment-participant'],
	volunteer: ['Human-agent', 'Experiment-participant'],
	patient: ['Human-agent', 'Experiment-participant'],
	person: ['Human', 'Human-agent'],
	people: ['Human', 'Human-agent'],
	human: ['Human', 'Human-agent'],
	man: ['Human', 'Human-agent'],
	woman: ['Human', 'Human-agent'],
	child: ['Human', 'Human-agent'],
	adult: ['Human', 'Human-agent'],
	infant: ['Human', 'Human-agent'],
	baby: ['Human', 'Human-agent'],
	toddler: ['Human', 'Human-agent'],
	adolescent: ['Human', 'Human-agent'],
	teenager: ['Human', 'Human-agent'],
	elderly: ['Human', 'Human-agent'],

	// =====================
	// EXPERIMENTAL PARADIGM TERMS
	// =====================
	// Stimuli
	stimulus: ['Experimental-stimulus', 'Sensory-event'],
	stimuli: ['Experimental-stimulus', 'Sensory-event'],
	stim: ['Experimental-stimulus', 'Sensory-event'],
	target: ['Target', 'Experimental-stimulus'],
	distractor: ['Distractor', 'Experimental-stimulus'],
	probe: ['Experimental-stimulus', 'Cue'],
	prime: ['Experimental-stimulus', 'Cue'],
	mask: ['Experimental-stimulus'],
	flanker: ['Distractor', 'Experimental-stimulus'],
	// Trial structure
	trial: ['Experimental-trial'],
	block: ['Time-block'],
	run: ['Time-block'],
	session: ['Time-block'],
	epoch: ['Time-block'],
	// Timing
	onset: ['Onset'],
	offset: ['Offset'],
	duration: ['Duration'],
	delay: ['Delay'],
	iti: ['Experimental-intertrial'],
	isi: ['Experimental-intertrial'],
	soa: ['Delay'], // stimulus onset asynchrony
	// Cues and instructions
	cue: ['Cue', 'Experimental-stimulus'],
	go: ['Go-signal', 'Cue'],
	nogo: ['Cue', 'Experimental-stimulus'],
	stop: ['Cue', 'Halt'],
	instruction: ['Instructional'],
	prompt: ['Cue', 'Instructional'],
	// Responses
	response: ['Participant-response'],
	answer: ['Participant-response'],
	reaction: ['Participant-response'],
	rt: ['Participant-response'], // reaction time
	// Feedback
	feedback: ['Feedback'],
	correct: ['Feedback'],
	incorrect: ['Feedback'],
	error: ['Feedback'],
	accuracy: ['Feedback'],

	// =====================
	// REWARD & MOTIVATION (common in animal/human neuroscience)
	// =====================
	reward: ['Reward'],
	punishment: ['Feedback'],
	reinforcement: ['Reward', 'Feedback'],
	incentive: ['Reward'],
	juice: ['Reward'], // common reward in primate studies
	sugar: ['Reward', 'Sweet'],
	sucrose: ['Reward', 'Sweet'],
	money: ['Reward'],
	monetary: ['Reward'],
	win: ['Reward'],
	loss: ['Feedback'],
	gain: ['Reward'],

	// =====================
	// COGNITIVE STATES & PROCESSES
	// =====================
	// Attention
	attention: ['Attentive', 'Focused-attention'],
	attentive: ['Attentive'],
	focus: ['Focused-attention', 'Attentive'],
	focused: ['Focused-attention'],
	concentrate: ['Focused-attention', 'Attentive'],
	distracted: ['Distracted'],
	vigilance: ['Attentive', 'Alert'],
	orienting: ['Orienting-attention'],
	covert: ['Covert-attention'],
	overt: ['Overt-attention'],
	// Alertness/Arousal
	alert: ['Alert'],
	awake: ['Awake'],
	asleep: ['Asleep'],
	sleep: ['Asleep'],
	drowsy: ['Drowsy'],
	aroused: ['Aroused'],
	arousal: ['Aroused'],
	// Rest/Baseline
	rest: ['Rest', 'Resting'],
	resting: ['Resting', 'Rest'],
	baseline: ['Rest'],
	fixation: ['Fixate'],
	fixate: ['Fixate'],
	// Memory-related (map to cognitive states)
	remember: ['Attentive'],
	recall: ['Attentive'],
	encode: ['Attentive'],
	retrieve: ['Attentive'],

	// =====================
	// EMOTIONAL STATES
	// =====================
	happy: ['Happy'],
	sad: ['Sad'],
	angry: ['Angry'],
	fear: ['Fearful'],
	fearful: ['Fearful'],
	afraid: ['Fearful'],
	scared: ['Fearful'],
	disgusted: ['Disgusted'],
	disgust: ['Disgusted'],
	surprised: ['Excited'],
	neutral: ['Emotionally-neutral'],
	emotional: ['Agent-emotional-state'],
	emotion: ['Agent-emotional-state'],
	mood: ['Agent-emotional-state'],
	anxious: ['Stressed', 'Fearful'],
	stressed: ['Stressed'],
	relaxed: ['Content', 'Resting'],
	excited: ['Excited'],
	frustrated: ['Frustrated'],
	bored: ['Passive'],

	// =====================
	// SENSORY MODALITIES
	// =====================
	// Visual
	visual: ['See', 'Visual-presentation'],
	see: ['See'],
	look: ['See', 'Fixate'],
	watch: ['See'],
	view: ['See', 'Visual-presentation'],
	image: ['Image', 'Visual-presentation'],
	picture: ['Image', 'Photograph'],
	photo: ['Photograph', 'Image'],
	photograph: ['Photograph'],
	video: ['Audiovisual-clip'],
	movie: ['Audiovisual-clip'],
	face: ['Face', 'Move-face'],
	scene: ['Image', 'Visual-presentation'],
	flash: ['Visual-presentation', 'Sensory-event'],
	flicker: ['Visual-presentation'],
	// Auditory
	auditory: ['Hear', 'Auditory-presentation'],
	hear: ['Hear'],
	listen: ['Hear'],
	sound: ['Sound'],
	audio: ['Sound', 'Auditory-presentation'],
	tone: ['Tone', 'Sound'],
	beep: ['Beep', 'Sound'],
	noise: ['Sound', 'Signal-noise'],
	music: ['Musical-sound'],
	speech: ['Vocalized-sound', 'Communicate-vocally'],
	voice: ['Vocalized-sound'],
	click: ['Sound', 'Beep', 'Press', 'Push-button'], // both sound and action
	// Tactile/Somatosensory
	touch: ['Touch', 'Sense-by-touch'],
	tactile: ['Tactile-presentation', 'Sense-by-touch'],
	vibration: ['Tactile-vibration'],
	pressure: ['Tactile-pressure'],
	pain: ['Pain'],
	painful: ['Pain'],
	thermal: ['Tactile-temperature'],
	temperature: ['Tactile-temperature'],
	hot: ['Tactile-temperature'],
	cold: ['Tactile-temperature'],
	// Other senses
	smell: ['Smell', 'Olfactory-presentation'],
	odor: ['Smell', 'Olfactory-presentation'],
	taste: ['Taste', 'Gustatory-presentation'],
	sweet: ['Sweet', 'Taste'],
	bitter: ['Bitter', 'Taste'],
	salty: ['Salty', 'Taste'],
	sour: ['Sour', 'Taste'],

	// =====================
	// MOTOR ACTIONS & RESPONSES
	// =====================
	// Eye movements
	saccade: ['Saccade', 'Move-eyes'],
	blink: ['Blink'],
	// 'fixation' defined above in cognitive states
	gaze: ['Fixate', 'Move-eyes'],
	eye: ['Move-eyes', 'Eye'],
	pupil: ['Eye'],
	// Hand/Button responses
	button: ['Push-button', 'Press'],
	press: ['Press', 'Push-button'],
	keypress: ['Press', 'Push-button'],
	// 'click' defined above in auditory (combines sound and press)
	tap: ['Press', 'Touch'],
	grip: ['Grasp'],
	grasp: ['Grasp'],
	reach: ['Move-body-part', 'Move-upper-extremity'],
	point: ['Move-upper-extremity'],
	// Body movements
	walk: ['Walk'],
	move: ['Move', 'Move-body'],
	movement: ['Move', 'Move-body'],
	motion: ['Move', 'Move-body'],
	gesture: ['Communicate-gesturally'],
	nod: ['Nod-head'],
	head: ['Head', 'Move-head'],
	// Speech production
	speak: ['Communicate-vocally', 'Vocalize'],
	say: ['Communicate-vocally'],
	vocalize: ['Vocalize'],
	articulate: ['Communicate-vocally'],

	// =====================
	// EQUIPMENT & DEVICES
	// =====================
	screen: ['Computer-screen', 'Display-device'],
	monitor: ['Computer-screen', 'Display-device'],
	display: ['Display-device', 'Computer-screen'],
	headphones: ['Headphones'],
	earphones: ['Headphones'],
	speaker: ['Loudspeaker'],
	keyboard: ['Keyboard'],
	joystick: ['Joystick'],
	touchscreen: ['Touchscreen'],

	// =====================
	// BRAIN & NEUROANATOMY
	// =====================
	brain: ['Brain'],
	cortex: ['Brain', 'Brain-region'],
	frontal: ['Frontal-lobe', 'Brain-region'],
	parietal: ['Parietal-lobe', 'Brain-region'],
	temporal: ['Temporal-lobe', 'Brain-region'],
	occipital: ['Occipital-lobe', 'Brain-region'],
	cerebellum: ['Cerebellum', 'Brain-region'],

	// =====================
	// BODY PARTS (for annotations)
	// =====================
	hand: ['Hand'],
	finger: ['Finger'],
	foot: ['Foot'],
	body: ['Body'],

	// =====================
	// CELLULAR & NETWORK NEUROSCIENCE
	// =====================
	neuron: ['Brain', 'Brain-region'],
	cell: ['Brain', 'Brain-region'],
	spike: ['Data-feature', 'Measurement-event'],
	firing: ['Data-feature', 'Measurement-event'],
	unit: ['Data-feature'], // single unit
	'single-cell': ['Data-feature', 'Measurement-event'],
	'multi-unit': ['Data-feature', 'Measurement-event'],
	network: ['Brain', 'Brain-region'],
	neural: ['Brain', 'Brain-region'],
	neuronal: ['Brain', 'Brain-region'],
	circuit: ['Brain', 'Brain-region'],
	ensemble: ['Brain', 'Brain-region'],
	lfp: ['Data-feature', 'Measurement-event'], // local field potential
	oscillation: ['Data-feature'],
	gamma: ['Data-feature'],
	theta: ['Data-feature'],
	alpha: ['Data-feature'],
	beta: ['Data-feature'],
	delta: ['Data-feature'],

	// =====================
	// RECORDING MODALITIES & NEUROIMAGING
	// =====================
	eeg: ['Measurement-event', 'Data-feature'],
	meg: ['Measurement-event', 'Data-feature'],
	fmri: ['Measurement-event', 'Data-feature'],
	mri: ['Measurement-event'],
	'pet-scan': ['Measurement-event'], // 'pet' is used for animal pet
	nirs: ['Measurement-event', 'Data-feature'],
	fnirs: ['Measurement-event', 'Data-feature'],
	electrophysiology: ['Measurement-event', 'Data-feature'],
	imaging: ['Measurement-event'],
	recording: ['Measurement-event', 'Data-feature'],
	scan: ['Measurement-event'],
	acquisition: ['Measurement-event'],
	trigger: ['Cue', 'Experimental-stimulus'],
	pulse: ['Sensory-event', 'Measurement-event'],
	tr: ['Time-block'], // repetition time

	// =====================
	// NATURALISTIC & ECOLOGICAL PARADIGMS
	// =====================
	naturalistic: ['Sensory-event', 'Experimental-stimulus'],
	ecological: ['Sensory-event'],
	'real-world': ['Sensory-event'],
	'free-viewing': ['See', 'Sensory-event'],
	narrative: ['Audiovisual-clip', 'Sensory-event'],
	story: ['Audiovisual-clip', 'Hear'],
	social: ['Human-agent', 'Sensory-event'],
	interaction: ['Communicate', 'Agent-action'],
	conversation: ['Communicate-vocally', 'Hear'],
	dialogue: ['Communicate-vocally', 'Hear'],

	// =====================
	// GENERAL OBJECTS & PLACES
	// =====================
	// Buildings
	house: ['Building'],
	home: ['Building'],
	building: ['Building'],
	room: ['Room'],
	office: ['Building'],
	lab: ['Building', 'Room'],
	laboratory: ['Building', 'Room'],
	// Vehicles
	car: ['Vehicle'],
	vehicle: ['Vehicle'],
	// Furniture
	// Food (also as stimuli)

	// =====================
	// SPATIAL RELATIONS (only non-HED terms)
	// =====================
	far: ['Far-from'],
	adjacent: ['Adjacent-to'],
	'in-front': ['In-front-of'],
	center: ['Center-of'],
	top: ['Top-of'],

	// =====================
	// TEMPORAL RELATIONS (only non-HED terms)
	// =====================
	simultaneous: ['Synchronous-with'],
	synchronous: ['Synchronous-with'],
	asynchronous: ['Asynchronous-with'],
	concurrent: ['Synchronous-with'],
	sequential: ['After'],
	following: ['After'],
	preceding: ['Before'],

	// =====================
	// EXTENDED BODY PARTS (only non-HED terms)
	// =====================
	lips: ['Lip'],
	scalp: ['Hair'],
	chest: ['Torso'],
	back: ['Torso'],
	stomach: ['Abdomen'],

	// =====================
	// DATA ARTIFACTS & SIGNAL QUALITY (only non-HED terms)
	// =====================
	clean: ['Normal'],

	// =====================
	// SCORE LIBRARY - EEG/CLINICAL (sc: prefix)
	// =====================
	// Sleep stages
	nrem: ['sc:Sleep-stage-N1', 'sc:Sleep-stage-N2', 'sc:Sleep-stage-N3'],
	'stage-1': ['sc:Sleep-stage-N1'],
	'stage-2': ['sc:Sleep-stage-N2'],
	'stage-3': ['sc:Sleep-stage-N3'],
	n1: ['sc:Sleep-stage-N1'],
	n2: ['sc:Sleep-stage-N2'],
	n3: ['sc:Sleep-stage-N3'],
	'slow-wave-sleep': ['sc:Sleep-stage-N3'],
	'deep-sleep': ['sc:Sleep-stage-N3'],
	// Sleep features
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
	'sharp-wave': ['sc:Sharp-wave'],

	// =====================
	// ENVIRONMENTAL CONTEXT (only non-HED terms)
	// =====================
	outdoor: ['Outdoors'],
	indoor: ['Indoors'],
	'virtual-reality': ['Virtual-world'],
	vr: ['Virtual-world'],
	ar: ['Augmented-reality'],

	// =====================
	// INFORMATIONAL PROPERTIES (only non-HED terms)
	// =====================
	predictable: ['Expected'],
	unpredictable: ['Unexpected'],

	// =====================
	// COGNITIVE ACTIONS (only non-HED terms)
	// =====================
	imagining: ['Imagine'],
	'mental-imagery': ['Imagine'],
	prediction: ['Predict'],
	counting: ['Count'],
	calculate: ['Count'],
	judgment: ['Judge'],
	attend: ['Attend-to'],
	attending: ['Attend-to'],
	notice: ['Attend-to'],
	detecting: ['Detect'],
	recognition: ['Recognize'],
	categorize: ['Discriminate'],

	// =====================
	// LANGUAGE & LINGUISTIC TERMS (only non-HED terms)
	// =====================
	words: ['Word'],
	sentences: ['Sentence'],
	text: ['Character'],
	letters: ['Character'],
	morpheme: ['Morpheme'],
	reading: ['Read'],
	writing: ['Write'],
	naming: ['Communicate-vocally'],
	comprehension: ['Hear', 'Read'],
	language: ['Communicate'],
	verbal: ['Communicate-vocally'],
	nonverbal: ['Communicate-gesturally'],

	// =====================
	// COLORS (only non-HED terms - most colors are HED tags)
	// =====================
	grey: ['Gray'],
	colour: ['CSS-color'],
	colored: ['CSS-color'],
	coloured: ['CSS-color'],

	// =====================
	// VISUAL PROPERTIES (only non-HED terms)
	// =====================
	monochrome: ['Grayscale'],

	// =====================
	// SHAPES & GEOMETRY (only non-HED terms)
	// =====================
	circle: ['Ellipse'],
	circular: ['Ellipse'],
	dot: ['Ellipse'],

	// =====================
	// ADDITIONAL TASK TYPES (only non-HED terms)
	// =====================
	stroop: ['Experimental-stimulus'],
	'n-back': ['Experimental-stimulus'],
	nback: ['Experimental-stimulus'],
	'working-memory': ['Attentive'],
	'memory-task': ['Experimental-stimulus'],
	detection: ['Experimental-stimulus', 'Target'],
	discrimination: ['Experimental-stimulus'],
	localization: ['Experimental-stimulus'],
	search: ['Experimental-stimulus', 'See'],
	'visual-search': ['Experimental-stimulus', 'See'],
	antisaccade: ['Saccade', 'Experimental-stimulus'],
	prosaccade: ['Saccade', 'Experimental-stimulus'],
	pursuit: ['Move-eyes'],
	'smooth-pursuit': ['Move-eyes'],

	// =====================
	// COMMUNICATION & SOCIAL (only non-HED terms)
	// =====================
	communication: ['Communicate'],
	talk: ['Communicate-vocally'],
	talking: ['Communicate-vocally'],
	chat: ['Communicate-vocally'],
	sign: ['Communicate-gesturally'],
	signing: ['Communicate-gesturally'],
	'facial-expression': ['Move-face'],
	expression: ['Move-face'],
};
