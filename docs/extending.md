# Extending HED-LSP

This guide explains how to extend the HED-LSP system with new keywords, improve semantic search, and customize behavior.

## Adding New Keywords

Keywords are the primary way to improve semantic search. Add them in one file, `server/src/engine/anchorKeywords.ts`, which exports `ANCHOR_KEYWORDS`. That map feeds both the exact-match index and the embedding anchors, and the generator imports the same file, so there is no second copy to keep in sync.

```typescript
export const ANCHOR_KEYWORDS: Record<string, string[]> = {
  // Existing entries...

  // Add your new keywords here:
  'optogenetics': ['Measurement-event', 'Experimental-stimulus'],
  'calcium-imaging': ['Measurement-event', 'Data-feature'],
  'patch-clamp': ['Measurement-event'],
};
```

**Guidelines:**
- Use lowercase keys; write multi-word keys with hyphens (`calcium-imaging`). Queries with spaces also match hyphenated keys.
- Map to existing HED tags only
- Multiple tags are allowed (most specific first)

Then regenerate the shipped embeddings and run the tests:
```bash
bun run server/scripts/generateEmbeddings.ts
bun run compile
cd server && bun run test
```

`server/src/__tests__/anchorKeywords.test.ts` fails until the shipped embeddings match the file, so a missed regeneration is caught by the test suite.

### Suggestion Mappings (Separate Map)

`SEMANTIC_MAPPINGS` in `server/src/engine/semanticMappings.ts` drives the keyword stage of `hed-suggest` and the `hed/suggest` request, and the static completion fallback. Its targets differ from the anchor map on purpose, so do not copy entries between the two files.

## Workflow for Adding Keywords

```mermaid
flowchart TD
    A[Identify missing term] --> B[Add to server/src/engine/anchorKeywords.ts]
    B --> C[bun run server/scripts/generateEmbeddings.ts]
    C --> D[bun run compile, then cd server and bun run test]
    D --> E[Test in VS Code]

    E --> F{Works correctly?}
    F -->|Yes| G[Done]
    F -->|No| H[Adjust mappings]
    H --> B
```

## Choosing Target Tags

When adding a keyword, consider:

1. **Primary concept**: What HED tag best represents this?
2. **Secondary concepts**: What related tags are relevant?
3. **Agent vs. Item**: Is it an agent performing actions or an item?

### Example Analysis

**Keyword: "optogenetics"**
- Primary: `Measurement-event` (it's a technique for measuring)
- Secondary: `Experimental-stimulus` (light is the stimulus)
- Not: `See` (it's not visual perception)

```typescript
'optogenetics': ['Measurement-event', 'Experimental-stimulus'],
```

**Keyword: "patient"**
- Primary: `Human-agent` (a human performing actions)
- Secondary: `Experiment-participant` (role in experiment)
- Consider: Clinical context

```typescript
'patient': ['Human-agent', 'Experiment-participant'],
```

## Testing New Keywords

Create a test script:

```typescript
// test-keywords.ts
import { embeddingsManager } from './server/src/engine/embeddings';

async function test(query: string) {
  const results = await embeddingsManager.findSimilar(query, 5);
  console.log(`\n"${query}":`);
  for (const r of results) {
    console.log(`  ${r.tag} (${(r.similarity * 100).toFixed(0)}%)`);
  }
}

async function main() {
  await embeddingsManager.loadEmbeddings();

  // Test your new keywords
  await test('optogenetics');
  await test('patch clamp');
  await test('calcium imaging');
}

main();
```

Run with:
```bash
bun run test-keywords.ts
```

## Adding New Keyword Categories

To add a whole new category of terms:

### Step 1: Research the Domain

Identify common terms used in that field:
- Read papers/datasets
- Check existing BIDS datasets
- Consult domain experts

### Step 2: Map to HED Tags

For each term, find appropriate HED tags:
Search the HED schema with the HED online tools: https://hedtools.org or browse at https://www.hedtags.org

### Step 3: Add to the Anchor File

Add the entries to `ANCHOR_KEYWORDS` in `server/src/engine/anchorKeywords.ts`. The generator imports that file, so the same entries drive both exact matching and embedding generation.

```typescript
// =====================
// SLEEP RESEARCH (new category)
// =====================
'sleep-onset': ['Asleep', 'Agent-cognitive-state'],
'sleep-stage': ['Asleep', 'Agent-cognitive-state'],
'slow-oscillation': ['Asleep', 'Data-feature'],
```

Check that each key is absent before you add it. Adding a key that already exists makes the file fail `bun run check` with `noDuplicateObjectKeys`.

### Step 4: Regenerate and Test

```bash
bun run server/scripts/generateEmbeddings.ts
bun run compile
cd server && bun run test
# Test in VS Code
```

## Adjusting Search Parameters

In `server/src/engine/embeddings.ts`, you can tune:

```typescript
// Minimum similarity to consider a keyword match
const KEYWORD_THRESHOLD = 0.6;  // Lower = more matches, less precise

// Number of similar keywords to consider
const TOP_KEYWORDS = 10;  // Higher = more votes, slower

// Minimum similarity for direct tag match
const TAG_THRESHOLD = 0.5;  // Lower = more results
```

## Adding a New Schema

To support additional HED schemas or library schemas:

### Step 1: Update Schema Loading

In `server/src/engine/schemaVersion.ts`, extend the embedding schema set. The generator and the anchor contract test both read it:
```typescript
export const EMBEDDING_SCHEMA_VERSION = `${DEFAULT_HED_SCHEMA},sc:score_2.1.0,la:lang_1.1.0,my:mylib_1.0.0`;
```

### Step 2: Regenerate Embeddings

```bash
bun run server/scripts/generateEmbeddings.ts
```

The generator automatically includes all tags from all loaded schemas.

## Debugging Search Issues

### Check if keyword exists

```typescript
import { embeddingsManager } from './server/src/engine/embeddings';

// findByKeyword returns nothing until the tag data is loaded
await embeddingsManager.loadEmbeddings();
const result = embeddingsManager.findByKeyword('your-term');
console.log(result);  // Empty if not found
```

### Check embedding similarity

```typescript
// Requires model loading
const embedding = await embeddingsManager.embed('your-term');
console.log('Embedding dimensions:', embedding?.length);
```

### Enable debug logging

In `server/src/engine/embeddings.ts`, add logging:
```typescript
async findSimilar(query: string, topK: number = 10) {
  console.log(`[DEBUG] Searching for: ${query}`);
  // ...
  console.log(`[DEBUG] Keyword votes:`, tagVotes);
  console.log(`[DEBUG] Direct matches:`, directMatches.size);
}
```

## Common Issues

### Keyword not matching

1. Check case: keywords must be lowercase
2. Check spelling: exact match required for deterministic index
3. Check if embeddings were regenerated after adding

### Wrong tags suggested

1. Review the tag mappings
2. Consider if multiple meanings exist (e.g., "mouse" = animal or device)
3. Add more specific keywords

### Slow search

1. Check if model is loading (should only happen once)
2. Reduce `TOP_KEYWORDS` if needed
3. Increase thresholds to reduce candidates

## Contributing New Keywords

When contributing keywords to the project:

1. **Document the category**: Add a comment header
2. **Be consistent**: Follow existing format
3. **Test thoroughly**: Verify all mappings work
4. **Update docs**: Add to `.context/semantic-keyword-research.md`

Example PR structure:
```
feat: add sleep research keywords

- Add REM/NREM sleep terms
- Add sleep spindle and K-complex
- Add polysomnography terms
- Update embeddings file
```
