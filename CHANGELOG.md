# Changelog

All notable changes to the HED Language Support extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- HTTP daemon, the third adapter over the engine (`server/src/daemon/`, run with `node out/daemon/main.js` or the `hed-lsp-daemon` command). Version 1 of the API has `GET /v1/health`, `GET /v1/schemas`, `POST /v1/validate`, and `POST /v1/suggest`, with one error envelope, CORS, and a request ID on every response. Every limit is a `HED_LSP_*` variable with a documented default: body size, batch sizes, string and query lengths, bounded validate output (issues per string, message length, and message text per response), per-client rates charged by the length of text, requests in flight and pending request bodies, timeouts for the body and for writing the answer, and a schema allowlist. Semantic search is off by default and is loaded in the background when enabled. The daemon logs no request text and no IP addresses. See `docs/daemon.md`.
- Container image for the daemon (`Dockerfile`): Bun build stage and Node 22 slim runtime, both pinned by digest, for `linux/amd64`, with a health check. A new `image` CI job builds it and runs `scripts/daemon-smoke.sh` for pull requests into `main` and pushes to `main`, once normally and once with no network. A `publish-image` job pushes the tested image to `ghcr.io/hed-standard/hed-lsp-daemon` from `main`, behind the `ghcr-publish` environment, tagged with the package version and `sha-<short commit>`.
- Deployment tooling for the hedtools host (`deploy/hedtools/`) and its runbook, `docs/deployment-hedtools.md`: `deploy.sh` (an image ID or digest, never a tag, with `--dry-run`) runs the container with the plan's limits on a dedicated network whose gateway the daemon trusts; `apache-hed-lsp.conf` is the `/hed-lsp/` route; `measure.sh` runs the S0 and S1 sequences with `neighbor-probe.sh` watching the other services on the host and stopping the run on harm; `check-client-key.sh` is the behavioral test of which address the daemon limits by; and `scripts/check-load-report.ts` judges a harness report against the acceptance criteria. The runbook records a measured difference from the plan: with `disablereuse=On`, Apache answers 502 instead of the daemon's JSON 413 for an oversize body, and `LimitRequestBody` does not limit a proxied body.
- Load harness options `--semantic-top` and `--semantic-batch`, which set the `top` and the number of queries of each semantic request, and `--reach-check`, which reports the share of corpus queries that return fewer than `top` results with semantic search off, the queries that would reach the embedding model: 27.2% at `top` 10 and 97.1% at `top` 50 on the evaluation set.
- Load harness for the daemon (`node out/daemon/loadTest.js`): a weighted mix of suggest, validate, and semantic requests built from the evaluation set, with latency percentiles, error rate, 429 and 503 counts by error code, throughput, and health before and after.
- `schemaVersionUsed(spec)` in the engine facade reports the schema version that actually loaded, including when the bundled 8.4.0 stood in for 8.5.0, and `embeddingsManager.setRuntimeOptions` sets the embedding threads and whether the model may be downloaded. Defaults leave the language server and the CLI unchanged.
- Engine facade (`server/src/engine/index.ts`) with `validate(hed, { schema })`, which validates against an explicit schema version without changing global state. Engine modules have no language-server imports, enforced by a boundary test.
- Transport tests: the language server runs as a child process over JSON-RPC on stdio, and the CLI is checked for JSON-only stdout.
- Semantic-search eval set of 206 description-to-HED pairs from `hed-examples`, with a harness that reports hit@10, recall@10, and MRR against the raw baseline. The query-instruction experiment ran on the dev split and was negative under fixed thresholds. The verdict is unchanged, but this release regenerates the index and cuts anchor targets, so search results change. See `docs/semantic-search.md`.

### Changed
- The `image` CI job builds and labels the image with the head commit of a pull request instead of the synthetic merge commit, checks that commit out, saves and uploads the image tarball for pull requests as well as pushes (14 days), and prints the image ID in the job summary, so the host can load the tested image before the merge and compare its ID. It then runs the deploy scripts against that image on the Docker of the runner: `deploy.sh` (a first deploy, the same image again, a bad setting that must be refused before anything is stopped, a replacement, and the rollback), `check-client-key.sh direct`, a rehearsal of `measure.sh`, and the Docker branches of `neighbor-probe.sh`, and removes what they made.
- The default HED schema is 8.5.0 (the `hed.schemaVersion` setting, the `hed-suggest` CLI, suggestions, and the embedding index). The version lives in one module, `server/src/engine/schemaVersion.ts`.
- The default schema is fetched from GitHub, because hed-validator 4.2.0 does not bundle 8.5.0. If the fetch fails, the server falls back to the bundled 8.4.0 and logs the reason, so validation works offline but lacks the 8.5.0 additions. Regenerating the embedding index and running the 8.5.0 contract tests need network access.
- The embedding model settings (model id, quantization, pooling, normalization) live in one module shared by the runtime and the generator, and a contract test records which model repositories publish the same weights.
- The embedding anchor keywords live in one file, `server/src/engine/anchorKeywords.ts`.
  The generator imports that file instead of keeping its own copy. A new
  contract test fails when the shipped keyword embeddings drift from it.

### Fixed
- A repeated tag, such as `Sensory-event, Red, Red`, is reported with the validator's code (`TAG_EXPRESSION_REPEATED`) and message, not as an internal error.
  The validator throws this issue instead of returning it, and the engine used to label every thrown exception `INTERNAL_ERROR` with the text `Validation error: ...`.
  The engine now keeps the issue the validator threw, and other exceptions, such as a stack overflow, are still internal errors.
  This changes the diagnostics the language server shows for such strings, and the daemon's answer for them.
- A suggestion query that fails no longer empties the whole batch (#60). `suggestBatch`, and so `hed/suggest` and `hed-suggest`, log the failure and leave that query out, so the other queries return. An absent key means the query failed, and an empty list means it found no matches.
- Keyword anchors point only at HED schema tags. Anchor targets that were extension words (48 names) are removed, which drops 71 keywords that had no other target. A contract test enforces this.
- The harness counts embedding failures directly and refuses to score a run where any query failed. It no longer infers failures from empty results.
- `isModelCached` checks the transformers.js cache layout, where it previously checked the Hub layout.
- Suggestion lookups no longer throw for the queries `constructor` or `__proto__`.
  Completion on a HED value with either name and `hed-suggest` or `hed/suggest`
  with either name as a query now return normally.
- `hed/suggest` batch results keep a query named `__proto__` as a key.
- Suggestion requests that omit `top`, or send `null` or a blank value for an option, now use the default.
  Before, a missing `top` overrode the default and skipped the schema search, and a `null` `top` returned no results.
- `hed-suggest --semantic --json` wrote engine log lines to stdout, mixed into its JSON output.
  Engine logs now go to stderr. The language server's console output is unchanged: under `--stdio` the client receives it as log messages, and under IPC info lines go to stdout and error lines go to stderr.
- Concurrent requests for a schema version that is not cached share one load. A failed load is not kept, so the next request retries it.
- Engine messages that contain a percent sign, such as a file path, are no longer garbled when the language server logs them under IPC.

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
