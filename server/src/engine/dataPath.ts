import * as fs from 'node:fs';
import * as path from 'node:path';

/** Name of the shipped embeddings file, used to recognize the data directory. */
const SENTINEL = 'tag-embeddings.compact.json';

/**
 * Directory holding the shipped data. Resolves from source (src/engine), compiled output
 * (out/engine), and the esbuild bundle (out/server.js), which sit at different depths.
 */
export function dataDir(): string {
	const candidates = [path.join(__dirname, '..', '..', 'data'), path.join(__dirname, '..', 'data')];
	return candidates.find((dir) => fs.existsSync(path.join(dir, SENTINEL))) ?? candidates[0];
}
