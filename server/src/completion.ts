/**
 * HED Completion Provider
 * Provides schema-aware autocomplete for HED strings.
 */

import {
	CompletionItem,
	CompletionItemKind,
	InsertTextFormat,
	Position
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { schemaManager } from './schemaManager.js';
import { getHedRegionAtPosition, getContentOffset, getTagAtOffset } from './documentParser.js';
import { getTsvHedRegionAtPosition, isTsvDocument } from './tsvParser.js';
import { HedTag, HedRegion } from './types.js';

/**
 * Get HED region at position for any document type.
 */
function getRegionAtPosition(document: TextDocument, position: Position): HedRegion | null {
	if (isTsvDocument(document)) {
		return getTsvHedRegionAtPosition(document, position);
	}
	return getHedRegionAtPosition(document, position);
}

/**
 * Trigger characters for HED completions.
 */
export const completionTriggerCharacters = ['/', ',', '(', ' '];

/**
 * Semantic word mappings: common terms to their HED equivalents.
 * Maps words that users might type to similar HED tags.
 */
const SEMANTIC_MAPPINGS: Record<string, string[]> = {
	// Buildings and places
	'house': ['Building', 'Residence', 'Structure'],
	'home': ['Building', 'Residence'],
	'room': ['Room', 'Indoor-place'],
	'office': ['Building', 'Workplace'],
	'school': ['Building', 'Educational-institution'],
	'hospital': ['Building', 'Medical-facility'],

	// People
	'person': ['Human', 'Agent', 'Human-agent'],
	'man': ['Human', 'Male', 'Adult'],
	'woman': ['Human', 'Female', 'Adult'],
	'child': ['Human', 'Youth'],
	'doctor': ['Human', 'Medical-practitioner'],

	// Actions
	'walk': ['Walk', 'Ambulate', 'Move'],
	'run': ['Run', 'Move-quickly'],
	'speak': ['Speak', 'Vocalize', 'Communicate'],
	'talk': ['Speak', 'Vocalize'],
	'look': ['Fixate', 'Attend-to', 'View'],
	'see': ['View', 'Perceive', 'Detect'],
	'hear': ['Hear', 'Listen', 'Perceive'],
	'touch': ['Touch', 'Feel', 'Tactile-action'],
	'grab': ['Grasp', 'Reach', 'Move-hand'],
	'hold': ['Grasp', 'Hold'],
	'push': ['Push', 'Press', 'Move'],
	'pull': ['Pull', 'Move'],
	'click': ['Press', 'Click', 'Mouse-button-press'],
	'press': ['Press', 'Push'],
	'type': ['Keyboard-key-press', 'Type'],

	// Sensory
	'sound': ['Sound', 'Auditory-presentation', 'Noise'],
	'noise': ['Noise', 'Sound', 'Signal-noise'],
	'music': ['Music', 'Sound', 'Auditory-presentation'],
	'light': ['Light', 'Illumination', 'Visual-presentation'],
	'color': ['Color', 'Hue'],
	'image': ['Image', 'Picture', 'Visual-presentation'],
	'picture': ['Image', 'Picture', 'Photograph'],
	'video': ['Video', 'Movie', 'Motion-picture'],
	'movie': ['Movie', 'Video', 'Motion-picture'],

	// Shapes
	'square': ['Square', 'Rectangle', '2D-shape'],
	'triangle': ['Triangle', '2D-shape'],
	'circle': ['Circle', 'Ellipse', '2D-shape'],
	'rectangle': ['Rectangle', '2D-shape'],

	// Time
	'start': ['Onset', 'Start', 'Beginning'],
	'end': ['Offset', 'End', 'Termination'],
	'begin': ['Onset', 'Start', 'Beginning'],
	'stop': ['Offset', 'Stop', 'Termination'],
	'pause': ['Pause', 'Break'],
	'wait': ['Delay', 'Wait', 'Pause'],

	// Experiment
	'trial': ['Trial', 'Experimental-trial'],
	'block': ['Block', 'Experimental-block'],
	'stimulus': ['Stimulus', 'Experimental-stimulus', 'Sensory-event'],
	'response': ['Response', 'Participant-response'],
	'feedback': ['Feedback', 'Informational-stimulus'],
	'cue': ['Cue', 'Warning', 'Signal'],
	'target': ['Target', 'Goal'],
	'distractor': ['Distractor', 'Non-target'],

	// Equipment
	'button': ['Button', 'Response-button', 'Mouse-button'],
	'keyboard': ['Keyboard', 'Keyboard-key'],
	'mouse': ['Mouse', 'Computer-mouse'],
	'screen': ['Screen', 'Computer-screen', 'Display'],
	'monitor': ['Screen', 'Computer-screen', 'Display'],
	'speaker': ['Speaker', 'Loudspeaker', 'Audio-device'],
	'headphone': ['Headphones', 'Audio-device'],

	// Body parts
	'eye': ['Eye', 'Eyes'],
	'hand': ['Hand', 'Hands'],
	'finger': ['Finger', 'Fingers'],
	'face': ['Face', 'Head'],
	'head': ['Head'],
	'arm': ['Arm', 'Upper-extremity'],
	'leg': ['Leg', 'Lower-extremity'],
	'foot': ['Foot', 'Feet'],
};

/**
 * Provide completion items for a position in a document.
 */
export async function provideCompletions(
	document: TextDocument,
	position: Position
): Promise<CompletionItem[]> {
	// Debug: log that completion was triggered
	console.log(`[HED] Completion triggered at line ${position.line}, char ${position.character}`);

	// Check if we're inside a HED string (works for both JSON and TSV)
	const region = getRegionAtPosition(document, position);
	if (!region) {
		console.log('[HED] No HED region found at position');
		return [];
	}

	console.log(`[HED] Found region: ${region.jsonPath}, content: "${region.content.substring(0, 50)}..."`);

	// Get the offset within the HED content
	const offset = getContentOffset(region, position, document);
	console.log(`[HED] Content offset: ${offset}`);

	// Check if we're inside a curly brace placeholder
	if (isInsidePlaceholder(region.content, offset)) {
		console.log('[HED] Inside placeholder, no completions');
		return []; // No completions inside {column} placeholders
	}

	// Analyze the context
	const context = analyzeCompletionContext(region.content, offset);
	console.log(`[HED] Completion context: type=${context.type}, parent=${context.parentTag}, prefix=${context.prefix}`);

	// Get appropriate completions based on context
	const items = await getCompletionsForContext(context);
	console.log(`[HED] Returning ${items.length} completions`);
	return items;
}

/**
 * Check if offset is inside a curly brace placeholder.
 */
function isInsidePlaceholder(content: string, offset: number): boolean {
	let depth = 0;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content[i] === '{') depth++;
		if (content[i] === '}') depth--;
	}
	return depth > 0;
}

/**
 * Completion context information.
 */
interface CompletionContext {
	/** The type of completion needed */
	type: 'top-level' | 'child' | 'partial' | 'value';
	/** Parent tag for child completions */
	parentTag?: string;
	/** Prefix for filtering */
	prefix?: string;
	/** Whether we just typed a separator */
	afterSeparator: boolean;
}

/**
 * Analyze the HED content to determine completion context.
 */
function analyzeCompletionContext(content: string, offset: number): CompletionContext {
	// Get text before cursor
	const beforeCursor = content.slice(0, offset);

	// Find the last significant character
	const trimmedBefore = beforeCursor.trimEnd();
	const lastChar = trimmedBefore[trimmedBefore.length - 1] || '';

	// Check for slash (child tag completion)
	if (lastChar === '/') {
		// Get the parent tag before the slash
		const parentMatch = beforeCursor.match(/([A-Za-z0-9_-]+)\s*\/\s*$/);
		if (parentMatch) {
			return {
				type: 'child',
				parentTag: parentMatch[1],
				afterSeparator: true
			};
		}
	}

	// Check for comma or opening parenthesis (top-level completion)
	if (lastChar === ',' || lastChar === '(') {
		return {
			type: 'top-level',
			afterSeparator: true
		};
	}

	// Check if we're in the middle of typing a tag
	const tagInfo = getTagAtOffset(content, offset);
	if (tagInfo) {
		// Check if the tag contains a slash (partial child completion)
		const slashIndex = tagInfo.tag.lastIndexOf('/');
		if (slashIndex > 0) {
			return {
				type: 'child',
				parentTag: tagInfo.tag.slice(0, slashIndex),
				prefix: tagInfo.tag.slice(slashIndex + 1),
				afterSeparator: false
			};
		}

		// Partial top-level completion
		return {
			type: 'partial',
			prefix: tagInfo.tag,
			afterSeparator: false
		};
	}

	// Default to top-level completion
	return {
		type: 'top-level',
		afterSeparator: false
	};
}

/**
 * Get completions for a given context.
 */
async function getCompletionsForContext(context: CompletionContext): Promise<CompletionItem[]> {
	const items: CompletionItem[] = [];

	switch (context.type) {
		case 'top-level':
			const topLevelTags = await schemaManager.getTopLevelTags();
			for (const tag of topLevelTags) {
				items.push(createCompletionItem(tag, context.afterSeparator));
			}
			break;

		case 'child':
			if (context.parentTag) {
				const childTags = await schemaManager.getChildTags(context.parentTag);
				for (const tag of childTags) {
					if (!context.prefix || matchesPrefix(tag.shortForm, context.prefix)) {
						items.push(createCompletionItem(tag, context.afterSeparator, context.parentTag));
					}
				}
			}
			break;

		case 'partial':
			if (context.prefix) {
				// Use enhanced search that finds tags containing the query anywhere
				const matchingTags = await schemaManager.searchTagsContaining(context.prefix);

				if (matchingTags.length > 0) {
					// Add exact and partial matches
					for (const tag of matchingTags) {
						items.push(createCompletionItem(tag, false));
					}
				}

				// Check for semantic mappings if few matches
				const lowerPrefix = context.prefix.toLowerCase();
				if (matchingTags.length < 3 && SEMANTIC_MAPPINGS[lowerPrefix]) {
					const semanticSuggestions = SEMANTIC_MAPPINGS[lowerPrefix];
					for (const suggestion of semanticSuggestions) {
						const tag = await schemaManager.findTag(suggestion);
						if (tag && !items.some(item => item.label === tag.shortForm)) {
							items.push(createSemanticSuggestion(tag, context.prefix));
						}
					}
				}

				// If few or no matches, suggest extensible parent tags
				if (matchingTags.length < 5) {
					const extensibleParents = await schemaManager.findExtensibleParents(context.prefix);
					for (const parent of extensibleParents) {
						// Don't add if already in items
						if (!items.some(item => item.label === parent.shortForm)) {
							items.push(createExtensionSuggestion(parent, context.prefix));
						}
					}
				}

				// If still no matches, add a hint about the unknown term
				if (items.length === 0) {
					items.push(createNoMatchHint(context.prefix));
				}
			}
			break;

		case 'value':
			// Value completions would go here (for takesValue tags)
			break;
	}

	return items;
}

/**
 * Check if a tag name matches a prefix (case-insensitive).
 */
function matchesPrefix(tagName: string, prefix: string): boolean {
	return tagName.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Create a completion item from a HED tag.
 */
function createCompletionItem(
	tag: HedTag,
	addLeadingSpace: boolean = false,
	parentPath?: string
): CompletionItem {
	const insertText = addLeadingSpace ? ` ${tag.shortForm}` : tag.shortForm;

	const item: CompletionItem = {
		label: tag.shortForm,
		kind: CompletionItemKind.Value,
		detail: tag.longForm,
		documentation: formatTagDocumentation(tag),
		insertText,
		insertTextFormat: InsertTextFormat.PlainText,
		sortText: getSortText(tag)
	};

	// Add a slash hint if the tag has children
	if (tag.children.length > 0) {
		item.command = {
			title: 'Show children',
			command: 'editor.action.triggerSuggest'
		};
	}

	return item;
}

/**
 * Format tag documentation for display.
 */
function formatTagDocumentation(tag: HedTag): string {
	const lines: string[] = [];

	if (tag.description) {
		lines.push(tag.description);
	}

	lines.push('');
	lines.push(`**Path:** ${tag.longForm}`);

	if (tag.attributes.takesValue) {
		lines.push('**Takes value:** Yes');
		if (tag.attributes.unitClass.length > 0) {
			lines.push(`**Units:** ${tag.attributes.unitClass.join(', ')}`);
		}
	}

	if (tag.attributes.extensionAllowed) {
		lines.push('**Extension allowed:** Yes');
	}

	if (tag.attributes.suggestedTag.length > 0) {
		lines.push(`**Suggested tags:** ${tag.attributes.suggestedTag.join(', ')}`);
	}

	if (tag.attributes.relatedTag.length > 0) {
		lines.push(`**Related tags:** ${tag.attributes.relatedTag.join(', ')}`);
	}

	return lines.join('\n');
}

/**
 * Get sort text for ordering completions.
 * Lower values appear first.
 */
function getSortText(tag: HedTag, priority: number = 2): string {
	// Priority: 1 = exact match, 2 = normal, 3 = extension suggestion
	return `${priority}-${tag.shortForm.toLowerCase()}`;
}

/**
 * Create a completion item for a semantic suggestion.
 */
function createSemanticSuggestion(tag: HedTag, searchTerm: string): CompletionItem {
	const item: CompletionItem = {
		label: tag.shortForm,
		kind: CompletionItemKind.Reference,
		detail: `Similar to "${searchTerm}"`,
		documentation: formatSemanticDocumentation(tag, searchTerm),
		insertText: tag.shortForm,
		insertTextFormat: InsertTextFormat.PlainText,
		sortText: getSortText(tag, 1), // High priority for semantic matches
		filterText: searchTerm, // Allow VS Code to show this when typing the search term
		labelDetails: {
			description: `(for "${searchTerm}")`
		}
	};

	return item;
}

/**
 * Format documentation for a semantic suggestion.
 */
function formatSemanticDocumentation(tag: HedTag, searchTerm: string): string {
	const lines: string[] = [];

	lines.push(`**Did you mean \`${tag.shortForm}\`?**`);
	lines.push('');
	lines.push(`The term "${searchTerm}" is not in HED, but \`${tag.shortForm}\` is similar.`);
	lines.push('');

	if (tag.description) {
		lines.push(tag.description);
		lines.push('');
	}

	lines.push(`**Path:** ${tag.longForm}`);

	if (tag.attributes.extensionAllowed) {
		lines.push('');
		lines.push(`**Tip:** You can extend this tag: \`${tag.shortForm}/${searchTerm}\``);
	}

	return lines.join('\n');
}

/**
 * Create a completion item suggesting to extend a parent tag.
 */
function createExtensionSuggestion(parent: HedTag, searchTerm: string): CompletionItem {
	// Format the extension: Parent/SearchTerm
	const extensionName = searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1).toLowerCase();
	const insertText = `${parent.shortForm}/${extensionName}`;

	return {
		label: `${parent.shortForm}/${extensionName}`,
		kind: CompletionItemKind.Snippet,
		detail: `Extend ${parent.shortForm} with "${extensionName}"`,
		documentation: formatExtensionDocumentation(parent, searchTerm),
		insertText,
		insertTextFormat: InsertTextFormat.PlainText,
		sortText: getSortText(parent, 3),
		filterText: searchTerm, // Allow VS Code to show this when typing the search term
		labelDetails: {
			description: '(extension)'
		}
	};
}

/**
 * Format documentation for an extension suggestion.
 */
function formatExtensionDocumentation(parent: HedTag, searchTerm: string): string {
	const lines: string[] = [];

	lines.push(`**"${searchTerm}" is not in the HED schema**`);
	lines.push('');
	lines.push(`Consider extending \`${parent.shortForm}\` to create \`${parent.shortForm}/${searchTerm}\``);
	lines.push('');

	if (parent.description) {
		lines.push(`**${parent.shortForm}:** ${parent.description}`);
		lines.push('');
	}

	lines.push(`**Path:** ${parent.longForm}`);
	lines.push('');
	lines.push('**Note:** Extensions should maintain the is-a relationship with the parent tag.');

	return lines.join('\n');
}

/**
 * Create a hint when no matching tags are found.
 */
function createNoMatchHint(searchTerm: string): CompletionItem {
	return {
		label: `"${searchTerm}" - not found`,
		kind: CompletionItemKind.Text,
		detail: 'No matching HED tags found',
		documentation: [
			`**"${searchTerm}" is not in the HED schema**`,
			'',
			'Suggestions:',
			'- Check for typos in the tag name',
			'- Browse the HED schema for similar tags',
			'- If needed, extend an existing tag using Parent/Extension syntax',
			'',
			'**Tip:** Use a more general term to find related tags.'
		].join('\n'),
		insertText: '',
		sortText: '9-not-found'
	};
}

/**
 * Resolve additional completion item details.
 */
export async function resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
	// Could add additional documentation or details here
	// For now, all information is provided upfront
	return item;
}
