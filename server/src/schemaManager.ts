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

		// Access the schema's tag hierarchy
		// The schema object structure varies; we need to explore it
		const schema = schemas.standardSchema || schemas;
		if (schema && typeof schema.entries === 'function') {
			for (const entry of schema.entries('tags')) {
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

		const schema = schemas.standardSchema || schemas;
		if (schema && typeof schema.entries === 'function') {
			for (const entry of schema.entries('tags')) {
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
		const schema = schemas.standardSchema || schemas;

		if (schema && typeof schema.entries === 'function') {
			for (const entry of schema.entries('tags')) {
				if (entry.name === shortForm || entry.shortName === shortForm) {
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

		const schema = schemas.standardSchema || schemas;
		if (schema && typeof schema.entries === 'function') {
			for (const entry of schema.entries('tags')) {
				const name = entry.shortName || entry.name || '';
				if (name.toLowerCase().startsWith(lowerPrefix)) {
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
			extensionAllowed: entry.hasAttributeValue?.('extensionAllowed') ?? false,
			takesValue: entry.hasAttributeValue?.('takesValue') ?? false,
			unitClass: this.getAttributeArray(entry, 'unitClass'),
			suggestedTag: this.getAttributeArray(entry, 'suggestedTag'),
			relatedTag: this.getAttributeArray(entry, 'relatedTag'),
			requireChild: entry.hasAttributeValue?.('requireChild') ?? false,
			unique: entry.hasAttributeValue?.('unique') ?? false,
			defaultUnits: entry.getAttributeValue?.('defaultUnits')
		};

		return {
			shortForm: entry.shortName || entry.name || '',
			longForm: entry.longName || entry.name || '',
			description: entry.description || '',
			parent: entry.parent?.shortName || entry.parent?.name || null,
			children: this.getChildNames(entry),
			attributes
		};
	}

	/**
	 * Get an attribute value as an array.
	 */
	private getAttributeArray(entry: any, attrName: string): string[] {
		const value = entry.getAttributeValue?.(attrName);
		if (!value) return [];
		if (Array.isArray(value)) return value;
		return [value];
	}

	/**
	 * Get child tag names from an entry.
	 */
	private getChildNames(entry: any): string[] {
		if (!entry.children) return [];
		if (typeof entry.children[Symbol.iterator] === 'function') {
			return Array.from(entry.children).map((child: any) =>
				child.shortName || child.name || ''
			);
		}
		return [];
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
