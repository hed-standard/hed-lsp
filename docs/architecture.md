# HED-LSP Architecture

This document describes the overall architecture of the HED-LSP system.

## System Overview

HED-LSP follows the Language Server Protocol (LSP) architecture, separating the VS Code extension (client) from the language intelligence (server).

```mermaid
graph LR
    subgraph "VS Code"
        A[Editor] --> B[Extension]
        B --> C[Language Client]
    end

    C <-->|JSON-RPC over IPC| D[Language Server]

    subgraph "Server Process"
        D --> E[Request Handler]
        E --> F[Completion]
        E --> G[Validation]
        E --> H[Hover]
    end
```

## Request Flow

When a user types in the editor, requests flow through the system:

```mermaid
sequenceDiagram
    participant User
    participant VSCode
    participant Client
    participant Server
    participant Schema
    participant Embeddings

    User->>VSCode: Types "Animal/"
    VSCode->>Client: textDocument/didChange
    Client->>Server: Sync document

    User->>VSCode: Triggers completion (/)
    VSCode->>Client: textDocument/completion
    Client->>Server: Request completions

    Server->>Schema: Get tag children
    Server->>Embeddings: Semantic search (if partial text)
    Schema-->>Server: Child tags
    Embeddings-->>Server: Similar tags

    Server-->>Client: CompletionList
    Client-->>VSCode: Show suggestions
    VSCode-->>User: Autocomplete dropdown
```

## Component Architecture

### Server Components

The server is split into an engine and adapters. The engine (`server/src/engine/`) is pure: it has no language-server imports, and a boundary test enforces that. Adapters translate between the engine and an editor or a command line. A daemon adapter over the same engine is planned.

```mermaid
graph TB
    subgraph "Adapters"
        A[server.ts: LSP connection] --> B[diagnostics.ts]
        A --> C[completion.ts]
        A --> D[hover.ts]
        E[cli.ts: hed-suggest]
    end

    subgraph "Engine (server/src/engine)"
        F[index.ts: validate, suggestions, schema access]
        F --> G[validation.ts]
        F --> H[suggestionEngine.ts]
        H --> I[embeddings.ts]
        H --> J[schemaManager.ts]
        I --> K[anchorKeywords.ts]
    end

    subgraph "External"
        G --> L[hed-validator]
        J --> L
        I --> M[transformers.js]
    end

    A --> H
    B --> G
    B --> J
    C --> I
    C --> J
    D --> J
    E --> H
```

Engine log lines go to stderr by default, so the CLI JSON on stdout stays clean. The language server sends them to its console, which reaches the client under `--stdio` and stays on stdout under IPC.

### Data Flow for Validation

```mermaid
flowchart TD
    A[Document Change] --> B[Parse JSON]
    B --> C{Find HED keys}
    C -->|Found| D[Extract HED strings]
    C -->|Not found| E[No diagnostics]

    D --> F[For each HED string]
    F --> G[Parse with hed-validator]
    G --> H{Valid?}

    H -->|Yes| I[No diagnostic]
    H -->|No| J[Create diagnostic]

    J --> K[Map error position]
    K --> L[Add to diagnostics list]

    I --> M{More strings?}
    L --> M
    M -->|Yes| F
    M -->|No| N[Publish diagnostics]
```

### Data Flow for Completion

```mermaid
flowchart TD
    A[Completion Request] --> B[Get cursor position]
    B --> C[Find HED context]
    C --> D{Trigger character?}

    D -->|/| E[Get parent tag]
    E --> F[Lookup children in schema]

    D -->|, or space| G[Check for partial text]
    G --> H{Has partial?}

    H -->|Yes| I[Prefix match + Semantic search]
    H -->|No| J[Top-level tags]

    D -->|(| K[Start new group]
    K --> J

    F --> L[Build completions]
    I --> L
    J --> L

    L --> M[Sort by relevance]
    M --> N[Return CompletionList]
```

## File Structure

```
hed-lsp/
├── client/                 # VS Code extension
│   ├── src/
│   │   └── extension.ts    # Extension entry point
│   ├── package.json        # Extension manifest
│   └── tsconfig.json
│
├── server/                 # Language server
│   ├── src/
│   │   ├── engine/         # Pure engine: no language-server imports
│   │   │   ├── index.ts    # Facade: validate, suggestions, schema access
│   │   │   ├── validation.ts # HED validation (pure)
│   │   │   ├── suggestionEngine.ts # Suggestion cascade
│   │   │   ├── schemaManager.ts # Schema loading
│   │   │   ├── embeddings.ts # Semantic search
│   │   │   └── log.ts      # Engine logging (stderr by default)
│   │   ├── server.ts       # LSP connection & routing
│   │   ├── completion.ts   # Autocomplete logic (adapter)
│   │   ├── diagnostics.ts  # Validation to LSP diagnostics (adapter)
│   │   ├── hover.ts        # Hover information (adapter)
│   │   ├── documentParser.ts # JSON parsing
│   │   └── types.ts        # LSP types and the re-exported engine types
│   ├── data/
│   │   └── tag-embeddings.compact.json
│   ├── scripts/
│   │   └── generateEmbeddings.ts
│   ├── package.json
│   └── tsconfig.json
│
├── docs/                   # Documentation
├── package.json            # Root workspace
└── tsconfig.json           # Root TypeScript config
```

## Key Design Decisions

### 1. Separate Client/Server

The LSP architecture allows the language intelligence to run in a separate process, improving VS Code responsiveness.

### 2. Schema Caching

Schemas are cached in memory after first load to avoid repeated network/disk access.

### 3. Pre-computed Embeddings

Tag embeddings are pre-computed and stored in JSON to avoid loading the ML model at runtime for most users.

### 4. Dual-Embedding Architecture

Semantic search uses both keyword anchors and direct tag matching to improve relevance. See [Semantic Search](./semantic-search.md) for details.

### 5. Debounced Validation

Validation is debounced (300ms) during typing to reduce CPU usage while still providing responsive feedback.

## Error Handling

```mermaid
flowchart TD
    A[Request] --> B{Schema loaded?}
    B -->|No| C[Load schema]
    C --> D{Load success?}
    D -->|No| E[Log error, return empty]
    D -->|Yes| F[Continue]
    B -->|Yes| F

    F --> G{Embeddings available?}
    G -->|No| H[Skip semantic search]
    G -->|Yes| I[Include semantic results]

    H --> J[Return results]
    I --> J
```

The system is designed to degrade gracefully:
- If schema fails to load: validation and completion disabled
- If embeddings fail to load: semantic search disabled, prefix matching still works
- If embedding model fails: falls back to deterministic keyword index
