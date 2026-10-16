/**
 * Contract test: the shipped keyword embeddings must match ANCHOR_KEYWORDS.
 *
 * Keyword vectors come from server/data/tag-embeddings.compact.json, which
 * generateEmbeddings.ts writes from the same anchor map. If someone edits the
 * map without regenerating the data, semantic search votes would silently use
 * stale targets. This test reads the real data file; no mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANCHOR_KEYWORDS } from '../anchorKeywords.js';
import { schemaManager } from '../schemaManager.js';
import { EMBEDDING_SCHEMA_VERSION } from '../schemaVersion.js';

interface ShippedKeyword {
	keyword: string;
	targets: string[];
}

function loadShippedKeywords(): Record<string, string[]> {
	const dataPath = path.join(__dirname, '..', '..', 'data', 'tag-embeddings.compact.json');
	const db: { keywords?: ShippedKeyword[] } = JSON.parse(readFileSync(dataPath, 'utf-8'));
	return Object.fromEntries((db.keywords ?? []).map((entry) => [entry.keyword, entry.targets]));
}

const REGENERATE_HINT =
	'Shipped keyword embeddings are out of date with ANCHOR_KEYWORDS. Regenerate server/data/tag-embeddings.compact.json with server/scripts/generateEmbeddings.ts.';

describe('shipped keyword embeddings', () => {
	it('have the same keywords as ANCHOR_KEYWORDS', () => {
		const shipped = Object.keys(loadShippedKeywords()).sort();
		const anchored = Object.keys(ANCHOR_KEYWORDS).sort();

		expect(shipped, REGENERATE_HINT).toEqual(anchored);
	});

	it('have the same targets as ANCHOR_KEYWORDS for every keyword', () => {
		const shipped = loadShippedKeywords();
		const mismatches = Object.keys(ANCHOR_KEYWORDS).filter(
			(keyword) => JSON.stringify(shipped[keyword]) !== JSON.stringify(ANCHOR_KEYWORDS[keyword]),
		);

		expect(mismatches, REGENERATE_HINT).toEqual([]);
	});
});

describe('anchor targets are HED schema tags', () => {
	it('all resolve in the embedding schema set, so extension words cannot become suggestions', async () => {
		const extensions: string[] = [];
		for (const target of new Set(Object.values(ANCHOR_KEYWORDS).flat())) {
			if ((await schemaManager.findTag(target, EMBEDDING_SCHEMA_VERSION)) === null) {
				extensions.push(target);
			}
		}

		expect(extensions, 'Anchor targets must be HED schema tags; extensions are unbounded words.').toEqual([]);
	});
});
