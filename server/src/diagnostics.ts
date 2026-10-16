/**
 * Document diagnostics: validates every HED region in a document and maps the issues to
 * LSP diagnostics. The pure validation lives in validation.ts; this module is the LSP adapter.
 */

import type { Schemas } from 'hed-validator';
import { type Diagnostic, DiagnosticSeverity, type Range } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { schemaManager } from './schemaManager.js';
import { boundsToRange, type HedRegion, type ValidationIssue } from './types.js';
import { validateHedString } from './validation.js';

/**
 * Validate all HED regions in a document and return diagnostics.
 * Auto-detects schema version from dataset_description.json if not specified.
 * Always includes library schemas for complete validation.
 */
export async function validateDocument(
	document: TextDocument,
	regions: HedRegion[],
	schemaVersion?: string,
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
			source: 'hed',
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
function issueToDiagnostic(issue: ValidationIssue, region: HedRegion, document: TextDocument): Diagnostic {
	let range: Range;

	if (issue.bounds) {
		// Use the bounds to create a precise range
		range = boundsToRange(region, issue.bounds, (offset) => document.positionAt(offset));
	} else {
		// Fall back to highlighting the entire HED string
		range = region.range;
	}

	return {
		severity: issue.level === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
		range,
		message: issue.message,
		code: issue.hedCode,
		source: 'hed',
	};
}
