/**
 * HED Validation Module
 * Wraps hed-validator for HED string validation.
 */

import { parseHedString } from 'hed-validator';
import type { Schemas } from 'hed-validator';
import { Diagnostic, DiagnosticSeverity, Range, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HedRegion, ValidationIssue, boundsToRange } from './types.js';
import { schemaManager } from './schemaManager.js';

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
	const placeholderPattern = /\{[^}]+\}/g;
	const cleanedHed = hedString.replace(placeholderPattern, '');

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
		return allIssues.map(issue => convertIssue(issue));
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
 * Convert a hed-validator Issue to our ValidationIssue type.
 */
function convertIssue(issue: any): ValidationIssue {
	return {
		hedCode: issue.hedCode || issue.code || 'UNKNOWN',
		internalCode: issue.internalCode || '',
		level: issue.level === 'warning' ? 'warning' : 'error',
		message: issue.message || 'Unknown validation error',
		bounds: issue.parameters?.bounds
	};
}

/**
 * Validate all HED regions in a document and return diagnostics.
 */
export async function validateDocument(
	document: TextDocument,
	regions: HedRegion[],
	schemaVersion?: string
): Promise<Diagnostic[]> {
	const diagnostics: Diagnostic[] = [];

	// Load schema
	let schemas: Schemas;
	try {
		schemas = await schemaManager.getSchema(schemaVersion);
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
