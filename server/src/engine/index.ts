/**
 * HED engine: the public surface for validation, suggestions, and schema access.
 *
 * Inputs and outputs are plain JSON-compatible values, so the same calls can serve in-process
 * callers and, later, network clients. The language server and the CLI currently import the
 * modules directly; this facade is the entry point for validation against an explicit schema
 * version. Nothing here imports the language server.
 */

import { schemaManager } from './schemaManager.js';
import { DEFAULT_HED_SCHEMA, resolveSchemaOption } from './schemaVersion.js';
import type { ValidationIssue } from './types.js';
import { validateHedString } from './validation.js';

export { embeddingsManager } from './embeddings.js';
export { schemaManager } from './schemaManager.js';
export { DEFAULT_HED_SCHEMA, EMBEDDING_SCHEMA_VERSION, FALLBACK_HED_SCHEMA } from './schemaVersion.js';
export { findSuggestions, type SuggestionOptions, type SuggestionResult, suggestBatch } from './suggestionEngine.js';
export type { HedTag, HedTagAttributes, ValidationIssue } from './types.js';
export { hasValidationErrors, validateHedString } from './validation.js';

export interface ValidateOptions {
	/**
	 * Schema version to validate against: a base version (8.5.0), a comma-separated list that names
	 * libraries (8.4.0,sc:score_2.1.0), or an array of those parts. Omitted or blank means
	 * DEFAULT_HED_SCHEMA.
	 */
	schema?: string | string[];
}

/**
 * Validate one HED string against an explicit schema version.
 *
 * The schema is loaded by its version; the schema manager's current version is never
 * changed, so concurrent callers with different versions cannot affect one another.
 */
export async function validate(hed: string, options?: ValidateOptions | null): Promise<ValidationIssue[]> {
	const schemas = await schemaManager.getSchema(resolveSchemaOption(options?.schema, DEFAULT_HED_SCHEMA));
	return validateHedString(hed, schemas);
}
