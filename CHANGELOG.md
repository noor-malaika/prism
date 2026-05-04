# Changelog

## 0.1.0-beta.1 — 2026-05-04

Initial beta release for feedback.

### Added
- MCP server exposing 7 LSP tools: `find_references`, `go_to_definition`, `find_implementations`, `get_type`, `get_diagnostics`, `list_symbols`, `get_call_hierarchy`
- Auto-writes MCP discovery config for Claude Code (`.mcp.json`) and GitHub Copilot (`.vscode/mcp.json`)
- `prism.reindex` command to force LSP reindex
- Configurable port, retry count, and retry interval

### Known gaps
- `prism.enabledTools` setting is declared but not yet enforced — all 7 tools are always active
- `get_type` returns the location of the type declaration, not an inferred type string
