# HED-LSP

Language Server Protocol implementation for [HED (Hierarchical Event Descriptors)](https://www.hedtags.org/).

## Overview

HED-LSP provides IDE support for annotating neuroimaging data using HED tags. It validates HED strings in JSON sidecar files, offers schema-aware autocomplete, and displays inline diagnostics.

## Features

- **Validation**: Real-time validation of HED strings against the HED schema
- **Autocomplete**: Context-aware tag suggestions from the HED hierarchy
- **Hover Information**: Tag descriptions, full paths, and related tags
- **Diagnostics**: Inline error and warning markers

## Installation

### VS Code

Install the HED extension from the VS Code Marketplace (coming soon).

### From Source

```bash
# Clone the repository
git clone https://github.com/hed-standard/hed-lsp.git
cd hed-lsp

# Install dependencies
npm install

# Compile
npm run compile
```

## Development

```bash
# Watch mode for development
npm run watch

# Run linting
npm run lint
```

## Project Structure

```
hed-lsp/
├── client/          # VS Code extension client
│   └── src/
│       └── extension.ts
├── server/          # LSP server implementation
│   └── src/
│       ├── server.ts
│       ├── validation.ts
│       ├── completion.ts
│       └── hover.ts
├── package.json     # Root workspace config
└── tsconfig.json    # TypeScript project references
```

## Schema Support

HED-LSP supports:
- HED Standard Schema (default: 8.4.0)
- HED Library Schemas (SCORE, LANG, etc.)
- Schema version configuration per workspace

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Related Projects

- [hed-python](https://github.com/hed-standard/hed-python) - Python HED tools
- [hed-javascript](https://github.com/hed-standard/hed-javascript) - JavaScript HED validator
- [hed-schemas](https://github.com/hed-standard/hed-schemas) - HED schema definitions
