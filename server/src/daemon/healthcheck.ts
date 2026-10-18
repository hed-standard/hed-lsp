#!/usr/bin/env node

/**
 * The Docker health probe: ask the daemon on this machine for /v1/health and exit 0 only when it
 * answers 200 with a status of `ok` or `degraded`. Anything else, including no answer within two
 * seconds, exits 1. The slim runtime image has no curl, so the probe is part of the daemon.
 */

import * as http from 'node:http';
import { loadConfig } from './config.js';

/** The longest the probe waits for the whole answer. */
export const PROBE_TIMEOUT_MS = 2000;

/** The most of an answer that is read; a health answer is a few hundred bytes. */
const MAX_ANSWER_BYTES = 65_536;

/** Whether a health answer from the daemon says it can serve requests. */
export function isHealthy(statusCode: number | undefined, body: string): boolean {
	if (statusCode !== 200) {
		return false;
	}
	try {
		const status: unknown = JSON.parse(body).status;
		return status === 'ok' || status === 'degraded';
	} catch {
		return false;
	}
}

/** Ask the daemon on 127.0.0.1:`port` for its health. Resolves false for any failure; never rejects. */
export function checkHealth(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		const request = http.get(
			{ host: '127.0.0.1', port, path: '/v1/health', agent: false, signal: AbortSignal.timeout(timeoutMs) },
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_ANSWER_BYTES) {
						response.destroy();
						resolve(false);
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () => resolve(isHealthy(response.statusCode, Buffer.concat(chunks).toString('utf-8'))));
				response.on('error', () => resolve(false));
			},
		);
		request.on('error', () => resolve(false));
	});
}

if (require.main === module) {
	let port: number;
	try {
		port = loadConfig(process.env).port;
	} catch {
		// A daemon that could not read this configuration is not running.
		process.exit(1);
	}
	void checkHealth(port).then((healthy) => process.exit(healthy ? 0 : 1));
}
