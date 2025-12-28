/**
 * HED Schema Manager
 * Handles loading, caching, and querying HED schemas.
 * Supports automatic version detection from dataset_description.json
 * and library schemas (SCORE, LANG, etc.).
 */

import { buildSchemasFromVersion } from 'hed-validator';
import type { Schemas } from 'hed-validator';
import { HedTag, HedTagAttributes } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Default schema version including all library schemas.
 * This ensures autocomplete works for all HED tags out of the box.
 */
const DEFAULT_BASE_VERSION = '8.4.0';
const LIBRARY_SCHEMAS = [
	'sc:score_2.1.0',
	'la:lang_1.1.0'
];
const DEFAULT_FULL_VERSION = [DEFAULT_BASE_VERSION, ...LIBRARY_SCHEMAS].join(',');

/**
 * Normalize a HED schema version string.
 * Handles multiple schemas separated by commas.
 */
function normalizeVersion(hedVersion: string | string[]): string {
	if (!hedVersion) {
		return '';
	}
	if (Array.isArray(hedVersion)) {
		return hedVersion
			.map(v => v.trim())
			.filter(v => v.length > 0)
			.join(',');
	}
	if (typeof hedVersion !== 'string') {
		return '';
	}
	return hedVersion
		.split(',')
		.map(part => part.trim())
		.filter(part => part.length > 0)
		.join(',');
}

/**
 * Parse HEDVersion from dataset_description.json content.
 * Handles various formats: string, array, and library-only schemas.
 */
function parseHedVersion(datasetDescription: any): string | null {
	if (!datasetDescription) return null;

	const hedVersion = datasetDescription.HEDVersion;
	if (!hedVersion) return null;

	// Can be string: "8.3.0" or array: ["8.3.0", "score_2.0.0"]
	return normalizeVersion(hedVersion) || null;
}

/**
 * Schema Manager for HED schemas.
 * Provides caching and tag lookup functionality.
 */
export class SchemaManager {
	private schemaCache: Map<string, Schemas> = new Map();
	private currentVersion: string = DEFAULT_FULL_VERSION;
	private workspaceVersionCache: Map<string, string> = new Map();

	/**
	 * Get or load a schema for a given version.
	 */
	async getSchema(version: string = this.currentVersion): Promise<Schemas> {
		const normalizedVersion = normalizeVersion(version) || this.currentVersion;

		if (this.schemaCache.has(normalizedVersion)) {
			return this.schemaCache.get(normalizedVersion)!;
		}

		try {
			console.log(`[HED] Loading schema: ${normalizedVersion}`);
			const schemas = await buildSchemasFromVersion(normalizedVersion);
			this.schemaCache.set(normalizedVersion, schemas);
			return schemas;
		} catch (error) {
			console.error(`Failed to load HED schema ${normalizedVersion}:`, error);
			throw error;
		}
	}

	/**
	 * Detect schema version from dataset_description.json in a directory.
	 * Searches up the directory tree to find the BIDS root.
	 */
	async detectSchemaVersion(documentUri: string): Promise<string | null> {
		// Check cache first
		if (this.workspaceVersionCache.has(documentUri)) {
			return this.workspaceVersionCache.get(documentUri)!;
		}

		try {
			// Convert URI to file path
			const filePath = documentUri.startsWith('file://')
				? decodeURIComponent(documentUri.replace('file://', ''))
				: documentUri;

			// Search up the directory tree for dataset_description.json
			let currentDir = path.dirname(filePath);
			const maxDepth = 10; // Prevent infinite loops

			for (let i = 0; i < maxDepth; i++) {
				const descPath = path.join(currentDir, 'dataset_description.json');

				if (fs.existsSync(descPath)) {
					try {
						const content = fs.readFileSync(descPath, 'utf-8');
						const description = JSON.parse(content);
						const version = parseHedVersion(description);

						if (version) {
							console.log(`[HED] Detected schema version from ${descPath}: ${version}`);
							this.workspaceVersionCache.set(documentUri, version);
							return version;
						}
					} catch (parseError) {
						console.error(`Failed to parse ${descPath}:`, parseError);
					}
				}

				// Move up one directory
				const parentDir = path.dirname(currentDir);
				if (parentDir === currentDir) {
					break; // Reached root
				}
				currentDir = parentDir;
			}
		} catch (error) {
			console.error('Error detecting schema version:', error);
		}

		return null;
	}

	/**
	 * Get schema for a document, auto-detecting version if possible.
	 * Always includes library schemas for full autocomplete support.
	 */
	async getSchemaForDocument(documentUri: string): Promise<Schemas> {
		let version = await this.detectSchemaVersion(documentUri);
		if (!version) {
			version = this.currentVersion;
		} else if (!version.includes(':')) {
			// Add library schemas if only base version was detected
			version = [version, ...LIBRARY_SCHEMAS].join(',');
		}
		return this.getSchema(version);
	}

	/**
	 * Set the current schema version.
	 * If only a base version is given, library schemas are added automatically.
	 */
	setCurrentVersion(version: string): void {
		const normalized = normalizeVersion(version);
		if (!normalized) {
			this.currentVersion = DEFAULT_FULL_VERSION;
			return;
		}
		// If version doesn't include library schemas, add them
		if (!normalized.includes(':')) {
			this.currentVersion = [normalized, ...LIBRARY_SCHEMAS].join(',');
		} else {
			this.currentVersion = normalized;
		}
	}

	/**
	 * Get the current schema version.
	 */
	getCurrentVersion(): string {
		return this.currentVersion;
	}

	/**
	 * Clear workspace version cache (call when workspace changes).
	 */
	clearWorkspaceCache(): void {
		this.workspaceVersionCache.clear();
	}

	/**
	 * Get all individual schema objects from a Schemas collection.
	 * This includes base schema and any library schemas.
	 */
	private getAllSchemaObjects(schemas: Schemas): any[] {
		const schemaList: any[] = [];

		// Add base schema if exists
		if (schemas.baseSchema) {
			schemaList.push({ schema: schemas.baseSchema, prefix: '' });
		}

		// Add library schemas from the schemas map
		if (schemas.schemas) {
			for (const [prefix, schema] of schemas.schemas) {
				if (prefix && schema !== schemas.baseSchema) {
					schemaList.push({ schema, prefix: prefix + ':' });
				}
			}
		}

		return schemaList;
	}

	/**
	 * Get all top-level tags from the schema (including library schemas).
	 */
	async getTopLevelTags(version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const tags: HedTag[] = [];

		for (const { schema, prefix } of this.getAllSchemaObjects(schemas)) {
			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					// Top-level tags have no parent
					if (!entry.parent) {
						const tag = this.schemaEntryToHedTag(entry, prefix);
						if (tag) {
							tags.push(tag);
						}
					}
				}
			}
		}

		return tags;
	}

	/**
	 * Get child tags of a given parent tag (searches all schemas).
	 */
	async getChildTags(parentShortForm: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const children: HedTag[] = [];

		// Remove prefix if present for matching
		const cleanParent = parentShortForm.includes(':')
			? parentShortForm.split(':')[1]
			: parentShortForm;

		for (const { schema, prefix } of this.getAllSchemaObjects(schemas)) {
			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					// Check if parent name matches (case-insensitive)
					if (entry.parent && entry.parent.name.toLowerCase() === cleanParent.toLowerCase()) {
						const tag = this.schemaEntryToHedTag(entry, prefix);
						if (tag) {
							children.push(tag);
						}
					}
				}
			}
		}

		return children;
	}

	/**
	 * Find a tag by its short form (case-insensitive, searches all schemas).
	 */
	async findTag(shortForm: string, version?: string): Promise<HedTag | null> {
		const schemas = await this.getSchema(version);

		// Check if tag has a library prefix
		let prefix = '';
		let tagName = shortForm;
		if (shortForm.includes(':')) {
			[prefix, tagName] = shortForm.split(':');
			prefix = prefix + ':';
		}

		for (const { schema, prefix: schemaPrefix } of this.getAllSchemaObjects(schemas)) {
			// If searching with prefix, only search that schema
			if (prefix && schemaPrefix !== prefix) continue;

			if (schema?.entries?.tags) {
				const lowerKey = tagName.toLowerCase();
				if (schema.entries.tags.hasEntry(lowerKey)) {
					const entry = schema.entries.tags.getEntry(lowerKey);
					return this.schemaEntryToHedTag(entry, schemaPrefix);
				}
			}
		}

		return null;
	}

	/**
	 * Search for tags matching a prefix (case-insensitive, searches all schemas).
	 */
	async searchTags(prefix: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const matches: HedTag[] = [];

		// Check if search has a library prefix
		let libraryPrefix = '';
		let searchPrefix = prefix;
		if (prefix.includes(':')) {
			[libraryPrefix, searchPrefix] = prefix.split(':');
			libraryPrefix = libraryPrefix + ':';
		}
		const lowerPrefix = searchPrefix.toLowerCase();

		for (const { schema, prefix: schemaPrefix } of this.getAllSchemaObjects(schemas)) {
			// If searching with prefix, only search that schema
			if (libraryPrefix && schemaPrefix !== libraryPrefix) continue;

			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					const tagName = entry.name || '';
					if (tagName.toLowerCase().startsWith(lowerPrefix)) {
						const tag = this.schemaEntryToHedTag(entry, schemaPrefix);
						if (tag) {
							matches.push(tag);
						}
					}
				}
			}
		}

		return matches;
	}

	/**
	 * Get available library schema prefixes.
	 */
	async getLibraryPrefixes(version?: string): Promise<string[]> {
		const schemas = await this.getSchema(version);
		const prefixes: string[] = [];

		if (schemas.schemas) {
			for (const [prefix] of schemas.schemas) {
				if (prefix) {
					prefixes.push(prefix);
				}
			}
		}

		return prefixes;
	}

	/**
	 * Search for tags containing a substring anywhere in the name.
	 * Returns matches sorted by relevance (prefix matches first, then contains).
	 */
	async searchTagsContaining(query: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const prefixMatches: HedTag[] = [];
		const containsMatches: HedTag[] = [];
		const lowerQuery = query.toLowerCase();

		for (const { schema, prefix } of this.getAllSchemaObjects(schemas)) {
			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					const tagName = entry.name || '';
					const lowerName = tagName.toLowerCase();

					if (lowerName.startsWith(lowerQuery)) {
						const tag = this.schemaEntryToHedTag(entry, prefix);
						if (tag) prefixMatches.push(tag);
					} else if (lowerName.includes(lowerQuery)) {
						const tag = this.schemaEntryToHedTag(entry, prefix);
						if (tag) containsMatches.push(tag);
					}
				}
			}
		}

		// Return prefix matches first, then contains matches
		return [...prefixMatches, ...containsMatches];
	}

	/**
	 * Get all tags from all schemas.
	 */
	async getAllTags(version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const tags: HedTag[] = [];

		for (const { schema, prefix } of this.getAllSchemaObjects(schemas)) {
			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					const tag = this.schemaEntryToHedTag(entry, prefix);
					if (tag) tags.push(tag);
				}
			}
		}

		return tags;
	}

	/**
	 * Find tags that allow extension and could be parent for a given term.
	 * Uses fuzzy matching on tag names and descriptions.
	 */
	async findExtensibleParents(term: string, version?: string): Promise<HedTag[]> {
		const schemas = await this.getSchema(version);
		const matches: HedTag[] = [];
		const lowerTerm = term.toLowerCase();
		const termWords = lowerTerm.split(/[-_\s]+/);

		for (const { schema, prefix } of this.getAllSchemaObjects(schemas)) {
			if (schema?.entries?.tags) {
				for (const [_key, entry] of schema.entries.tags) {
					// Only consider tags that allow extension
					if (!entry.hasBooleanAttribute?.('extensionAllowed')) continue;

					const tagName = (entry.name || '').toLowerCase();
					const description = (entry.valueAttributeNames?.get?.('description') || '').toLowerCase();

					// Check if term or its parts appear in tag name or description
					let score = 0;
					for (const word of termWords) {
						if (tagName.includes(word)) score += 3;
						if (description.includes(word)) score += 1;
					}

					if (score > 0) {
						const tag = this.schemaEntryToHedTag(entry, prefix);
						if (tag) {
							(tag as any).matchScore = score;
							matches.push(tag);
						}
					}
				}
			}
		}

		// Sort by match score (highest first)
		matches.sort((a, b) => ((b as any).matchScore || 0) - ((a as any).matchScore || 0));
		return matches.slice(0, 10); // Limit to top 10
	}

	/**
	 * Check if a tag entry belongs to a specific library schema.
	 * Tags have an 'inLibrary' attribute if they're from a library.
	 */
	private isTagFromLibrary(entry: any, libraryPrefix: string): boolean {
		if (!libraryPrefix) return true; // Base schema tags always belong

		// Check if the tag has the inLibrary attribute matching this library
		const inLibrary = entry.valueAttributeNames?.get?.('inLibrary');
		if (inLibrary) {
			// inLibrary value is the library name without the prefix
			// e.g., "score" for sc: prefix
			const prefixWithoutColon = libraryPrefix.replace(':', '');
			return inLibrary === prefixWithoutColon ||
			       inLibrary.toLowerCase() === prefixWithoutColon.toLowerCase();
		}

		// If no inLibrary attribute, it's a base schema tag
		return false;
	}

	/**
	 * Convert a schema entry to our HedTag type.
	 * @param entry The schema entry
	 * @param prefix Library schema prefix (e.g., "sc:" for SCORE) or empty for standard
	 */
	private schemaEntryToHedTag(entry: any, prefix: string = ''): HedTag | null {
		if (!entry) return null;

		// Skip tags that don't belong to this schema's library
		if (prefix && !this.isTagFromLibrary(entry, prefix)) {
			return null;
		}

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

		// SchemaTag has shortTagName and longTagName getters
		const baseName = entry.shortTagName || entry.name || '';
		const shortForm = prefix + baseName;
		const longForm = prefix + (entry.longTagName || entry.longName || entry.name || '');

		return {
			shortForm,
			longForm,
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
