/**
 * Semantic word mappings: common terms to their HED equivalents.
 * Maps words that users might type to similar HED tags.
 *
 * Used by both the LSP completion provider and the CLI tool.
 */
export const SEMANTIC_MAPPINGS: Record<string, string[]> = {
	// Buildings and places
	house: ['Building', 'Residence', 'Structure'],
	home: ['Building', 'Residence'],
	room: ['Room', 'Indoor-place'],
	office: ['Building', 'Workplace'],
	school: ['Building', 'Educational-institution'],
	hospital: ['Building', 'Medical-facility'],

	// People
	person: ['Human', 'Agent', 'Human-agent'],
	man: ['Human', 'Male', 'Adult'],
	woman: ['Human', 'Female', 'Adult'],
	child: ['Human', 'Youth'],
	doctor: ['Human', 'Medical-practitioner'],

	// Actions
	walk: ['Walk', 'Ambulate', 'Move'],
	run: ['Run', 'Move-quickly'],
	speak: ['Speak', 'Vocalize', 'Communicate'],
	talk: ['Speak', 'Vocalize'],
	look: ['Fixate', 'Attend-to', 'View'],
	see: ['View', 'Perceive', 'Detect'],
	hear: ['Hear', 'Listen', 'Perceive'],
	touch: ['Touch', 'Feel', 'Tactile-action'],
	grab: ['Grasp', 'Reach', 'Move-hand'],
	hold: ['Grasp', 'Hold'],
	push: ['Push', 'Press', 'Move'],
	pull: ['Pull', 'Move'],
	click: ['Press', 'Click', 'Mouse-button-press'],
	press: ['Press', 'Push'],
	type: ['Keyboard-key-press', 'Type'],

	// Sensory
	sound: ['Sound', 'Auditory-presentation', 'Noise'],
	noise: ['Noise', 'Sound', 'Signal-noise'],
	music: ['Music', 'Sound', 'Auditory-presentation'],
	light: ['Light', 'Illumination', 'Visual-presentation'],
	color: ['Color', 'Hue'],
	image: ['Image', 'Picture', 'Visual-presentation'],
	picture: ['Image', 'Picture', 'Photograph'],
	video: ['Video', 'Movie', 'Motion-picture'],
	movie: ['Movie', 'Video', 'Motion-picture'],
	flash: ['Flash', 'Flickering', 'Visual-presentation'],

	// Shapes
	square: ['Square', 'Rectangle', '2D-shape'],
	triangle: ['Triangle', '2D-shape'],
	circle: ['Circle', 'Ellipse', '2D-shape'],
	rectangle: ['Rectangle', '2D-shape'],

	// Time
	start: ['Onset', 'Start', 'Beginning'],
	end: ['Offset', 'End', 'Termination'],
	begin: ['Onset', 'Start', 'Beginning'],
	stop: ['Offset', 'Stop', 'Termination'],
	pause: ['Pause', 'Break'],
	wait: ['Delay', 'Wait', 'Pause'],

	// Experiment
	trial: ['Trial', 'Experimental-trial'],
	block: ['Block', 'Experimental-block'],
	stimulus: ['Stimulus', 'Experimental-stimulus', 'Sensory-event'],
	response: ['Response', 'Participant-response'],
	feedback: ['Feedback', 'Informational-stimulus'],
	cue: ['Cue', 'Warning', 'Signal'],
	target: ['Target', 'Goal'],
	distractor: ['Distractor', 'Non-target'],

	// Equipment
	button: ['Button', 'Response-button', 'Mouse-button'],
	keyboard: ['Keyboard', 'Keyboard-key'],
	mouse: ['Mouse', 'Computer-mouse'],
	screen: ['Screen', 'Computer-screen', 'Display'],
	monitor: ['Screen', 'Computer-screen', 'Display'],
	speaker: ['Speaker', 'Loudspeaker', 'Audio-device'],
	headphone: ['Headphones', 'Audio-device'],

	// Body parts
	eye: ['Eye', 'Eyes'],
	hand: ['Hand', 'Hands'],
	finger: ['Finger', 'Fingers'],
	face: ['Face', 'Head'],
	head: ['Head'],
	arm: ['Arm', 'Upper-extremity'],
	leg: ['Leg', 'Lower-extremity'],
	foot: ['Foot', 'Feet'],
};
