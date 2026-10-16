/**
 * HED engine: the public surface for validation, suggestions, and schema access.
 *
 * Inputs and outputs are plain JSON-compatible values, so one contract serves in-process
 * callers (the LSP server and the CLI), the daemon (Phase 4), and remote clients (Phase 6).
 * Nothing here imports the language server.
 */

import { schemaManager } from './schemaManager.js';
import { DEFAULT_HED_SCHEMA } from './schemaVersion.js';
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
	 * Schema version to validate against: a base version (8.5.0) or a comma-separated list that
	 * names libraries (8.4.0,sc:score_2.1.0). Omitted or blank means DEFAULT_HED_SCHEMA.
	 */
	schema?: string;
}

/**
 * Validate one HED string against an explicit schema version.
 *
 * The schema is loaded by its version; the schema manager's current version is never
 * changed, so concurrent callers with different versions cannot affect one another.
 */
export async function validate(hed: string, options: ValidateOptions = {}): Promise<ValidationIssue[]> {
	const schemas = await schemaManager.getSchema(options.schema?.trim() || DEFAULT_HED_SCHEMA);
	return validateHedString(hed, schemas);
}
