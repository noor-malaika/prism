/**
 * @file hover.ts
 *
 * PURE, VS-Code-free hover-parsing logic for the `get_hover` MCP tool.
 *
 * Per the project steering rule, all response-parsing logic that a Prism MCP
 * tool needs is isolated here into a pure function with NO `vscode` import, so
 * it can be unit-tested in isolation from the VS Code host.
 *
 * The `get_hover` tool wrapper (a separate Task) is responsible for calling
 * `vscode.executeHoverProvider`, flattening the resulting `vscode.Hover.contents`
 * (which may be `MarkdownString | MarkedString | string`, singular or an array)
 * into a single plain string, and then handing that string plus the queried
 * symbol name to {@link parseHover}. This keeps every VS Code dependency in the
 * wrapper and every string-parsing decision here, where it is testable without
 * an editor.
 */

/**
 * The normalised shape returned by the `get_hover` tool.
 *
 * @property symbol     - The symbol name the caller asked about, echoed back.
 * @property typeString - The inferred type string extracted from the hover
 *                        text (e.g. `"string | number"`). Empty string when no
 *                        type could be extracted.
 * @property raw        - The raw, flattened hover text exactly as supplied, so
 *                        callers can fall back to the full markdown if the
 *                        extracted `typeString` is insufficient.
 */
export interface HoverResult {
  symbol: string;
  typeString: string;
  raw: string;
}

/**
 * Parses a flattened VS Code hover string into a {@link HoverResult}.
 *
 * VS Code renders a symbol's hover as markdown that, for TypeScript, contains a
 * fenced code block tagged ```` ```typescript ```` (or ```` ```ts ````) holding
 * the symbol's declaration, for example:
 *
 * ```text
 * ```typescript
 * const x: string | number
 * ```
 * ```
 *
 * This function pulls the inferred type — the text after the declaration's
 * top-level `:` (here `"string | number"`) — out of that block. The extraction
 * is deliberately colon-depth-aware: it uses the LAST colon at bracket depth 0
 * so that function signatures (`function f(a: number): string`) yield the
 * return type (`"string"`) rather than a parameter type, while object type
 * literals (`const o: { a: number }`) still yield the whole `{ a: number }`.
 *
 * The function performs NO VS Code API calls and imports nothing from `vscode`;
 * it operates purely on the string it is given.
 *
 * @param raw    - The flattened hover text (markdown) produced by the wrapper.
 * @param symbol - The symbol name that was queried, echoed into the result.
 * @returns A {@link HoverResult} of `{ symbol, typeString, raw }`. `typeString`
 *          is `""` when no type could be extracted; `raw` is always the exact
 *          input string.
 */
export function parseHover(raw: string, symbol: string): HoverResult {
  return {
    symbol,
    typeString: extractTypeString(raw),
    raw,
  };
}

/**
 * Extracts the inferred type substring from flattened hover text.
 *
 * Prefers the contents of the first ```` ```typescript ```` / ```` ```ts ````
 * fenced block; falls back to the whole string when no such block is present.
 * Within that, it returns the text after the last bracket-depth-0 colon.
 */
function extractTypeString(raw: string): string {
  const code = extractFencedCode(raw) ?? raw;
  // Collapse the declaration to a single line so a colon split is unambiguous.
  const decl = code
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");

  const idx = lastTopLevelColonIndex(decl);
  if (idx === -1) {
    return "";
  }
  return decl.slice(idx + 1).trim();
}

/**
 * Returns the trimmed contents of the first TypeScript-tagged fenced code
 * block, or `undefined` when none is present.
 */
function extractFencedCode(raw: string): string | undefined {
  const match = raw.match(/```(?:typescript|ts)[^\n]*\n([\s\S]*?)```/);
  return match ? match[1].trim() : undefined;
}

/**
 * Finds the index of the last `:` that sits at bracket depth 0, i.e. outside
 * any `()`, `[]`, `{}`, or `<>`. This isolates a declaration's type annotation
 * from colons that appear inside parameter lists, object literals, or generics.
 */
function lastTopLevelColonIndex(s: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}" || c === ">") {
      depth--;
    } else if (c === ":" && depth === 0) {
      last = i;
    }
  }
  return last;
}
