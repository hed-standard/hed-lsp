import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Embedding model settings shared by the runtime (embeddings.ts) and the
 * generator (scripts/generateEmbeddings.ts), so the vectors that were stored
 * and the query vectors computed at runtime come from the same configuration.
 */

/**
 * Directory where transformers.js caches model files. The runtime and the generator must
 * share it; otherwise the generator downloads a second copy into the package directory.
 */
export function modelCacheDir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
	return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

/** Model repository used at runtime and by the generator. */
export const MODEL_ID = 'neuromechanist/Qwen3-Embedding-0.6B-ONNX-Q8';

/** Quantization; resolves to `onnx/model_uint8.onnx` in the repository. */
export const DTYPE = 'uint8' as const;

/** Qwen3-Embedding pools the last token of the sequence. */
export const POOLING = 'last_token' as const;

/** Vectors are L2-normalized, so cosine similarity is a dot product. */
export const NORMALIZE = true;

/**
 * Repositories that publish a model file byte-identical to `MODEL_ID` with `DTYPE`
 * (verified by SHA-256: `onnx-community/...-ONNX` `model_quantized.onnx` and
 * `model_uint8.onnx` both equal `neuromechanist/...-ONNX-Q8` `model_uint8.onnx`).
 * The shipped embeddings file records `onnx-community` as its model, which is
 * equivalent, so the contract test accepts either id.
 */
export const EQUIVALENT_MODEL_IDS: readonly string[] = [
	'neuromechanist/Qwen3-Embedding-0.6B-ONNX-Q8',
	'onnx-community/Qwen3-Embedding-0.6B-ONNX',
];

/**
 * How a query is wrapped before embedding. Documents (tags and anchors) are
 * always embedded bare; only the query side is formatted. `raw` is the behavior
 * shipped before the alignment experiment.
 *
 * - raw: the query lowercased, as the runtime has always embedded it (no instruction)
 * - qwen: Qwen3-Embedding's default retrieval instruction
 * - hed: one HED-specific instruction, written before the experiment ran
 */
export type QueryFormat = 'raw' | 'qwen' | 'hed';

export const QUERY_FORMATS: Readonly<Record<QueryFormat, (query: string) => string>> = {
	raw: (query) => query,
	qwen: (query) =>
		`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:${query}`,
	hed: (query) =>
		`Instruct: Given a description of an experimental event, retrieve the matching HED tag\nQuery:${query}`,
};

/** Format applied to queries at runtime. */
export const DEFAULT_QUERY_FORMAT: QueryFormat = 'raw';

/** Wraps a query for embedding in the given format. */
export function formatQuery(query: string, format: QueryFormat = DEFAULT_QUERY_FORMAT): string {
	return QUERY_FORMATS[format](query);
}
