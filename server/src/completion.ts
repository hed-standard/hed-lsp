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
				const matchingTags = await schemaManager.searchTags(context.prefix);
				for (const tag of matchingTags) {
					items.push(createCompletionItem(tag, false));
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
function getSortText(tag: HedTag): string {
	// Prioritize commonly used tags
	// This could be enhanced with usage statistics
	return tag.shortForm.toLowerCase();
}

/**
 * Resolve additional completion item details.
 */
export async function resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
	// Could add additional documentation or details here
	// For now, all information is provided upfront
	return item;
}
