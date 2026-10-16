/**
 * Tests for the semantic eval metrics, with hand-checked values. Pure functions; no mocks.
 */

import { describe, expect, it } from 'vitest';
import { bootstrapMeanDifference, mulberry32, scoreRanking } from '../eval/metrics.js';

describe('scoreRanking', () => {
	it('scores a hit at rank 2 with full recall inside k', () => {
		const score = scoreRanking(['A', 'B'], ['X', 'A', 'Y', 'B'], 10);

		expect(score).toEqual({ hit: 1, recall: 1, reciprocalRank: 0.5 });
	});

	it('truncates to k before scoring recall', () => {
		const score = scoreRanking(['A', 'B'], ['X', 'A', 'Y', 'B'], 2);

		expect(score).toEqual({ hit: 1, recall: 0.5, reciprocalRank: 0.5 });
	});

	it('scores zero when no expected tag appears in the ranking', () => {
		expect(scoreRanking(['A'], ['X', 'Y'], 10)).toEqual({ hit: 0, recall: 0, reciprocalRank: 0 });
	});

	it('does not count an expected tag twice when the ranking repeats it', () => {
		const score = scoreRanking(['A', 'B'], ['A', 'A', 'B'], 10);

		expect(score.recall).toBe(1);
	});
});

describe('bootstrapMeanDifference', () => {
	it('returns a zero-width interval when both systems score identically', () => {
		const scores = [0, 0.5, 1, 0.25];

		expect(bootstrapMeanDifference(scores, scores, 500, 7)).toEqual({ mean: 0, low: 0, high: 0 });
	});

	it('is reproducible for a fixed seed and differs across seeds', () => {
		const a = [0, 0, 1, 0, 0, 1, 0, 0];
		const b = [1, 0, 1, 1, 0, 1, 1, 0];

		expect(bootstrapMeanDifference(a, b, 300, 11)).toEqual(bootstrapMeanDifference(a, b, 300, 11));
		expect(bootstrapMeanDifference(a, b, 300, 11)).not.toEqual(bootstrapMeanDifference(a, b, 300, 12));
	});

	it('reports the observed paired mean difference', () => {
		const result = bootstrapMeanDifference([0, 0, 0, 0], [1, 0, 1, 0], 200, 3);

		expect(result.mean).toBe(0.5);
	});

	it('rejects unpaired inputs', () => {
		expect(() => bootstrapMeanDifference([0, 1], [0], 10, 1)).toThrow('paired');
	});
});

describe('mulberry32', () => {
	it('produces values in [0, 1) that repeat for the same seed', () => {
		const first = mulberry32(42);
		const second = mulberry32(42);
		const values = [first(), first(), first()];

		expect(values).toEqual([second(), second(), second()]);
		for (const value of values) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});
});
