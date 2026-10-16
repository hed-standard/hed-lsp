/**
 * Logging for the engine. Each message is formatted into one string before it reaches a sink, so
 * no printf formatting can change a path that contains a percent sign. The engine writes to stderr
 * by default, because the CLI prints its JSON on stdout. The language server installs a sink that
 * forwards to the console.
 *
 * A line can carry a detail beside its message: the variable part, such as the message of an error,
 * which can quote the input that caused it. A sink that prints for people shows it after the message;
 * a sink that must not log input, such as the daemon's, drops it.
 */

import * as util from 'node:util';

export interface LogSink {
	info(message: string, detail?: string): void;
	error(message: string, detail?: string): void;
}

/** The text of a line as a sink prints it for people: the message, and `: ` and the detail when there is one. */
export function lineText(message: string, detail?: string): string {
	return detail === undefined ? message : `${message}: ${detail}`;
}

const stderrSink: LogSink = {
	info: (message, detail) => process.stderr.write(`${lineText(message, detail)}\n`),
	error: (message, detail) => process.stderr.write(`${lineText(message, detail)}\n`),
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
	/**
	 * An error line whose variable part is passed apart from its text. The message of an error can quote
	 * the input that caused it, so a sink decides whether to print it.
	 */
	errorWithDetail: (message: string, detail: string) => sink.error(message, detail),
};
