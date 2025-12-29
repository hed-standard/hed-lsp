/**
 * TSV Parser for HED Columns
 * Extracts HED strings from TSV files (typically *_events.tsv in BIDS).
 */

import type { Range, TextDocument } from 'vscode-languageserver-textdocument';
import type { HedRegion } from './types.js';

/**
 * Parse a TSV document and extract HED column cells as regions.
 */
export function parseTsvForHedStrings(document: TextDocument): HedRegion[] {
	const text = document.getText();
	const regions: HedRegion[] = [];

	// Split into lines, preserving line info for position tracking
	const lines = text.split('\n');
	if (lines.length === 0) return regions;

	// Parse header to find HED column
	const headerLine = lines[0];
	const hedColumnIndex = findHedColumn(headerLine);

	if (hedColumnIndex === -1) {
		// No HED column found
		return regions;
	}

	// Track character offset as we process lines
	let currentOffset = headerLine.length + 1; // +1 for newline

	// Process each data row
	for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];

		// Skip empty lines
		if (!line.trim()) {
			currentOffset += line.length + 1;
			continue;
		}

		// Parse the line to find the HED cell
		const cell = getCellAtIndex(line, hedColumnIndex);

		if (cell?.content.trim()) {
			const cellStart = currentOffset + cell.startOffset;
			const cellEnd = cellStart + cell.content.length;

			regions.push({
				content: cell.content,
				range: {
					start: document.positionAt(cellStart),
					end: document.positionAt(cellEnd),
				},
				jsonPath: `row${lineIndex + 1}.HED`,
				contentOffset: cellStart,
			});
		}

		currentOffset += line.length + 1; // +1 for newline
	}

	return regions;
}

/**
 * Find the index of the HED column in a TSV header line.
 * Returns -1 if not found.
 */
function findHedColumn(headerLine: string): number {
	const headers = parseTsvLine(headerLine);

	for (let i = 0; i < headers.length; i++) {
		// Case-insensitive match for "HED"
		if (headers[i].content.trim().toLowerCase() === 'hed') {
			return i;
		}
	}

	return -1;
}

/**
 * Parsed TSV cell with content and position info.
 */
interface TsvCell {
	content: string;
	startOffset: number;
	endOffset: number;
}

/**
 * Parse a TSV line into cells, handling quoted values.
 */
function parseTsvLine(line: string): TsvCell[] {
	const cells: TsvCell[] = [];
	let currentStart = 0;
	let i = 0;
	let inQuotes = false;

	while (i <= line.length) {
		const char = line[i];

		if (char === '"' && !inQuotes) {
			inQuotes = true;
			i++;
			continue;
		}

		if (char === '"' && inQuotes) {
			// Check for escaped quote
			if (line[i + 1] === '"') {
				i += 2;
				continue;
			}
			inQuotes = false;
			i++;
			continue;
		}

		if ((char === '\t' || i === line.length) && !inQuotes) {
			const content = line.slice(currentStart, i);
			cells.push({
				content: unquoteTsvCell(content),
				startOffset: currentStart,
				endOffset: i,
			});
			currentStart = i + 1;
		}

		i++;
	}

	return cells;
}

/**
 * Get a specific cell from a TSV line by index.
 */
function getCellAtIndex(line: string, index: number): TsvCell | null {
	const cells = parseTsvLine(line);
	if (index >= 0 && index < cells.length) {
		return cells[index];
	}
	return null;
}

/**
 * Remove quotes from a TSV cell value and unescape internal quotes.
 */
function unquoteTsvCell(content: string): string {
	let result = content.trim();

	// Remove surrounding quotes if present
	if (result.startsWith('"') && result.endsWith('"')) {
		result = result.slice(1, -1);
		// Unescape doubled quotes
		result = result.replace(/""/g, '"');
	}

	return result;
}

/**
 * Check if a document is a TSV file that might contain HED.
 */
export function isTsvDocument(document: TextDocument): boolean {
	const uri = document.uri.toLowerCase();
	return uri.endsWith('.tsv');
}

/**
 * Check if a TSV document has a HED column.
 */
export function hasHedColumn(document: TextDocument): boolean {
	const text = document.getText();
	const firstLine = text.split('\n')[0] || '';
	return findHedColumn(firstLine) !== -1;
}

/**
 * Get the HED region at a specific position in a TSV document.
 */
export function getTsvHedRegionAtPosition(
	document: TextDocument,
	position: { line: number; character: number },
): HedRegion | null {
	const regions = parseTsvForHedStrings(document);

	for (const region of regions) {
		if (isPositionInRange(position, region.range)) {
			return region;
		}
	}

	return null;
}

/**
 * Check if a position is within a range.
 */
function isPositionInRange(position: { line: number; character: number }, range: Range): boolean {
	if (position.line < range.start.line || position.line > range.end.line) {
		return false;
	}

	if (position.line === range.start.line && position.character < range.start.character) {
		return false;
	}

	if (position.line === range.end.line && position.character > range.end.character) {
		return false;
	}

	return true;
}
