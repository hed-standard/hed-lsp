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

```mermaid
graph TB
    subgraph "server.ts"
        A[Connection] --> B[Documents]
        B --> C[onDidChangeContent]
        B --> D[onCompletion]
        B --> E[onHover]
    end

    subgraph "Core Modules"
        C --> F[validation.ts]
        D --> G[completion.ts]
        E --> H[hover.ts]
    end

    subgraph "Support Modules"
        F --> I[schemaManager.ts]
        G --> I
        G --> J[embeddings.ts]
        H --> I

        I --> K[documentParser.ts]
    end

    subgraph "External"
        I --> L[hed-validator]
        J --> M[transformers.js]
    end
```

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
│   │   ├── server.ts       # LSP connection & routing
│   │   ├── completion.ts   # Autocomplete logic
│   │   ├── validation.ts   # HED validation
│   │   ├── hover.ts        # Hover information
│   │   ├── schemaManager.ts # Schema loading
│   │   ├── embeddings.ts   # Semantic search
│   │   ├── documentParser.ts # JSON parsing
│   │   └── types.ts        # Shared types
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
