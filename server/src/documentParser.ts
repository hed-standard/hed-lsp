/**
 * Document Parser for HED Strings
 * Extracts HED string regions from JSON documents with position tracking.
 */

import { TextDocument, Position, Range } from 'vscode-languageserver-textdocument';
import { HedRegion } from './types.js';

/**
 * Parse a JSON document and extract all HED string regions.
 * Handles nested structures like Levels.*.HED.
 */
export function parseJsonForHedStrings(document: TextDocument): HedRegion[] {
	const text = document.getText();
	const regions: HedRegion[] = [];

	// Parse JSON to get structure, then find positions in text
	let jsonObj: any;
	try {
		jsonObj = JSON.parse(text);
	} catch {
		// Invalid JSON, return empty
		return regions;
	}

	// Find all HED keys recursively
	const hedPaths = findHedPaths(jsonObj, []);

	// For each path, locate the string in the document
	for (const path of hedPaths) {
		const region = locateHedRegion(text, path, document);
		if (region) {
			regions.push(region);
		}
	}

	return regions;
}

/**
 * Recursively find all paths to HED string values in a JSON object.
 * Handles both direct "HED": "string" and nested "HED": { "key": "string" } patterns.
 */
function findHedPaths(obj: any, currentPath: string[], insideHed: boolean = false): string[][] {
	const paths: string[][] = [];

	if (obj === null || typeof obj !== 'object') {
		return paths;
	}

	for (const key of Object.keys(obj)) {
		const newPath = [...currentPath, key];
		const value = obj[key];

		if (key === 'HED') {
			if (typeof value === 'string') {
				// Direct HED string: "HED": "Sensory-event, ..."
				paths.push(newPath);
			} else if (typeof value === 'object' && value !== null) {
				// Nested HED object: "HED": { "go": "...", "stop": "..." }
				// Recursively find all string values inside
				paths.push(...findHedPaths(value, newPath, true));
			}
		} else if (insideHed && typeof value === 'string') {
			// Inside a HED object, all string values are HED strings
			paths.push(newPath);
		} else if (typeof value === 'object' && value !== null) {
			// Continue searching in nested objects
			paths.push(...findHedPaths(value, newPath, insideHed));
		}
	}

	return paths;
}

/**
 * Locate a HED string region in the document text by its JSON path.
 */
function locateHedRegion(
	text: string,
	path: string[],
	document: TextDocument
): HedRegion | null {
	// Strategy: Navigate through the JSON structure to find the offset
	let searchStart = 0;

	// For each path segment except the last, find the key
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		const keyPattern = new RegExp(`"${escapeRegex(key)}"\\s*:`);
		const match = keyPattern.exec(text.slice(searchStart));

		if (!match) {
			return null;
		}

		searchStart += match.index + match[0].length;
	}

	// Find the last key in the path and its string value
	const lastKey = path[path.length - 1];
	const keyPattern = new RegExp(`"${escapeRegex(lastKey)}"\\s*:\\s*"`);
	const keyMatch = keyPattern.exec(text.slice(searchStart));

	if (!keyMatch) {
		return null;
	}

	const valueStart = searchStart + keyMatch.index + keyMatch[0].length;

	// Find the end of the string value (handle escaped quotes)
	let valueEnd = valueStart;
	let escaped = false;

	for (let i = valueStart; i < text.length; i++) {
		const char = text[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === '\\') {
			escaped = true;
			continue;
		}

		if (char === '"') {
			valueEnd = i;
			break;
		}
	}

	// Extract the content (without quotes)
	const content = text.slice(valueStart, valueEnd);

	// Unescape the content
	const unescapedContent = unescapeJsonString(content);

	// Create the range (including quotes for the full value)
	const rangeStart = document.positionAt(valueStart - 1); // Include opening quote
	const rangeEnd = document.positionAt(valueEnd + 1); // Include closing quote

	return {
		content: unescapedContent,
		range: { start: rangeStart, end: rangeEnd },
		jsonPath: path.join('.'),
		contentOffset: valueStart
	};
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unescape a JSON string value.
 */
function unescapeJsonString(str: string): string {
	return str
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\')
		.replace(/\\n/g, '\n')
		.replace(/\\r/g, '\r')
		.replace(/\\t/g, '\t');
}

/**
 * Get the HED region at a specific position in the document.
 */
export function getHedRegionAtPosition(
	document: TextDocument,
	position: Position
): HedRegion | null {
	const regions = parseJsonForHedStrings(document);

	for (const region of regions) {
		if (isPositionInRange(position, region.range)) {
			return region;
		}
	}

	return null;
}

/**
 * Check if a position is within a range.
 */
function isPositionInRange(position: Position, range: Range): boolean {
	if (position.line < range.start.line || position.line > range.end.line) {
		return false;
	}

	if (position.line === range.start.line && position.character < range.start.character) {
		return false;
	}

	if (position.line === range.end.line && position.character > range.end.character) {
		return false;
	}

	return true;
}

/**
 * Get the offset within the HED string content for a document position.
 */
export function getContentOffset(region: HedRegion, position: Position, document: TextDocument): number {
	const documentOffset = document.offsetAt(position);
	return documentOffset - region.contentOffset;
}

/**
 * Get the tag at a specific offset within a HED string.
 * Returns the tag text and its bounds within the HED string.
 */
export function getTagAtOffset(
	hedContent: string,
	offset: number
): { tag: string; start: number; end: number } | null {
	// Find the tag boundaries
	// Tags are separated by commas, parentheses, or spaces

	const separators = /[,()]/;

	// Find start of tag
	let start = offset;
	while (start > 0 && !separators.test(hedContent[start - 1])) {
		start--;
	}

	// Find end of tag
	let end = offset;
	while (end < hedContent.length && !separators.test(hedContent[end])) {
		end++;
	}

	// Trim whitespace
	while (start < end && hedContent[start] === ' ') {
		start++;
	}
	while (end > start && hedContent[end - 1] === ' ') {
		end--;
	}

	if (start === end) {
		return null;
	}

	return {
		tag: hedContent.slice(start, end),
		start,
		end
	};
}
