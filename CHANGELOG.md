# Changelog

All notable changes to the HED Language Support extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Semantic-search eval set of 206 description-to-HED pairs from `hed-examples`, with a harness that reports hit@10, recall@10, and MRR against the raw baseline. The query-instruction experiment ran on the dev split and was negative under fixed thresholds; search behavior is unchanged. See `docs/semantic-search.md`.

### Changed
- The default HED schema is 8.5.0 (the `hed.schemaVersion` setting, the `hed-suggest` CLI, suggestions, and the embedding index). The version lives in one module, `server/src/schemaVersion.ts`.
- The embedding model settings (model id, quantization, pooling, normalization) live in one module shared by the runtime and the generator, and a contract test records which model repositories publish the same weights.

### Fixed
- Keyword anchors point only at HED schema tags. Anchor targets that were extension words (48 names) are removed, which drops 71 keywords that had no other target. A contract test enforces this.
- The harness counts embedding failures directly and refuses to score a run where any query failed. It no longer infers failures from empty results.
- `isModelCached` checks the transformers.js cache layout, where it previously checked the Hub layout.
- Suggestion lookups no longer throw for the queries `constructor` or `__proto__`.
  Completion on a HED value with either name and `hed-suggest` or `hed/suggest`
  with either name as a query now return normally.
- `hed/suggest` batch results keep a query named `__proto__` as a key.

### Changed
- The embedding anchor keywords live in one file, `server/src/anchorKeywords.ts`.
  The generator imports that file instead of keeping its own copy. A new
  contract test fails when the shipped keyword embeddings drift from it.

## [0.4.0] - 2026-05-21

### Added
- New `hed/suggest` JSON-RPC request on the LSP server. Long-running clients
  (editors, the HEDit backend) can hold one persistent connection and submit
  batched tag-suggestion queries instead of spawning the `hed-suggest` CLI
  per query. Request payload: `{queries: string[], schema?: string, top?:
  number, semantic?: boolean}`. Response: `Record<string, string[]>`,
  matching `hed-suggest --json` output shape.
- `server/src/suggestionEngine.ts`: shared module exporting `findSuggestions`
  and `suggestBatch`. Both the `hed-suggest` CLI and the `hed/suggest`
  request handler delegate to this module so they share the schema load and
  semantic-embedding warmup.

### Changed
- `cli.ts` now delegates to `suggestBatch`. CLI behavior is unchanged.

## [0.3.4] - 2026-02-18

### Fixed
- CLI `--semantic` flag now properly enables embeddings and initializes the model
- Compound query matching for `searchTagsContaining` (e.g., "muscle artifact" now finds "EMG-artifact")
- `findByKeyword` normalizes spaces to hyphens for KEYWORD_INDEX lookup

## [0.3.3] - 2025-12-29

### Changed
- Semantic search is now opt-in with a popup prompt (avoids unexpected 600MB download)
- Status bar shows model download progress when semantic search is enabled
- Cross-platform support for Windows, macOS, and Linux

### Fixed
- Extension now works correctly on fresh installs (was only working in debug mode)
- Bundled dependencies properly with esbuild

## [0.3.1] - 2025-12-29

### Changed
- Self-hosted embedding model at `neuromechanist/Qwen3-Embedding-0.6B-ONNX-Q8` for reliability
- Added demo GIFs and extension icon for VS Code Marketplace

### Fixed
- Excluded .env files from package

## [0.3.0] - 2025-12-29

### Added
- Definition tracking: autocomplete suggests defined names after `Def/` or `Def-expand/`
- Hover shows definition content when hovering over `Def/Name` references
- Go to Definition (F12) navigates from `Def/Name` to its `Definition/Name` declaration
- Support for placeholder definitions (`Definition/Name/#`)
- Unit tests with vitest (13 tests for definition extraction)
- GitHub Actions CI workflow (Node 20 and 22)
- Biome for linting and formatting
- cspell spell checking with scientific vocabulary
- Issue and PR templates

## [0.2.0] - 2025-12-28

### Added
- Dual-embedding semantic search architecture for intelligent tag suggestions
- 457 curated keyword mappings to HED tags
- SCORE library terms (EEG, sleep, clinical terminology)
- Spatial and temporal relation keywords
- Architecture documentation with Mermaid diagrams

### Changed
- Improved autocomplete ranking with semantic similarity scores

## [0.1.0] - 2025-12-27

### Added
- Initial release
- Real-time HED validation for JSON sidecars and TSV files
- Schema-aware autocomplete with fuzzy matching
- Hover documentation showing tag descriptions and full paths
- Semantic syntax highlighting for HED strings
- Library schema support (SCORE, LANG, etc.)
- Automatic schema detection from `dataset_description.json`
- Support for `{column}` placeholders in BIDS sidecars
- Configurable schema version per workspace

[0.3.3]: https://github.com/hed-standard/hed-lsp/releases/tag/v0.3.3
[0.3.1]: https://github.com/hed-standard/hed-lsp/releases/tag/v0.3.1
[0.3.0]: https://github.com/hed-standard/hed-lsp/releases/tag/v0.3.0
[0.2.0]: https://github.com/hed-standard/hed-lsp/releases/tag/v0.2.0
[0.1.0]: https://github.com/hed-standard/hed-lsp/releases/tag/v0.1.0
