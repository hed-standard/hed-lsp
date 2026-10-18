/**
 * HED schema versions used across the server. Change the default here, not in each caller.
 */

/** Base HED schema used when a caller does not name a version. */
export const DEFAULT_HED_SCHEMA = '8.5.0';

/**
 * Newest HED schema bundled inside hed-validator. The default is fetched from GitHub, so when that
 * fetch fails the runtime falls back to this bundled schema and warns, keeping validation offline.
 */
export const FALLBACK_HED_SCHEMA = '8.4.0';

/**
 * Schema set the embedding index and the anchor map are built against: the base
 * schema plus the libraries whose tags the index includes. Anchor targets must
 * resolve in this set, so extension names cannot become suggestions.
 */
export const EMBEDDING_SCHEMA_VERSION = `${DEFAULT_HED_SCHEMA},sc:score_2.1.0,la:lang_1.1.0`;

/**
 * Resolve a schema option from a caller to a version string. A string is used after trimming, and
 * an array of parts is joined with commas, as dataset_description.json can give it. A blank,
 * missing, or other value means the fallback.
 */
export function resolveSchemaOption(schema: unknown, fallback: string): string {
	const text = Array.isArray(schema) ? schema.join(',') : schema;
	return typeof text === 'string' && text.trim() ? text.trim() : fallback;
}
