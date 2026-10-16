/**
 * Logging for the engine. The engine writes to stderr by default, because the CLI prints
 * its JSON on stdout. The language server installs a sink that forwards to the client.
 */

import * as util from 'node:util';

export interface LogSink {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

const stderrSink: LogSink = {
	info: (message) => process.stderr.write(`${message}\n`),
	warn: (message) => process.stderr.write(`${message}\n`),
	error: (message) => process.stderr.write(`${message}\n`),
};

let sink: LogSink = stderrSink;

/** Set where engine log lines go. */
export function setLogger(next: LogSink): void {
	sink = next;
}

/** Engine log functions. Arguments are formatted the same way console formats them. */
export const log = {
	info: (...args: unknown[]) => sink.info(util.format(...args)),
	warn: (...args: unknown[]) => sink.warn(util.format(...args)),
	error: (...args: unknown[]) => sink.error(util.format(...args)),
};
