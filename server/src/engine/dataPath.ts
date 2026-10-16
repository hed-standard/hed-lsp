import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './log.js';

/**
 * Embedding files shipped in the data directory, in the order the loader prefers them: the compact
 * file (smaller), then the full file. A directory that holds either one is the data directory.
 */
export const EMBEDDING_FILES = ['tag-embeddings.compact.json', 'tag-embeddings.json'];

/**
 * Find the directory that holds the shipped data, given the directory of the calling module. The
 * source (src/engine) and compiled output (out/engine) layouts resolve to the first candidate, and the
 * esbuild bundle (out/server.js) resolves to the second. When neither holds the data, the first
 * candidate is returned and both candidates are logged.
 */
export function resolveDataDir(startDir: string): string {
	const candidates = [path.join(startDir, '..', '..', 'data'), path.join(startDir, '..', 'data')];
	const found = candidates.find((dir) => EMBEDDING_FILES.some((name) => fs.existsSync(path.join(dir, name))));
	if (found) {
		return found;
	}
	log.error(`[HED Embeddings] No shipped data found; looked in ${candidates.join(', ')}`);
	return candidates[0];
}

/** Directory holding the shipped data, resolved from this module's location. */
export function dataDir(): string {
	return resolveDataDir(__dirname);
}
