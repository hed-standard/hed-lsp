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
	private currentVersion: string = '8.3.0';

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

		const schema = schemas.baseSchema;
		if (schema?.entries?.tags) {
			for (const [_key, entry] of schema.entries.tags) {
				// Top-level tags have no parent
				if (!entry.parent) {
					const tag = this.schemaEntryToHedTag(entry);
					if (tag) {
						tags.push(tag);
					}
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
			for (const [_key, entry] of schema.entries.tags) {
				// Check if parent name matches (case-insensitive)
				if (entry.parent && entry.parent.name.toLowerCase() === parentShortForm.toLowerCase()) {
					const tag = this.schemaEntryToHedTag(entry);
					if (tag) {
						children.push(tag);
					}
				}
			}
		}

		return children;
	}

	/**
	 * Find a tag by its short form (case-insensitive).
	 */
	async findTag(shortForm: string, version?: string): Promise<HedTag | null> {
		const schemas = await this.getSchema(version);
		const schema = schemas.baseSchema;

		if (schema?.entries?.tags) {
			// Keys in the schema are lowercase
			const lowerKey = shortForm.toLowerCase();
			if (schema.entries.tags.hasEntry(lowerKey)) {
				const entry = schema.entries.tags.getEntry(lowerKey);
				return this.schemaEntryToHedTag(entry);
			}
		}

		return null;
	}

	/**
	 * Search for tags matching a prefix (case-insensitive).
	 */
	async searchTags(prefix: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const matches: HedTag[] = [];
		const lowerPrefix = prefix.toLowerCase();

		const schema = schemas.baseSchema;
		if (schema?.entries?.tags) {
			for (const [_key, entry] of schema.entries.tags) {
				// entry.name has proper casing
				const tagName = entry.name || '';
				if (tagName.toLowerCase().startsWith(lowerPrefix)) {
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

		// Get description from valueAttributeNames Map
		const description = entry.valueAttributeNames?.get?.('description') || '';

		// Get suggested and related tags
		const suggestedTag = this.getValueAttribute(entry, 'suggestedTag');
		const relatedTag = this.getValueAttribute(entry, 'relatedTag');
		const unitClass = this.getValueAttribute(entry, 'unitClass');
		const defaultUnits = entry.valueAttributeNames?.get?.('defaultUnits') || undefined;

		const attributes: HedTagAttributes = {
			extensionAllowed: entry.hasBooleanAttribute?.('extensionAllowed') ?? false,
			takesValue: entry.hasBooleanAttribute?.('takesValue') ?? false,
			unitClass,
			suggestedTag,
			relatedTag,
			requireChild: entry.hasBooleanAttribute?.('requireChild') ?? false,
			unique: entry.hasBooleanAttribute?.('unique') ?? false,
			defaultUnits
		};

		return {
			shortForm: entry.name || '',
			longForm: entry.longName || entry.name || '',
			description,
			parent: entry.parent?.name || null,
			children: [], // Could be populated but not needed for basic features
			attributes
		};
	}

	/**
	 * Get a value attribute as an array.
	 */
	private getValueAttribute(entry: any, attrName: string): string[] {
		const value = entry.valueAttributeNames?.get?.(attrName);
		if (!value) return [];
		if (Array.isArray(value)) return value;
		if (typeof value === 'string') return [value];
		return [];
	}

	/**
	 * Clear all caches.
	 */
	clearCache(): void {
		this.schemaCache.clear();
	}
}

// Export singleton instance
export const schemaManager = new SchemaManager();
