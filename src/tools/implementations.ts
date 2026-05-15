/**
 * @file implementations.ts
 *
 * Provides the `findImplementations` MCP tool for the Prism LSP-to-MCP bridge.
 *
 * In object-oriented and interface-driven code, the declaration of an interface
 * or abstract method lives in one place while the concrete classes that fulfil
 * the contract live elsewhere. This module exposes that relationship to Claude
 * Code: given a symbol name (and an optional anchoring file) it returns every
 * concrete implementation, allowing an AI agent to reason about the full class
 * hierarchy without manually grepping the workspace.
 */

import * as vscode from 'vscode';
import { resolveSymbolLocation, getLineText } from '../resolve';
import { withLSRetry } from '../lsp-ready';

const MAX_RESULTS = 50;

/**
 * Finds all concrete implementations of a symbol (typically an interface,
 * abstract class, or abstract method) using VS Code's built-in
 * `vscode.executeImplementationProvider` LSP command.
 *
 * This function exists because `go-to-definition` would return only the
 * *declaration* (e.g. the interface itself), whereas this command follows the
 * LSP `textDocument/implementation` request to locate every class or method
 * that actually implements the contract — information that is essential for an
 * AI agent performing impact analysis, refactoring planning, or code
 * comprehension tasks.
 *
 * @param params - Lookup parameters.
 * @param params.symbol - The fully-qualified or simple name of the symbol whose
 *   implementations should be found (e.g. `"IAuthProvider"` or `"save"`).
 * @param params.file - Optional workspace-relative or absolute path to a source
 *   file that contains or imports the symbol. Providing this helps
 *   `resolveSymbolLocation` disambiguate symbols with the same name that exist
 *   in multiple files.
 *
 * @returns A promise that resolves to an array of implementation site
 *   descriptors. Each descriptor contains:
 *   - `file` — absolute filesystem path of the file containing the
 *     implementation.
 *   - `line` — 1-based line number of the implementation's start position.
 *   - `column` — 1-based column number of the implementation's start position.
 *   - `preview` — the raw text of that source line, useful for quick
 *     human-readable context without opening the file.
 *
 *   Resolves to an empty array when no implementations are found or when the
 *   active language server does not support the implementation provider.
 *
 * @remarks
 * Side effect: triggers VS Code's LSP machinery, which may cause language
 * servers to index or analyse files on demand. This is a read-only operation
 * from the workspace's perspective — no files are modified.
 */
export async function findImplementations(params: { symbol: string; file: string }) {
  if (!params.file) {
    throw new Error('file is required: provide the absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts)');
  }
  const location = await resolveSymbolLocation(params.symbol, params.file);

  // executeImplementationProvider finds concrete classes; executeDefinitionProvider would return the interface declaration
  const impls = await withLSRetry(
    () => Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeImplementationProvider',
      location.uri,
      location.position
    )),
    (v) => v === null || v === undefined
  );

  const all = impls ?? [];
  const total = all.length;
  const truncated = total > MAX_RESULTS;
  const results = all.slice(0, MAX_RESULTS).map((i) => ({
    file: i.uri.fsPath,
    line: i.range.start.line + 1,
    column: i.range.start.character + 1,
    preview: getLineText(i.uri, i.range.start.line)
  }));
  return { results, total, truncated };
}
