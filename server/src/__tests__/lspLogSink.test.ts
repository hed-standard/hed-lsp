/**
 * Test for how the language server prints an engine log line that carries a detail. The engine passes
 * the message of an error apart from the text of some of its lines, and the language server prints the
 * two joined as "text: detail", the same line that it printed before the detail was a separate
 * argument. The compiled server runs as a child process over stdio, and a real failure inside a batch
 * of suggestions logs the line. It needs `bun run compile` first. No mocks.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { setLogger } from '../engine/log.js';
import { findSuggestions } from '../engine/suggestionEngine.js';

const serverEntry = path.join(__dirname, '..', '..', 'out', 'server.js');

/** The message of the error that a query which is not a string throws, which a number in a JSON request is. */
async function messageOfNumericQuery(): Promise<string> {
	const previousSink = setLogger({ info: () => {}, error: () => {} });
	try {
		await findSuggestions(42 as unknown as string, { schema: '8.4.0', top: 5 });
	} catch (error) {
		return (error as Error).message;
	} finally {
		setLogger(previousSink);
	}
	throw new Error('a numeric query was expected to throw');
}

describe('the language server console sink', () => {
	it('prints the failure line of a batch query as the text, a colon, and the message of the error', async () => {
		if (!existsSync(serverEntry)) {
			throw new Error(`${serverEntry} is missing; run "bun run compile" before this test`);
		}
		const child: ChildProcess = spawn(process.execPath, [serverEntry, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
		const connection = createMessageConnection(
			new StreamMessageReader(child.stdout!),
			new StreamMessageWriter(child.stdin!),
		);
		const logs: string[] = [];
		connection.onNotification('window/logMessage', (params: { message: string }) => {
			logs.push(params.message);
		});
		connection.listen();

		try {
			await connection.sendRequest('initialize', { processId: null, rootUri: null, capabilities: {} });
			connection.sendNotification('initialized', {});

			const suggestions = (await connection.sendRequest('hed/suggest', {
				queries: ['red square', 42, 'modulator'],
				schema: '8.4.0,sc:score_2.1.0',
				top: 5,
			})) as Record<string, string[]>;

			expect(Object.keys(suggestions)).toEqual(['red square', 'modulator']);
			expect(logs).toContain(`[HED] Suggestions failed for query 2 of 3: ${await messageOfNumericQuery()}`);
		} finally {
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
			await connection.sendRequest('shutdown');
			connection.sendNotification('exit');
			await exited;
			connection.dispose();
		}
	}, 120000);
});
