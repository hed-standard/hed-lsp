/**
 * HED Schema Manager
 * Handles loading, caching, and querying HED schemas.
 */

import { buildSchemasFromVersion } from 'hed-validator';
import type { Schemas } from 'hed-validator';
import { HedTag, HedTagAttributes } from './types.js';

/**
 * Normalize a HED schema version string.
 * Handles multiple schemas separated by commas.
 */
function normalizeVersion(hedVersion: string): string {
	if (!hedVersion || typeof hedVersion !== 'string') {
		return hedVersion;
	}
	return hedVersion
		.split(',')
		.map(part => part.trim())
		.filter(part => part.length > 0)
		.join(',');
}

/**
 * Schema Manager for HED schemas.
 * Provides caching and tag lookup functionality.
 */
export class SchemaManager {
	private schemaCache: Map<string, Schemas> = new Map();
	private tagCache: Map<string, Map<string, HedTag>> = new Map();
	private currentVersion: string = '8.4.0';

	/**
	 * Get or load a schema for a given version.
	 */
	async getSchema(version: string = this.currentVersion): Promise<Schemas> {
		const normalizedVersion = normalizeVersion(version);

		if (this.schemaCache.has(normalizedVersion)) {
			return this.schemaCache.get(normalizedVersion)!;
		}

		try {
			const schemas = await buildSchemasFromVersion(version);
			this.schemaCache.set(normalizedVersion, schemas);
			return schemas;
		} catch (error) {
			console.error(`Failed to load HED schema ${normalizedVersion}:`, error);
			throw error;
		}
	}

	/**
	 * Set the current schema version.
	 */
	setCurrentVersion(version: string): void {
		this.currentVersion = normalizeVersion(version);
	}

	/**
	 * Get the current schema version.
	 */
	getCurrentVersion(): string {
		return this.currentVersion;
	}

	/**
	 * Get all top-level tags from the schema.
	 */
	async getTopLevelTags(version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const tags: HedTag[] = [];

		// Access the base schema's tag entries
		const schema = schemas.baseSchema;
		if (schema?.entries?.tags) {
			for (const [_name, entry] of schema.entries.tags) {
				const tag = this.schemaEntryToHedTag(entry);
				if (tag && !tag.parent) {
					tags.push(tag);
				}
			}
		}

		return tags;
	}

	/**
	 * Get child tags of a given parent tag.
	 */
	async getChildTags(parentShortForm: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const children: HedTag[] = [];

		const schema = schemas.baseSchema;
		if (schema?.entries?.tags) {
			for (const [_name, entry] of schema.entries.tags) {
				const tag = this.schemaEntryToHedTag(entry);
				if (tag && tag.parent === parentShortForm) {
					children.push(tag);
				}
			}
		}

		return children;
	}

	/**
	 * Find a tag by its short form.
	 */
	async findTag(shortForm: string, version?: string): Promise<HedTag | null> {
		const schemas = await this.getSchema(version);
		const schema = schemas.baseSchema;

		if (schema?.entries?.tags) {
			// Try direct lookup first
			if (schema.entries.tags.hasEntry(shortForm)) {
				const entry = schema.entries.tags.getEntry(shortForm);
				return this.schemaEntryToHedTag(entry);
			}
			// Search by short name
			for (const [_name, entry] of schema.entries.tags) {
				if (entry.shortTagName === shortForm) {
					return this.schemaEntryToHedTag(entry);
				}
			}
		}

		return null;
	}

	/**
	 * Search for tags matching a prefix.
	 */
	async searchTags(prefix: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const matches: HedTag[] = [];
		const lowerPrefix = prefix.toLowerCase();

		const schema = schemas.baseSchema;
		if (schema?.entries?.tags) {
			for (const [_name, entry] of schema.entries.tags) {
				const shortName = entry.shortTagName || entry.name || '';
				if (shortName.toLowerCase().startsWith(lowerPrefix)) {
					const tag = this.schemaEntryToHedTag(entry);
					if (tag) {
						matches.push(tag);
					}
				}
			}
		}

		return matches;
	}

	/**
	 * Convert a schema entry to our HedTag type.
	 */
	private schemaEntryToHedTag(entry: any): HedTag | null {
		if (!entry) return null;

		const attributes: HedTagAttributes = {
			extensionAllowed: entry.hasBooleanAttribute?.('extensionAllowed') ?? false,
			takesValue: entry.hasBooleanAttribute?.('takesValue') ?? false,
			unitClass: this.getAttributeArray(entry, 'unitClass'),
			suggestedTag: this.getAttributeArray(entry, 'suggestedTag'),
			relatedTag: this.getAttributeArray(entry, 'relatedTag'),
			requireChild: entry.hasBooleanAttribute?.('requireChild') ?? false,
			unique: entry.hasBooleanAttribute?.('unique') ?? false,
			defaultUnits: entry.getValue?.('defaultUnits')
		};

		return {
			shortForm: entry.shortTagName || entry.name || '',
			longForm: entry.longTagName || entry.name || '',
			description: entry.getValue?.('description') || '',
			parent: entry.parent?.shortTagName || entry.parent?.name || null,
			children: [], // Will be populated by iterating over all tags
			attributes
		};
	}

	/**
	 * Get an attribute value as an array.
	 */
	private getAttributeArray(entry: any, attrName: string): string[] {
		const value = entry.getValue?.(attrName);
		if (!value) return [];
		if (Array.isArray(value)) return value;
		return [value];
	}

	/**
	 * Clear all caches.
	 */
	clearCache(): void {
		this.schemaCache.clear();
		this.tagCache.clear();
	}
}

// Export singleton instance
export const schemaManager = new SchemaManager();
