/**
 * Structural checks for the committed semantic eval set. Expected tags are
 * resolved against the real schema; no mocks.
 */

import { describe, expect, it } from 'vitest';
import { EVAL_SCHEMA_VERSION, loadEvalSet } from '../eval/evalSet.js';
import { schemaManager } from '../schemaManager.js';

const evalSet = loadEvalSet();

describe('committed semantic eval set', () => {
	it('targets the eval schema version', () => {
		expect(evalSet.version).toBe(1);
		expect(evalSet.schema).toBe(EVAL_SCHEMA_VERSION);
	});

	it('has unique ids and non-empty queries and HED strings', () => {
		const ids = evalSet.pairs.map((pair) => pair.id);

		expect(new Set(ids).size).toBe(ids.length);
		for (const pair of evalSet.pairs) {
			expect(pair.query.trim().length, pair.id).toBeGreaterThan(0);
			expect(pair.hed.trim().length, pair.id).toBeGreaterThan(0);
		}
	});

	it('gives every pair expected tag names that exist in the eval schema', async () => {
		const unresolved: string[] = [];
		for (const pair of evalSet.pairs) {
			expect(pair.expected.length, pair.id).toBeGreaterThan(0);
			for (const tag of pair.expected) {
				const found = typeof tag === 'string' && (await schemaManager.findTag(tag, EVAL_SCHEMA_VERSION)) !== null;
				if (!found) {
					unresolved.push(`${pair.id}: ${String(tag)}`);
				}
			}
		}

		expect(unresolved).toEqual([]);
	});

	it('assigns each dataset to exactly one split, with both splits populated', () => {
		const splitsByDataset = new Map<string, Set<string>>();
		for (const pair of evalSet.pairs) {
			const splits = splitsByDataset.get(pair.dataset) ?? new Set<string>();
			splits.add(pair.split);
			splitsByDataset.set(pair.dataset, splits);
		}

		for (const [dataset, splits] of splitsByDataset) {
			expect(splits.size, dataset).toBe(1);
		}
		expect(evalSet.pairs.some((pair) => pair.split === 'dev')).toBe(true);
		expect(evalSet.pairs.some((pair) => pair.split === 'test')).toBe(true);
	});
});
