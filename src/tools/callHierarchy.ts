/**
 * @file callHierarchy.ts
 *
 * Exposes VS Code's call-hierarchy LSP capability as an MCP tool.
 *
 * In the Prism bridge, each file under `src/tools/` maps to one logical MCP
 * tool.  This file handles the "call hierarchy" tool: given a symbol name (and
 * an optional file hint), it asks the active language server to prepare a call
 * hierarchy for that symbol and then recursively walks callers, callees, or
 * both — up to a configurable depth — returning a plain JSON-serialisable tree
 * that Claude Code can reason about.
 */

import * as vscode from 'vscode';
import { resolveSymbolLocation } from '../resolve';
import { withLSRetry } from '../lsp-ready';

/** Hard cap on recursion depth to prevent exponential LSP fan-out. */
const MAX_DEPTH = 3;

/** Maximum total nodes that may be created across the entire tree walk. */
const MAX_NODES = 100;

/** Shared budget passed by reference so all recursive calls share the counter. */
interface NodesBudget {
  remaining: number;
}

/**
 * A single node in the call-hierarchy tree returned to the MCP client.
 *
 * Nodes are intentionally lightweight — only the information needed for a
 * language model to understand "what calls what and where" is included.
 */
interface CallNode {
  /** Display name of the symbol (function, method, constructor, …). */
  name: string;
  /** Absolute filesystem path of the file that contains the symbol. */
  file: string;
  /** 1-based line number of the symbol's name within that file. */
  line: number;
  /**
   * Symbols that call this node.  Present only when `direction` is
   * `'incoming'` or `'both'` and `depth > 0`.
   */
  callers?: CallNode[];
  /**
   * Symbols that this node calls.  Present only when `direction` is
   * `'outgoing'` or `'both'` and `depth > 0`.
   */
  callees?: CallNode[];
}

/**
 * Result type for {@link getCallHierarchy}, extending the root node array with
 * an optional flag indicating that the node budget was exhausted before the
 * full tree was expanded.
 */
interface CallHierarchyResult {
  nodes: CallNode[];
  /** Present and `true` when the shared nodes budget hit zero mid-walk. */
  truncated?: true;
}

/**
 * Retrieves the call hierarchy for a named symbol and returns it as a tree of
 * {@link CallNode} objects.
 *
 * This is the primary entry-point exposed to the MCP server.  It:
 * 1. Resolves the symbol's document position via {@link resolveSymbolLocation}.
 * 2. Asks VS Code (and the underlying language server) to prepare a
 *    `CallHierarchyItem` at that position.
 * 3. Recursively expands callers, callees, or both via {@link buildNode}.
 *
 * Depth is hard-capped at {@link MAX_DEPTH} and total nodes at
 * {@link MAX_NODES} to prevent exponential LSP fan-out from blocking the MCP
 * HTTP/SSE response stream on large call graphs.
 *
 * @param params - Options controlling which symbol to inspect and how deeply.
 * @param params.symbol - The name of the symbol to look up (e.g. `"myFunction"`).
 * @param params.file - Optional absolute path of the file that contains the
 *   symbol.  Providing this avoids an expensive workspace-wide search when the
 *   caller already knows the file.
 * @param params.direction - Which direction to walk the hierarchy.
 *   - `'incoming'` (default) — expand callers only.
 *   - `'outgoing'` — expand callees only.
 *   - `'both'` — expand both callers and callees.
 * @param params.depth - Maximum number of recursive levels to expand.
 *   Defaults to `1`.  Silently capped at {@link MAX_DEPTH}.
 * @returns A promise that resolves to a {@link CallHierarchyResult} containing
 *   the root node trees and a `truncated` flag if the budget was exhausted.
 *   Returns an empty node array when the language server cannot prepare a call
 *   hierarchy for the symbol (e.g. symbol not found, language not supported).
 */
export async function getCallHierarchy(params: {
  symbol: string;
  file: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
}): Promise<CallHierarchyResult> {
  if (!params.file) {
    throw new Error('file is required: provide the absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts)');
  }
  const { direction = 'incoming', depth = 1 } = params;
  const location = await resolveSymbolLocation(params.symbol, params.file);

  let items: vscode.CallHierarchyItem[] | undefined;
  try {
    items = await withLSRetry(
      () => Promise.resolve(vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
        'vscode.prepareCallHierarchy',
        location.uri,
        location.position
      )),
      (v) => !v || (v as unknown[]).length === 0
    );
  } catch (err) {
    if (String(err).includes('command') || String(err).includes('not found')) {
      return { nodes: [] };
    }
    throw err;
  }

  if (!items?.length) return { nodes: [] };

  const budget: NodesBudget = { remaining: MAX_NODES };
  const cappedDepth = Math.min(depth, MAX_DEPTH);

  const nodes: CallNode[] = [];
  for (const item of items) {
    nodes.push(await buildNode(item, direction, cappedDepth, budget));
  }

  const result: CallHierarchyResult = { nodes };
  if (budget.remaining <= 0) {
    result.truncated = true;
  }
  return result;
}

/**
 * Recursively builds a {@link CallNode} for a single `CallHierarchyItem`.
 *
 * This internal helper is called once per item returned by
 * `vscode.prepareCallHierarchy` and then once per caller/callee at every
 * subsequent level of the tree.  It drives the VS Code built-in commands
 * `vscode.provideCallHierarchyIncomingCalls` and
 * `vscode.provideCallHierarchyOutgoingCalls`, both of which delegate to
 * whatever language server extension is active for the file's language.
 *
 * Uses sequential `for...of` loops instead of `Promise.all` to avoid
 * unbounded concurrent LSP requests that can make VS Code unresponsive.
 *
 * Side effects:
 * - Executes VS Code commands that communicate with the language server over
 *   the LSP protocol; this is I/O-bound and may be slow on large projects.
 * - Decrements `budget.remaining` for every node created.
 *
 * @param item - The VS Code `CallHierarchyItem` to convert into a node.
 * @param direction - Propagated unchanged from {@link getCallHierarchy};
 *   controls whether `callers`, `callees`, or both are fetched at each level.
 * @param depth - Remaining expansion depth.  When `<= 0` the node is returned
 *   without any `callers`/`callees` children, terminating the recursion.
 * @param budget - Shared mutable counter; when `remaining` hits zero, children
 *   are skipped and the node is returned as a leaf.
 * @returns A promise that resolves to a fully expanded {@link CallNode} tree
 *   rooted at `item`, up to the remaining `depth` and `budget`.
 */
async function buildNode(
  item: vscode.CallHierarchyItem,
  direction: 'incoming' | 'outgoing' | 'both',
  depth: number,
  budget: NodesBudget
): Promise<CallNode> {
  budget.remaining--;

  const node: CallNode = {
    name: item.name,
    file: item.uri.fsPath,
    line: item.selectionRange.start.line + 1 // selectionRange targets the symbol name; range includes the full declaration
  };

  // Stop recursing if depth exhausted or node budget consumed.
  if (depth <= 0 || budget.remaining <= 0) return node;

  if (direction === 'incoming' || direction === 'both') {
    try {
      const calls = await withLSRetry(
        //!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
        //--------------------------mark: y is this timing out?--------------------------------
        () => Promise.resolve(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
          'vscode.provideIncomingCalls',
          item
        )),
        (v) => v === null || v === undefined
      );
      node.callers = [];
      for (const c of (calls ?? [])) {
        if (budget.remaining <= 0) break;
        node.callers.push(await buildNode(c.from, direction, depth - 1, budget));
      }
    } catch (err) {
      if (!String(err).includes('command') && !String(err).includes('not found')) throw err;
      node.callers = [];
    }
  }

  if (direction === 'outgoing' || direction === 'both') {
    try {
      const calls = await withLSRetry(
        () => Promise.resolve(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
          'vscode.provideOutgoingCalls',
          item
        )),
        (v) => v === null || v === undefined
      );
      node.callees = [];
      for (const c of (calls ?? [])) {
        if (budget.remaining <= 0) break;
        node.callees.push(await buildNode(c.to, direction, depth - 1, budget));
      }
    } catch (err) {
      if (!String(err).includes('command') && !String(err).includes('not found')) throw err;
      node.callees = [];
    }
  }

  return node;
}
