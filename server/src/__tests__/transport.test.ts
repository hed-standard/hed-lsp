/**
 * End-to-end checks over real transports: the compiled language server as a child process
 * speaking JSON-RPC over stdio, and the compiled hed-suggest CLI. They need `bun run compile`
 * first; they fail with a clear message if the build output is missing. The language server is
 * configured to the bundled 8.4.0 (with its bundled libraries), so these tests run offline. The
 * CLI uses the default 8.5.0, which falls back to the bundled 8.4.0 when offline, so its
 * assertions are structural. No mocks.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-languageserver/node';
import { defaultSettings } from '../types.js';

const serverEntry = path.join(__dirname, '..', '..', 'out', 'server.js');
const cliEntry = path.join(__dirname, '..', '..', 'out', 'cli.js');
const sampleUri = 'file:///fixtures/sample_events.json';
const sampleText = readFileSync(path.join(__dirname, 'fixtures', 'sample_events.json'), 'utf-8');

function requireBuilt(file: string): void {
	if (!existsSync(file)) {
		throw new Error(`${file} is missing; run "bun run compile" before the transport tests`);
	}
}

interface Session {
	child: ChildProcess;
	connection: ReturnType<typeof createMessageConnection>;
	logs: string[];
}

function startServer(): Session {
	requireBuilt(serverEntry);
	const child = spawn(process.execPath, [serverEntry, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
	const connection = createMessageConnection(
		new StreamMessageReader(child.stdout!),
		new StreamMessageWriter(child.stdin!),
	);
	const logs: string[] = [];
	connection.onNotification('window/logMessage', (params: { message: string }) => {
		logs.push(params.message);
	});
	connection.listen();
	return { child, connection, logs };
}

async function stopServer(session: Session): Promise<number | null> {
	const exited = new Promise<number | null>((resolve) => session.child.once('exit', (code) => resolve(code)));
	await session.connection.sendRequest('shutdown');
	session.connection.sendNotification('exit');
	let timer: ReturnType<typeof setTimeout> | undefined;
	const code = await Promise.race([
		exited,
		new Promise<number | null>((_, reject) => {
			timer = setTimeout(() => reject(new Error('server did not exit')), 30000);
		}),
	]);
	clearTimeout(timer);
	session.connection.dispose();
	return code;
}

describe('language server over stdio', () => {
	it('initializes, validates an opened sidecar, logs, and serves hed/suggest', async () => {
		const session = startServer();
		try {
			const init = (await session.connection.sendRequest('initialize', {
				processId: null,
				rootUri: null,
				capabilities: {},
			})) as { capabilities: Record<string, unknown> };
			expect(init.capabilities.hoverProvider).toBe(true);
			expect(init.capabilities.completionProvider).toBeDefined();
			expect(init.capabilities.semanticTokensProvider).toBeDefined();
			session.connection.sendNotification('initialized', {});
			session.connection.sendNotification('workspace/didChangeConfiguration', {
				settings: { hed: { ...defaultSettings, schemaVersion: '8.4.0' } },
			});

			const diagnostics = await new Promise<{ code?: unknown; message: string }[]>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('no diagnostics within 90s')), 90000);
				session.connection.onNotification(
					'textDocument/publishDiagnostics',
					(params: { uri: string; diagnostics: { code?: unknown; message: string }[] }) => {
						if (params.uri === sampleUri && params.diagnostics.length > 0) {
							clearTimeout(timer);
							resolve(params.diagnostics);
						}
					},
				);
				session.connection.sendNotification('textDocument/didOpen', {
					textDocument: { uri: sampleUri, languageId: 'json', version: 1, text: sampleText },
				});
			});
			expect(diagnostics.some((d) => d.code === 'TAG_INVALID')).toBe(true);
			expect(session.logs).toContain('[HED] Loading schema: 8.4.0,sc:score_2.1.0,la:lang_1.1.0');

			await session.connection.sendRequest('textDocument/completion', {
				textDocument: { uri: sampleUri },
				position: { line: 4, character: 20 },
			});
			expect(session.logs.some((m) => m.includes('[HED] onCompletion called'))).toBe(true);

			const suggestions = (await session.connection.sendRequest('hed/suggest', {
				queries: ['red square'],
				top: 5,
			})) as Record<string, string[]>;
			expect(Object.keys(suggestions)).toEqual(['red square']);
			expect(suggestions['red square'].length).toBeGreaterThan(0);
			expect(suggestions['red square'].length).toBeLessThanOrEqual(5);

			expect(await stopServer(session)).toBe(0);
		} finally {
			session.child.kill();
		}
	}, 150000);
});

describe('hed-suggest CLI', () => {
	it('prints only JSON on stdout for a suggestion query', () => {
		requireBuilt(cliEntry);
		const result = spawnSync(process.execPath, [cliEntry, '--json', 'red square'], {
			encoding: 'utf-8',
			timeout: 150000,
		});

		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout) as Record<string, string[]>;
		expect(Object.keys(parsed)).toEqual(['red square']);
		expect(parsed['red square'].length).toBeGreaterThan(0);
	}, 180000);

	it('prints its usage and exits cleanly for --help', () => {
		requireBuilt(cliEntry);
		const result = spawnSync(process.execPath, [cliEntry, '--help'], { encoding: 'utf-8', timeout: 60000 });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage');
	}, 90000);
});
