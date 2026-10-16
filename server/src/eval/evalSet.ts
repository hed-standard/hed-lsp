/**
 * Semantic-search eval set: natural-language descriptions paired with the HED
 * tags they were annotated with. Built from hed-examples by buildEvalSet.ts and
 * committed as server/eval/hed-examples-pairs.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_HED_SCHEMA } from '../schemaVersion.js';

/** Schema version used to resolve the expected tags. */
export const EVAL_SCHEMA_VERSION = DEFAULT_HED_SCHEMA;

/** Default location of the committed eval set (server/eval). */
export const EVAL_SET_PATH = path.join(__dirname, '..', '..', 'eval', 'hed-examples-pairs.json');

export type EvalSplit = 'dev' | 'test';

export interface EvalPair {
	/** Stable identifier, assigned after sorting, e.g. "pair-0001". */
	id: string;
	/** Source dataset directory, e.g. "datasets/eeg_ds004106s_hed". */
	dataset: string;
	split: EvalSplit;
	/** Natural-language query: the sidecar level description. */
	query: string;
	/** The HED string annotated for that level. */
	hed: string;
	/** Short names of the leaf tags in `hed` that resolve in the eval schema, sorted. */
	expected: string[];
}

export interface EvalSet {
	version: 1;
	schema: string;
	source: string;
	pairs: EvalPair[];
}

/** Reads an eval set from disk. Throws if the file is missing or malformed JSON. */
export function loadEvalSet(filePath: string = EVAL_SET_PATH): EvalSet {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EvalSet;
}
