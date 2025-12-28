# Contributing to HED-LSP

Thank you for your interest in contributing to HED-LSP!

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/hed-standard/hed-lsp.git
   cd hed-lsp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the compiler in watch mode:
   ```bash
   npm run watch
   ```

4. Open VS Code and press F5 to launch the Extension Development Host.

## Project Structure

- `client/` - VS Code extension client that communicates with the LSP server
- `server/` - LSP server implementation with validation, completion, and hover features

## Making Changes

1. Create a new branch for your feature or fix
2. Make your changes with clear, atomic commits
3. Ensure the code compiles: `npm run compile`
4. Run linting: `npm run lint`
5. Test manually in the Extension Development Host
6. Submit a pull request

## Code Style

- Use TypeScript strict mode
- Follow existing code patterns
- Keep functions focused and well-documented
- Use meaningful variable and function names

## Commit Messages

- Use concise, descriptive commit messages
- Start with a verb (Add, Fix, Update, Remove, Refactor)
- Reference issues when applicable

## Reporting Issues

Please use the [GitHub Issues](https://github.com/hed-standard/hed-lsp/issues) page to report bugs or request features. Include:

- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- VS Code and extension version

## Questions

For questions about HED itself, see [hed-resources](https://www.hed-resources.org/) or post on the [HED discussion forum](https://github.com/hed-standard/hed-schemas/discussions).
