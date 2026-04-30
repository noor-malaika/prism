/**
 * @file lsp-ready.ts
 *
 * Provides stateless retry utilities for Language Server Protocol (LSP) operations
 * within the Prism LSP-to-MCP bridge. Because VS Code's language servers start
 * asynchronously and can crash and restart at any time during a session, MCP tool
 * handlers must tolerate a temporarily unavailable LSP rather than failing
 * immediately. This module centralises that "wait for LSP to respond" logic so
 * every tool (definition, references, diagnostics, etc.) gets consistent retry
 * behaviour without duplicating polling loops.
 *
 * Design note: all retry state is intentionally ephemeral — there is no cached
 * "ready" flag — so that a post-crash LSP restart is automatically detected on
 * the next MCP invocation without any manual reset step.
 */

import * as vscode from 'vscode';

/**
 * Executes an LSP operation with automatic polling-retry until the operation
 * returns a non-empty result or the configured retry budget is exhausted.
 *
 * WHY THIS EXISTS: VS Code language servers (TypeScript, Pylance, rust-analyzer,
 * etc.) load asynchronously after a workspace opens. An MCP tool request that
 * arrives before the server is ready will receive an empty array/null from the
 * VS Code LSP APIs rather than an error. `withLSRetry` wraps those calls so that
 * Prism transparently waits for the LSP to become responsive instead of returning
 * misleadingly empty results to Claude Code.
 *
 * The retry parameters are read from VS Code settings on **every call** (no
 * caching) so that a user can tweak `prism.lspRetryCount` or
 * `prism.lspRetryIntervalMs` mid-session and have the change take effect
 * immediately without restarting the extension.
 *
 * There is deliberately no cached "LSP is ready" flag: if the language server
 * crashes and restarts, a stale flag would prevent retries for the newly-started
 * server, causing silent failures. Stateless polling avoids that class of bug.
 *
 * @template T - The type returned by the LSP operation (e.g. `vscode.Location[]`).
 *
 * @param op - An async factory that invokes the underlying VS Code LSP API and
 *   returns its raw result. Called once per attempt.
 * @param isEmpty - A predicate that returns `true` when `op`'s result should be
 *   treated as "LSP not ready yet" and retried. Typically checks for an empty
 *   array (`v => v.length === 0`) or a null/undefined value.
 *
 * @returns A promise that resolves to the first non-empty result returned by
 *   `op` within the retry budget.
 *
 * @throws {Error} If every attempt returns an empty result, throws with a
 *   human-readable message that includes the number of attempts made and advises
 *   the caller to retry — because the next call will start fresh from attempt 0.
 *
 * @example
 * // Used inside a Prism MCP tool handler:
 * const locations = await withLSRetry(
 *   () => vscode.commands.executeCommand<vscode.Location[]>(
 *     'vscode.executeDefinitionProvider', uri, position
 *   ),
 *   (v) => !v || v.length === 0
 * );
 */
export async function withLSRetry<T>(
  op: () => Promise<T>,
  isEmpty: (v: T) => boolean
): Promise<T> {
  // Re-read on every call so setting changes are picked up immediately
  const config = vscode.workspace.getConfiguration('prism');
  const maxRetries = config.get<number>('lspRetryCount', 10);
  const intervalMs = config.get<number>('lspRetryIntervalMs', 1000);

  // No caching: LSP can crash and restart mid-session, so a cached "ready" flag would suppress retries after a crash
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await op();
    if (!isEmpty(result)) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  // "try again" is intentional: because there is no stale cache, the next invocation will retry fresh from attempt 0
  throw new Error(
    `Language server not ready after ${maxRetries} attempts — try again in a moment`
  );
}

/**
 * Nominal reset hook for the LSP-readiness subsystem.
 *
 * WHY THIS EXISTS: When Prism triggers a workspace reindex (e.g. the user runs
 * the "Prism: Reindex Workspace" command), other subsystems may call
 * `resetLSReady` as a clear signal that the LSP should be considered
 * temporarily unavailable again. Because the retry design in `withLSRetry` is
 * fully stateless, no bookkeeping is actually required here — the next call to
 * `withLSRetry` will automatically poll from scratch. The function therefore
 * exists purely as a named, importable symbol that communicates *intent* in the
 * call-site code without coupling callers to implementation details of the retry
 * strategy.
 *
 * **This function is intentionally a no-op.** The retry logic in `withLSRetry`
 * is stateless — no gate needs resetting between reindex cycles. Do not add
 * state-reset logic here; doing so would couple callers to implementation
 * details and risk suppressing retries after a crash-restart cycle.
 *
 * Side effects: none.
 *
 * @returns `void`
 */
export function resetLSReady(): void {
  // no-op: retry logic is stateless, this exists so reindex can signal intent
}
