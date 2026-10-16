/**
 * HED-LSP Type Definitions
 */

import type { Position, Range } from 'vscode-languageserver';
import { DEFAULT_HED_SCHEMA } from './schemaVersion.js';

export type { HedTag, HedTagAttributes, ValidationIssue } from './engine/types.js';

/**
 * Represents a HED string region within a document.
 * Tracks the location and context of HED content for validation and features.
 */
export interface HedRegion {
	/** The raw HED string content */
	content: string;
	/** Document range of the HED string (including quotes) */
	range: Range;
	/** JSON path to this HED value (e.g., "stim_file.HED" or "Levels.happy.HED") */
	jsonPath: string;
	/** Character offset within the document where content starts (after opening quote) */
	contentOffset: number;
}

/**
 * Configuration for the HED language server.
 */
export interface HedLspSettings {
	/** HED schema version to use (e.g., "8.5.0") */
	schemaVersion: string;
	/** Maximum number of diagnostics to report */
	maxNumberOfProblems: number;
	/** Whether to validate on change (vs only on save) */
	validateOnChange: boolean;
	/** Debounce time in milliseconds for validation on change */
	debounceMs: number;
	/** Whether to enable AI-powered semantic search for HED tags */
	enableSemanticSearch: boolean;
}

/**
 * Default settings for the language server.
 */
export const defaultSettings: HedLspSettings = {
	schemaVersion: DEFAULT_HED_SCHEMA,
	maxNumberOfProblems: 100,
	validateOnChange: true,
	debounceMs: 300,
	enableSemanticSearch: false,
};

/**
 * Utility to convert bounds within a HED string to a document Range.
 * @param region - The HED region containing the string
 * @param bounds - Character bounds within the HED string [start, end]
 * @param document - The text document for position mapping
 */
export function boundsToRange(
	region: HedRegion,
	bounds: [number, number],
	positionAt: (offset: number) => Position,
): Range {
	const startOffset = region.contentOffset + bounds[0];
	const endOffset = region.contentOffset + bounds[1];
	return {
		start: positionAt(startOffset),
		end: positionAt(endOffset),
	};
}
