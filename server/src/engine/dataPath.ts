import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './log.js';

/** Files that identify the shipped data directory: the compact embeddings file, or the full one. */
const SENTINELS = ['tag-embeddings.compact.json', 'tag-embeddings.json'];

/**
 * Find the directory that holds the shipped data, starting from the directory of the calling module.
 * That module sits at different depths in source (src/engine), compiled output (out/engine), and the
 * esbuild bundle (out/server.js), so the candidates are tried in that order. When none holds the data,
 * the first candidate is returned and every candidate is logged.
 */
export function resolveDataDir(startDir: string): string {
	const candidates = [path.join(startDir, '..', '..', 'data'), path.join(startDir, '..', 'data')];
	const found = candidates.find((dir) => SENTINELS.some((name) => fs.existsSync(path.join(dir, name))));
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
