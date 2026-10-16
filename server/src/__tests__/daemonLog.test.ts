/**
 * Tests for what the daemon logs about an exception. An exception's message can quote the request
 * that caused it, and it can run over many lines, so only the type of the exception and its stack
 * frames are logged, and the frames are read from the stack only after its header, the name and the
 * message, has been cut off. The engine passes the message of an error apart from the text of some
 * of its lines, as a detail; the daemon's sink writes the text and drops the detail. Real errors,
 * real stacks, a real engine failure. No mocks.
 */

import { describe, expect, it } from 'vitest';
import { createLogger, engineSink, errorDetail } from '../daemon/log.js';
import { failureReply, itemFailure, VALIDATION_FAILED } from '../daemon/server.js';
import { findSuggestions, setLogger } from '../engine/index.js';

const SECRET = 'SECRET-9c1f';

/** An error thrown from `depth` calls down, so its stack has frames beyond the one that made it. */
function thrownFrom(depth: number, message: string): Error {
	const make = (level: number): Error => (level === 0 ? new Error(message) : make(level - 1));
	return make(depth);
}

describe('errorDetail', () => {
	it('keeps the type of an exception and its frames, each starting with "at "', () => {
		const detail = errorDetail(thrownFrom(3, 'plain message'));

		expect(detail.errorType).toBe('Error');
		const frames = detail.frames as string[];
		expect(frames.length).toBeGreaterThan(3);
		expect(frames.every((frame) => frame.startsWith('at '))).toBe(true);
		expect(JSON.stringify(detail)).not.toContain('plain message');
	});

	it('keeps at most 8 frames', () => {
		expect((errorDetail(thrownFrom(20, 'deep')).frames as string[]).length).toBe(8);
	});

	it('does not read a line of a multi-line message as a frame, however it is indented', () => {
		const messages = [
			`bad input\nat ${SECRET}`,
			`bad input\n    at ${SECRET} (file.js:1:1)`,
			`\n  at ${SECRET}\n    at ${SECRET}-again (file.js:2:2)`,
			`${SECRET}\n\tat ${SECRET}`,
			`first\r\n    at ${SECRET}\r\nlast`,
		];
		for (const message of messages) {
			const detail = errorDetail(thrownFrom(2, message));

			expect(JSON.stringify(detail), JSON.stringify(message)).not.toContain(SECRET);
			// The real frames are still there.
			expect((detail.frames as string[]).length).toBeGreaterThan(0);
			expect((detail.frames as string[]).every((frame) => frame.startsWith('at '))).toBe(true);
		}
	});

	it('cuts the header by the message, so a stack whose first frame line looks like the message is still read', () => {
		const detail = errorDetail(thrownFrom(2, 'at somewhere'));

		expect((detail.frames as string[]).length).toBeGreaterThan(0);
	});

	it('keeps no frame when the message was changed after the stack was read, and no text of it either way', () => {
		const settled = thrownFrom(2, 'original');
		// Reading the stack fixes its header, so a message set afterwards is not in it.
		expect(settled.stack).toContain('original');
		settled.message = `changed\n    at ${SECRET}`;
		const unread = thrownFrom(2, 'original');
		unread.message = `changed\n    at ${SECRET}`;

		expect(errorDetail(settled)).toEqual({ errorType: 'Error', frames: [] });
		expect(JSON.stringify(errorDetail(unread))).not.toContain(SECRET);
	});

	it('reads the frames of an error whose name was set after the stack was captured', () => {
		class Named extends Error {
			constructor(message: string) {
				super(message);
				this.name = 'Named';
			}
		}

		const detail = errorDetail(new Named(`two\n    at ${SECRET}\nlines`));

		expect(detail.errorType).toBe('Named');
		expect(JSON.stringify(detail)).not.toContain(SECRET);
		expect((detail.frames as string[]).length).toBeGreaterThan(0);
	});

	it('handles an error with no message', () => {
		const detail = errorDetail(thrownFrom(1, ''));

		expect(detail.errorType).toBe('Error');
		expect((detail.frames as string[]).length).toBeGreaterThan(0);
	});

	it('describes a thrown value that is not an Error by its type alone', () => {
		for (const value of [SECRET, { message: SECRET }, 7, null, undefined]) {
			expect(JSON.stringify(errorDetail(value))).not.toContain(SECRET);
			expect(errorDetail(value)).toEqual({ errorType: typeof value });
		}
	});
});

describe('what reaches the log when a request or an item fails', () => {
	it('never writes the marker of a multi-line message to any line, whether the request or one item failed', () => {
		const lines: string[] = [];
		const logger = createLogger((line) => lines.push(line));
		const message = `could not read Sensory-event, ${SECRET}\nat ${SECRET}\n    at ${SECRET} (x.js:1:1)`;

		const reply = failureReply(thrownFrom(2, message), 'req-1', logger);
		const item = itemFailure(logger, 'req-1', 4, thrownFrom(2, message), VALIDATION_FAILED);

		expect(lines).toHaveLength(2);
		expect(lines.join('\n')).not.toContain(SECRET);
		expect(JSON.stringify(reply)).not.toContain(SECRET);
		expect(JSON.stringify(item)).not.toContain(SECRET);
		for (const line of lines) {
			expect(JSON.parse(line).frames.length).toBeGreaterThan(0);
		}
	});
});

describe('engine lines through the daemon sink', () => {
	/** A library that does not exist, so loading it fails for real and the schema search that needs it throws. */
	const MISSING = '8.4.0,sc:score_9.9.9';

	it('writes the text of a line and drops its detail, which can quote the request', () => {
		const lines: string[] = [];
		const sink = engineSink(createLogger((line) => lines.push(line)));

		sink.error('Warning: Schema search failed', `Could not load ${SECRET}`);
		sink.info('[HED] Loading schema: 8.4.0', SECRET);

		const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries).toMatchObject([
			{ level: 'error', msg: 'Warning: Schema search failed' },
			{ level: 'info', msg: '[HED] Loading schema: 8.4.0' },
		]);
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(['level', 'msg', 'time']);
		}
		expect(lines.join('\n')).not.toContain(SECRET);
	});

	it('writes the schema search warning of the real engine without the message of its error', async () => {
		const lines: string[] = [];
		const previous = setLogger(engineSink(createLogger((line) => lines.push(line))));
		try {
			await findSuggestions('red square', { schema: MISSING, top: 10 });
		} finally {
			setLogger(previous);
		}

		const warnings = lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => entry.msg === 'Warning: Schema search failed');
		expect(warnings).toHaveLength(1);
		expect(Object.keys(warnings[0]).sort()).toEqual(['level', 'msg', 'time']);
		expect(JSON.stringify(warnings[0])).not.toContain('SCHEMA_LOAD_FAILED');
		expect(JSON.stringify(warnings[0])).not.toContain('9.9.9');
	});
});
