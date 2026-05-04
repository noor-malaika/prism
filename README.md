# Prism

A VS Code extension that bridges your workspace language servers to any MCP-capable agent via MCP — giving agents the same semantic understanding your IDE has.

Agents navigating codebases typically rely on grep and tree-sitter heuristics: pattern matching over text. Your VS Code workspace already runs language servers (TypeScript, rust-analyzer, Pylance, …) that maintain a full semantic index — exact types, cross-file references, call graphs, live diagnostics. Prism exposes those capabilities as MCP tools so any agent can query them directly instead of guessing from text.

---

## How it works

Prism runs inside the VS Code extension host. It plays two roles simultaneously:

- **LSP client** — calls `vscode.commands.executeCommand` to delegate to whatever language server is registered for the active language. No custom LSP wire protocol.
- **MCP server** — binds a plain HTTP server to `localhost:7878`. Agents call tools via JSON-RPC 2.0 over `POST /` (`tools/list` to enumerate tools, `tools/call` to invoke them).

```
  Language Servers (TypeScript, rust-analyzer, Pylance, …)
        ↑ LSP wire protocol
  VS Code LSP Client (built-in)
        ↑ vscode.commands.executeCommand(…)
  Prism Extension  ← this repo
        ↑ HTTP POST { tool, params }
  Agent (MCP client)
```

Prism is language-agnostic — any language server registered with VS Code can be queried. Tested with **TypeScript** and **rust-analyzer**.

---

## Tools

| Tool                     | What it does                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| `find_references`      | All locations that reference a symbol, including the declaration site      |
| `go_to_definition`     | Declaration location(s) for a symbol                                       |
| `find_implementations` | Concrete classes or functions implementing an interface or abstract method |
| `get_type`             | Location of the type alias or interface declaration for a symbol           |
| `get_diagnostics`      | Errors and warnings for a file (absolute path required)                    |
| `list_symbols`         | Symbols in the workspace or a single file                                  |
| `get_call_hierarchy`   | Incoming/outgoing call tree up to depth 3                                  |

---

## Installation

1. Install the extension from the VS Code marketplace.
2. Open a workspace. Prism starts automatically and writes an `.mcp.json` file at the workspace root pointing the agent to `http://localhost:7878`.
3. Start your agent in the same workspace. The tools are available immediately.

### Build from source

```bash
npm install
npm run package
```

Then install the `.vsix` via **Extensions: Install from VSIX…** in the command palette.

---

## Configuration

| Key                          | Default           | Description                                                                                                                                                 |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prism.port`               | `7878`          | HTTP port. Auto-increments to 7900 if busy;`.mcp.json` is written with the actual bound port.                                                             |
| `prism.lspRetryCount`      | `10`            | Max retries waiting for the language server before a tool call fails.                                                                                       |
| `prism.lspRetryIntervalMs` | `500`           | Milliseconds between retries.                                                                                                                               |
| `prism.enabledTools`       | all tools         | Which tools to advertise (dispatch enforcement pending — see Known gaps).                                                                                  |
| `prism.agent`              | `"Claude Code"` | Which MCP client to write configuration for.`"Claude Code"` writes `.mcp.json` at the workspace root; `"Github Copilot"` writes `.vscode/mcp.json`. |

---

## Benchmark

Benchmarked using **Claude Code(Sonnet 4.6)** as the agent.

**Repo:** [nestjs/nest](https://github.com/nestjs/nest) — `packages/common/exceptions/intrinsic.exception.ts`

**Task:** Find all implementations of `IntrinsicException` and give a one-line description of what each does.

| Approach                              | Token usage    | Results                                                                                                        |
| ------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| Prism (`find_implementations` tool) | ~1% of context | Correct and complete — returned all 23 implementations with accurate descriptions                             |
| Raw grep                              | ~1% of context | Incomplete — returned only 6 files (direct `extends`/`import` occurrences), missed 17 indirect subclasses |

**What grep missed:** The 17 specific HTTP exception subclasses (`BadRequestException`, `NotFoundException`, `ForbiddenException`, etc.) that extend `HttpException`, which in turn extends `IntrinsicException`. Grep found only the files that directly mention the string `IntrinsicException` — it has no way to traverse the inheritance chain. Prism asked the TypeScript language server, which resolved the full hierarchy.

Both approaches used roughly the same tokens. Prism returned the semantically correct answer; grep returned a structurally incomplete one.


---

## Known gaps

**`get_type` returns a declaration location, not a type string.** `executeTypeDefinitionProvider` gives the location of the type alias or interface, not an inferred type like `string | number`. A `get_hover` tool (not yet implemented) would be the right path for hover-style type info.

**`get_diagnostics` only works for already-open files.** Files that have never been opened in the editor have no diagnostics registered in VS Code's in-memory collection, even if they contain errors. The `file` parameter is required — there is no fallback to the active editor.

**`enabledTools` is not enforced in dispatch.** The config key is declared but `server.ts` does not read it — all 7 tools are always active. Fix pending before stable release.

**`prism.reindex` cannot verify LS readiness.** The command saves all dirty buffers and calls `resetLSReady()` (a no-op — retry logic is stateless), but cannot poll the language server for completion. Readiness is discovered on the next tool call via the retry loop.

**No streaming.** All tool calls are synchronous request/response. Diagnostic changes are not pushed to the agent — it must poll `get_diagnostics` explicitly.

---

## Architecture

See [docs/architecture.md](docs/architecture.md) for a detailed walkthrough of symbol resolution, LSP readiness handling, the retry loop, and each tool's implementation.

---

## License

MIT
