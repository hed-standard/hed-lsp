/**
 * HED schema versions used across the server. Change the default here, not in each caller.
 */

/** Base HED schema used when a caller does not name a version. */
export const DEFAULT_HED_SCHEMA = '8.5.0';

/**
 * Schema set the embedding index and the anchor map are built against: the base
 * schema plus the libraries whose tags the index includes. Anchor targets must
 * resolve in this set, so extension names cannot become suggestions.
 */
export const EMBEDDING_SCHEMA_VERSION = `${DEFAULT_HED_SCHEMA},sc:score_2.1.0,la:lang_1.1.0`;
