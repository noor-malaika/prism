# Prism Architecture

## 1. What Prism Is

Claude Code (CC) navigates codebases using grep and tree-sitter heuristics: pattern matching over text rather than semantic understanding. Meanwhile, every VS Code workspace already runs one or more language servers (TypeScript, rust-analyzer, Pylance, etc.) that maintain a full semantic index — exact type information, cross-file references, call graphs, and live diagnostics. Prism bridges these two worlds. It is a VS Code extension that acts simultaneously as an LSP client (consuming VS Code's built-in language server APIs) and as an MCP server (exposing those capabilities over HTTP). When CC needs to resolve a symbol, find all callers of a function, or check for type errors, it calls a Prism MCP tool instead of grepping source files — and gets back the same answer the IDE would give a human developer.

Prism is language-agnostic: it wraps VS Code's LSP client infrastructure, so any language server registered with VS Code can be queried. **Tested with TypeScript (bundled with VS Code) and rust-analyzer.** Other servers implementing the standard LSP capabilities (Pylance, pylsp, etc.) should work without changes.

---

## 2. Architecture

### Two-Role Model

The extension plays two roles in the same process:

- **LSP client**: calls `vscode.commands.executeCommand` with standard VS Code command IDs (`vscode.executeReferenceProvider`, `vscode.executeDefinitionProvider`, etc.). VS Code routes these to whichever language server is registered for the active file's language. Prism never speaks the LSP wire protocol directly — it delegates to VS Code's built-in LSP client infrastructure.
- **MCP server**: runs a plain Node.js `http.Server` bound to `localhost` (default port 7878). It speaks JSON-RPC 2.0 over `POST /`: `initialize` for handshake, `tools/list` for the tool manifest, and `tools/call` for tool invocations. `OPTIONS /` is handled for CORS pre-flight; all other methods return `405`. The HTTP layer is intentionally minimal — no framework dependency, no SSE, no authentication beyond the loopback restriction.

### Component Diagram

```
  TypeScript LS
  rust-analyzer         (language servers — external processes)
  Pylance, ...
        ^
        | LSP wire protocol
        v
  VS Code LSP Client    (built into VS Code)
        ^
        | vscode.commands.executeCommand(...)
        v
  Prism Extension       (this codebase — runs in VS Code extension host)
        ^
        | HTTP JSON-RPC 2.0 POST /
        v
  Claude Code           (MCP client — calls tools during agentic tasks)
```

### Request Lifecycle

1. CC decides it needs semantic information and issues an HTTP POST to `http://localhost:7878` with a JSON-RPC 2.0 body: `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "find_references", "arguments": { "symbol": "MyClass", "file": "/path/to/file.ts" } } }`.
2. `PrismMCPServer.handleRequest` parses the body, reads `msg.method`, and for `tools/call` extracts `params.name` and `params.arguments`, then calls `dispatch(toolName, args)`.
3. `dispatch` routes to the appropriate tool function (e.g. `findReferences`).
4. The tool calls `resolveSymbolLocation` to obtain a `{ uri, position }` pair that VS Code commands require.
5. The tool issues `vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position)`.
6. VS Code routes the command to the registered language server; the LS returns `Location[]`.
7. The tool maps the result to a plain JSON-serialisable structure (1-indexed lines/columns, `fsPath` strings, preview text).
8. `dispatch` returns the value; `handleRequest` wraps it as `{ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }` and writes it to the HTTP response.
9. CC receives the JSON and continues its task.

On error at any step, a `500` response with a JSON-RPC 2.0 error object `{ jsonrpc: "2.0", id, error: { code: -32603, message: "..." } }` is returned. Unknown methods return a `200` with an error object using code `-32601`.

---

## 3. Symbol Resolution

Most VS Code LSP commands require a document URI and a cursor position, not a symbol name. `resolveSymbolLocation` in `src/resolve.ts` bridges the gap between the name-based interface CC provides and the position-based interface VS Code requires.

### Resolution Steps

1. **Cold-start activation** — If `hintFile` is provided, `vscode.workspace.openTextDocument(Uri.file(hintFile))` is called first. This loads the document into VS Code's model without opening it visually. Many language servers only activate (and begin indexing) when a file of the target language is opened. Without this step, the workspace symbol provider may return nothing for a freshly opened workspace.
2. **Workspace symbol provider with exact match** — `vscode.executeWorkspaceSymbolProvider` is called with the symbol name. If a `SymbolInformation` with `.name === symbol` exists, it is used immediately.
3. **Proximity-ranked partial match** — If there are results but none match exactly (e.g. overloaded names, symbols from different packages), and a `hintFile` was provided, results are sorted so that any entry whose `uri.fsPath` contains the hint file path ranks first. The top result is returned. Without a hint file the first result is used as-is.
4. **Text fallback** — If the workspace symbol provider returns nothing (LS not yet indexed, or the symbol is private/unexported and not in the provider's index), `findDeclarationInFile` opens the hint file and does a plain `text.indexOf(symbol)` search. This is a last resort: it finds the first textual occurrence, not necessarily a declaration.
5. **Throw** — If all strategies fail, an error is thrown and propagated as a `500` response to CC.

### Why This Matters for CC-Driven Workflows

In normal IDE use, a developer opens files before navigating them — the LS is already warm. CC operates headlessly: it has never opened any file in the editor. Without the `openTextDocument` call in step 1, the first tool call on a cold workspace will hit an unindexed symbol provider and fall through to the text fallback or fail entirely. The `hintFile` parameter (the file where the symbol is declared, which CC often knows from prior grep results) is the mechanism that forces LS activation before resolution is attempted.

---

## 4. LSP Readiness

### No Preflight Check

There is no separate "is the LS ready?" call before tool invocations. Language servers vary in how they signal readiness, and VS Code does not expose a uniform readiness API. A preflight check would either be language-server-specific or unreliable.

### `withLSRetry`

Instead of a preflight, `withLSRetry` (in `src/lsp-ready.ts`) wraps any operation that depends on the LS being indexed:

```typescript
for (let attempt = 0; attempt < maxRetries; attempt++) {
  const result = await op();
  if (!isEmpty(result)) return result;
  await sleep(intervalMs);
}
throw new Error(`Language server not ready after ${maxRetries} attempts`);
```

The caller supplies the operation and an `isEmpty` predicate. If the predicate returns `true` (indicating the LS returned an empty or null result, consistent with not-yet-indexed), the loop sleeps and retries. The loop is stateless: no global flag, no shared readiness cache. This is deliberate — a language server can restart (e.g. after an extension update or OOM kill), invalidating any cached state.

The retry loop is currently used only in `resolveSymbolLocation` around the workspace symbol provider call.

### `reindex` Command

The `prism.reindex` VS Code command:

1. Calls `vscode.workspace.saveAll(false)` — saves all dirty buffers. Many language servers only reindex on save, so this ensures the LS sees the latest source.
2. Calls `resetLSReady()` — currently a no-op. The function exists as a named intent boundary: if state is added to the readiness module in the future, `reindex` already calls the reset point. For now, its value is saving all files, not resetting any state.

The command cannot verify that the LS has actually finished reindexing. Readiness is demonstrated on the next tool call, which will either succeed or begin retrying.

### Config Knobs

| Key | Default | Effect |
| --- | --- | --- |
| `prism.lspRetryCount` | 10 | Maximum number of retry attempts in `withLSRetry` before throwing |
| `prism.lspRetryIntervalMs` | 500 | Milliseconds to sleep between attempts |

With defaults, a tool call will wait up to 5 seconds for the LS to return a non-empty result before failing. Increase `lspRetryCount` for large monorepos where initial indexing takes longer.

---

## 5. Tool Reference

| Tool                     | VS Code command                                                                                                             | Key params                                                                                  | Notes                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `find_references`      | `vscode.executeReferenceProvider`                                                                                         | `symbol` (required), `file` (required)                                                  | Returns all reference locations including the declaration site; lines are 1-indexed                          |
| `go_to_definition`     | `vscode.executeDefinitionProvider`                                                                                        | `symbol` (required), `file` (required)                                                  | Returns declaration location(s); multiple results possible for merged declarations                           |
| `find_implementations` | `vscode.executeImplementationProvider`                                                                                    | `symbol` (required), `file` (required)                                                  | Finds concrete classes/functions implementing an interface or abstract method                                |
| `get_type`             | `vscode.executeTypeDefinitionProvider`                                                                                    | `symbol` (required), `file` (required)                                                  | Returns the location of the type alias or interface declaration, not an inferred type string; see Known Gaps |
| `get_diagnostics`      | `vscode.languages.getDiagnostics`                                                                                         | `file` (required)                                                                         | Reads the diagnostic collection for a specific URI; no fallback to active editor                             |
| `list_symbols`         | `vscode.executeWorkspaceSymbolProvider` (workspace) / `vscode.executeDocumentSymbolProvider` (file)                     | `query` (required), `scope` (required), `file` (required when `scope=file`)          | `scope=file` requires `file`; file-scope results are flattened recursively from the document symbol tree |
| `get_call_hierarchy`   | `vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`, `vscode.provideOutgoingCalls` | `symbol` (required), `file` (required), `direction` (incoming/outgoing/both), `depth` (default 1, max 3) | Builds a recursive `CallNode` tree; depth is capped at 3 and total nodes at 100 to avoid runaway recursion |

---

## 6. Configuration Reference

| Key | Type | Default | When to Change |
| --- | --- | --- | --- |
| `prism.port` | number | `7878` | Change if 7878 is in use by another process; the extension will auto-increment up to 7900 if the preferred port is busy, but the MCP config file is written with the actual bound port |
| `prism.agent` | string | `"Claude Code"` | Controls which MCP config file is written. `"Claude Code"` writes `.mcp.json` at the workspace root (key `mcpServers`). `"Github Copilot"` writes `.vscode/mcp.json` (key `servers`), creating the directory if needed. |
| `prism.enabledTools` | array | all 7 tools | Intended to restrict which tools are advertised and dispatched; currently not enforced in dispatch (see Known Gaps) |
| `prism.lspRetryCount` | number | `10` | Increase for large monorepos or slow machines where LS indexing takes more than 5 seconds on first call |
| `prism.lspRetryIntervalMs` | number | `500` | Decrease for faster feedback in well-tuned environments; increase if aggressive polling causes LS instability |

---

## 7. Known Gaps

**`get_type` returns a declaration location, not a type string.** `executeTypeDefinitionProvider` returns the location of the type alias or interface declaration for a symbol. It does not return the inferred type string (e.g. `string | number`) that a hover tooltip would show. To get hover-style type information, a `vscode.executeHoverProvider` call would be needed and its Markdown output parsed — not yet implemented.

**`get_diagnostics` only works for already-open files.** `vscode.languages.getDiagnostics(uri)` reads diagnostics from VS Code's in-memory diagnostic collection. A file that has never been opened in the editor will have no diagnostics registered, even if it contains errors. The `file` parameter is required — the tool no longer falls back to the active editor. Workspace-wide diagnostics require either opening all files programmatically or relying on a language server that populates diagnostics for closed files (behaviour varies by LS).

**`list_symbols` with `scope=file` may return empty for freshly created files.** `executeDocumentSymbolProvider` depends on the language server having parsed and indexed the file. A file that was just created and saved may not yet be in the LS index. Waiting a moment and retrying, or calling `prism.reindex`, is the workaround.

**`prism.reindex` cannot verify LS readiness.** The command saves all files and calls `resetLSReady()` (currently a no-op). It does not poll the LS for completion or provide any signal that reindexing has finished. The next tool call will discover readiness through `withLSRetry`.

**No SSE or streaming support.** All tool calls are synchronous request/response. Diagnostic changes are not pushed to CC as they occur — CC must poll `get_diagnostics` explicitly. The MCP HTTP server does not implement Server-Sent Events.(way too advanced, what good is it gonna do apart from burning bunch of tokens?)

**`enabledTools` is not enforced in dispatch.** The `prism.enabledTools` configuration key is declared in `package.json` and will be written to workspace settings, but `dispatch` in `server.ts` does not read it. All 7 tools are always active regardless of this setting.(bad bad, needs a patch before the first release)

---

## 8. Extension Points

**`get_hover`**: Would call `vscode.executeHoverProvider(uri, position)` and return the Markdown content from the hover result; this is the correct path to expose inferred type strings and documentation comments that `get_type` currently cannot provide.

**Streaming diagnostics**: Would require adding an SSE endpoint to the HTTP server and subscribing to `vscode.languages.onDidChangeDiagnostics` to push diagnostic change events to connected clients without polling.

**Rename preview**: Would use `vscode.executeDocumentRenameProvider(uri, position, newName)` to compute a `WorkspaceEdit` diff across all affected files, returning the proposed changes for CC to inspect before committing them.


todos:

whats the hardcoded version in handlerequest in server file doing, being an extension, the version should be declared at the project scope and then referenced in all other places
