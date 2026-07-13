import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Import the PURE parser directly — no VS Code host is loaded here. If
// hover.ts ever grew an `import * as vscode`, this import would fail at
// module-load time because `vscode` is only resolvable inside the editor.
import { parseHover } from "../src/tools/hover";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The union-type hover fixture: its text contains `string | number`.
const unionFixture = readFileSync(
  join(__dirname, "fixtures", "hover-union.md"),
  "utf8",
);

describe("parseHover", () => {
  it('parses union type — extracts typeString exactly "string | number"', () => {
    const result = parseHover(unionFixture, "x");
    expect(result.typeString).toBe("string | number");
  });

  it("returns the { symbol, typeString, raw } shape", () => {
    const result = parseHover(unionFixture, "x");
    // Exactly these three keys, nothing more, nothing less.
    expect(Object.keys(result).sort()).toEqual(["raw", "symbol", "typeString"]);
    expect(result.symbol).toBe("x");
    // raw is echoed back verbatim so callers can fall back to full markdown.
    expect(result.raw).toBe(unionFixture);
  });

  it("picks the top-level return-type colon, not a parameter colon", () => {
    // A first-colon split would wrongly yield "number): string"; the correct
    // bracket-depth-aware logic yields the return type "string".
    const fnHover = "```typescript\nfunction foo(a: number): string\n```";
    expect(parseHover(fnHover, "foo").typeString).toBe("string");
  });

  it("returns empty typeString when no type annotation is present", () => {
    expect(
      parseHover('```typescript\nmodule "foo"\n```', "foo").typeString,
    ).toBe("");
  });
});
