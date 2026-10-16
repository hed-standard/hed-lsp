/**
 * Structured logging for the daemon: every line is one JSON object, whether the daemon wrote it
 * or the engine did through its log sink. Callers decide what a line carries; this module never
 * sees a request body, a query, a HED string, or an IP address.
 */

import type { LogSink } from '../engine/index.js';

export type LogFields = Record<string, unknown>;

/** Receives one finished line, without the trailing newline. */
export type LineWriter = (line: string) => void;

export interface Logger {
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
}

/** The default writer: one line on stderr. */
export function stderrWriter(line: string): void {
	process.stderr.write(`${line}\n`);
}

/**
 * A logger that writes `{time, level, msg, ...fields}` as one JSON line. The reserved keys cannot
 * be overridden by a field of the same name.
 */
export function createLogger(write: LineWriter = stderrWriter, clock: () => Date = () => new Date()): Logger {
	const emit = (level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields): void => {
		const line: LogFields = { time: clock().toISOString(), level, msg };
		for (const [key, value] of Object.entries(fields ?? {})) {
			if (!(key in line)) {
				line[key] = value;
			}
		}
		write(JSON.stringify(line));
	};
	return {
		info: (msg, fields) => emit('info', msg, fields),
		warn: (msg, fields) => emit('warn', msg, fields),
		error: (msg, fields) => emit('error', msg, fields),
	};
}

/** A sink for the engine's `setLogger`, so engine lines are JSON objects like the daemon's own. */
export function engineSink(logger: Logger): LogSink {
	return {
		info: (message) => logger.info(message),
		error: (message) => logger.error(message),
	};
}

/**
 * What to log about an exception without logging request text. An exception's message can quote
 * the input that caused it, so only its type and its stack frames are kept.
 */
export function errorDetail(error: unknown): LogFields {
	if (!(error instanceof Error)) {
		return { errorType: typeof error };
	}
	const frames = (error.stack ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('at '))
		.slice(0, 8);
	return { errorType: error.name, frames };
}
