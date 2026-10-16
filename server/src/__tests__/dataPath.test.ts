/**
 * Data directory resolution over real temporary trees, one per layout: source (src/engine),
 * compiled output (out/engine), and the esbuild bundle (out/server.js). Files hold no data,
 * because only their presence is checked. No mocks.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDataDir } from '../engine/dataPath.js';
import { setLogger } from '../engine/log.js';

const layouts: [string, string][] = [
	['source (src/engine)', path.join('server', 'src', 'engine')],
	['compiled output (out/engine)', path.join('server', 'out', 'engine')],
	['esbuild bundle (out/server.js)', path.join('server', 'out')],
];

describe('resolveDataDir', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'hed-data-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** Create a file under the temporary root, with its parent directories. */
	function touch(relative: string): void {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{}');
	}

	function startDirFor(layout: string): string {
		const startDir = path.join(root, layout);
		fs.mkdirSync(startDir, { recursive: true });
		return startDir;
	}

	it.each(layouts)('finds the shipped data from the %s layout', (_name, layout) => {
		touch(path.join('server', 'data', 'tag-embeddings.compact.json'));

		expect(resolveDataDir(startDirFor(layout))).toBe(path.join(root, 'server', 'data'));
	});

	// In the bundle layout the first candidate is wrong, so only a correct lookup finds the full file.
	it('accepts the full embeddings file alone in the bundle layout', () => {
		touch(path.join('server', 'data', 'tag-embeddings.json'));

		expect(resolveDataDir(startDirFor(path.join('server', 'out')))).toBe(path.join(root, 'server', 'data'));
	});

	it('logs every candidate when no layout holds the data', () => {
		const startDir = startDirFor(path.join('server', 'out', 'engine'));
		const messages: string[] = [];
		const previous = setLogger({
			info: () => {},
			error: (...args) => {
				messages.push(String(args[0]));
			},
		});
		try {
			expect(resolveDataDir(startDir)).toBe(path.join(root, 'server', 'data'));
		} finally {
			setLogger(previous);
		}

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain(path.join(root, 'server', 'data'));
		expect(messages[0]).toContain(path.join(root, 'server', 'out', 'data'));
	});
});
