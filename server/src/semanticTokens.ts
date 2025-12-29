/**
 * HED Semantic Tokens Provider
 * Provides syntax highlighting for HED strings via LSP semantic tokens.
 */

import { SemanticTokensBuilder, type SemanticTokensLegend } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { parseJsonForHedStrings } from './documentParser.js';
import { isTsvDocument, parseTsvForHedStrings } from './tsvParser.js';
import type { HedRegion } from './types.js';

/**
 * Token types for HED semantic highlighting.
 */
export const tokenTypes = [
	'type', // Standard HED tag
	'class', // Library schema tag
	'function', // Definition tags (Definition, Def, Def-expand)
	'keyword', // Reserved tags (Onset, Offset, Inset, Duration, Delay)
	'variable', // Placeholders {column}
	'number', // Numeric values
	'string', // Tag paths/extensions
	'operator', // Separators (comma)
	'namespace', // Library prefix (sc:, la:)
];

/**
 * Token modifiers for HED semantic highlighting.
 */
export const tokenModifiers = [
	'declaration', // Definition declaration
	'definition', // Def reference
	'readonly', // Reserved tags
];

/**
 * The semantic tokens legend for registration.
 */
export const semanticTokensLegend: SemanticTokensLegend = {
	tokenTypes,
	tokenModifiers,
};

/**
 * Reserved HED tags that have special meaning.
 */
const RESERVED_TAGS = new Set(['onset', 'offset', 'inset', 'duration', 'delay']);

/**
 * Definition-related tags.
 */
const DEFINITION_TAGS = new Set(['definition', 'def', 'def-expand']);

/**
 * Get HED regions from a document.
 */
function getHedRegions(document: TextDocument): HedRegion[] {
	if (isTsvDocument(document)) {
		return parseTsvForHedStrings(document);
	} else if (document.uri.endsWith('.json')) {
		return parseJsonForHedStrings(document);
	}
	return [];
}

/**
 * Token information for building semantic tokens.
 */
interface TokenInfo {
	line: number;
	startChar: number;
	length: number;
	tokenType: number;
	tokenModifiers: number;
}

/**
 * Parse a HED string and extract tokens.
 */
function tokenizeHedString(content: string, region: HedRegion, document: TextDocument): TokenInfo[] {
	const tokens: TokenInfo[] = [];
	let i = 0;

	while (i < content.length) {
		const char = content[i];

		// Skip whitespace
		if (/\s/.test(char)) {
			i++;
			continue;
		}

		// Comma separator
		if (char === ',') {
			const pos = document.positionAt(region.contentOffset + i);
			tokens.push({
				line: pos.line,
				startChar: pos.character,
				length: 1,
				tokenType: tokenTypes.indexOf('operator'),
				tokenModifiers: 0,
			});
			i++;
			continue;
		}

		// Parentheses
		if (char === '(' || char === ')') {
			i++;
			continue;
		}

		// Placeholder {column}
		if (char === '{') {
			const start = i;
			while (i < content.length && content[i] !== '}') {
				i++;
			}
			if (i < content.length) {
				i++; // Include closing brace
			}
			const pos = document.positionAt(region.contentOffset + start);
			tokens.push({
				line: pos.line,
				startChar: pos.character,
				length: i - start,
				tokenType: tokenTypes.indexOf('variable'),
				tokenModifiers: 0,
			});
			continue;
		}

		// Tag (starts with letter or library prefix)
		if (/[A-Za-z]/.test(char)) {
			const start = i;
			let tagPart = '';
			let hasLibraryPrefix = false;
			let prefixEnd = 0;

			// Read until separator
			while (i < content.length && !/[,(){}]/.test(content[i])) {
				tagPart += content[i];
				i++;
			}

			tagPart = tagPart.trim();
			if (!tagPart) continue;

			// Check for library prefix (e.g., sc:Tag)
			const colonIndex = tagPart.indexOf(':');
			if (colonIndex > 0 && colonIndex <= 3) {
				const prefix = tagPart.slice(0, colonIndex);
				if (/^[a-z]{1,3}$/.test(prefix)) {
					hasLibraryPrefix = true;
					prefixEnd = colonIndex + 1;

					// Add prefix token
					const prefixPos = document.positionAt(region.contentOffset + start);
					tokens.push({
						line: prefixPos.line,
						startChar: prefixPos.character,
						length: prefixEnd,
						tokenType: tokenTypes.indexOf('namespace'),
						tokenModifiers: 0,
					});
				}
			}

			// Get the main tag name (first part before /)
			const tagContent = hasLibraryPrefix ? tagPart.slice(prefixEnd) : tagPart;
			const slashIndex = tagContent.indexOf('/');
			const mainTag = slashIndex > 0 ? tagContent.slice(0, slashIndex) : tagContent;
			const mainTagLower = mainTag.toLowerCase();

			// Determine token type
			let tokenType: number;
			let modifier = 0;

			if (DEFINITION_TAGS.has(mainTagLower)) {
				tokenType = tokenTypes.indexOf('function');
				if (mainTagLower === 'definition') {
					modifier = 1 << tokenModifiers.indexOf('declaration');
				} else {
					modifier = 1 << tokenModifiers.indexOf('definition');
				}
			} else if (RESERVED_TAGS.has(mainTagLower)) {
				tokenType = tokenTypes.indexOf('keyword');
				modifier = 1 << tokenModifiers.indexOf('readonly');
			} else if (hasLibraryPrefix) {
				tokenType = tokenTypes.indexOf('class');
			} else {
				tokenType = tokenTypes.indexOf('type');
			}

			// Add main tag token
			const tagStart = start + (hasLibraryPrefix ? prefixEnd : 0);
			const _mainTagEnd = tagStart + mainTag.length;
			const tagPos = document.positionAt(region.contentOffset + tagStart);
			tokens.push({
				line: tagPos.line,
				startChar: tagPos.character,
				length: mainTag.length,
				tokenType,
				tokenModifiers: modifier,
			});

			// Handle path/value after the main tag
			if (slashIndex > 0) {
				const rest = tagContent.slice(slashIndex);
				const restStart = tagStart + slashIndex;

				// Check if the value looks like a number or #
				const valuePart = rest.slice(1); // Skip the /
				if (/^[#0-9]/.test(valuePart)) {
					// It's a value
					const valuePos = document.positionAt(region.contentOffset + restStart + 1);
					tokens.push({
						line: valuePos.line,
						startChar: valuePos.character,
						length: valuePart.length,
						tokenType: tokenTypes.indexOf('number'),
						tokenModifiers: 0,
					});
				} else {
					// It's a path/extension
					const pathPos = document.positionAt(region.contentOffset + restStart);
					tokens.push({
						line: pathPos.line,
						startChar: pathPos.character,
						length: rest.length,
						tokenType: tokenTypes.indexOf('string'),
						tokenModifiers: 0,
					});
				}
			}

			continue;
		}

		// Skip unknown characters
		i++;
	}

	return tokens;
}

/**
 * Provide semantic tokens for a document.
 */
export function provideSemanticTokens(document: TextDocument): SemanticTokensBuilder {
	const builder = new SemanticTokensBuilder();
	const regions = getHedRegions(document);

	// Collect all tokens from all regions
	const allTokens: TokenInfo[] = [];

	for (const region of regions) {
		const tokens = tokenizeHedString(region.content, region, document);
		allTokens.push(...tokens);
	}

	// Sort tokens by position (required by semantic tokens protocol)
	allTokens.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		return a.startChar - b.startChar;
	});

	// Build tokens
	for (const token of allTokens) {
		builder.push(token.line, token.startChar, token.length, token.tokenType, token.tokenModifiers);
	}

	return builder;
}
