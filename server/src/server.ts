/**
 * HED Language Server
 * Main entry point for the LSP server.
 */

import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	InitializeResult,
	TextDocumentSyncKind,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentPositionParams,
	Hover
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import { defaultSettings, HedLspSettings } from './types.js';
import { schemaManager } from './schemaManager.js';
import { parseJsonForHedStrings } from './documentParser.js';
import { validateDocument } from './validation.js';
import { provideCompletions, resolveCompletionItem, completionTriggerCharacters } from './completion.js';
import { provideHover } from './hover.js';

// Create a connection using Node's IPC transport
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents = new TextDocuments(TextDocument);

// Capability flags
let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

// Settings
let globalSettings: HedLspSettings = defaultSettings;
const documentSettings = new Map<string, Thenable<HedLspSettings>>();

// Debounce timer for validation
const validationDebounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Initialize the server.
 */
connection.onInitialize((params: InitializeParams): InitializeResult => {
	const capabilities = params.capabilities;

	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: completionTriggerCharacters
			},
			hoverProvider: true
		}
	};

	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}

	return result;
});

/**
 * After initialization, register for configuration changes.
 */
connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}

	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}

	connection.console.log('HED Language Server initialized successfully');
	connection.console.log('Completion trigger characters: ' + completionTriggerCharacters.join(', '));
	connection.console.log('Hover and completion providers are ready');
});

/**
 * Get settings for a document.
 */
function getDocumentSettings(resource: string): Thenable<HedLspSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}

	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'hed'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

/**
 * Handle configuration changes.
 */
connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		documentSettings.clear();
	} else {
		globalSettings = change.settings.hed || defaultSettings;
	}

	// Update schema version if changed
	const newVersion = change.settings?.hed?.schemaVersion;
	if (newVersion) {
		schemaManager.setCurrentVersion(newVersion);
	}

	// Revalidate all open documents
	documents.all().forEach(validateDocumentDebounced);
});

/**
 * Clean up settings when document is closed.
 */
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	const timer = validationDebounceTimers.get(e.document.uri);
	if (timer) {
		clearTimeout(timer);
		validationDebounceTimers.delete(e.document.uri);
	}
});

/**
 * Validate on content change with debounce.
 */
documents.onDidChangeContent(change => {
	validateDocumentDebounced(change.document);
});

/**
 * Validate on save immediately.
 */
documents.onDidSave(change => {
	validateDocumentNow(change.document);
});

/**
 * Validate a document with debouncing.
 */
async function validateDocumentDebounced(document: TextDocument): Promise<void> {
	const uri = document.uri;

	// Clear existing timer
	const existingTimer = validationDebounceTimers.get(uri);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	// Get settings for debounce time
	const settings = await getDocumentSettings(uri);

	if (!settings.validateOnChange) {
		return;
	}

	// Set new timer
	const timer = setTimeout(() => {
		validationDebounceTimers.delete(uri);
		validateDocumentNow(document);
	}, settings.debounceMs);

	validationDebounceTimers.set(uri, timer);
}

/**
 * Validate a document immediately.
 */
async function validateDocumentNow(document: TextDocument): Promise<void> {
	// Only validate JSON files
	if (!document.uri.endsWith('.json')) {
		return;
	}

	try {
		const settings = await getDocumentSettings(document.uri);

		// Parse for HED regions
		const regions = parseJsonForHedStrings(document);

		if (regions.length === 0) {
			// No HED content, clear diagnostics
			connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
			return;
		}

		// Validate
		const diagnostics = await validateDocument(document, regions, settings.schemaVersion);

		// Limit number of problems
		const limitedDiagnostics = diagnostics.slice(0, settings.maxNumberOfProblems);

		// Send diagnostics
		connection.sendDiagnostics({ uri: document.uri, diagnostics: limitedDiagnostics });
	} catch (error) {
		connection.console.error(`Validation error: ${error}`);
	}
}

/**
 * Provide completions.
 */
connection.onCompletion(
	async (params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
		connection.console.log(`[HED] onCompletion called at line ${params.position.line}, char ${params.position.character}`);

		const document = documents.get(params.textDocument.uri);
		if (!document) {
			connection.console.log('[HED] No document found for completion');
			return [];
		}

		try {
			const items = await provideCompletions(document, params.position);
			connection.console.log(`[HED] Returning ${items.length} completion items`);
			return items;
		} catch (error) {
			connection.console.error(`Completion error: ${error}`);
			return [];
		}
	}
);

/**
 * Resolve completion item details.
 */
connection.onCompletionResolve(
	async (item: CompletionItem): Promise<CompletionItem> => {
		try {
			return await resolveCompletionItem(item);
		} catch (error) {
			connection.console.error(`Completion resolve error: ${error}`);
			return item;
		}
	}
);

/**
 * Provide hover information.
 */
connection.onHover(
	async (params: TextDocumentPositionParams): Promise<Hover | null> => {
		const document = documents.get(params.textDocument.uri);
		if (!document) {
			return null;
		}

		try {
			return await provideHover(document, params.position);
		} catch (error) {
			connection.console.error(`Hover error: ${error}`);
			return null;
		}
	}
);

// Make the document manager listen on the connection
documents.listen(connection);

// Listen on the connection
connection.listen();
