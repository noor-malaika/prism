/**
 * @file resolve.ts
 *
 * Symbol-resolution utilities for the Prism LSP-to-MCP bridge.
 *
 * MCP tools such as `go-to-definition` and `references` need to translate a
 * plain string symbol name (provided by Claude Code) into a concrete VS Code
 * `Uri` + `Position` pair before they can invoke any language-server command.
 * This module owns that translation step.
 *
 * Resolution is attempted in order of reliability:
 *   1. Workspace symbol provider (LSP-backed fuzzy search, exact-name filter).
 *   2. Hint-file ranking — when multiple overloads exist, prefer the one that
 *      lives in the same file the caller mentioned.
 *   3. Plain-text substring scan of the hint file — last resort when the LSP
 *      has not yet indexed the workspace.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { withLSRetry } from './lsp-ready';

function resolveFilePath(file: string): string {
  if (path.isAbsolute(file)) return file;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, file) : file;
}

/**
 * Resolves a symbol name to its declaration location inside the VS Code
 * workspace.
 *
 * This function is the primary entry point used by MCP tool handlers
 * (definition, references, call-hierarchy, etc.) whenever they receive a bare
 * symbol string from Claude Code and need a `Uri`/`Position` pair to pass to
 * the language-server commands.
 *
 * Resolution strategy (in priority order):
 *  1. If `hintFile` is provided, open the document silently so the LSP
 *     activates and begins indexing the relevant file before the query fires.
 *  2. Query the workspace symbol provider via
 *     `vscode.executeWorkspaceSymbolProvider`. The provider returns fuzzy
 *     matches, so results are filtered to an exact name match first.
 *  3. When no exact match exists but fuzzy matches do, sort them so any
 *     candidate whose path contains `hintFile` ranks first — useful for
 *     overloaded names that appear in multiple packages.
 *  4. If the LSP returns nothing at all and `hintFile` was supplied, fall back
 *     to a plain-text substring search inside that file via
 *     {@link findDeclarationInFile}.
 *
 * @param symbol   - The exact name of the symbol to locate (e.g. `"MyClass"`,
 *                   `"handleRequest"`). Used both for the workspace-symbol
 *                   query and for the exact-match filter.
 * @param hintFile - Optional absolute filesystem path of the file most likely
 *                   to contain the symbol. Serves two purposes: (a) it cold-
 *                   starts the LSP by opening the document silently, and (b)
 *                   it biases the ranking of ambiguous results toward that
 *                   file. When omitted, only the workspace symbol provider is
 *                   consulted and no text-scan fallback is attempted.
 *
 * @returns A promise that resolves to an object containing:
 *   - `uri`      — the VS Code `Uri` of the file that declares the symbol.
 *   - `position` — the zero-based `Position` of the symbol's declaration
 *                  within that file (start of its range, or first occurrence
 *                  for the text-scan fallback).
 *
 * @throws {Error} If the symbol cannot be resolved by any strategy, an error
 *   with the message `"Could not resolve symbol: <symbol>"` is thrown. Callers
 *   should surface this as an MCP tool error.
 *
 * @remarks
 * **Side effects**: may open text documents in the VS Code workspace document
 * cache (without revealing them in the editor UI) as a side effect of calling
 * `vscode.workspace.openTextDocument`. This is intentional — it triggers LSP
 * activation for cold workspaces.
 */
export async function resolveSymbolLocation(
  symbol: string,
  hintFile?: string
): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
  if (hintFile) {
    const resolvedHint = resolveFilePath(hintFile);
    hintFile = resolvedHint;
    // Opens the file in the background to trigger LSP activation without showing it in the editor — cold-start anchor
    await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedHint));
  }

  // LSP may not have finished indexing on first call; retry only when the LSP
  // returns null/undefined (not ready), not when it returns an empty array
  // (which is a valid "symbol not found" answer from a ready LSP).
  const symbols = await withLSRetry(
    () => Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      symbol
    )),
    (v) => v == null
  );

  if (symbols.length === 0) {
    if (hintFile) {
      const pos = await findDeclarationInFile(symbol, hintFile);
      if (pos) { return { uri: vscode.Uri.file(hintFile), position: pos }; }
    }
    throw new Error(`Symbol not found: ${symbol}`);
  }

  // it's a fuzzy search above, turning down to an exact one
  const exact = symbols?.find((s) => s.name === symbol);
  if (exact) {
    return { uri: exact.location.uri, position: await pinToSymbolName(symbol, exact.location.uri, exact.location.range.start) };
  }

  // Overloaded symbol names exist across packages; caller's file is the most likely intent
  if (symbols?.length) {
    const ranked = hintFile
      ? [...symbols].sort((a, b) => {
          const aMatch = a.location.uri.fsPath.includes(hintFile) ? -1 : 1;
          const bMatch = b.location.uri.fsPath.includes(hintFile) ? -1 : 1;
          return aMatch - bMatch;
        })
      : symbols;
    const best = ranked[0];
    return { uri: best.location.uri, position: await pinToSymbolName(symbol, best.location.uri, best.location.range.start) };
  }

  if (hintFile) {
    // Text search as last resort when LSP returns nothing
    const pos = await findDeclarationInFile(symbol, hintFile);
    if (pos) return { uri: vscode.Uri.file(hintFile), position: pos };
  }

  throw new Error(`Could not resolve symbol: ${symbol}`);
}

/**
 * Locates the first occurrence of a symbol string inside a specific file using
 * a plain-text substring search.
 *
 * This function is an internal fallback used by {@link resolveSymbolLocation}
 * when the language-server workspace-symbol provider returns no results — most
 * commonly during cold starts before the LSP has finished indexing. It is
 * intentionally simple: it finds the **first** byte offset of `symbol` in the
 * raw document text and converts it to a VS Code `Position`.
 *
 * @param symbol   - The symbol name string to search for within the file text.
 * @param filePath - Absolute filesystem path of the file to scan.
 *
 * @returns A promise that resolves to the VS Code `Position` of the first
 *   occurrence of `symbol` in the file, or `undefined` if the string is not
 *   found. The position points to the start of the matched substring.
 *
 * @remarks
 * **Side effects**: calls `vscode.workspace.openTextDocument`, which loads the
 * file into the VS Code document cache if it is not already open.
 *
 * Because this is a raw substring match (not a token-aware search), it may
 * return false positives — for example, matching the symbol name inside a
 * comment or string literal. Callers should treat the result as a best-effort
 * hint rather than a definitive declaration location.
 */
/**
 * Adjusts a position returned by the workspace symbol provider so it lands on
 * the symbol identifier token rather than the start of the declaration line.
 *
 * LSP commands like `prepareCallHierarchy` require the cursor to be on the
 * identifier itself (e.g. the `g` of `getDirs`), not on a leading keyword like
 * `export` or `function`. The workspace symbol provider returns `range.start`
 * which points to the beginning of the whole declaration, so we scan the line
 * from that column forward to find the first occurrence of the symbol name.
 */
async function pinToSymbolName(
  symbol: string,
  uri: vscode.Uri,
  fallback: vscode.Position
): Promise<vscode.Position> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lineText = doc.lineAt(fallback.line).text;
    const col = lineText.indexOf(symbol, fallback.character);
    if (col !== -1) return new vscode.Position(fallback.line, col);
  } catch { /* fall through */ }
  return fallback;
}

async function findDeclarationInFile(
  symbol: string,
  filePath: string
): Promise<vscode.Position | undefined> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundaryRegex = new RegExp('\\b' + escapedSymbol + '\\b');
  const lineCount = doc.lineCount;
  for (let i = 0; i < lineCount; i++) {
    const lineText = doc.lineAt(i).text;
    const match = wordBoundaryRegex.exec(lineText);
    if (match) {
      return new vscode.Position(i, match.index);
    }
  }
  return undefined;
}

/**
 * Returns the trimmed source text of a single line from an already-open VS
 * Code text document.
 *
 * MCP tool responses include a human-readable `preview` field alongside raw
 * location data so that Claude Code can display context without performing an
 * additional file read. This function supplies that preview text by looking up
 * the document in VS Code's in-memory document cache and extracting the
 * requested line.
 *
 * The lookup is intentionally limited to documents that are **already open**
 * in the workspace cache (`vscode.workspace.textDocuments`). No file I/O is
 * performed, keeping this function synchronous-friendly and safe to call in
 * tight result-mapping loops.
 *
 * @param uri  - The VS Code `Uri` identifying the document to look up. Must
 *               match an entry already present in
 *               `vscode.workspace.textDocuments`; if not found the function
 *               returns an empty string.
 * @param line - Zero-based line number to retrieve from the document.
 *
 * @returns The trimmed text of the requested line, or an empty string if the
 *   document is not currently open in the workspace or if accessing the line
 *   throws (e.g. the line index is out of range for that document).
 *
 * @remarks
 * **Best-effort**: because this function only queries the in-memory document
 * cache, it will silently return `""` for any file that has not yet been
 * opened during the current extension session. Callers must treat an empty
 * return value as "preview unavailable" rather than "the line is blank".
 */
export function getLineText(uri: vscode.Uri, line: number): string {
  try {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    return doc?.lineAt(line).text.trim() ?? '';
  } catch {
    // Doc may not be open in the editor; preview is best-effort
    return '';
  }
}
