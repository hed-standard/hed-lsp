/**
 * HED Language Extension for VS Code
 * Launches the HED language server and provides HED language features.
 */

import * as path from 'node:path';
import { type ExtensionContext, StatusBarAlignment, type StatusBarItem, window, workspace } from 'vscode';

import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;
let statusBarItem: StatusBarItem;

const SEMANTIC_SEARCH_PROMPT_KEY = 'hed.semanticSearchPromptShown';

/**
 * Progress update from the server.
 */
interface ModelProgress {
	status: 'downloading' | 'loading' | 'ready' | 'error';
	message: string;
	progress?: number;
}

/**
 * Activate the extension.
 */
export function activate(context: ExtensionContext) {
	// Create status bar item for model download progress
	statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);
	statusBarItem.name = 'HED Semantic Search';
	context.subscriptions.push(statusBarItem);

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
	client.start().then(() => {
		// Listen for model progress notifications
		client.onNotification('hed/modelProgress', (progress: ModelProgress) => {
			handleModelProgress(progress);
		});
	});

	// Check if we should prompt for semantic search
	promptForSemanticSearch(context);
}

/**
 * Handle model download progress updates from the server.
 */
function handleModelProgress(progress: ModelProgress): void {
	switch (progress.status) {
		case 'downloading':
			statusBarItem.text = `$(sync~spin) HED: ${progress.message}`;
			statusBarItem.tooltip = 'Downloading semantic search model...';
			statusBarItem.show();
			break;
		case 'loading':
			statusBarItem.text = '$(sync~spin) HED: Loading model...';
			statusBarItem.tooltip = progress.message;
			statusBarItem.show();
			break;
		case 'ready':
			statusBarItem.text = '$(check) HED: Semantic search ready';
			statusBarItem.tooltip = 'Semantic search is ready to use';
			statusBarItem.show();
			// Hide after 5 seconds
			setTimeout(() => {
				statusBarItem.hide();
			}, 5000);
			window.showInformationMessage('HED semantic search model loaded successfully!');
			break;
		case 'error':
			statusBarItem.text = '$(error) HED: Model error';
			statusBarItem.tooltip = progress.message;
			statusBarItem.show();
			window.showErrorMessage(`HED semantic search error: ${progress.message}`);
			break;
	}
}

/**
 * Prompt user to enable semantic search if not already configured.
 */
async function promptForSemanticSearch(context: ExtensionContext): Promise<void> {
	const config = workspace.getConfiguration('hed');
	const semanticSearchEnabled = config.get<boolean>('enableSemanticSearch', false);

	// If already enabled, no need to prompt
	if (semanticSearchEnabled) {
		return;
	}

	// Check if we've already shown the prompt
	const promptShown = context.globalState.get<boolean>(SEMANTIC_SEARCH_PROMPT_KEY, false);
	if (promptShown) {
		return;
	}

	// Mark prompt as shown
	await context.globalState.update(SEMANTIC_SEARCH_PROMPT_KEY, true);

	// Show the prompt
	const result = await window.showInformationMessage(
		'HED Annotation Tools can provide AI-powered semantic search for HED tags. This requires downloading a ~600MB model. Would you like to enable it?',
		'Enable',
		'Not Now',
		'Never Ask Again',
	);

	if (result === 'Enable') {
		await config.update('enableSemanticSearch', true, true);
		window.showInformationMessage('Semantic search enabled. Model download starting...');
	} else if (result === 'Never Ask Again') {
		// Already marked as shown, nothing more to do
	}
	// 'Not Now' - they can enable later via settings
}

/**
 * Deactivate the extension.
 */
export function deactivate(): Thenable<void> | undefined {
	if (statusBarItem) {
		statusBarItem.dispose();
	}
	if (!client) {
		return undefined;
	}
	return client.stop();
}
