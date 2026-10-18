/**
 * Ranking metrics for the semantic eval harness. Pure functions, no I/O.
 */

export interface RankScore {
	/** 1 if any expected tag is in the top k, else 0. */
	hit: number;
	/** Fraction of the expected tags that appear in the top k. */
	recall: number;
	/** 1 / rank of the first expected tag in the top k, else 0. */
	reciprocalRank: number;
}

/** Scores one query's ranked suggestions against its expected tags. */
export function scoreRanking(expected: readonly string[], ranked: readonly string[], k: number): RankScore {
	const expectedSet = new Set(expected);
	const top = ranked.slice(0, k);
	const found = new Set(top.filter((tag) => expectedSet.has(tag)));
	const firstHit = top.findIndex((tag) => expectedSet.has(tag));
	return {
		hit: found.size > 0 ? 1 : 0,
		recall: expectedSet.size === 0 ? 0 : found.size / expectedSet.size,
		reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
	};
}

export function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** mulberry32: a small seeded PRNG, so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface Interval {
	mean: number;
	low: number;
	high: number;
}

/**
 * Paired percentile bootstrap of the mean difference (b - a), resampling queries.
 * Returns the observed mean difference and a 95% interval.
 */
export function bootstrapMeanDifference(
	a: readonly number[],
	b: readonly number[],
	resamples: number,
	seed: number,
): Interval {
	if (a.length !== b.length) {
		throw new Error('bootstrap inputs must be paired');
	}
	const n = a.length;
	const rng = mulberry32(seed);
	const diffs: number[] = [];
	for (let r = 0; r < resamples; r++) {
		let total = 0;
		for (let i = 0; i < n; i++) {
			const index = Math.floor(rng() * n);
			total += b[index] - a[index];
		}
		diffs.push(n === 0 ? 0 : total / n);
	}
	diffs.sort((x, y) => x - y);
	return {
		mean: mean(b.map((value, i) => value - a[i])),
		low: diffs[Math.floor(0.025 * (resamples - 1))] ?? 0,
		high: diffs[Math.floor(0.975 * (resamples - 1))] ?? 0,
	};
}
