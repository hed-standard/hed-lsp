/**
 * HED Hover Provider
 * Provides hover information for HED tags.
 */

import { Hover, Position, MarkupContent, MarkupKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { schemaManager } from './schemaManager.js';
import { getHedRegionAtPosition, getContentOffset, getTagAtOffset } from './documentParser.js';

/**
 * Provide hover information for a position in a document.
 */
export async function provideHover(
	document: TextDocument,
	position: Position
): Promise<Hover | null> {
	// Check if we're inside a HED string
	const region = getHedRegionAtPosition(document, position);
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
