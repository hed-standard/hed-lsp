/**
 * Boundary test: the engine must not depend on the language server or on the adapters, and the
 * daemon, which is an adapter, must not depend on the language server, on another adapter, or on
 * the engine beyond its facade. Each directory has a rule in one table. The rules are applied to the
 * real source, and they are tested on synthetic source text so that a weakened matcher fails here.
 * No mocks.
 *
 * The check is textual, not a parse. It reads module specifiers written as string literals after
 * import, export-from, require, and triple-slash reference forms, with single, double, or backtick
 * quotes. It does not follow computed specifiers, such as a variable or a createRequire call, so
 * modules must name their imports as literals. It does not skip comments either, so prose that
 * quotes a name right after the word from, such as differs from `spec`, reads as an import and is
 * reworded.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.join(__dirname, '..');
const engineDir = path.join(srcDir, 'engine');
const daemonDir = path.join(srcDir, 'daemon');

/** A directory and the imports its modules may have. */
interface BoundaryRule {
	name: string;
	dir: string;
	/** Whether a module at `file` may import `specifier`. */
	allowed(specifier: string, file: string): boolean;
}

/** Whether `target` is `dir` or lies inside it. */
function inside(dir: string, target: string): boolean {
	return target === dir || target.startsWith(dir + path.sep);
}

/**
 * The engine may import its own modules, node built-ins, and its two dependencies. Relative paths are
 * allowed only when they stay inside the engine directory.
 */
const engineRule: BoundaryRule = {
	name: 'engine',
	dir: engineDir,
	allowed(specifier, file) {
		if (specifier.startsWith('.')) {
			return inside(engineDir, path.resolve(path.dirname(file), specifier));
		}
		return specifier.startsWith('node:') || specifier === 'hed-validator' || specifier === '@huggingface/transformers';
	},
};

/**
 * The daemon may import its own modules, the engine facade `../engine/index.js` and nothing else of
 * the engine, and node built-ins written with the `node:` prefix. No package is allowed, so the
 * language server packages, the validator, and the model library are all out of reach, and so is
 * every module of the language server and the other adapters.
 */
const daemonRule: BoundaryRule = {
	name: 'daemon',
	dir: daemonDir,
	allowed(specifier, file) {
		if (specifier.startsWith('.')) {
			const target = path.resolve(path.dirname(file), specifier);
			return inside(daemonDir, target) || target === path.join(engineDir, 'index.js');
		}
		return specifier.startsWith('node:');
	},
};

const rules: BoundaryRule[] = [engineRule, daemonRule];

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

/** Specifiers in the source text of `file` that its directory's rule does not allow. */
function violationsIn(source: string, file: string, rule: BoundaryRule): string[] {
	return specifiersIn(source).filter((specifier) => !rule.allowed(specifier, file));
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

describe.each(rules)('$name boundary', (rule) => {
	it('has no import that its rule does not allow', () => {
		const files = sourceFiles(rule.dir);
		expect(files.length).toBeGreaterThan(0);

		const violations = files.flatMap((file) =>
			violationsIn(fs.readFileSync(file, 'utf-8'), file, rule).map(
				(specifier) => `${path.relative(rule.dir, file)} imports ${specifier}`,
			),
		);

		expect(violations, `${rule.name} modules import something outside their boundary`).toEqual([]);
	});
});

describe('engine boundary', () => {
	it('imports only engine modules, node built-ins, and the two engine dependencies', () => {
		const files = sourceFiles(engineDir);

		expect(files.map((file) => path.basename(file))).toEqual(
			expect.arrayContaining(['embeddings.ts', 'index.ts', 'schemaManager.ts', 'suggestionEngine.ts']),
		);
	});

	describe('rules', () => {
		const probe = path.join(engineDir, 'probe.ts');
		const violations = (line: string, file = probe): string[] => violationsIn(line, file, engineRule);

		it.each([
			"import { x } from './types.js';",
			"import { x } from './sub/helper.js';",
			"export * from './validation.js';",
			"import { x } from 'node:fs';",
			"import { x } from 'hed-validator';",
			"import { x } from '@huggingface/transformers';",
			"/// <reference path='./types.ts' />",
		])('allows %s', (line) => {
			expect(violations(line)).toEqual([]);
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
			"import { x } from '../daemon/server.js';",
			"import { x } from '../daemon/limits.js';",
		])('rejects %s', (line) => {
			expect(violations(line).length).toBeGreaterThan(0);
		});

		it("does not read the data keywords 'from' and 'import' as imports", () => {
			expect(violations("const keywords = [['from'], ['import']];")).toEqual([]);
		});

		it('resolves relative imports from the importing file, so a subdirectory may import its parent', () => {
			const nested = path.join(engineDir, 'sub', 'nested.ts');

			expect(violations("import { x } from '../index.js';", nested)).toEqual([]);
			expect(violations("import { x } from '../../types.js';", nested)).toEqual(['../../types.js']);
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

describe('daemon boundary', () => {
	it('covers every daemon module, the entry point and the health probe included', () => {
		const names = sourceFiles(daemonDir).map((file) => path.basename(file));

		expect(names).toEqual(
			expect.arrayContaining([
				'config.ts',
				'healthcheck.ts',
				'limits.ts',
				'log.ts',
				'main.ts',
				'protocol.ts',
				'schemas.ts',
				'semantic.ts',
				'server.ts',
			]),
		);
	});

	describe('rules', () => {
		const probe = path.join(daemonDir, 'probe.ts');
		const violations = (line: string, file = probe): string[] => violationsIn(line, file, daemonRule);

		it.each([
			"import { x } from './limits.js';",
			"import { x } from './sub/helper.js';",
			"import type { Logger } from './log.js';",
			"export { x } from './protocol.js';",
			"import { findSuggestions } from '../engine/index.js';",
			"import type { LogSink } from '../engine/index.js';",
			"export { schemaVersionUsed } from '../engine/index.js';",
			"import * as http from 'node:http';",
			"import { TextDecoder } from 'node:util';",
			"const fs = await import('node:fs');",
			"const net = require('node:net');",
			"/// <reference path='./protocol.ts' />",
		])('allows %s', (line) => {
			expect(violations(line)).toEqual([]);
		});

		it.each([
			// The engine beyond its facade.
			"import { schemaManager } from '../engine/schemaManager.js';",
			"import { embeddingsManager } from '../engine/embeddings.js';",
			"import type { HedTag } from '../engine/types.js';",
			"import { x } from '../engine/suggestionEngine.js';",
			"import { x } from '../engine/index';",
			"import { x } from '../engine/index.ts';",
			"import { x } from '../engine';",
			"import { x } from '../engine/sub/../schemaManager.js';",
			"import { x } from './../engine/schemaManager.js';",
			"export * from '../engine/validation.js';",
			// The language server and the other adapters.
			"import { x } from '../server.js';",
			"import { x } from '../cli.js';",
			"import { x } from '../diagnostics.js';",
			"import { x } from '../completion.js';",
			"import { x } from '../documentParser.js';",
			"import { x } from '../engine/../server.js';",
			"import { x } from '../../client/src/extension.js';",
			"const lsp = require('../server.js');",
			"const lsp = require.resolve('../server.js');",
			// The language server packages and the editor.
			"import 'vscode-languageserver';",
			"import type { Position } from 'vscode-languageserver/node';",
			"export { x } from 'vscode-languageserver-textdocument';",
			"import { x } from 'vscode-jsonrpc/node';",
			"import { x } from 'vscode-uri';",
			"import vscode from 'vscode';",
			'import { x } from "vscode-languageserver";',
			'import { x } from `vscode-languageserver`;',
			"const lsp = await import('vscode-languageserver');",
			'const lsp = await import(`vscode-languageserver`);',
			"const lsp = require('vscode-languageserver');",
			"const lsp = require.resolve('vscode-languageserver');",
			"import lsp = require('vscode-languageserver');",
			'/// <reference types="vscode-languageserver" />',
			"/// <reference path='../server.ts' />",
			// Packages, which the daemon reaches only through the engine, and built-ins without the prefix.
			"import { x } from 'hed-validator';",
			"import { x } from '@huggingface/transformers';",
			"import { x } from 'express';",
			"import * as fs from 'fs';",
			"import * as http from 'http';",
			"import { x } from '/abs/path.js';",
			"import { x } from '../types.js';",
		])('rejects %s', (line) => {
			expect(violations(line).length).toBeGreaterThan(0);
		});

		it('names the import that breaks the rule, and only that one', () => {
			const source = [
				"import * as http from 'node:http';",
				"import { findSuggestions } from '../engine/index.js';",
				"import { schemaManager } from '../engine/schemaManager.js';",
				"import { createConnection } from 'vscode-languageserver/node';",
				"import { createLogger } from './log.js';",
			].join('\n');

			expect(violations(source)).toEqual(['../engine/schemaManager.js', 'vscode-languageserver/node']);
		});

		it('resolves relative imports from the importing file', () => {
			const nested = path.join(daemonDir, 'sub', 'nested.ts');

			expect(violations("import { x } from '../limits.js';", nested)).toEqual([]);
			expect(violations("import { x } from '../../engine/index.js';", nested)).toEqual([]);
			expect(violations("import { x } from '../../engine/schemaManager.js';", nested)).toEqual([
				'../../engine/schemaManager.js',
			]);
			expect(violations("import { x } from '../../server.js';", nested)).toEqual(['../../server.js']);
		});

		it('does not read the data keywords from and import as imports', () => {
			expect(violations("const keywords = [['from'], ['import']];")).toEqual([]);
		});
	});
});
