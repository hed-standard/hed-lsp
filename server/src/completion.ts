/**
 * HED Completion Provider
 * Provides schema-aware autocomplete for HED strings.
 */

import { type CompletionItem, CompletionItemKind, InsertTextFormat, type Position } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { getContentOffset, getHedRegionAtPosition, getTagAtOffset, parseJsonForHedStrings } from './documentParser.js';
import { embeddingsManager, type SemanticMatch } from './embeddings.js';
import { schemaManager } from './schemaManager.js';
import { SEMANTIC_MAPPINGS } from './semanticMappings.js';
import { getTsvHedRegionAtPosition, isTsvDocument, parseTsvForHedStrings } from './tsvParser.js';
import type { HedRegion, HedTag } from './types.js';

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
 * Pattern to match Definition/Name tags in HED strings.
 * Captures the definition name and optional placeholder marker.
 * Group 1: definition name, Group 2: /# if present
 */
const DEFINITION_PATTERN = /\bDefinition\/([A-Za-z0-9_-]+)(\/\s*#)?/g;

/**
 * Information about a HED definition found in the document.
 */
export interface DefinitionInfo {
	/** The definition name (e.g., "MyDef") */
	name: string;
	/** Whether this definition has a placeholder (Definition/Name/#) */
	hasPlaceholder: boolean;
}

/**
 * Extract all definition names from a document.
 * Scans all HED regions for Definition/Name patterns.
 * Tracks whether each definition has a placeholder.
 */
export function extractDefinitions(document: TextDocument): DefinitionInfo[] {
	const definitions = new Map<string, DefinitionInfo>();

	// Get all HED regions from the document
	const regions = isTsvDocument(document) ? parseTsvForHedStrings(document) : parseJsonForHedStrings(document);

	// Extract definition names from each region
	for (const region of regions) {
		let match: RegExpExecArray | null;
		DEFINITION_PATTERN.lastIndex = 0; // Reset regex state

		while ((match = DEFINITION_PATTERN.exec(region.content)) !== null) {
			const name = match[1];
			const hasPlaceholder = !!match[2]; // /# was captured

			// If we've seen this definition before, update if it has a placeholder
			const existing = definitions.get(name);
			if (!existing || hasPlaceholder) {
				definitions.set(name, { name, hasPlaceholder });
			}
		}
	}

	return Array.from(definitions.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create a completion item for a definition reference.
 * Note: For definition completions (after Def/ or Def-expand/), we never add
 * leading space since the user is completing after a slash.
 */
function createDefinitionCompletionItem(def: DefinitionInfo, isDefExpand: boolean): CompletionItem {
	const prefix = isDefExpand ? 'Def-expand' : 'Def';

	if (def.hasPlaceholder) {
		// Definition with placeholder: insert with snippet for value
		return {
			label: `${def.name}/…`,
			kind: CompletionItemKind.Reference,
			detail: `${prefix}/${def.name}/value (requires value)`,
			documentation: formatDefinitionDocumentation(def, prefix),
			insertText: `${def.name}/\${1:value}`,
			insertTextFormat: InsertTextFormat.Snippet,
			sortText: `1-${def.name.toLowerCase()}`,
		};
	} else {
		// Simple definition: insert name directly
		return {
			label: def.name,
			kind: CompletionItemKind.Reference,
			detail: `${prefix}/${def.name}`,
			documentation: formatDefinitionDocumentation(def, prefix),
			insertText: def.name,
			insertTextFormat: InsertTextFormat.PlainText,
			sortText: `1-${def.name.toLowerCase()}`,
		};
	}
}

/**
 * Format documentation for a definition completion.
 */
function formatDefinitionDocumentation(def: DefinitionInfo, prefix: string): string {
	const lines: string[] = [];

	lines.push(`**Reference to \`Definition/${def.name}${def.hasPlaceholder ? '/#' : ''}\`**`);
	lines.push('');

	if (def.hasPlaceholder) {
		lines.push(`This definition requires a value: \`${prefix}/${def.name}/value\``);
		lines.push('');
		lines.push('The value replaces the `#` placeholder in the definition content.');
	} else {
		lines.push(`Use \`${prefix}/${def.name}\` to reference this definition.`);
	}

	if (prefix === 'Def') {
		lines.push('');
		lines.push('**Tip:** Use with `Onset`/`Offset` tags for temporal scope.');
	}

	return lines.join('\n');
}

/**
 * Provide completion items for a position in a document.
 */
export async function provideCompletions(document: TextDocument, position: Position): Promise<CompletionItem[]> {
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
	const items = await getCompletionsForContext(context, document);
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
				afterSeparator: true,
			};
		}
	}

	// Check for comma or opening parenthesis (top-level completion)
	if (lastChar === ',' || lastChar === '(') {
		return {
			type: 'top-level',
			afterSeparator: true,
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
				afterSeparator: false,
			};
		}

		// Partial top-level completion
		return {
			type: 'partial',
			prefix: tagInfo.tag,
			afterSeparator: false,
		};
	}

	// Default to top-level completion
	return {
		type: 'top-level',
		afterSeparator: false,
	};
}

/**
 * Get completions for a given context.
 */
async function getCompletionsForContext(context: CompletionContext, document: TextDocument): Promise<CompletionItem[]> {
	const items: CompletionItem[] = [];

	switch (context.type) {
		case 'top-level': {
			const topLevelTags = await schemaManager.getTopLevelTags();
			for (const tag of topLevelTags) {
				items.push(createCompletionItem(tag, context.afterSeparator));
			}
			break;
		}

		case 'child':
			if (context.parentTag) {
				// Check if completing after Def/ or Def-expand/
				const parentLower = context.parentTag.toLowerCase();
				if (parentLower === 'def' || parentLower === 'def-expand') {
					const isDefExpand = parentLower === 'def-expand';
					const definitions = extractDefinitions(document);
					console.log(`[HED] Found ${definitions.length} definitions in document`);

					for (const def of definitions) {
						if (!context.prefix || matchesPrefix(def.name, context.prefix)) {
							items.push(createDefinitionCompletionItem(def, isDefExpand));
						}
					}
					break;
				}

				// Normal child tag completion
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

				// Always run semantic search (fast with pre-loaded embeddings)
				// Direct matches are ranked higher via sortText priority
				const semanticMatches = await getSemanticSuggestions(context.prefix);
				for (const match of semanticMatches) {
					// Skip if already in items (direct match takes precedence)
					const fullTag = match.prefix + match.tag;
					if (!items.some((item) => item.label === fullTag)) {
						items.push(createSemanticSuggestionFromMatch(match, context.prefix));
					}
				}

				// If few or no matches, suggest extensible parent tags
				if (matchingTags.length < 5) {
					const extensibleParents = await schemaManager.findExtensibleParents(context.prefix);
					for (const parent of extensibleParents) {
						// Don't add if already in items
						if (!items.some((item) => item.label === parent.shortForm)) {
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
function createCompletionItem(tag: HedTag, addLeadingSpace: boolean = false, _parentPath?: string): CompletionItem {
	const insertText = addLeadingSpace ? ` ${tag.shortForm}` : tag.shortForm;

	const item: CompletionItem = {
		label: tag.shortForm,
		kind: CompletionItemKind.Value,
		detail: tag.longForm,
		documentation: formatTagDocumentation(tag),
		insertText,
		insertTextFormat: InsertTextFormat.PlainText,
		sortText: getSortText(tag),
	};

	// Add a slash hint if the tag has children
	if (tag.children.length > 0) {
		item.command = {
			title: 'Show children',
			command: 'editor.action.triggerSuggest',
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
function _createSemanticSuggestion(tag: HedTag, searchTerm: string): CompletionItem {
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
			description: `(for "${searchTerm}")`,
		},
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
 * Minimum similarity threshold for embedding-based suggestions.
 */
const SIMILARITY_THRESHOLD = 0.3;

/**
 * Get semantic suggestions using embedding-based search.
 * Falls back to static mappings if embeddings aren't available.
 */
async function getSemanticSuggestions(query: string): Promise<SemanticMatch[]> {
	// Try embedding-based search first
	try {
		const matches = await embeddingsManager.findSimilar(query, 5);
		// Filter by similarity threshold
		return matches.filter((m) => m.similarity >= SIMILARITY_THRESHOLD);
	} catch (_error) {
		console.log('[HED] Embedding search failed, falling back to static mappings');
	}

	// Fallback to static mappings
	const lowerQuery = query.toLowerCase();
	if (SEMANTIC_MAPPINGS[lowerQuery]) {
		const results: SemanticMatch[] = [];
		for (const tagName of SEMANTIC_MAPPINGS[lowerQuery]) {
			results.push({
				tag: tagName,
				longForm: tagName,
				prefix: '',
				similarity: 0.8, // High similarity for static mappings
			});
		}
		return results;
	}

	return [];
}

/**
 * Create a completion item from an embedding search match.
 */
function createSemanticSuggestionFromMatch(match: SemanticMatch, searchTerm: string): CompletionItem {
	const fullTag = match.prefix + match.tag;
	const similarityPercent = Math.round(match.similarity * 100);

	return {
		label: fullTag,
		kind: CompletionItemKind.Reference,
		detail: `${similarityPercent}% similar to "${searchTerm}"`,
		documentation: formatSemanticMatchDocumentation(match, searchTerm),
		insertText: fullTag,
		insertTextFormat: InsertTextFormat.PlainText,
		// Priority 4 = after direct matches (2) and extension suggestions (3)
		sortText: `4-${String(100 - similarityPercent).padStart(3, '0')}-${fullTag.toLowerCase()}`,
		filterText: searchTerm,
		labelDetails: {
			description: `(semantic match)`,
		},
	};
}

/**
 * Format documentation for an embedding-based semantic match.
 */
function formatSemanticMatchDocumentation(match: SemanticMatch, searchTerm: string): string {
	const lines: string[] = [];
	const similarityPercent = Math.round(match.similarity * 100);

	lines.push(`**Semantic Match: \`${match.prefix}${match.tag}\`**`);
	lines.push('');
	lines.push(`The term "${searchTerm}" is similar to this HED tag (${similarityPercent}% match).`);
	lines.push('');
	lines.push(`**Path:** ${match.longForm}`);

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
			description: '(extension)',
		},
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
			'**Tip:** Use a more general term to find related tags.',
		].join('\n'),
		insertText: '',
		sortText: '9-not-found',
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
