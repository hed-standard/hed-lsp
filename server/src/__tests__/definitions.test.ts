/**
 * Tests for HED Definition extraction and completion.
 * Uses real HED strings and actual document parsing.
 */

import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { extractDefinitions, DefinitionInfo } from '../completion.js';

/**
 * Helper to create a TextDocument from JSON content.
 */
function createJsonDocument(content: object): TextDocument {
	return TextDocument.create(
		'file:///test.json',
		'json',
		1,
		JSON.stringify(content, null, 2)
	);
}

describe('extractDefinitions', () => {
	describe('simple definitions (without placeholders)', () => {
		it('extracts a single definition', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/MyEvent, (Sensory-event, Visual-presentation))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0]).toEqual({
				name: 'MyEvent',
				hasPlaceholder: false
			});
		});

		it('extracts multiple definitions', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/StartTrial, (Experimental-trial, Onset)), (Definition/EndTrial, (Experimental-trial, Offset))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(2);
			expect(definitions.map(d => d.name)).toEqual(['EndTrial', 'StartTrial']);
			expect(definitions.every(d => !d.hasPlaceholder)).toBe(true);
		});

		it('extracts definitions from nested HED keys', () => {
			const doc = createJsonDocument({
				'stimulus_type': {
					'HED': {
						'visual': 'Visual-presentation',
						'auditory': 'Auditory-presentation'
					}
				},
				'def_dummy': {
					'HED': '(Definition/MyStimulus, (Sensory-event))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0].name).toBe('MyStimulus');
		});
	});

	describe('definitions with placeholders', () => {
		it('detects Definition/Name/# pattern', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/PresentationRate/#, (Visual-presentation, Temporal-rate/# Hz))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0]).toEqual({
				name: 'PresentationRate',
				hasPlaceholder: true
			});
		});

		it('handles whitespace in placeholder pattern', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/MyRate/ #, (Duration/# s))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0].hasPlaceholder).toBe(true);
		});

		it('distinguishes placeholder vs non-placeholder definitions', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/SimpleEvent, (Sensory-event)), (Definition/RateEvent/#, (Temporal-rate/# Hz))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(2);

			const simple = definitions.find(d => d.name === 'SimpleEvent');
			const rate = definitions.find(d => d.name === 'RateEvent');

			expect(simple?.hasPlaceholder).toBe(false);
			expect(rate?.hasPlaceholder).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('returns empty array for document without HED keys', () => {
			const doc = createJsonDocument({
				'other_key': 'value'
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(0);
		});

		it('returns empty array for HED without definitions', () => {
			const doc = createJsonDocument({
				'event_code': {
					'HED': 'Sensory-event, Visual-presentation'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(0);
		});

		it('handles definition names with hyphens and underscores', () => {
			const doc = createJsonDocument({
				'def_dummy': {
					'HED': '(Definition/My-Event_Type, (Sensory-event))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0].name).toBe('My-Event_Type');
		});

		it('deduplicates repeated definitions', () => {
			const doc = createJsonDocument({
				'def_dummy1': {
					'HED': '(Definition/MyDef, (Event))'
				},
				'def_dummy2': {
					'HED': '(Definition/MyDef, (Event))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0].name).toBe('MyDef');
		});

		it('ignores Def references (only extracts Definition)', () => {
			const doc = createJsonDocument({
				'event_code': {
					'HED': 'Def/MyDef, Sensory-event'
				},
				'def_dummy': {
					'HED': '(Definition/MyDef, (Event))'
				}
			});

			const definitions = extractDefinitions(doc);

			// Should only find the Definition, not the Def reference
			expect(definitions).toHaveLength(1);
			expect(definitions[0].name).toBe('MyDef');
		});
	});

	describe('real-world BIDS sidecar patterns', () => {
		it('extracts from typical BIDS events sidecar', () => {
			const doc = createJsonDocument({
				'onset': {
					'Description': 'Event onset time'
				},
				'duration': {
					'Description': 'Event duration'
				},
				'trial_type': {
					'Description': 'Type of trial',
					'HED': {
						'go': 'Def/GoTrial',
						'stop': 'Def/StopTrial'
					}
				},
				'def_go': {
					'HED': '(Definition/GoTrial, (Agent-action, Go-signal))'
				},
				'def_stop': {
					'HED': '(Definition/StopTrial, (Agent-action, Stop-signal))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(2);
			expect(definitions.map(d => d.name).sort()).toEqual(['GoTrial', 'StopTrial']);
		});

		it('extracts from sidecar with rate-based definitions', () => {
			const doc = createJsonDocument({
				'stimulus_rate': {
					'Description': 'Presentation rate in Hz',
					'HED': 'Def/PresentationRate/{stimulus_rate}'
				},
				'def_rate': {
					'HED': '(Definition/PresentationRate/#, (Visual-presentation, Experimental-stimulus, Temporal-rate/# Hz))'
				}
			});

			const definitions = extractDefinitions(doc);

			expect(definitions).toHaveLength(1);
			expect(definitions[0]).toEqual({
				name: 'PresentationRate',
				hasPlaceholder: true
			});
		});
	});
});
