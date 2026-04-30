/**
 * @file symbols.ts
 *
 * MCP tool implementation for symbol lookup — one of the core navigational
 * primitives Prism exposes to Claude Code.
 *
 * Two VS Code LSP commands are surfaced here:
 *  - `vscode.executeWorkspaceSymbolProvider` — broadcast query across all open
 *    language servers; useful for finding a symbol by name across the project.
 *  - `vscode.executeDocumentSymbolProvider` — query a single file; returns a
 *    nested tree that this module flattens into a plain list for JSON transport.
 *
 * Both paths are unified under a single exported function (`listSymbols`) so
 * the MCP server has a single handler to register.
 */

import * as vscode from 'vscode';
import * as path from 'path';

function resolveFilePath(file: string): string {
  if (path.isAbsolute(file)) return file;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, file) : file;
}

const WORKSPACE_QUERY_MIN_LENGTH = 2;
const WORKSPACE_RESULT_CAP = 200;
const FILE_RESULT_CAP = 200;

/**
 * Lists symbols in either the entire workspace or a single file, delegating to
 * VS Code's built-in LSP symbol providers.
 *
 * This function exists so Claude Code can answer questions like "where is class
 * Foo defined?" or "show me all exports in bar.ts" without requiring a full
 * text search, relying instead on the language server's semantic index.
 *
 * Scope selection logic:
 * - `scope='workspace'` with a `file` present → silently downgrades to
 *   `scope='file'` because targeting a provider at a specific file is cheaper
 *   than a workspace-wide broadcast and yields identical results for single-file
 *   intent.
 * - `scope='workspace'` without a `file` → uses
 *   `executeWorkspaceSymbolProvider`; requires a query of at least
 *   {@link WORKSPACE_QUERY_MIN_LENGTH} characters to avoid flooding callers
 *   with unbounded results.
 * - `scope='file'` → uses `executeDocumentSymbolProvider` on the given URI and
 *   flattens the resulting symbol tree via {@link flattenSymbols}.
 *
 * @param params - Options controlling what symbols to retrieve.
 * @param params.query - Search string forwarded to the workspace symbol
 *   provider. For file-scoped calls the value is accepted but not forwarded to
 *   VS Code (the document symbol provider returns all symbols unconditionally).
 * @param params.scope - `'workspace'` to search across all files known to the
 *   language server, or `'file'` to list every symbol in a single document.
 * @param params.file - Absolute filesystem path of the file to query. Required
 *   when `scope` is `'file'`; optional (but honoured as a downgrade trigger)
 *   when `scope` is `'workspace'`.
 *
 * @returns A promise that resolves to an array of plain objects, each
 *   describing one symbol:
 *   - `name` {string} — symbol identifier.
 *   - `kind` {string} — human-readable symbol kind (e.g. `"Class"`,
 *     `"Function"`, `"Variable"`).
 *   - `file` {string} — absolute path of the file containing the symbol
 *     (workspace scope only; file-scope results omit this field).
 *   - `line` {number} — 1-based line number of the symbol's declaration.
 *   - `container` {string | undefined} — name of the enclosing symbol (e.g.
 *     the class that owns a method), or `undefined` for top-level symbols.
 *
 * @throws {Error} If `scope='workspace'` and `query` is shorter than
 *   {@link WORKSPACE_QUERY_MIN_LENGTH} characters.
 * @throws {Error} If `scope='file'` and `params.file` is not provided.
 */
export async function listSymbols(params: {
  query: string;
  scope: 'workspace' | 'file';
  file?: string;
}) {
  // If a file is known, always prefer the cheaper per-file provider even for
  // workspace-scoped calls — same results for single-file intent, no broadcast.
  if (params.scope === 'workspace' && params.file) {
    const all = await listFileSymbols(params.file);
    const total = all.length;
    const truncated = total > FILE_RESULT_CAP;
    const results = truncated ? all.slice(0, FILE_RESULT_CAP) : all;
    return { scope_used: 'file' as const, results, total, truncated };
  }

  if (params.scope === 'workspace') {
    if (params.query.length < WORKSPACE_QUERY_MIN_LENGTH) {
      throw new Error(
        `workspace symbol search requires at least ${WORKSPACE_QUERY_MIN_LENGTH} characters — ` +
        `use scope=file with a file path for broad listing`
      );
    }

    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      params.query
    );
    const all = symbols ?? [];
    const total = all.length;
    const truncated = total > WORKSPACE_RESULT_CAP;
    const results = all.slice(0, WORKSPACE_RESULT_CAP).map((s) => ({
      name: s.name,
      kind: vscode.SymbolKind[s.kind],
      file: s.location.uri.fsPath,
      line: s.location.range.start.line + 1,
      container: s.containerName
    }));
    return { scope_used: 'workspace' as const, results, total, truncated };
  }

  // Workspace query fans out to all providers; file query needs a specific URI to target
  if (!params.file) throw new Error('file is required for scope=file');

  const all = await listFileSymbols(params.file);
  const total = all.length;
  const truncated = total > FILE_RESULT_CAP;
  const results = truncated ? all.slice(0, FILE_RESULT_CAP) : all;
  return { scope_used: 'file' as const, results, total, truncated };
}

async function listFileSymbols(file: string) {
  const uri = vscode.Uri.file(resolveFilePath(file));
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );
  return flattenSymbols(symbols ?? []); // returns the full flat array; callers apply the cap
}

/**
 * Recursively flattens a VS Code `DocumentSymbol` tree into a plain array.
 *
 * `vscode.executeDocumentSymbolProvider` returns a hierarchy — a class node
 * contains its method nodes, which may in turn contain local variable nodes,
 * etc. JSON transport over MCP is easier with a flat list, and callers can
 * reconstruct nesting from the `container` field if needed.
 *
 * The function recurses depth-first, pushing a record for the current symbol
 * before visiting its children, so output order mirrors a top-down reading of
 * the source file.
 *
 * @param symbols - Array of `DocumentSymbol` nodes to flatten. Pass the
 *   top-level array returned by `executeDocumentSymbolProvider` for the initial
 *   call; recursive calls pass `s.children`.
 * @param container - Name of the parent symbol, threaded through recursive
 *   calls so each child record knows its enclosing context. `undefined` for
 *   top-level symbols.
 *
 * @returns A flat array of plain objects, one per symbol in the subtree:
 *   - `name` {string} — symbol identifier.
 *   - `kind` {string} — human-readable symbol kind (e.g. `"Method"`).
 *   - `line` {number} — 1-based line number of the symbol's range start.
 *   - `container` {string | undefined} — name of the directly enclosing
 *     symbol, or `undefined` for top-level declarations.
 *
 * @remarks
 * Side-effect: none. This is a pure transformation of the input tree.
 */
function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  container?: string
): { name: string; kind: string; line: number; container: string | undefined }[] {
  const results: ReturnType<typeof flattenSymbols> = [];
  for (const s of symbols) {
    results.push({
      name: s.name,
      kind: vscode.SymbolKind[s.kind],
      line: s.range.start.line + 1,
      container
    });
    // DocumentSymbol is a tree (class → methods → locals); flatten so callers get a plain list,
    // threading `container` so the parent name isn't lost in the process
    if (s.children?.length) {
      results.push(...flattenSymbols(s.children, s.name));
    }
  }
  return results;
}
