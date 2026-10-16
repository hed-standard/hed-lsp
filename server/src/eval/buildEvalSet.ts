/**
 * Builds the semantic eval set from a hed-examples checkout.
 *
 * Every BIDS sidecar level description paired with its HED string is one query.
 * The expected tags are the short names of the leaf tags in that HED string,
 * resolved with the default HED schema. Strings that do not parse cleanly under that
 * schema are skipped and counted.
 *
 * Usage (after `bun run compile`):
 *   node server/out/eval/buildEvalSet.js <path-to-hed-examples> [output.json]
 *
 * The output is deterministic: rebuilding from the same checkout gives identical bytes.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseStandaloneString, type Schemas } from 'hed-validator';
import { schemaManager } from '../schemaManager.js';
import { EVAL_SCHEMA_VERSION, EVAL_SET_PATH, type EvalPair, type EvalSet } from './evalSet.js';

interface RawPair {
	dataset: string;
	query: string;
	hed: string;
}

export interface BuildStats {
	jsonFiles: number;
	uniquePairs: number;
	skippedParseErrors: number;
	skippedNoTags: number;
	datasets: number;
}

/** Recursively lists .json files, skipping VCS and dependency folders. */
function listJsonFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '.git' || entry.name === 'node_modules') {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...listJsonFiles(full));
		} else if (entry.name.endsWith('.json')) {
			found.push(full);
		}
	}
	return found.sort();
}

/** Groups a file under its dataset directory: datasets/<name>, or src/data/<name>. */
function datasetOf(root: string, file: string): string {
	const parts = path.relative(root, file).split(path.sep);
	const depth = parts[0] === 'src' ? 3 : 2;
	return parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || '.';
}

/** Extracts (level description, HED string) pairs from one sidecar. */
function pairsFromSidecar(sidecar: unknown, dataset: string): RawPair[] {
	const pairs: RawPair[] = [];
	if (!sidecar || typeof sidecar !== 'object') {
		return pairs;
	}
	for (const definition of Object.values(sidecar as Record<string, unknown>)) {
		if (!definition || typeof definition !== 'object') {
			continue;
		}
		const { HED, Levels } = definition as { HED?: unknown; Levels?: unknown };
		if (!HED || typeof HED !== 'object' || !Levels || typeof Levels !== 'object') {
			continue;
		}
		for (const [level, hed] of Object.entries(HED as Record<string, unknown>)) {
			const description = (Levels as Record<string, unknown>)[level];
			if (typeof description === 'string' && typeof hed === 'string') {
				pairs.push({ dataset, query: description.trim(), hed: hed.trim() });
			}
		}
	}
	return pairs;
}

/**
 * Short names of the leaf tags in a HED string. Returns `{ error: 'parse' }` when
 * the string has errors under the schema, and `{ error: 'empty' }` when it has no
 * leaf tags (for example, only definition or label tags).
 */
export function expectedTags(hed: string, schemas: Schemas): { tags: string[] } | { error: 'parse' | 'empty' } {
	const [parsed, syntaxIssues, semanticIssues] = parseStandaloneString(hed, schemas, null);
	const errors = [...syntaxIssues, ...semanticIssues].filter((issue) => issue.level === 'error');
	if (errors.length > 0) {
		return { error: 'parse' };
	}
	const names = new Set<string>();
	for (const tag of parsed.tags) {
		if (tag.schemaTag && !tag._value) {
			// `name` is the short tag name at runtime; the typings' shortTagName getter is absent.
			names.add(tag.schemaTag.name);
		}
	}
	return names.size > 0 ? { tags: [...names].sort() } : { error: 'empty' };
}

/** Builds the eval set from a hed-examples checkout at `root`. */
export async function buildEvalSet(root: string): Promise<{ set: EvalSet; stats: BuildStats }> {
	const schemas = await schemaManager.getSchema(EVAL_SCHEMA_VERSION);
	const stats: BuildStats = {
		jsonFiles: 0,
		uniquePairs: 0,
		skippedParseErrors: 0,
		skippedNoTags: 0,
		datasets: 0,
	};

	const unique = new Map<string, RawPair>();
	const unreadable: string[] = [];
	for (const file of listJsonFiles(root)) {
		stats.jsonFiles++;
		let sidecar: unknown;
		try {
			sidecar = JSON.parse(fs.readFileSync(file, 'utf-8'));
		} catch (error) {
			unreadable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const pair of pairsFromSidecar(sidecar, datasetOf(root, file))) {
			const key = `${pair.query.toLowerCase()}\u0000${pair.hed}`;
			if (!unique.has(key)) {
				unique.set(key, pair);
			}
		}
	}
	// A file that cannot be read would silently change the eval set, so fail instead.
	if (unreadable.length > 0) {
		throw new Error(`cannot read ${unreadable.length} sidecar file(s):\n${unreadable.join('\n')}`);
	}
	stats.uniquePairs = unique.size;

	const resolved: (RawPair & { expected: string[] })[] = [];
	for (const pair of unique.values()) {
		const result = expectedTags(pair.hed, schemas);
		if ('error' in result) {
			if (result.error === 'parse') {
				stats.skippedParseErrors++;
			} else {
				stats.skippedNoTags++;
			}
			continue;
		}
		resolved.push({ ...pair, expected: result.tags });
	}

	// Code-unit comparison, so ids do not depend on the machine's locale.
	const compareCodeUnits = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
	resolved.sort(
		(a, b) =>
			compareCodeUnits(a.dataset, b.dataset) || compareCodeUnits(a.query, b.query) || compareCodeUnits(a.hed, b.hed),
	);

	// Datasets alternate between dev (even index) and test (odd index), so no dataset spans both splits.
	const datasets = [...new Set(resolved.map((pair) => pair.dataset))].sort();
	stats.datasets = datasets.length;
	const splitOf = new Map(datasets.map((name, index) => [name, index % 2 === 0 ? 'dev' : 'test'] as const));

	const pairs: EvalPair[] = resolved.map((pair, index) => ({
		id: `pair-${String(index + 1).padStart(4, '0')}`,
		dataset: pair.dataset,
		split: splitOf.get(pair.dataset) ?? 'dev',
		query: pair.query,
		hed: pair.hed,
		expected: pair.expected,
	}));

	return {
		set: {
			version: 2,
			schema: EVAL_SCHEMA_VERSION,
			source: {
				name: 'hed-examples',
				...checkoutState(root),
				description: 'BIDS sidecar level descriptions paired with HED strings',
			},
			skipped: { parseErrors: stats.skippedParseErrors, noLeafTags: stats.skippedNoTags },
			pairs,
		},
		stats,
	};
}

/**
 * The commit of the hed-examples checkout, and whether its working tree differs from that
 * commit. A dirty tree means the commit alone does not pin the content, so the set says so.
 */
function checkoutState(root: string): { commit: string; dirty: boolean } {
	try {
		const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
		const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf-8' });
		return { commit, dirty: status.trim().length > 0 };
	} catch {
		throw new Error(`${root} must be a git checkout so the eval set can record its commit`);
	}
}

async function main(): Promise<void> {
	const root = process.argv[2];
	if (!root) {
		console.error('usage: buildEvalSet.js <path-to-hed-examples> [output.json]');
		process.exit(2);
	}
	const output = process.argv[3] ?? EVAL_SET_PATH;
	const { set, stats } = await buildEvalSet(path.resolve(root));
	fs.writeFileSync(output, `${JSON.stringify(set, null, 2)}\n`);
	console.error(JSON.stringify({ output, ...stats, pairs: set.pairs.length }, null, 2));
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
