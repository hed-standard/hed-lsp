/**
 * Semantic-search eval harness.
 *
 * Runs each query format over one split of the eval set and reports hit@10,
 * recall@10 and MRR for the semantic stage alone and for the end-to-end
 * suggestion path, with paired bootstrap intervals against the raw baseline (E0).
 * Uses the cached runtime model; nothing is downloaded when it is present.
 *
 * Usage (after `bun run compile`):
 *   node server/out/eval/evalSemantic.js --split dev [--configs E0,E1,E2] [--out results.json]
 */

import * as fs from 'node:fs';
import type { QueryFormat } from '../engine/embeddingConfig.js';
import { embeddingsManager } from '../engine/embeddings.js';
import { findSuggestions } from '../engine/suggestionEngine.js';
import { EVAL_SCHEMA_VERSION, type EvalPair, type EvalSplit, loadEvalSet } from './evalSet.js';
import { bootstrapMeanDifference, type Interval, mean, type RankScore, scoreRanking } from './metrics.js';

const K = 10;
const RESAMPLES = 2000;
const SEED = 20260615;
/** Dev recall@10 must rise by at least this much over E0 (2.0 points). */
const DEV_RECALL_MARGIN = 0.02;

const FORMATS: Readonly<Record<string, QueryFormat>> = { E0: 'raw', E1: 'qwen', E2: 'hed' };
const BASELINE = 'E0';

interface Summary {
	hit: number;
	recall: number;
	mrr: number;
}

export interface ConfigRun {
	config: string;
	format: QueryFormat;
	semantic: RankScore[];
	endToEnd: RankScore[];
}

function summarize(scores: readonly RankScore[]): Summary {
	return {
		hit: mean(scores.map((s) => s.hit)),
		recall: mean(scores.map((s) => s.recall)),
		mrr: mean(scores.map((s) => s.reciprocalRank)),
	};
}

function parseArgs(argv: string[]): { split: EvalSplit; configs: string[]; out?: string } {
	const value = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index === -1 ? undefined : argv[index + 1];
	};
	const split = value('--split');
	if (split !== 'dev' && split !== 'test') {
		throw new Error('usage: evalSemantic.js --split dev|test [--configs E0,E1,E2] [--out file.json]');
	}
	const configs = (value('--configs') ?? Object.keys(FORMATS).join(',')).split(',').map((c) => c.trim());
	for (const config of configs) {
		if (!(config in FORMATS)) {
			throw new Error(`unknown config ${config}; choose from ${Object.keys(FORMATS).join(', ')}`);
		}
	}
	if (!configs.includes(BASELINE)) {
		configs.unshift(BASELINE);
	}
	return { split, configs, out: value('--out') };
}

async function runConfig(config: string, pairs: readonly EvalPair[]): Promise<ConfigRun> {
	const format = FORMATS[config];
	const semantic: RankScore[] = [];
	const endToEnd: RankScore[] = [];
	const failuresBefore = embeddingsManager.embedFailureCount();
	for (const pair of pairs) {
		const matches = await embeddingsManager.findSimilar(pair.query, K, format);
		semantic.push(
			scoreRanking(
				pair.expected,
				matches.map((m) => m.tag),
				K,
			),
		);
		const result = await findSuggestions(pair.query, {
			schema: EVAL_SCHEMA_VERSION,
			top: K,
			semantic: true,
			queryFormat: format,
		});
		endToEnd.push(scoreRanking(pair.expected, result.suggestions, K));
	}
	// findSimilar turns a failed embed() into "no matches", so count the failures rather than the empty results.
	const failed = embeddingsManager.embedFailureCount() - failuresBefore;
	if (failed > 0) {
		throw new Error(`${config}: ${failed} query embedding(s) failed; refusing to score this run`);
	}
	return { config, format, semantic, endToEnd };
}

export interface ReportRow {
	config: string;
	format: QueryFormat;
	semantic: Summary;
	endToEnd: Summary;
	/** Paired difference against E0; null for the baseline itself. */
	recallVsBaseline: Interval | null;
	hitVsBaseline: Interval | null;
	/** Pre-registered gate verdict; null for the baseline itself. */
	gate: { devRecallMarginMet: boolean } | { testRecallNotLower: boolean; testHitNotLower: boolean } | null;
}

export interface Report {
	split: EvalSplit;
	k: number;
	pairs: number;
	resamples: number;
	seed: number;
	rows: ReportRow[];
}

/** Summarizes each run and compares it with the baseline using paired bootstrap intervals and the gate. */
export function report(split: EvalSplit, runs: readonly ConfigRun[]): Report {
	const baseline = runs.find((r) => r.config === BASELINE);
	if (!baseline) {
		throw new Error('baseline run missing');
	}
	const rows = runs.map((run): ReportRow => {
		if (run.config === BASELINE) {
			return {
				config: run.config,
				format: run.format,
				semantic: summarize(run.semantic),
				endToEnd: summarize(run.endToEnd),
				recallVsBaseline: null,
				hitVsBaseline: null,
				gate: null,
			};
		}
		const diff = (pick: (r: ConfigRun) => number[]): Interval =>
			bootstrapMeanDifference(pick(baseline), pick(run), RESAMPLES, SEED);
		const recallVsBaseline = diff((r) => r.semantic.map((s) => s.recall));
		const hitVsBaseline = diff((r) => r.semantic.map((s) => s.hit));
		return {
			config: run.config,
			format: run.format,
			semantic: summarize(run.semantic),
			endToEnd: summarize(run.endToEnd),
			recallVsBaseline,
			hitVsBaseline,
			gate:
				split === 'dev'
					? { devRecallMarginMet: recallVsBaseline.mean >= DEV_RECALL_MARGIN }
					: { testRecallNotLower: recallVsBaseline.mean >= 0, testHitNotLower: hitVsBaseline.mean >= 0 },
		};
	});
	return { split, k: K, pairs: baseline.semantic.length, resamples: RESAMPLES, seed: SEED, rows };
}

function printTable(result: Report): void {
	const pct = (x: number) => (x * 100).toFixed(1);
	const ci = (i: Interval | null) =>
		i === null ? '-' : `${(i.mean * 100).toFixed(1)} [${(i.low * 100).toFixed(1)}, ${(i.high * 100).toFixed(1)}]`;
	console.log(`split=${result.split} k=${result.k} pairs=${result.pairs}`);
	console.log(
		'config  format  sem.hit  sem.recall  sem.mrr  e2e.hit  e2e.recall  dRecall(pts, 95% CI)  dHit(pts, 95% CI)',
	);
	for (const row of result.rows) {
		console.log(
			[
				row.config.padEnd(7),
				row.format.padEnd(7),
				pct(row.semantic.hit).padStart(7),
				pct(row.semantic.recall).padStart(11),
				row.semantic.mrr.toFixed(3).padStart(8),
				pct(row.endToEnd.hit).padStart(8),
				pct(row.endToEnd.recall).padStart(11),
				`  ${ci(row.recallVsBaseline)}`,
				`  ${ci(row.hitVsBaseline)}`,
			].join(' '),
		);
	}
}

async function main(): Promise<void> {
	const { split, configs, out } = parseArgs(process.argv.slice(2));
	const pairs = loadEvalSet().pairs.filter((pair) => pair.split === split);

	embeddingsManager.setEnabled(true);
	if (!(await embeddingsManager.initializeModel())) {
		throw new Error('embedding model failed to load');
	}
	if (!(await embeddingsManager.loadEmbeddings())) {
		throw new Error('shipped embeddings failed to load');
	}

	const runs: ConfigRun[] = [];
	for (const config of configs) {
		console.error(`running ${config} (${FORMATS[config]}) over ${pairs.length} ${split} pairs`);
		runs.push(await runConfig(config, pairs));
	}

	const result = report(split, runs);
	printTable(result);
	if (out) {
		fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
		console.error(`wrote ${out}`);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
