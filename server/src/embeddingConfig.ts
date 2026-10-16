/**
 * Embedding model settings shared by the runtime (embeddings.ts) and the
 * generator (scripts/generateEmbeddings.ts), so the vectors that were stored
 * and the query vectors computed at runtime come from the same configuration.
 */

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
