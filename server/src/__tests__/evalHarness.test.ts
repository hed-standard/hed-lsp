/**
 * Tests for the eval set's tag extraction, the committed set's structure, and the
 * harness's gate logic. Real schema and committed data; no mocks.
 */

import { describe, expect, it } from 'vitest';
import type { QueryFormat } from '../engine/embeddingConfig.js';
import { schemaManager } from '../engine/schemaManager.js';
import { DEFAULT_HED_SCHEMA } from '../engine/schemaVersion.js';
import { expectedTags } from '../eval/buildEvalSet.js';
import { type ConfigRun, report } from '../eval/evalSemantic.js';
import { loadEvalSet } from '../eval/evalSet.js';
import { bootstrapMeanDifference, type RankScore } from '../eval/metrics.js';

describe('expectedTags', () => {
	it('keeps the leaf tags and drops value tags', async () => {
		const schemas = await schemaManager.getSchema(DEFAULT_HED_SCHEMA);

		expect(expectedTags('Sensory-event, Visual-presentation, Label/Foo', schemas)).toEqual({
			tags: ['Sensory-event', 'Visual-presentation'],
		});
	});

	it('reports a string with only value tags as empty', async () => {
		const schemas = await schemaManager.getSchema(DEFAULT_HED_SCHEMA);

		expect(expectedTags('Label/Foo', schemas)).toEqual({ error: 'empty' });
	});

	it('reports a string that fails validation as a parse error', async () => {
		const schemas = await schemaManager.getSchema(DEFAULT_HED_SCHEMA);

		expect(expectedTags('Duration/3 s', schemas)).toEqual({ error: 'parse' });
	});
});

describe('committed eval set structure', () => {
	it('names only tags that appear in their own HED string', () => {
		const violations = loadEvalSet().pairs.flatMap((pair) =>
			pair.expected
				.filter((tag) => !pair.hed.toLowerCase().includes(tag.toLowerCase()))
				.map((tag) => `${pair.id}: ${tag}`),
		);

		expect(violations).toEqual([]);
	});
});

function scores(recall: number, hit: number): RankScore[] {
	return Array.from({ length: 10 }, () => ({ hit, recall, reciprocalRank: hit }));
}

function run(config: string, format: QueryFormat, recall: number, hit: number): ConfigRun {
	return { config, format, semantic: scores(recall, hit), endToEnd: scores(recall, hit) };
}

describe('report gates', () => {
	it('passes the dev gate only when recall rises by at least 2.0 points', () => {
		const result = report('dev', [
			run('E0', 'raw', 0.2, 0.5),
			run('E1', 'qwen', 0.21, 0.5),
			run('E2', 'hed', 0.23, 0.5),
		]);

		expect(result.rows.find((r) => r.config === 'E1')?.gate).toEqual({ devRecallMarginMet: false });
		expect(result.rows.find((r) => r.config === 'E2')?.gate).toEqual({ devRecallMarginMet: true });
	});

	it('requires neither recall nor hit to drop on the test split', () => {
		const result = report('test', [
			run('E0', 'raw', 0.2, 0.5),
			run('E1', 'qwen', 0.6, 0.9),
			run('E2', 'hed', 0.2, 0.4),
		]);

		expect(result.rows.find((r) => r.config === 'E1')?.gate).toEqual({
			testRecallNotLower: true,
			testHitNotLower: true,
		});
		expect(result.rows.find((r) => r.config === 'E2')?.gate).toEqual({
			testRecallNotLower: true,
			testHitNotLower: false,
		});
	});

	it('gives the baseline no gate verdict and no difference', () => {
		const result = report('dev', [run('E0', 'raw', 0.2, 0.5), run('E1', 'qwen', 0.6, 0.9)]);
		const baseline = result.rows.find((r) => r.config === 'E0');

		expect(baseline?.gate).toBeNull();
		expect(baseline?.recallVsBaseline).toBeNull();
		expect(baseline?.hitVsBaseline).toBeNull();
	});
});

describe('bootstrapMeanDifference (hand-checked)', () => {
	it('gives a degenerate interval at the shift when every pair moves by one', () => {
		expect(bootstrapMeanDifference([0, 0, 0, 0], [1, 1, 1, 1], 200, 1)).toEqual({ mean: 1, low: 1, high: 1 });
	});
});
