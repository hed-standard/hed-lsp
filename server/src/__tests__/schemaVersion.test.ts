/**
 * The default HED schema is defined once, in schemaVersion.ts. The VS Code settings
 * in the extension and the client manifest must declare the same default, and the
 * embedding schema set must start from it. Reads the real manifests; no mocks.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemaManager } from '../schemaManager.js';
import { DEFAULT_HED_SCHEMA, EMBEDDING_SCHEMA_VERSION, FALLBACK_HED_SCHEMA } from '../schemaVersion.js';

/** Collects the `default` values of every property whose key mentions schemaVersion. */
function schemaVersionDefaults(node: unknown, found: string[] = []): string[] {
	if (node && typeof node === 'object') {
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key.includes('schemaVersion') && value && typeof value === 'object' && 'default' in value) {
				found.push(String((value as { default: unknown }).default));
			}
			schemaVersionDefaults(value, found);
		}
	}
	return found;
}

const repoRoot = path.join(__dirname, '..', '..', '..');

describe('default HED schema', () => {
	it.each(['package.json', 'client/package.json'])('%s declares the same default', (manifest) => {
		const json = JSON.parse(readFileSync(path.join(repoRoot, manifest), 'utf-8'));

		expect(schemaVersionDefaults(json)).toEqual([DEFAULT_HED_SCHEMA]);
	});

	it('falls back to a schema bundled with hed-validator, which needs no network', async () => {
		const schemas = await schemaManager.getSchema(FALLBACK_HED_SCHEMA);

		expect(schemas).toBeDefined();
	});

	it('starts the embedding schema set from the default', () => {
		expect(EMBEDDING_SCHEMA_VERSION.startsWith(`${DEFAULT_HED_SCHEMA},`)).toBe(true);
	});
});
