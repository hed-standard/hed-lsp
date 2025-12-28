/**
 * HED Validation Module
 * Wraps hed-validator for HED string validation.
 */

import { parseHedString } from 'hed-validator';
import type { Schemas } from 'hed-validator';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HedRegion, ValidationIssue, boundsToRange } from './types.js';
import { schemaManager } from './schemaManager.js';

/**
 * Remove {column_name} placeholders from a HED string without leaving empty tags.
 * Handles cases like "Tag, {column}" -> "Tag" and "({column}, Tag)" -> "(Tag)"
 */
function removePlaceholders(hedString: string): string {
	// Pattern matches placeholders with optional surrounding comma and whitespace
	// This handles: ", {col}", "{col}, ", "{col}" at start/end
	let result = hedString;

	// Remove placeholder with preceding comma: ", {col}" or " , {col}"
	result = result.replace(/\s*,\s*\{[^}]+\}/g, '');

	// Remove placeholder with following comma: "{col}, " or "{col} ,"
	result = result.replace(/\{[^}]+\}\s*,\s*/g, '');

	// Remove standalone placeholders: "{col}"
	result = result.replace(/\{[^}]+\}/g, '');

	// Clean up any remaining issues
	// Remove double commas that might result
	result = result.replace(/,\s*,/g, ',');

	// Remove leading/trailing commas from groups
	result = result.replace(/\(\s*,/g, '(');
	result = result.replace(/,\s*\)/g, ')');

	// Remove empty groups
	result = result.replace(/\(\s*\)/g, '');

	// Clean up leading/trailing commas
	result = result.replace(/^\s*,\s*/, '');
	result = result.replace(/\s*,\s*$/, '');

	return result.trim();
}

/**
 * Validate a HED string and return issues.
 */
export async function validateHedString(
	hedString: string,
	schemas: Schemas
): Promise<ValidationIssue[]> {
	// Skip validation for empty strings
	if (!hedString.trim()) {
		return [];
	}

	// Handle curly brace placeholders - remove them for validation
	// {column_name} placeholders are assembly markers and should not be validated
	const cleanedHed = removePlaceholders(hedString);

	// If only placeholders, skip validation
	if (!cleanedHed.trim()) {
		return [];
	}

	try {
		// parseHedString returns [ParsedHedString | null, Issue[], Issue[]]
		// First array is syntax issues, second is semantic issues
		const [_parsed, syntaxIssues, semanticIssues] = parseHedString(
			cleanedHed,
			schemas,
			true,  // definitionsAllowed
			true,  // placeholdersAllowed
			true   // fullValidation
		);

		const allIssues = [...syntaxIssues, ...semanticIssues];
		return allIssues.map(issue => convertIssue(issue, hedString));
	} catch (error) {
		// Return a generic error if parsing fails unexpectedly
		return [{
			hedCode: 'INTERNAL_ERROR',
			internalCode: 'internalError',
			level: 'error',
			message: `Validation error: ${error instanceof Error ? error.message : String(error)}`
		}];
	}
}

/**
 * Map internal error codes to HED error codes when hedCode is missing.
 */
const internalCodeToHedCode: Record<string, string> = {
	'unclosedParentheses': 'PARENTHESES_MISMATCH',
	'unopenedParentheses': 'PARENTHESES_MISMATCH',
	'extraDelimiter': 'TAG_EMPTY',
	'invalidTag': 'TAG_INVALID',
	'duplicateTag': 'TAG_DUPLICATE',
	'multipleUniqueTags': 'TAG_NOT_UNIQUE',
	'childRequired': 'TAG_REQUIRES_CHILD',
	'invalidValue': 'VALUE_INVALID',
	'unitClassInvalidUnit': 'UNITS_INVALID',
	'invalidPlaceholder': 'PLACEHOLDER_INVALID',
	'missingRequiredColumn': 'SIDECAR_KEY_MISSING',
};

/**
 * Convert a hed-validator Issue to our ValidationIssue type.
 * Extracts position information from various parameter formats.
 */
function convertIssue(issue: any, hedString: string): ValidationIssue {
	// Parse parameters if it's a string (may be nested)
	let params = issue.parameters || {};
	if (typeof params === 'string') {
		try {
			params = JSON.parse(params);
		} catch {
			params = {};
		}
	}
	// Handle nested parameters string
	if (params.parameters && typeof params.parameters === 'string') {
		try {
			const nestedParams = JSON.parse(params.parameters.replace('Issue parameters: ', ''));
			params = { ...params, ...nestedParams };
		} catch {
			// Ignore nested parsing errors
		}
	}

	// Get HED code - if it's a generic error, try to use the internal code instead
	let hedCode = issue.hedCode || issue.code;

	// Try multiple sources for internal code
	let internalCode = issue.internalCode || params.internalCode;

	// If still no internal code, try to extract from message
	if (!internalCode && issue.message) {
		const match = issue.message.match(/"internalCode"\s*:\s*"([^"]+)"/);
		if (match) {
			internalCode = match[1];
		}
	}

	// Generic error codes that should be remapped using internal code
	const genericCodes = ['INTERNAL_ERROR', 'GENERICERROR', 'GENERIC_ERROR', 'UNKNOWN'];

	// If hedCode is generic or missing, try to map from internal code
	if (!hedCode || genericCodes.includes(hedCode)) {
		if (internalCode && internalCodeToHedCode[internalCode]) {
			hedCode = internalCodeToHedCode[internalCode];
		} else if (internalCode) {
			hedCode = internalCode.toUpperCase();
		}
	}
	hedCode = hedCode || 'UNKNOWN';

	// Try to extract bounds from different parameter formats
	let bounds: [number, number] | undefined = params.bounds;

	if (!bounds) {
		// Check for index (used by PARENTHESES_MISMATCH)
		if (params.index !== undefined) {
			const idx = parseInt(params.index, 10);
			if (!isNaN(idx)) {
				// Highlight just the character at the index
				bounds = [idx, idx + 1];
			}
		}

		// Check for tag - can be string or ParsedHedTag object
		if (!bounds && params.tag) {
			let tagName: string | undefined;

			if (typeof params.tag === 'string') {
				tagName = params.tag;
			} else if (typeof params.tag === 'object') {
				// ParsedHedTag object - try various properties
				tagName = params.tag.originalTag ||
				          params.tag.formattedTag ||
				          params.tag.canonicalTag ||
				          (params.tag.originalBounds ? hedString.slice(params.tag.originalBounds[0], params.tag.originalBounds[1]) : undefined);

				// If the tag object has originalBounds, use them directly
				if (params.tag.originalBounds && Array.isArray(params.tag.originalBounds)) {
					bounds = params.tag.originalBounds as [number, number];
				}
			}

			// If we have a tag name but no bounds yet, search for it
			if (!bounds && tagName) {
				const tagBounds = findTagInString(hedString, tagName);
				if (tagBounds) {
					bounds = tagBounds;
				}
			}
		}
	}

	// Clean up message - remove embedded generic error codes if we've remapped them
	let message = issue.message || 'Unknown validation error';
	const genericMessagePatterns = ['[INTERNAL_ERROR]', '[GENERICERROR]', '[GENERIC_ERROR]'];
	for (const pattern of genericMessagePatterns) {
		if (!genericCodes.includes(hedCode) && message.includes(pattern)) {
			// Replace the embedded generic code with our mapped code
			message = message.replace(pattern, `[${hedCode}]`);
			message = message.replace(/Unknown HED error "[^"]+"/,
				`${hedCode.replace(/_/g, ' ').toLowerCase()}`);
			message = message.replace(/genericerror/gi, hedCode.replace(/_/g, ' ').toLowerCase());
			break;
		}
	}

	return {
		hedCode,
		internalCode: issue.internalCode || '',
		level: issue.level === 'warning' ? 'warning' : 'error',
		message,
		bounds
	};
}

/**
 * Find the bounds of a tag within a HED string.
 * Returns [start, end] or null if not found.
 */
function findTagInString(hedString: string, tagName: string): [number, number] | null {
	// Case-insensitive search
	const lowerHed = hedString.toLowerCase();
	const lowerTag = tagName.toLowerCase();

	let index = lowerHed.indexOf(lowerTag);
	if (index === -1) {
		return null;
	}

	// Make sure we're matching a whole tag (not a substring of another tag)
	// Tags are separated by commas, parentheses, or whitespace
	const separators = /[,()]/;

	while (index !== -1) {
		const beforeChar = index > 0 ? hedString[index - 1] : ',';
		const afterChar = index + tagName.length < hedString.length
			? hedString[index + tagName.length]
			: ',';

		// Check if this is a whole tag match
		const beforeOk = separators.test(beforeChar) || beforeChar === ' ' || index === 0;
		const afterOk = separators.test(afterChar) || afterChar === ' ' || afterChar === '/' ||
			index + tagName.length >= hedString.length;

		if (beforeOk && afterOk) {
			return [index, index + tagName.length];
		}

		// Continue searching
		index = lowerHed.indexOf(lowerTag, index + 1);
	}

	return null;
}

/**
 * Validate all HED regions in a document and return diagnostics.
 * Auto-detects schema version from dataset_description.json if not specified.
 * Always includes library schemas for complete validation.
 */
export async function validateDocument(
	document: TextDocument,
	regions: HedRegion[],
	schemaVersion?: string
): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];

	// Load schema - always use getSchemaForDocument to ensure library schemas are included
	let schemas: Schemas;
	try {
		// If version specified in settings, set it first (schemaManager will add library schemas)
		if (schemaVersion) {
			schemaManager.setCurrentVersion(schemaVersion);
		}
		// Always use getSchemaForDocument to include library schemas
		schemas = await schemaManager.getSchemaForDocument(document.uri);
	} catch (error) {
		// If schema fails to load, report it
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			message: `Failed to load HED schema: ${error instanceof Error ? error.message : String(error)}`,
			source: 'hed'
		});
		return diagnostics;
	}

	// Validate each region
	for (const region of regions) {
		const issues = await validateHedString(region.content, schemas);

		for (const issue of issues) {
			const diagnostic = issueToDiagnostic(issue, region, document);
			diagnostics.push(diagnostic);
		}
	}

	return diagnostics;
}

/**
 * Convert a validation issue to an LSP diagnostic.
 */
function issueToDiagnostic(
	issue: ValidationIssue,
	region: HedRegion,
	document: TextDocument
): Diagnostic {
	let range: Range;

	if (issue.bounds) {
		// Use the bounds to create a precise range
		range = boundsToRange(
			region,
			issue.bounds,
			(offset) => document.positionAt(offset)
		);
	} else {
		// Fall back to highlighting the entire HED string
		range = region.range;
	}

	return {
		severity: issue.level === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
		range,
		message: issue.message,
		code: issue.hedCode,
		source: 'hed'
	};
}

/**
 * Quick validation check - returns true if the HED string has issues.
 */
export async function hasValidationErrors(
	hedString: string,
	schemas: Schemas
): Promise<boolean> {
	const issues = await validateHedString(hedString, schemas);
	return issues.some(issue => issue.level === 'error');
}
