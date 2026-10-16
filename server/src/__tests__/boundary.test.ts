/**
 * Boundary test: the engine must not depend on the language server or on the editor adapters.
 * The rules are applied to the real engine source, and the rules are tested on synthetic source
 * text so that a weakened matcher fails here. No mocks.
 *
 * The check is textual, not a parse. It reads module specifiers written as string literals after
 * import, export-from, require, and triple-slash reference forms, with single, double, or backtick
 * quotes. It does not follow computed specifiers, such as a variable or a createRequire call, so
 * engine modules must name their imports as literals.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const engineDir = path.join(__dirname, '..', 'engine');

/**
 * Whether a module at `file` may import `specifier`. Relative paths are allowed only when they stay
 * inside the engine directory. Node built-ins and the two engine dependencies are allowed by name.
 */
function allowed(specifier: string, file: string): boolean {
	if (specifier.startsWith('.')) {
		const target = path.resolve(path.dirname(file), specifier);
		return target === engineDir || target.startsWith(engineDir + path.sep);
	}
	return specifier.startsWith('node:') || specifier === 'hed-validator' || specifier === '@huggingface/transformers';
}

/**
 * Each alternative names one form and captures its path in one of three groups (single, double, or
 * backtick quotes). The keyword must be followed by whitespace or a parenthesis, and the path must
 * stay on one line, so data such as the keyword 'from' (followed directly by a quote) is not read as
 * an import. Triple-slash path and types references are read as well.
 */
const SPECIFIER_PATTERN =
	/\bfrom\s+(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)|\bimport\s*\(\s*(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)|\bimport\s+(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)|\brequire(?:\.resolve)?\s*\(\s*(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)|<reference\s+(?:path|types)\s*=\s*(?:'([^'\n]+)'|"([^"\n]+)")/g;

/** Module specifiers in source text, in the order they appear. */
function specifiersIn(source: string): string[] {
	return Array.from(source.matchAll(SPECIFIER_PATTERN), (match) => {
		return match.slice(1).find((group) => group !== undefined) ?? '';
	});
}

/** Specifiers in the source text of `file` that the engine may not import. */
function violationsIn(source: string, file: string): string[] {
	return specifiersIn(source).filter((specifier) => !allowed(specifier, file));
}

/** Every TypeScript or JavaScript module under `dir`, including subdirectories. */
function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(full);
		}
		return /\.(?:[cm]?ts|js)$/.test(entry.name) ? [full] : [];
	});
}

describe('engine boundary', () => {
	it('imports only engine modules, node built-ins, and the two engine dependencies', () => {
		const files = sourceFiles(engineDir);
		expect(files.length).toBeGreaterThan(0);

		const violations = files.flatMap((file) =>
			violationsIn(fs.readFileSync(file, 'utf-8'), file).map(
				(specifier) => `${path.relative(engineDir, file)} imports ${specifier}`,
			),
		);

		expect(violations, 'engine modules must not import the language server or adapters').toEqual([]);
	});

	describe('rules', () => {
		const probe = path.join(engineDir, 'probe.ts');

		it.each([
			"import { x } from './types.js';",
			"import { x } from './sub/helper.js';",
			"export * from './validation.js';",
			"import { x } from 'node:fs';",
			"import { x } from 'hed-validator';",
			"import { x } from '@huggingface/transformers';",
			"/// <reference path='./types.ts' />",
		])('allows %s', (line) => {
			expect(violationsIn(line, probe)).toEqual([]);
		});

		it.each([
			"import { x } from '../types.js';",
			"import { x } from './../types.js';",
			"import { x } from './a/../../types.js';",
			"import './../types.js';",
			"import 'vscode-languageserver';",
			"import type { Position } from 'vscode-languageserver/node';",
			"export { x } from 'vscode-languageserver-textdocument';",
			'import { x } from "vscode-languageserver";',
			'import { x } from `vscode-languageserver`;',
			"const lsp = await import('vscode-languageserver');",
			'const lsp = await import(`vscode-languageserver`);',
			"const lsp = require('../server.js');",
			"const lsp = require.resolve('vscode-languageserver');",
			"import lsp = require('vscode-languageserver');",
			"import { x } from '/abs/path.js';",
			'/// <reference types="vscode-languageserver" />',
			"/// <reference path='../types.ts' />",
		])('rejects %s', (line) => {
			expect(violationsIn(line, probe).length).toBeGreaterThan(0);
		});

		it("does not read the data keywords 'from' and 'import' as imports", () => {
			expect(violationsIn("const keywords = [['from'], ['import']];", probe)).toEqual([]);
		});

		it('resolves relative imports from the importing file, so a subdirectory may import its parent', () => {
			const nested = path.join(engineDir, 'sub', 'nested.ts');

			expect(violationsIn("import { x } from '../index.js';", nested)).toEqual([]);
			expect(violationsIn("import { x } from '../../types.js';", nested)).toEqual(['../../types.js']);
		});

		it('collects TypeScript and JavaScript modules from subdirectories', () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-walk-'));
			try {
				fs.mkdirSync(path.join(root, 'sub'));
				fs.writeFileSync(path.join(root, 'top.ts'), '');
				fs.writeFileSync(path.join(root, 'esm.mts'), '');
				fs.writeFileSync(path.join(root, 'legacy.js'), '');
				fs.writeFileSync(path.join(root, 'sub', 'nested.ts'), '');
				fs.writeFileSync(path.join(root, 'sub', 'notes.md'), '');

				const found = sourceFiles(root).map((file) => path.relative(root, file));
				expect(found.sort()).toEqual(['esm.mts', 'legacy.js', path.join('sub', 'nested.ts'), 'top.ts']);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
