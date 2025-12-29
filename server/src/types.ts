/**
 * HED-LSP Type Definitions
 */

import type { Position, Range } from 'vscode-languageserver';

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
 * Represents a validation issue from hed-validator.
 * Maps to LSP diagnostics.
 */
export interface ValidationIssue {
	/** HED error code (e.g., "TAG_INVALID", "PARENTHESES_MISMATCH") */
	hedCode: string;
	/** Internal error code from hed-validator */
	internalCode: string;
	/** Severity level */
	level: 'error' | 'warning';
	/** Human-readable error message */
	message: string;
	/** Character bounds within the HED string [start, end] */
	bounds?: [number, number];
}

/**
 * Represents a tag from the HED schema.
 * Used for completion and hover features.
 */
export interface HedTag {
	/** Short form of the tag (e.g., "Square") */
	shortForm: string;
	/** Long form with full path (e.g., "Item/Object/Geometric-object/2D-shape/Rectangle/Square") */
	longForm: string;
	/** Tag description for documentation */
	description: string;
	/** Parent tag short form, null for top-level tags */
	parent: string | null;
	/** Child tag short forms */
	children: string[];
	/** Tag attributes */
	attributes: HedTagAttributes;
}

/**
 * Attributes associated with a HED tag.
 */
export interface HedTagAttributes {
	/** Whether child extensions are allowed */
	extensionAllowed: boolean;
	/** Whether this tag takes a value (with # placeholder) */
	takesValue: boolean;
	/** Unit classes for value-taking tags */
	unitClass: string[];
	/** Suggested related tags */
	suggestedTag: string[];
	/** Related alternative tags */
	relatedTag: string[];
	/** Whether this tag requires a value */
	requireChild: boolean;
	/** Whether this tag is unique (can only appear once) */
	unique: boolean;
	/** Default unit for value-taking tags */
	defaultUnits?: string;
}

/**
 * Configuration for the HED language server.
 */
export interface HedLspSettings {
	/** HED schema version to use (e.g., "8.4.0") */
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
	schemaVersion: '8.4.0',
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
