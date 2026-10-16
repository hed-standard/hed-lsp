/**
 * Semantic search state for the daemon. This first version reports `disabled` only; the state
 * machine for model warm-up, retries, and the ready state arrives with the suggest endpoint.
 */

import { EMBEDDING_SCHEMA_VERSION } from '../engine/index.js';
import type { SemanticState } from './protocol.js';

export interface SemanticSnapshot {
	state: SemanticState;
	/** Consecutive failed model loads. */
	failures: number;
	/** The schema set the embedding index was built against. */
	index: string;
}

export class SemanticService {
	snapshot(): SemanticSnapshot {
		return { state: 'disabled', failures: 0, index: EMBEDDING_SCHEMA_VERSION };
	}

	/** Begin warm-up. Nothing to do while semantic search is disabled. */
	start(): void {}

	/** Stop timers, so a closed daemon leaves nothing running. */
	stop(): void {}
}
