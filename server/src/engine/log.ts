/**
 * Logging for the engine. The engine writes to stderr by default, because the CLI prints
 * its JSON on stdout. The language server installs a sink that forwards to the console.
 */

import * as util from 'node:util';

export interface LogSink {
	info(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

const stderrSink: LogSink = {
	info: (...args) => process.stderr.write(`${util.format(...args)}\n`),
	error: (...args) => process.stderr.write(`${util.format(...args)}\n`),
};

let sink: LogSink = stderrSink;

/** Set where engine log lines go. Returns the previous sink, so a caller can restore it. */
export function setLogger(next: LogSink): LogSink {
	const previous = sink;
	sink = next;
	return previous;
}

/**
 * Engine log functions. Arguments reach the sink unchanged, so a sink that formats them the way
 * console does formats them exactly as the engine did before it had a logger.
 */
export const log = {
	info: (...args: unknown[]) => sink.info(...args),
	error: (...args: unknown[]) => sink.error(...args),
};
