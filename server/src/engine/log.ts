/**
 * Logging for the engine. Each message is formatted into one string before it reaches a sink, so
 * no printf formatting can change a path that contains a percent sign. The engine writes to stderr
 * by default, because the CLI prints its JSON on stdout. The language server installs a sink that
 * forwards to the console.
 */

import * as util from 'node:util';

export interface LogSink {
	info(message: string): void;
	error(message: string): void;
}

const stderrSink: LogSink = {
	info: (message) => process.stderr.write(`${message}\n`),
	error: (message) => process.stderr.write(`${message}\n`),
};

let sink: LogSink = stderrSink;

/** Set where engine log lines go. Returns the previous sink, so a caller can restore it. */
export function setLogger(next: LogSink): LogSink {
	const previous = sink;
	sink = next;
	return previous;
}

/**
 * Join log arguments into one message: strings as they are, anything else inspected, separated by
 * spaces. This is how the LSP console joins arguments, and it never applies printf substitution.
 */
function formatMessage(args: unknown[]): string {
	return args.map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg))).join(' ');
}

/** Engine log functions. */
export const log = {
	info: (...args: unknown[]) => sink.info(formatMessage(args)),
	error: (...args: unknown[]) => sink.error(formatMessage(args)),
};
