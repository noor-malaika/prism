/**
 * @file extension.ts
 *
 * VS Code extension entry point for Prism — the LSP-to-MCP bridge.
 *
 * Prism exists to expose VS Code's rich language-server capabilities
 * (go-to-definition, references, diagnostics, call hierarchy, etc.) as an
 * MCP (Model Context Protocol) HTTP/SSE server so that Claude Code can query
 * them while editing code.  This file is the only module that VS Code's
 * extension host knows about directly; everything else is internal
 * implementation detail wired up from here.
 *
 * Lifecycle:
 *   1. VS Code calls {@link activate} when the extension activates.
 *   2. A {@link PrismMCPServer} is created and bound to a port.
 *   3. `.mcp.json` in the workspace root is updated so Claude Code
 *      automatically discovers the running server.
 *   4. VS Code calls {@link deactivate} (or the subscription dispose) when
 *      the extension is unloaded, cleanly stopping the HTTP server.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PrismMCPServer } from './server';
import { resetLSReady } from './lsp-ready';

let server: PrismMCPServer | undefined;

// VS Code calls `activate` automatically on extension load; it is the single required entry point defined in package.json#activationEvents
/**
 * Activates the Prism extension.
 *
 * This is the mandatory VS Code extension entry point, referenced in
 * `package.json#main` and triggered by the activation events declared in
 * `package.json#activationEvents`.  It is responsible for:
 *
 * - Reading the user-configured port from VS Code settings (`prism.port`).
 * - Creating and starting the {@link PrismMCPServer} HTTP/SSE server.
 * - Writing (or updating) `.mcp.json` in the workspace root so Claude Code
 *   picks up the server address without manual configuration.
 * - Registering the `prism.reindex` command, which forces all open editors to
 *   save and resets the LSP-ready gate so the next MCP tool call will wait for
 *   the language server to settle before responding.
 * - Pushing a disposal handle onto `context.subscriptions` so the server is
 *   cleanly stopped when VS Code deactivates the extension.
 *
 * **Side effects:**
 * - Binds a TCP port (default 7878, overridable via `prism.port` setting).
 * - Writes or mutates `.mcp.json` in the first workspace folder.
 * - Displays transient status-bar messages and, on error, modal error/warning
 *   notifications.
 * - Registers the disposable command `prism.reindex` into the VS Code command
 *   palette.
 *
 * @param context - The extension context provided by VS Code.  Used to push
 *   disposables that are automatically cleaned up on deactivation.
 */
export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('prism');
  const port = config.get<number>('port', 7878);
  const agent = config.get<string>('agent', 'Claude Code');

  server = new PrismMCPServer(port);
  // start() is async because port binding is non-blocking; actualPort may differ from `port` if the preferred port was in use
  server.start()
    .then((actualPort) => {
      injectMCPConfig(actualPort, agent).then((writtenPath) => {
        vscode.window.setStatusBarMessage(`Prism MCP :${actualPort} → ${writtenPath}`, 5000);
      }).catch((err) => {
        vscode.window.showWarningMessage(`Prism: failed to write MCP config — ${err.message}`);
      });
      vscode.window.setStatusBarMessage(`Prism MCP running on :${actualPort}`, 3000);
    })
    .catch((err: Error) => {
      vscode.window.showErrorMessage(`Prism: could not start MCP server — ${err.message}`);
    });

  // subscriptions ensures VS Code calls dispose() on each item when the extension is deactivated, preventing resource leaks
  context.subscriptions.push(
    { dispose: () => server?.stop() },
    // withProgress was removed: reindex is near-instant (saveAll + state reset), so a progress spinner added noise without value
    vscode.commands.registerCommand('prism.reindex', async () => {
      try {
        // saveAll ensures the LSP sees up-to-date file contents before the index is invalidated
        await vscode.workspace.saveAll(false);
        // resetLSReady is called after saveAll so the LSP has already flushed diagnostics for clean files
        resetLSReady();
        vscode.window.setStatusBarMessage('Prism: index reset — next tool call will wait for LSP', 3000);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Prism: reindex failed — ${message}`);
      }
    })
  );
}

/**
 * Deactivates the Prism extension.
 *
 * VS Code calls this function when the extension is unloaded (e.g. the window
 * closes, the extension is disabled, or VS Code shuts down).  It is a
 * secondary teardown path — the primary path is the dispose handle pushed onto
 * `context.subscriptions` inside {@link activate}.  Both paths call
 * `server.stop()`, which is idempotent, so calling it twice is safe.
 *
 * **Side effects:**
 * - Stops the HTTP/SSE server and releases the bound TCP port.
 */
export function deactivate() {
  server?.stop();
}

/**
 * Writes (or updates) the workspace `.mcp.json` file so Claude Code
 * automatically discovers the Prism MCP server.
 *
 * This function exists because Claude Code reads `.mcp.json` from the
 * workspace root to learn which MCP servers are available.  Without this
 * file (or with a stale port), Claude Code would not connect to Prism even
 * though the server is running.  Injecting it programmatically means users
 * never have to configure the URL manually.
 *
 * The function merges the `prism` entry into any pre-existing `mcpServers`
 * map so that other tools already registered in `.mcp.json` are preserved.
 * If the file does not yet exist it is created from scratch.
 *
 * **Side effects:**
 * - Reads and then overwrites (or creates) `<workspaceRoot>/.mcp.json`.
 * - No-ops silently if there are no workspace folders open.
 *
 * @param port - The actual TCP port the {@link PrismMCPServer} bound to.
 *   This may differ from the user-configured `prism.port` setting if that
 *   port was already in use.
 * @returns A promise that resolves once the file has been written, or rejects
 *   with a filesystem error (the caller surfaces this as a VS Code warning
 *   message).
 */
async function injectMCPConfig(port: number, agent: string): Promise<string> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error('no workspace folder open — open a folder in VS Code so Prism knows where to write the MCP config');
  }

  const useVSCodeMCP = agent === 'Github Copilot';
  const configDir = useVSCodeMCP ? path.join(workspaceRoot, '.vscode') : workspaceRoot;
  const mcpPath = path.join(configDir, useVSCodeMCP ? 'mcp.json' : '.mcp.json');

  if (useVSCodeMCP) {
    await fs.mkdir(configDir, { recursive: true });
  }

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
  } catch { /* file doesn't exist yet */ }

  const serverKey = useVSCodeMCP ? 'servers' : 'mcpServers';
  const existingServers = (config[serverKey] as object) ?? {};

  // Preserve existing MCP server registrations while adding/updating Prism.
  config[serverKey] = {
    ...existingServers,
    prism: { type: 'http', url: `http://localhost:${port}` }
  };

  const tmpPath = mcpPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  try {
    await fs.rename(tmpPath, mcpPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => { /* ignore secondary cleanup errors */ });
    throw err;
  }
  return mcpPath;
}
