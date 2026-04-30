/**
 * @file references.ts
 *
 * MCP tool implementation for the "find references" capability.
 *
 * This module bridges VS Code's built-in reference provider (the same engine
 * that powers the editor's "Find All References" command) to the Prism MCP
 * server so that Claude Code can ask: "where is this symbol used across the
 * entire workspace?"  Without this bridge the information would be locked
 * inside the editor and unavailable to any external AI client.
 */

import * as vscode from 'vscode';
import { resolveSymbolLocation, getLineText } from '../resolve';
import { withLSRetry } from '../lsp-ready';

const MAX_RESULTS = 50;

/**
 * Finds every location in the workspace where a given symbol is referenced.
 *
 * This function is the MCP-facing entry point for the "references" tool.  It
 * performs two steps:
 *  1. Resolves the symbol name (and optional file hint) to a concrete
 *     `Uri` + `Position` pair that VS Code's language servers understand.
 *  2. Delegates to `vscode.executeReferenceProvider`, which fans the request
 *     out to all registered LSP reference providers (TypeScript, Pylsp, etc.)
 *     and returns the aggregated result.
 *
 * Line and column numbers are converted from VS Code's 0-based indexing to the
 * 1-based convention that MCP consumers (including Claude Code) expect.
 *
 * Side effects:
 *  - May trigger workspace-wide indexing in the active language server if the
 *    project has not been fully loaded yet, which can be slow on first call.
 *
 * @param params - Input parameters for the reference lookup.
 * @param params.symbol - The name of the symbol to search for (e.g. `"findReferences"`).
 * @param params.file - Optional absolute path to a source file that provides
 *   context for resolving an ambiguous symbol name.  When omitted, resolution
 *   falls back to heuristics inside `resolveSymbolLocation`.
 *
 * @returns A promise that resolves to an array of reference location objects.
 *   Each object contains:
 *   - `file` {string} — Absolute filesystem path of the file containing the reference.
 *   - `line` {number} — 1-based line number of the reference.
 *   - `column` {number} — 1-based column (character) offset of the reference.
 *   - `preview` {string} — The raw text of the line, useful for displaying
 *     context snippets to the AI without requiring a separate file read.
 *   Returns an empty array when no references are found or when the provider
 *   returns `undefined`.
 */
export async function findReferences(params: { symbol: string; file: string }) {
  if (!params.file) {
    throw new Error('file is required: provide the absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts)');
  }
  const location = await resolveSymbolLocation(params.symbol, params.file);

  const refs = await withLSRetry(
    () => Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      location.uri,
      location.position
    )),
    (v) => !v || (v as unknown[]).length === 0
  );

  const all = refs ?? [];
  const total = all.length;
  const truncated = total > MAX_RESULTS;
  const results = all.slice(0, MAX_RESULTS).map((r) => ({
    file: r.uri.fsPath,
    line: r.range.start.line + 1,       // VS Code is 0-indexed; MCP consumers expect 1-indexed
    column: r.range.start.character + 1, // same offset reason as line
    preview: getLineText(r.uri, r.range.start.line)
  }));
  return { results, total, truncated };
}
