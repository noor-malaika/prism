# Prism MCP

<p align="center"><img src="media/prism-icon.png" alt="Prism icon" width="96" /></p>

**Give your AI agent the same code intelligence your IDE has.**

When an agent navigates your codebase, it guesses: pattern-matching over text with grep and heuristics. Your VS Code workspace already runs language servers (TypeScript, rust-analyzer, Pylance, …) that know the *actual* answer: exact types, full inheritance chains, cross-file references, live diagnostics. Prism bridges those language servers to your agent via MCP so it stops guessing.

---

## Why it matters

Here's a concrete example from the NestJS repo. The task is the same in both runs, but the prompts are deliberately different:

- Baseline prompt: *"Find all implementations of `IntrinsicException` without using any MCP tool."*
- Prism prompt: *"Use Prism MCP to find all implementations of `IntrinsicException`."*

| Approach | Results |
| --- | --- |
| grep | 6 files (only direct `extends`/`import` occurrences) |
| Prism `find_implementations` | 23 implementations, full inheritance chain resolved |

Grep found the files that mention the string. Prism asked the TypeScript language server, which traversed the actual type hierarchy. Both used roughly the same tokens.

[Watch the benchmark walkthrough](https://github.com/user-attachments/assets/e9a2e5c6-8692-43b5-aab9-55a9a9038f28)

---

## Quick start

Prism is a VS Code extension that starts a local MCP server for the workspace you have open. Install it in the same VS Code window where your project is open, then make sure Prism is writing the MCP config for the agent you actually use.

1. Install **Prism MCP** from the VS Code Marketplace.
2. Open the project you want your agent to work on.
3. Prism defaults to Claude Code. If you use Claude Code, leave `prism.agent` as-is.
4. If you use GitHub Copilot, open **Settings**, search for `prism.agent`, and change it to `Github Copilot`.
5. If you changed `prism.agent`, run **Developer: Reload Window** from the command palette so Prism writes the MCP settings file again for the selected agent.

If you prefer JSON, open **Preferences: Open Workspace Settings (JSON)** and set:

```json
{
  "prism.agent": "Claude Code"
}
```

`"Claude Code"` reads `.mcp.json` from the workspace root, while `"Github Copilot"` reads `.vscode/mcp.json`. The setting file must match the agent you are actually using.

6. Restart or reload your agent so it picks up the new MCP server.

### Optional:
If your agent does not see Prism, confirm Prism wrote the right MCP settings file. The file is different for Claude Code and GitHub Copilot:

For Claude Code, check `.mcp.json`:

```json
{
  "mcpServers": {
    "prism": {
      "type": "http",
      "url": "http://localhost:7878"
    }
  }
}
```

For GitHub Copilot, check `.vscode/mcp.json`:

```json
{
  "servers": {
    "prism": {
      "type": "http",
      "url": "http://localhost:7878"
    }
  }
}
```

If port `7878` is busy, Prism auto-increments up to `7900` and writes the actual port into the config file.

### Prompts for Agents

**Now ask your agent to use Prism deliberately. Do not assume it will choose MCP tools on its own.**

Good prompts:

```text
Use Prism MCP to find all references to `createServer` in src/server.ts, then explain which callers need to change.
```

```text
Use Prism MCP, not grep, to find implementations of `AuthProvider`. Start from /absolute/path/to/src/auth/types.ts.
```

```text
Use Prism MCP to check diagnostics for /absolute/path/to/src/extension.ts after your edits.
```

Most Prism tools need the symbol name and the absolute path to a file where that symbol appears. If the agent only has a relative path, ask it to resolve the absolute path first.

---

## Tools

| Tool | What it does |
| --- | --- |
| `find_references` | Every location that references a symbol, including the declaration site |
| `go_to_definition` | Declaration location(s) for a symbol |
| `find_implementations` | Concrete classes or functions implementing an interface or abstract method |
| `get_type` | Location of the type alias or interface declaration for a symbol |
| `get_diagnostics` | Errors and warnings for a file (absolute path required) |
| `list_symbols` | Symbols in the workspace or a single file |
| `get_call_hierarchy` | Incoming/outgoing call tree up to depth 3 |

Works with any language server registered in VS Code. Tested with TypeScript and rust-analyzer.

---

## How it works

Prism runs inside the VS Code extension host and plays two roles:

- **VS Code language-intelligence client**: delegates to language servers via `vscode.commands.executeCommand`. Prism is not a language server and does not implement the LSP wire protocol.
- **MCP server**: binds an HTTP server to `localhost:7878`. Agents call tools via JSON-RPC 2.0 over `POST /`.

```text
  Language Servers (TypeScript, rust-analyzer, Pylance, …)
        ↑ LSP wire protocol
  VS Code LSP Client (built-in)
        ↑ vscode.commands.executeCommand(…)
  Prism Extension  ← this repo
        ↑ HTTP POST { tool, params }
  Agent (MCP client)
```

---

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `prism.port` | `7878` | HTTP port. Auto-increments to 7900 if busy; `.mcp.json` is written with the actual bound port. |
| `prism.lspRetryCount` | `10` | Max retries waiting for the language server before a tool call fails. |
| `prism.lspRetryIntervalMs` | `1000` | Milliseconds between retries. |
| `prism.enabledTools` | all tools | **Not yet implemented.** All 7 tools are always active. See Known gaps. |
| `prism.agent` | `"Claude Code"` | MCP client to configure. `"Claude Code"` writes `.mcp.json` at the workspace root; `"Github Copilot"` writes `.vscode/mcp.json`. |

---

## Known gaps

**`get_type` returns a location, not a type string.** `executeTypeDefinitionProvider` gives the location of the type alias or interface, not an inferred type like `string | number`. A `get_hover` tool would be the right path for that.

**`get_diagnostics` only works for already-open files.** Files never opened in the editor have no diagnostics in VS Code's in-memory collection, even if they contain errors.

**`enabledTools` is not enforced.** The config key is declared but not read — all 7 tools are always active.

**`prism.reindex` cannot verify language server readiness.** The command flushes dirty buffers but can't poll the LS for completion. Readiness is discovered on the next tool call via the retry loop.

**Timeouts.** Tool calls time out after 25 s; the HTTP socket timeout is 30 s.

**No streaming.** All tool calls are synchronous request/response. Diagnostic changes are not pushed; the agent must poll `get_diagnostics`.

---

## Architecture

See [docs/architecture.md](docs/architecture.md) for a walkthrough of symbol resolution, LSP readiness handling, the retry loop, and each tool's implementation.

---

## Contributors

- [Malaika Noor](https://github.com/malaikacode),  author and maintainer

PRs and issues are welcome.

---

## License

MIT
