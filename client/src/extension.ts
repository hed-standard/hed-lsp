/**
 * HED Language Extension for VS Code
 * Launches the HED language server and provides HED language features.
 */

import * as path from 'node:path';
import { type ExtensionContext, workspace } from 'vscode';

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

/**
 * Activate the extension.
 */
export function activate(context: ExtensionContext) {
	// Path to the server module
	const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

	// Server options - run the server as a Node module
	const serverOptions: ServerOptions = {
		run: {
			module: serverModule,
			transport: TransportKind.ipc,
		},
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: {
				execArgv: ['--nolazy', '--inspect=6009'],
			},
		},
	};

	// Client options - register for JSON and TSV files
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'json' },
			{ scheme: 'file', pattern: '**/*.tsv' },
		],
		synchronize: {
			// Watch for configuration changes
			configurationSection: 'hed',
			// Watch for HED-related file changes
			fileEvents: [
				workspace.createFileSystemWatcher('**/*_events.json'),
				workspace.createFileSystemWatcher('**/dataset_description.json'),
				workspace.createFileSystemWatcher('**/*_events.tsv'),
			],
		},
		// Output channel for debug messages
		outputChannelName: 'HED Language Server',
	};

	// Create the language client
	client = new LanguageClient('hedLanguageServer', 'HED Language Server', serverOptions, clientOptions);

	// Start the client (also launches the server)
	client.start();
}

/**
 * Deactivate the extension.
 */
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
