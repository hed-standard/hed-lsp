/**
 * Boundary test: the engine must not depend on the language server or on the editor
 * adapters. Reads the real source files; no mocks.
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const engineDir = path.join(__dirname, '..', 'engine');

/** Module specifiers the engine may use: siblings and the two engine dependencies. */
function allowed(specifier: string): boolean {
	return (
		specifier.startsWith('./') ||
		specifier.startsWith('node:') ||
		specifier === 'hed-validator' ||
		specifier === '@huggingface/transformers'
	);
}

/** Every module specifier in a source file: static imports, re-exports, and dynamic imports. */
function specifiersIn(source: string): string[] {
	const found: string[] = [];
	const patterns = [/from\s+'([^']+)'/g, /import\(\s*'([^']+)'\s*\)/g, /require\(\s*'([^']+)'\s*\)/g];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			found.push(match[1]);
		}
	}
	return found;
}

describe('engine boundary', () => {
	it('imports only siblings, node built-ins, and the two engine dependencies', () => {
		const files = readdirSync(engineDir).filter((name) => name.endsWith('.ts'));
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const source = readFileSync(path.join(engineDir, file), 'utf-8');
			for (const specifier of specifiersIn(source)) {
				if (!allowed(specifier)) {
					violations.push(`${file} imports ${specifier}`);
				}
			}
		}

		expect(violations, 'engine modules must not import the language server or adapters').toEqual([]);
	});
});
