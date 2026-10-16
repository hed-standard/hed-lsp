/**
 * Tests for what the daemon logs about an exception. An exception's message can quote the request
 * that caused it, and it can run over many lines, so only the type of the exception and its stack
 * frames are logged, and the frames are read from the stack only after its header, the name and the
 * message, has been cut off. Real errors, real stacks. No mocks.
 */

import { describe, expect, it } from 'vitest';
import { createLogger, errorDetail } from '../daemon/log.js';
import { failureReply, itemFailure, VALIDATION_FAILED } from '../daemon/server.js';

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
