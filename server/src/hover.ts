/**
 * HED Hover Provider
 * Provides hover information for HED tags.
 */

import { Hover, Position, MarkupContent, MarkupKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { schemaManager } from './schemaManager.js';
import { parseJsonForHedStrings, getHedRegionAtPosition, getContentOffset, getTagAtOffset } from './documentParser.js';
import { parseTsvForHedStrings, getTsvHedRegionAtPosition, isTsvDocument } from './tsvParser.js';
import { HedRegion } from './types.js';

/**
 * Pattern to match Def/Name or Def-expand/Name references.
 */
const DEF_REFERENCE_PATTERN = /^(Def|Def-expand)\/([A-Za-z0-9_-]+)(\/.*)?$/i;

/**
 * Pattern to find Definition/Name in HED content.
 */
const DEFINITION_PATTERN = /\(Definition\/([A-Za-z0-9_-]+)(\/\s*#)?,\s*(\([^)]*(?:\([^)]*\)[^)]*)*\))/g;

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
 * Information about a definition found in the document.
 */
interface DefinitionLocation {
	name: string;
	hasPlaceholder: boolean;
	content: string;
	region: HedRegion;
	startOffset: number;
	endOffset: number;
}

/**
 * Find all definitions in a document.
 */
function findDefinitionsInDocument(document: TextDocument): Map<string, DefinitionLocation> {
	const definitions = new Map<string, DefinitionLocation>();

	const regions = isTsvDocument(document)
		? parseTsvForHedStrings(document)
		: parseJsonForHedStrings(document);

	for (const region of regions) {
		// Use a simpler approach: find Definition/Name patterns
		const defPattern = /\(Definition\/([A-Za-z0-9_-]+)(\/\s*#)?,/g;
		let match: RegExpExecArray | null;

		while ((match = defPattern.exec(region.content)) !== null) {
			const name = match[1];
			const hasPlaceholder = !!match[2];
			const startOffset = match.index;

			// Find the matching closing paren for this definition group
			let depth = 1;
			let i = startOffset + 1;
			while (i < region.content.length && depth > 0) {
				if (region.content[i] === '(') depth++;
				if (region.content[i] === ')') depth--;
				i++;
			}

			const fullContent = region.content.slice(startOffset, i);

			definitions.set(name.toLowerCase(), {
				name,
				hasPlaceholder,
				content: fullContent,
				region,
				startOffset,
				endOffset: i
			});
		}
	}

	return definitions;
}

/**
 * Provide hover information for a position in a document.
 */
export async function provideHover(
	document: TextDocument,
	position: Position
): Promise<Hover | null> {
	// Check if we're inside a HED string (works for both JSON and TSV)
	const region = getRegionAtPosition(document, position);
	if (!region) {
		return null;
	}

	// Get the offset within the HED content
	const offset = getContentOffset(region, position, document);

	// Check if we're inside a curly brace placeholder
	if (isInsidePlaceholder(region.content, offset)) {
		return createPlaceholderHover(region.content, offset);
	}

	// Get the tag at this position
	const tagInfo = getTagAtOffset(region.content, offset);
	if (!tagInfo) {
		return null;
	}

	// Extract the tag name (handle paths like Parent/Child)
	const tagPath = tagInfo.tag.trim();

	// Check if this is a Def/Name or Def-expand/Name reference
	const defMatch = DEF_REFERENCE_PATTERN.exec(tagPath);
	if (defMatch) {
		const defType = defMatch[1]; // "Def" or "Def-expand"
		const defName = defMatch[2]; // The definition name
		const defValue = defMatch[3]; // Optional value like "/1.5 Hz"

		// Look up the definition in the document
		const definitions = findDefinitionsInDocument(document);
		const definition = definitions.get(defName.toLowerCase());

		if (definition) {
			return createDefinitionReferenceHover(defType, defName, defValue, definition);
		} else {
			return createUndefinedReferenceHover(defType, defName);
		}
	}

	// Check if this is a Definition/Name declaration
	if (tagPath.toLowerCase().startsWith('definition/')) {
		const defName = tagPath.slice('definition/'.length).replace(/\/#$/, '');
		const definitions = findDefinitionsInDocument(document);
		const definition = definitions.get(defName.toLowerCase());
		if (definition) {
			return createDefinitionDeclarationHover(definition);
		}
	}

	const tagParts = tagPath.split('/');
	const shortForm = tagParts[tagParts.length - 1];

	// Look up the tag in the schema
	const tag = await schemaManager.findTag(shortForm);
	if (!tag) {
		return createUnknownTagHover(tagPath);
	}

	return createTagHover(tag);
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
 * Create hover for a curly brace placeholder.
 */
function createPlaceholderHover(content: string, offset: number): Hover {
	// Extract the placeholder name
	let start = offset;
	while (start > 0 && content[start - 1] !== '{') {
		start--;
	}
	let end = offset;
	while (end < content.length && content[end] !== '}') {
		end++;
	}

	const placeholderName = content.slice(start, end).trim();

	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: [
			`**Column Placeholder:** \`{${placeholderName}}\``,
			'',
			'This placeholder will be replaced with values from the column during HED assembly.',
			'',
			'Placeholders are used in BIDS sidecar files to reference values from TSV event files.'
		].join('\n')
	};

	return { contents: markdown };
}

/**
 * Create hover for a Def/Name reference that points to a known definition.
 */
function createDefinitionReferenceHover(
	defType: string,
	defName: string,
	defValue: string | undefined,
	definition: DefinitionLocation
): Hover {
	const lines: string[] = [];

	lines.push(`## ${defType}/${defName}${defValue || ''}`);
	lines.push('');
	lines.push(`**Reference to definition:** \`Definition/${definition.name}${definition.hasPlaceholder ? '/#' : ''}\``);
	lines.push('');

	if (definition.hasPlaceholder && defValue) {
		lines.push(`**Value:** \`${defValue.slice(1)}\` (replaces \`#\` in definition)`);
		lines.push('');
	} else if (definition.hasPlaceholder && !defValue) {
		lines.push('**Warning:** This definition requires a value (e.g., `Def/' + defName + '/value`)');
		lines.push('');
	}

	lines.push('### Definition Content');
	lines.push('```');
	lines.push(definition.content);
	lines.push('```');
	lines.push('');
	lines.push('*Press F12 (Go to Definition) to navigate to the definition.*');

	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: lines.join('\n')
	};

	return { contents: markdown };
}

/**
 * Create hover for a Def/Name reference to an undefined definition.
 */
function createUndefinedReferenceHover(defType: string, defName: string): Hover {
	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: [
			`## ${defType}/${defName}`,
			'',
			`**Error:** No definition found for \`${defName}\``,
			'',
			'This reference points to a definition that does not exist in the current document.',
			'',
			'To fix this:',
			`1. Add a definition: \`(Definition/${defName}, (your-tags-here))\``,
			'2. Or check for typos in the definition name'
		].join('\n')
	};

	return { contents: markdown };
}

/**
 * Create hover for a Definition/Name declaration.
 */
function createDefinitionDeclarationHover(definition: DefinitionLocation): Hover {
	const lines: string[] = [];

	lines.push(`## Definition: ${definition.name}`);
	lines.push('');

	if (definition.hasPlaceholder) {
		lines.push('**Type:** Placeholder definition (requires value when used)');
		lines.push('');
		lines.push(`**Usage:** \`Def/${definition.name}/value\` or \`Def-expand/${definition.name}/value\``);
	} else {
		lines.push('**Type:** Simple definition');
		lines.push('');
		lines.push(`**Usage:** \`Def/${definition.name}\` or \`Def-expand/${definition.name}\``);
	}

	lines.push('');
	lines.push('### Content');
	lines.push('```');
	lines.push(definition.content);
	lines.push('```');

	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: lines.join('\n')
	};

	return { contents: markdown };
}

/**
 * Create hover for an unknown tag.
 */
function createUnknownTagHover(tagPath: string): Hover {
	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: [
			`**Unknown Tag:** \`${tagPath}\``,
			'',
			'This tag was not found in the HED schema.',
			'',
			'Possible reasons:',
			'- Typo in the tag name',
			'- Tag from a library schema not currently loaded',
			'- Custom extension (if parent allows extensions)'
		].join('\n')
	};

	return { contents: markdown };
}

/**
 * Create hover for a known HED tag.
 */
function createTagHover(tag: any): Hover {
	const lines: string[] = [];

	// Tag header
	lines.push(`## ${tag.shortForm}`);
	lines.push('');

	// Description
	if (tag.description) {
		lines.push(tag.description);
		lines.push('');
	}

	// Full path
	lines.push(`**Full path:** \`${tag.longForm}\``);
	lines.push('');

	// Attributes section
	const attrLines: string[] = [];

	if (tag.attributes.takesValue) {
		attrLines.push('- Takes value: **Yes**');
		if (tag.attributes.unitClass?.length > 0) {
			attrLines.push(`- Unit classes: ${tag.attributes.unitClass.join(', ')}`);
		}
		if (tag.attributes.defaultUnits) {
			attrLines.push(`- Default units: ${tag.attributes.defaultUnits}`);
		}
	}

	if (tag.attributes.extensionAllowed) {
		attrLines.push('- Extensions allowed: **Yes**');
	}

	if (tag.attributes.requireChild) {
		attrLines.push('- Requires child: **Yes**');
	}

	if (tag.attributes.unique) {
		attrLines.push('- Unique: **Yes** (can only appear once)');
	}

	if (attrLines.length > 0) {
		lines.push('### Attributes');
		lines.push(...attrLines);
		lines.push('');
	}

	// Children
	if (tag.children?.length > 0) {
		const childPreview = tag.children.slice(0, 5);
		const moreCount = tag.children.length - 5;
		lines.push('### Children');
		lines.push(childPreview.map((c: string) => `\`${c}\``).join(', ') +
			(moreCount > 0 ? ` ... and ${moreCount} more` : ''));
		lines.push('');
	}

	// Related tags
	if (tag.attributes.suggestedTag?.length > 0) {
		lines.push('### Suggested Tags');
		lines.push(tag.attributes.suggestedTag.map((t: string) => `\`${t}\``).join(', '));
		lines.push('');
	}

	if (tag.attributes.relatedTag?.length > 0) {
		lines.push('### Related Tags');
		lines.push(tag.attributes.relatedTag.map((t: string) => `\`${t}\``).join(', '));
		lines.push('');
	}

	const markdown: MarkupContent = {
		kind: MarkupKind.Markdown,
		value: lines.join('\n')
	};

	return { contents: markdown };
}
