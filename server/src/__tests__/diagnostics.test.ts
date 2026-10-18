/**
 * Characterization of document validation (diagnostics) against pinned outputs, for a
 * sample sidecar and a sample TSV. The pins were captured before the engine was extracted.
 * They use the bundled 8.4.0 schema. No mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { validateDocument } from '../diagnostics.js';
import { parseJsonForHedStrings } from '../documentParser.js';
import { parseTsvForHedStrings } from '../tsvParser.js';

const fixtures = path.join(__dirname, 'fixtures');
const pinned = (name: string) => JSON.parse(readFileSync(path.join(fixtures, 'pinned', `${name}.json`), 'utf-8'));

function project(diagnostics: Diagnostic[]) {
	return diagnostics.map((d) => ({
		severity: d.severity,
		code: d.code,
		message: d.message,
		range: d.range,
		source: d.source,
	}));
}

describe('document diagnostics match the pinned outputs', () => {
	it('reports the invalid, unbalanced, and placeholder HED strings in a sidecar', async () => {
		const text = readFileSync(path.join(fixtures, 'sample_events.json'), 'utf-8');
		const document = TextDocument.create('file:///fixtures/sample_events.json', 'json', 1, text);

		const diagnostics = await validateDocument(document, parseJsonForHedStrings(document), '8.4.0');

		expect(JSON.parse(JSON.stringify(project(diagnostics)))).toEqual(pinned('diagnosticsSidecar'));
	});

	it('reports the invalid HED string in a TSV HED column', async () => {
		const text = readFileSync(path.join(fixtures, 'sample_events.tsv'), 'utf-8');
		const document = TextDocument.create('file:///fixtures/sample_events.tsv', 'tsv', 1, text);

		const diagnostics = await validateDocument(document, parseTsvForHedStrings(document), '8.4.0');

		expect(JSON.parse(JSON.stringify(project(diagnostics)))).toEqual(pinned('diagnosticsTsv'));
	});
});
