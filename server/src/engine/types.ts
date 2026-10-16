/**
 * Engine types shared by validation, suggestions, and the editor adapters.
 * No LSP imports: these shapes are plain JSON so the same contract can be served over HTTP.
 */

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
