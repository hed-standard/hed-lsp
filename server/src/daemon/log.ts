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

/**
 * A sink for the engine's `setLogger`, so engine lines are JSON objects like the daemon's own. The
 * detail that the engine passes with some lines, the message of an error, is dropped on purpose: it
 * can quote the request, and the daemon logs no request text.
 */
export function engineSink(logger: Logger): LogSink {
	return {
		info: (message) => logger.info(message),
		error: (message) => logger.error(message),
	};
}

/** The most stack frames kept from an exception. */
const MAX_FRAMES = 8;

/** A line of a stack that is a frame: it starts with whitespace and then `at `. */
const FRAME_LINE = /^\s+at /;

/**
 * The stack frames of an exception, without anything of its message. A stack is the header, the
 * name and the message, and then one line per frame. A message can run over many lines, and a line
 * of it can look like a frame, so the header is cut off first, by the length of the message, before
 * any line is read as a frame. When the message is not in the stack, because it was changed after
 * the stack was captured, no frame is kept.
 */
function stackFrames(error: Error): string[] {
	const stack = error.stack ?? '';
	let afterHeader = stack;
	if (error.message !== '') {
		const at = stack.indexOf(error.message);
		afterHeader = at === -1 ? '' : stack.slice(at + error.message.length);
	}
	return afterHeader
		.split('\n')
		.filter((line) => FRAME_LINE.test(line))
		.map((line) => line.trim())
		.slice(0, MAX_FRAMES);
}

/**
 * What to log about an exception without logging request text. An exception's message can quote
 * the input that caused it, so only its type and its stack frames are kept.
 */
export function errorDetail(error: unknown): LogFields {
	if (!(error instanceof Error)) {
		return { errorType: typeof error };
	}
	return { errorType: error.name, frames: stackFrames(error) };
}
