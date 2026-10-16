/**
 * Boundary test: the engine must not depend on the language server or on the editor adapters.
 * The rules are applied to the real engine source, and the rules are tested on synthetic source
 * text so that a weakened matcher fails here. No mocks.
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
 * Module specifiers in source text: static imports, re-exports, side-effect imports, dynamic
 * imports, and require calls, with either quote style. The keyword must be followed by whitespace
 * or a parenthesis, and the specifier must stay on one line, so data such as the keyword 'from'
 * (followed directly by a quote) does not look like an import.
 */
function specifiersIn(source: string): string[] {
	const pattern =
		/\bfrom\s+['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s+['"]([^'"\n]+)['"]|\brequire\s*\(\s*['"]([^'"\n]+)['"]/g;
	return Array.from(source.matchAll(pattern), (match) => match.slice(1).find((group) => group !== undefined) ?? '');
}

/** Specifiers in the source text of `file` that the engine may not import. */
function violationsIn(source: string, file: string): string[] {
	return specifiersIn(source).filter((specifier) => !allowed(specifier, file));
}

/** Every TypeScript file under `dir`, including subdirectories. */
function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(full);
		}
		return entry.name.endsWith('.ts') ? [full] : [];
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
			"const lsp = await import('vscode-languageserver');",
			"const lsp = require('../server.js');",
			"import { x } from '/abs/path.js';",
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

		it('collects source files from subdirectories', () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-walk-'));
			try {
				fs.mkdirSync(path.join(root, 'sub'));
				fs.writeFileSync(path.join(root, 'top.ts'), '');
				fs.writeFileSync(path.join(root, 'sub', 'nested.ts'), '');
				fs.writeFileSync(path.join(root, 'sub', 'notes.md'), '');

				const found = sourceFiles(root).map((file) => path.relative(root, file));
				expect(found.sort()).toEqual(['sub/nested.ts', 'top.ts']);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});
});
