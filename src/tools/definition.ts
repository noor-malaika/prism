/**
 * @file definition.ts
 *
 * MCP tool implementations for go-to-definition and type-definition queries.
 *
 * This module bridges VS Code's built-in language server definition providers
 * to the Prism MCP server so that Claude Code (and any other MCP client) can
 * ask "where is this symbol defined?" or "where is this symbol's type declared?"
 * without needing direct access to the editor's LSP state.
 *
 * Both exported functions follow the same pattern:
 *   1. Resolve the caller-supplied symbol name (and optional file hint) to a
 *      concrete URI + Position via {@link resolveSymbolLocation}.
 *   2. Delegate to the appropriate VS Code definition provider command.
 *   3. Normalise the VS Code `Location[]` result into a plain object array
 *      with 1-indexed line/column numbers (VS Code uses 0-indexed internally)
 *      and a human-readable source-line preview, then return it to the caller.
 */

import * as vscode from 'vscode';
import { resolveSymbolLocation, getLineText } from '../resolve';
import { withLSRetry } from '../lsp-ready';

const MAX_RESULTS = 50;

/**
 * Finds the declaration site(s) of a symbol using VS Code's Definition Provider.
 *
 * This is the MCP-facing equivalent of pressing F12 (Go to Definition) in the
 * editor. It is exposed as an MCP tool so that Claude Code can navigate a
 * codebase's symbol graph without opening files manually.
 *
 * The function delegates to `vscode.executeDefinitionProvider`, which fans out
 * to every registered language server that covers the file's language. This
 * means results are identical to what the editor would show interactively.
 *
 * @param params - Input parameters for the tool call.
 * @param params.symbol - The symbol name to look up (e.g. `"MyClass"`,
 *   `"someFunction"`). Must be a token that the language server can resolve
 *   from the cursor position returned by {@link resolveSymbolLocation}.
 * @param params.file - Optional absolute path of the file that provides
 *   additional context for resolving ambiguous symbol names. When omitted,
 *   {@link resolveSymbolLocation} uses its own heuristics to locate the symbol.
 *
 * @returns A promise that resolves to an array of definition location objects.
 *   Each object contains:
 *   - `file`    {string}  — Absolute file-system path of the file that
 *                           contains the definition.
 *   - `line`    {number}  — 1-indexed line number of the definition start.
 *   - `column`  {number}  — 1-indexed column (character offset) of the
 *                           definition start.
 *   - `preview` {string}  — The raw text of that source line, useful for
 *                           quick visual confirmation without opening the file.
 *
 *   Returns an empty array when no definition is found or when the provider
 *   returns `undefined`.
 */
export async function goToDefinition(params: { symbol: string; file: string }) {
  if (!params.file) {
    throw new Error('file is required: provide the absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts)');
  }
  const location = await resolveSymbolLocation(params.symbol, params.file);

  const defs = await withLSRetry(
    () => Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeDefinitionProvider',
      location.uri,
      location.position
    )),
    (v) => v === null || v === undefined
  );

  const all = (defs ?? []).map((d) => {
    const link = d as unknown as vscode.LocationLink;
    return 'targetUri' in d
      ? { uri: link.targetUri, range: link.targetRange }
      : { uri: (d as vscode.Location).uri, range: (d as vscode.Location).range };
  });
  const total = all.length;
  const truncated = total > MAX_RESULTS;
  const results = all.slice(0, MAX_RESULTS).map((d) => ({
    file: d.uri.fsPath,
    line: d.range.start.line + 1,       // VS Code is 0-indexed; MCP consumers expect 1-indexed
    column: d.range.start.character + 1, // same offset reason as line
    preview: getLineText(d.uri, d.range.start.line)
  }));
  return { results, total, truncated };
}

/**
 * Finds the type declaration site(s) of a symbol using VS Code's Type
 * Definition Provider.
 *
 * This is the MCP-facing equivalent of "Go to Type Definition" in the editor.
 * It is distinct from {@link goToDefinition} because it resolves the *type*
 * of a symbol rather than the symbol's own declaration. For example, given a
 * variable `const x: MyType = …`, this function navigates to where `MyType`
 * is declared, whereas {@link goToDefinition} navigates to where `x` is
 * declared.
 *
 * This distinction matters when Claude Code needs to understand the shape of
 * data (interfaces, type aliases, enums) rather than the runtime binding point.
 * The function delegates to `vscode.executeTypeDefinitionProvider`, which
 * correctly handles type aliases, generic instantiations, and mapped types —
 * cases where `executeDefinitionProvider` would land on the value declaration
 * instead.
 *
 * @param params - Input parameters for the tool call.
 * @param params.symbol - The symbol whose *type* should be located (e.g. a
 *   variable, parameter, or class member name). The language server resolves
 *   the type from the cursor position returned by {@link resolveSymbolLocation}.
 * @param params.file - Optional absolute path of the source file that provides
 *   context for resolving the symbol. When omitted, {@link resolveSymbolLocation}
 *   uses its own heuristics.
 *
 * @returns A promise that resolves to an array of type-definition location
 *   objects. Each object contains:
 *   - `file`    {string}  — Absolute file-system path of the file that
 *                           contains the type declaration.
 *   - `line`    {number}  — 1-indexed line number of the type declaration start.
 *   - `column`  {number}  — 1-indexed column (character offset) of the
 *                           type declaration start.
 *   - `preview` {string}  — The raw text of that source line, for quick
 *                           visual confirmation without opening the file.
 *
 *   Returns an empty array when no type definition is found or when the
 *   provider returns `undefined`.
 */
export async function getTypeDefinition(params: { symbol: string; file: string }) {
  if (!params.file) {
    throw new Error('file is required: provide the absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts)');
  }
  const location = await resolveSymbolLocation(params.symbol, params.file);

  // executeTypeDefinitionProvider resolves type aliases; executeDefinitionProvider would land on the value declaration
  const defs = await withLSRetry(
    () => Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeTypeDefinitionProvider',
      location.uri,
      location.position
    )),
    (v) => v === null || v === undefined
  );

  const all = (defs ?? []).map((d) => {
    const link = d as unknown as vscode.LocationLink;
    return 'targetUri' in d
      ? { uri: link.targetUri, range: link.targetRange }
      : { uri: (d as vscode.Location).uri, range: (d as vscode.Location).range };
  });
  const total = all.length;
  const truncated = total > MAX_RESULTS;
  const results = all.slice(0, MAX_RESULTS).map((d) => ({
    file: d.uri.fsPath,
    line: d.range.start.line + 1,       // VS Code is 0-indexed; MCP consumers expect 1-indexed
    column: d.range.start.character + 1, // same offset reason as line
    preview: getLineText(d.uri, d.range.start.line)
  }));
  return { results, total, truncated };
}
