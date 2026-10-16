/**
 * Characterization of the editor features (completion, hover, semantic tokens) against
 * pinned outputs. The pins were captured from the code before the engine was extracted,
 * so these tests fail if a move changes what an editor receives. They run on the bundled
 * 8.4.0 schema, so they behave the same offline and online. No mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { provideCompletions } from '../completion.js';
import { schemaManager } from '../engine/schemaManager.js';
import { provideHover } from '../hover.js';
import { provideSemanticTokens } from '../semanticTokens.js';

const fixtures = path.join(__dirname, 'fixtures');
const pinned = (name: string) => JSON.parse(readFileSync(path.join(fixtures, 'pinned', `${name}.json`), 'utf-8'));
const readFixture = (name: string) => readFileSync(path.join(fixtures, name), 'utf-8');

const completionJsonText =
	'{\n  "trial_type": {\n    "HED": {\n      "cue": "Sensory-event, Visual-pre"\n    }\n  }\n}\n';
const completionTsvText = 'onset\tduration\ttrial_type\tHED\n0.5\t1.0\tred\tSensory-event, Visual-pre\n';

/** Offset of the first occurrence of `needle` in `text`, plus `within` characters. */
function offsetOf(text: string, needle: string, within: number): number {
	const index = text.indexOf(needle);
	if (index < 0) {
		throw new Error(`fixture text does not contain ${needle}`);
	}
	return index + within;
}

/** Round-trip through JSON so the comparison sees exactly what would cross the wire. */
function wire<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

describe('editor features match the pinned outputs', () => {
	beforeAll(() => {
		schemaManager.setCurrentVersion('8.4.0');
	});

	it('completes a partial tag in a sidecar value', async () => {
		const document = TextDocument.create('file:///fixtures/completion.json', 'json', 1, completionJsonText);
		const offset = offsetOf(completionJsonText, 'Visual-pre', 'Visual-pre'.length);

		const items = await provideCompletions(document, document.positionAt(offset));
		const projected = items.map((item) => ({
			label: item.label,
			kind: item.kind,
			sortText: item.sortText,
			insertText: item.insertText,
			detail: item.detail,
		}));

		expect(wire(projected)).toEqual(pinned('completionJson'));
	});

	it('completes a partial tag in a TSV HED column', async () => {
		const document = TextDocument.create('file:///fixtures/completion.tsv', 'tsv', 1, completionTsvText);
		const offset = offsetOf(completionTsvText, 'Visual-pre', 'Visual-pre'.length);

		const items = await provideCompletions(document, document.positionAt(offset));
		const projected = items.map((item) => ({
			label: item.label,
			kind: item.kind,
			sortText: item.sortText,
			insertText: item.insertText,
			detail: item.detail,
		}));

		expect(wire(projected)).toEqual(pinned('completionTsv'));
	});

	it('shows hover documentation for a tag in a sidecar', async () => {
		const text = readFixture('sample_events.json');
		const document = TextDocument.create('file:///fixtures/sample_events.json', 'json', 1, text);
		const offset = offsetOf(text, 'Visual-presentation', 3);

		const hover = await provideHover(document, document.positionAt(offset));

		expect(wire(hover)).toEqual(pinned('hoverSidecar'));
	});

	it('shows hover documentation for a tag in a TSV HED column', async () => {
		const text = readFixture('sample_events.tsv');
		const document = TextDocument.create('file:///fixtures/sample_events.tsv', 'tsv', 1, text);
		const offset = offsetOf(text, 'Square', 2);

		const hover = await provideHover(document, document.positionAt(offset));

		expect(wire(hover)).toEqual(pinned('hoverTsv'));
	});

	it('produces semantic tokens for a sidecar', () => {
		const text = readFixture('sample_events.json');
		const document = TextDocument.create('file:///fixtures/sample_events.json', 'json', 1, text);

		expect(wire(provideSemanticTokens(document).build().data)).toEqual(pinned('tokensSidecar'));
	});

	it('produces semantic tokens for a TSV file', () => {
		const text = readFixture('sample_events.tsv');
		const document = TextDocument.create('file:///fixtures/sample_events.tsv', 'tsv', 1, text);

		expect(wire(provideSemanticTokens(document).build().data)).toEqual(pinned('tokensTsv'));
	});
});
