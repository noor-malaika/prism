/**
 * @file server.ts
 *
 * Core HTTP/MCP server for the Prism VS Code extension.
 *
 * Prism bridges VS Code's Language Server Protocol (LSP) capabilities to the
 * Model Context Protocol (MCP) so that Claude Code can query live language
 * intelligence (definitions, references, diagnostics, etc.) from inside the
 * editor.  This file is responsible for:
 *
 *  1. Declaring the MCP tool catalogue (`TOOL_SCHEMAS`) that Claude Code reads
 *     on startup to discover available tools.
 *  2. Hosting a lightweight HTTP server (`PrismMCPServer`) that accepts tool
 *     calls as JSON POST requests, routes them to the matching LSP helper, and
 *     returns the result.
 *  3. Auto-incrementing the listen port on `EADDRINUSE` so the extension
 *     survives port collisions without user intervention.
 */
import * as http from 'http';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: pkgVersion } = require('../package.json') as { version: string };
import { findReferences } from './tools/references';
import { goToDefinition, getTypeDefinition } from './tools/definition';
import { findImplementations } from './tools/implementations';
import { getDiagnostics } from './tools/diagnostics';
import { listSymbols } from './tools/symbols';
import { getCallHierarchy } from './tools/callHierarchy';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LSP timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

type ToolName =
  | 'find_references'
  | 'go_to_definition'
  | 'find_implementations'
  | 'get_type'
  | 'get_diagnostics'
  | 'list_symbols'
  | 'get_call_hierarchy';

const TOOL_SCHEMAS = [
  {
    name: 'find_references',
    description: 'Find all references to a symbol using the active language server. Always provide the absolute file path — the LSP cannot resolve the symbol without it.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name (e.g. "MyComponent", "handleClick")' },
        file: { type: 'string', description: 'Absolute path of the file that contains the symbol (e.g. /home/user/project/src/foo.ts). Required — do not omit.' }
      },
      required: ['symbol', 'file']
    }
  },
  {
    name: 'go_to_definition',
    description: 'Find the declaration site of a symbol. Always provide the absolute file path — the LSP cannot resolve the symbol without it.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name' },
        file: { type: 'string', description: 'Absolute path of the file that contains the symbol. Required — do not omit.' }
      },
      required: ['symbol', 'file']
    }
  },
  {
    name: 'find_implementations',
    description: 'Find all concrete implementations of an interface or abstract method. Always provide the absolute file path — the LSP cannot resolve the symbol without it.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name' },
        file: { type: 'string', description: 'Absolute path of the file that declares the interface or abstract method. Required — do not omit.' }
      },
      required: ['symbol', 'file']
    }
  },
  {
    name: 'get_type',
    description: 'Get the type definition of a symbol — navigates to the type/interface declaration, not the value binding. Use instead of go_to_definition when you need the type shape, not the implementation. Always provide the absolute file path.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name' },
        file: { type: 'string', description: 'Absolute path of the file that contains the symbol. Required — do not omit.' }
      },
      required: ['symbol', 'file']
    }
  },
  {
    name: 'get_diagnostics',
    description: 'Get current compiler errors and warnings for a file. Provide the absolute file path.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute path of the file to check (e.g. /home/user/project/src/foo.ts). Required.' }
      },
      required: ['file']
    }
  },
  {
    name: 'list_symbols',
    description: 'Search for symbols across the workspace or within a specific file. When scope is "file", the absolute file path is required.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or partial name to search for' },
        scope: { type: 'string', enum: ['workspace', 'file'], description: '"file" searches only within the given file; "workspace" searches all open project files' },
        file: { type: 'string', description: 'Absolute path of the file to search within. Required when scope is "file".' }
      },
      required: ['query', 'scope']
    }
  },
  {
    name: 'get_call_hierarchy',
    description: 'Get the incoming and/or outgoing call hierarchy for a symbol. Always provide the absolute file path — the LSP cannot resolve the symbol without it.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name (e.g. "Dashboard", "fetchData")' },
        file:   { type: 'string', description: 'Absolute path of the file that contains the symbol (e.g. /home/user/project/src/components/Dashboard.tsx). Required — do not omit.' },
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], default: 'incoming', description: '"incoming" = who calls this symbol; "outgoing" = what this symbol calls; "both" = full graph' },
        depth:  { type: 'number', default: 1, description: 'Recursion depth (1–3). Default 1.' }
      },
      required: ['symbol', 'file']
    }
  }
];

/**
 * The MCP-over-HTTP server that exposes VS Code LSP capabilities as callable
 * tools for Claude Code.
 *
 * A single instance is created by the extension's `activate` function and kept
 * alive for the lifetime of the VS Code session.  It listens on localhost only
 * so that only processes on the same machine can reach it — no network exposure.
 *
 * Responsibilities:
 *  - Serve the MCP discovery endpoint (`GET /`) so Claude Code can enumerate
 *    available tools on connection.
 *  - Accept tool-invocation requests (`POST /`) from Claude Code, delegate them
 *    to the appropriate LSP helper, and return the result as JSON.
 *  - Handle CORS pre-flight (`OPTIONS`) to support browser-based MCP clients.
 *  - Auto-increment the listen port when the preferred port is already in use.
 */
export class PrismMCPServer {
  // httpServer is a field so both start() and stop() can reference the same instance across calls
  private httpServer: http.Server;
  // actualPort is tracked separately because EADDRINUSE auto-increment may land on a different port than the constructor arg
  private actualPort: number;

  /**
   * Creates a new `PrismMCPServer` but does NOT start listening yet.
   *
   * The underlying `http.Server` is created eagerly so that event handlers can
   * be attached before `start()` is called, but the port is bound only when
   * `start()` resolves.
   *
   * @param port - The preferred TCP port to listen on (e.g. `7878`).  If the
   *   port is already in use, `start()` will increment this value until a free
   *   port is found (up to 7900).
   */
  constructor(private port: number) {
    this.actualPort = port;
    this.httpServer = http.createServer(this.handleRequest.bind(this));
  }

  /**
   * Binds the HTTP server to localhost and begins accepting connections.
   *
   * If the preferred port is already in use (`EADDRINUSE`), the method
   * transparently retries with the next port number up to a ceiling of 7900.
   * This allows multiple VS Code windows to each run their own Prism instance
   * without conflicting.
   *
   * Side effects:
   *  - Mutates `this.port` while searching for a free port.
   *  - Mutates `this.actualPort` to reflect the port that was ultimately bound.
   *  - The extension writes `this.actualPort` to VS Code workspace state so that
   *    the companion Claude Code MCP config can point to the correct URL.
   *
   * @returns A promise that resolves with the actual TCP port number that was
   *   bound.  Rejects if no free port is found below 7900, or if any non-EADDRINUSE
   *   OS error occurs.
   */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.setTimeout(30_000);
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        const addr = this.httpServer.address();
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(this.actualPort);
      });
      const attachErrorHandler = () => {
        this.httpServer.once('error', (err: NodeJS.ErrnoException) => {
          // 7900 is a reasonable ceiling: staying close to 7878 avoids colliding with well-known ports while limiting unbounded search
          if (err.code === 'EADDRINUSE' && this.port < 7900) {
            this.port++;
            // close() must complete before listen() can be called again on the same server instance
            this.httpServer.close(() => {
              attachErrorHandler();
              this.httpServer.listen(this.port, '127.0.0.1');
            });
          } else {
            reject(err);
          }
        });
      };
      attachErrorHandler();
    });
  }

  /**
   * Gracefully shuts down the HTTP server, stopping it from accepting new
   * connections.
   *
   * Called by the extension's `deactivate` hook so that the OS port is freed
   * promptly when VS Code closes or the extension is disabled, rather than
   * waiting for Node's GC to release it.
   *
   * Side effects:
   *  - In-flight requests are allowed to complete before the server fully closes
   *    (standard Node.js `http.Server.close` behaviour).
   */
  stop() {
    this.httpServer.close();
  }

  /**
   * Node.js `http.Server` request handler — the single entry point for all
   * inbound HTTP traffic on the Prism MCP server.
   *
   * Implements the minimal HTTP surface that Claude Code's MCP client expects:
   *
   * | Method  | Path | Behaviour                                                 |
   * |---------|------|-----------------------------------------------------------|
   * | GET     | /    | Returns MCP server metadata + full tool catalogue (JSON). |
   * | OPTIONS | *    | Responds with 204 for CORS pre-flight.                    |
   * | POST    | /    | Parses `{ tool, params }` body and dispatches to LSP tool.|
   * | other   | *    | Returns 405 Method Not Allowed.                           |
   *
   * All responses include permissive CORS headers so that browser-hosted MCP
   * clients can also connect without additional proxy configuration.
   *
   * Side effects:
   *  - Writes the HTTP response directly to `res`.
   *  - On POST, awaits `dispatch`, which in turn awaits VS Code LSP APIs.
   *
   * @param req - The incoming HTTP request from Node's built-in `http` module.
   * @param res - The server response object used to send the reply.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, cors);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let id: unknown = null;
    try {
      const body = await readBody(req);
      const msg = JSON.parse(body) as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
      id = msg.id ?? null;
      const method = msg.method;

      if (method === 'initialize') {
        res.writeHead(200, cors);
        res.end(JSON.stringify({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'prism', version: pkgVersion },
            capabilities: { tools: {} }
          }
        }));
        return;
      }

      if (method === 'notifications/initialized') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      if (method === 'tools/list') {
        res.writeHead(200, cors);
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOL_SCHEMAS } }));
        return;
      }

      if (method === 'tools/call') {
        const p = msg.params as { name?: unknown; arguments?: unknown } | undefined;
        const toolName = p?.name;
        const toolArgs = p?.arguments;
        if (typeof toolName !== 'string' || !toolName) {
          res.writeHead(400, cors);
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing or invalid tool name' } }));
          return;
        }
        const args = (typeof toolArgs === 'object' && toolArgs !== null ? toolArgs : {}) as Record<string, unknown>;
        const result = await withTimeout(this.dispatch(toolName as ToolName, args), 25_000, toolName);
        res.writeHead(200, cors);
        res.end(JSON.stringify({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
        }));
        return;
      }

      // Unknown method
      res.writeHead(200, cors);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }));
    } catch (err) {
      res.writeHead(500, cors);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } }));
    }
  }

  /**
   * Routes a validated MCP tool call to the correct LSP helper function.
   *
   * This is the central switching table that maps every tool name advertised in
   * `TOOL_SCHEMAS` to its concrete implementation in `./tools/*`.  Keeping the
   * mapping in one place makes it easy to add, remove, or rename tools without
   * touching request-handling logic.
   *
   * Important: the `get_type` case calls `getTypeDefinition` (not
   * `goToDefinition`).  An earlier version aliased the two by mistake; the
   * comment in the source preserves the rationale for the correction.
   *
   * @param tool   - One of the string literals defined in the `ToolName` union;
   *                 guaranteed to be valid by `handleRequest`'s JSON parse.
   * @param params - Arbitrary key/value bag parsed from the POST body.  Each
   *                 branch casts `params` to the precise shape expected by the
   *                 target helper — no runtime validation is performed here.
   * @returns      A promise that resolves with the tool result object, whose
   *               shape is determined by the individual LSP helper.
   * @throws       An `Error` with message `"Unknown tool: <name>"` if `tool`
   *               does not match any case (should be unreachable in practice).
   */
  private async dispatch(tool: ToolName, params: Record<string, unknown>) {
    switch (tool) {
      case 'find_references':      return findReferences(params as { symbol: string; file: string });
      case 'go_to_definition':     return goToDefinition(params as { symbol: string; file: string });
      case 'find_implementations': return findImplementations(params as { symbol: string; file: string });
      // get_type previously aliased go_to_definition by mistake; it now correctly calls getTypeDefinition for type-declaration lookup
      case 'get_type':             return getTypeDefinition(params as { symbol: string; file: string });
      case 'get_diagnostics':      return getDiagnostics(params as { file?: string });
      case 'list_symbols':         return listSymbols(params as { query: string; scope: 'workspace' | 'file'; file?: string });
      case 'get_call_hierarchy':   return getCallHierarchy(params as { symbol: string; file: string; direction?: 'incoming' | 'outgoing' | 'both'; depth?: number });
      default: throw new Error(`Unknown tool: ${String(tool)}`);
    }
  }
}

/**
 * Collects all data chunks from a Node.js `IncomingMessage` stream and returns
 * the complete request body as a UTF-8 string.
 *
 * Extracted as a standalone function (rather than inlined inside
 * `handleRequest`) for two reasons:
 *  1. It can be unit-tested independently with a mock stream.
 *  2. It keeps `handleRequest` focused on request routing rather than I/O
 *     mechanics.
 *
 * @param req - The raw Node.js HTTP request stream to drain.
 * @returns   A promise that resolves with the full body string once the stream
 *            emits `"end"`, or rejects with the stream error if `"error"` fires
 *            first.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const MAX_BYTES = 1_048_576; // 1 MB
    let data = '';
    let byteLength = 0;
    req.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > MAX_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
