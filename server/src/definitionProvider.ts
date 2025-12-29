/**
 * HED Definition Provider
 * Provides Go to Definition for Def/Name references.
 */

import { type Location, type Position, Range } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { getContentOffset, getHedRegionAtPosition, getTagAtOffset, parseJsonForHedStrings } from './documentParser.js';
import { getTsvHedRegionAtPosition, isTsvDocument, parseTsvForHedStrings } from './tsvParser.js';
import type { HedRegion } from './types.js';

/**
 * Pattern to match Def/Name or Def-expand/Name references.
 */
const DEF_REFERENCE_PATTERN = /^(Def|Def-expand)\/([A-Za-z0-9_-]+)(\/.*)?$/i;

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
 * Information about a definition location in the document.
 */
interface DefinitionLocation {
	name: string;
	region: HedRegion;
	startOffset: number;
	endOffset: number;
}

/**
 * Find the location of a definition in the document.
 */
function findDefinitionLocation(document: TextDocument, defName: string): DefinitionLocation | null {
	const regions = isTsvDocument(document) ? parseTsvForHedStrings(document) : parseJsonForHedStrings(document);

	const searchName = defName.toLowerCase();

	for (const region of regions) {
		// Find Definition/Name pattern
		const defPattern = /\(Definition\/([A-Za-z0-9_-]+)(\/\s*#)?,/g;
		let match: RegExpExecArray | null;

		while ((match = defPattern.exec(region.content)) !== null) {
			const name = match[1];
			if (name.toLowerCase() === searchName) {
				const startOffset = match.index;

				// Find the matching closing paren
				let depth = 1;
				let i = startOffset + 1;
				while (i < region.content.length && depth > 0) {
					if (region.content[i] === '(') depth++;
					if (region.content[i] === ')') depth--;
					i++;
				}

				return {
					name,
					region,
					startOffset,
					endOffset: i,
				};
			}
		}
	}

	return null;
}

/**
 * Provide Go to Definition for Def/Name references.
 */
export function provideDefinition(document: TextDocument, position: Position): Location | null {
	// Check if we're inside a HED string
	const region = getRegionAtPosition(document, position);
	if (!region) {
		return null;
	}

	// Get the offset within the HED content
	const offset = getContentOffset(region, position, document);

	// Get the tag at this position
	const tagInfo = getTagAtOffset(region.content, offset);
	if (!tagInfo) {
		return null;
	}

	const tagPath = tagInfo.tag.trim();

	// Check if this is a Def/Name or Def-expand/Name reference
	const defMatch = DEF_REFERENCE_PATTERN.exec(tagPath);
	if (!defMatch) {
		return null;
	}

	const defName = defMatch[2];

	// Find the definition in the document
	const definition = findDefinitionLocation(document, defName);
	if (!definition) {
		return null;
	}

	// Calculate the range of the Definition tag
	const startPos = document.positionAt(definition.region.contentOffset + definition.startOffset);
	const endPos = document.positionAt(definition.region.contentOffset + definition.endOffset);

	return {
		uri: document.uri,
		range: Range.create(startPos, endPos),
	};
}
