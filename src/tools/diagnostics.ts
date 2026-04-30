/**
 * @file diagnostics.ts
 *
 * MCP tool that surfaces VS Code language-server diagnostics (errors, warnings,
 * hints, and information messages) to Claude Code over the Prism LSP-to-MCP
 * bridge.  Diagnostics are the canonical way language servers report problems
 * in source files, so exposing them lets Claude Code understand compilation
 * errors, linting violations, and type mismatches without having to run an
 * external build tool.
 */

import * as vscode from 'vscode';
import * as path from 'path';

function resolveFilePath(file: string): string {
  if (path.isAbsolute(file)) return file;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, file) : file;
}

const MAX_DIAGNOSTICS = 50;

/**
 * Retrieves all diagnostics reported by VS Code's language servers for a given
 * file and returns them in a plain, serialisable format suitable for sending
 * over the MCP/SSE transport to Claude Code.
 *
 * Why it exists: VS Code's `vscode.languages.getDiagnostics` API returns rich
 * {@link vscode.Diagnostic} objects that are not JSON-serialisable and contain
 * far more detail than Claude Code needs.  This function acts as the adapter
 * layer — it resolves the correct URI, fetches the raw diagnostics, and maps
 * them to a compact shape that the MCP server can safely forward.
 *
 * Side effects: none — this function is read-only and does not mutate any
 * VS Code state.
 *
 * @param params - Input parameters for the tool call.
 * @param params.file - Absolute filesystem path of the file whose diagnostics
 *   should be returned.  When omitted, the function falls back to the URI of
 *   the currently active text editor, which is the best available guess when
 *   Claude Code does not know which file contains the errors.  If neither
 *   source yields a URI the function returns an empty array.
 * @returns A promise that resolves to an array of diagnostic objects.  Each
 *   object contains:
 *   - `severity` (`string`) — human-readable severity label derived from
 *     {@link vscode.DiagnosticSeverity} (e.g. `"Error"`, `"Warning"`).
 *   - `message` (`string`) — the diagnostic message text.
 *   - `line` (`number`) — 1-based line number where the diagnostic starts.
 *   - `column` (`number`) — 1-based column number where the diagnostic starts.
 *   - `source` (`string | undefined`) — the language server or linter that
 *     produced the diagnostic (e.g. `"eslint"`, `"typescript"`).
 *   - `code` (`string | number | { value: string | number; target: Uri } | undefined`) —
 *     an optional diagnostic code or rule identifier supplied by the source.
 *
 *   Returns an empty array when no URI can be resolved or when the file has no
 *   diagnostics.
 */
export async function getDiagnostics(params: { file?: string }) {
  const uri = params.file
    ? vscode.Uri.file(resolveFilePath(params.file))
    : vscode.window.activeTextEditor?.document.uri; // best guess when CC doesn't know which file has errors

  if (!uri) return [];

  const resolvedFile = uri.fsPath;
  const all = vscode.languages.getDiagnostics(uri);
  const total = all.length;
  const truncated = total > MAX_DIAGNOSTICS;
  const results = all.slice(0, MAX_DIAGNOSTICS).map((d) => ({
    severity: vscode.DiagnosticSeverity[d.severity],
    message: d.message,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    source: d.source,
    code: d.code
  }));
  return { file: resolvedFile, results, total, truncated };
}
