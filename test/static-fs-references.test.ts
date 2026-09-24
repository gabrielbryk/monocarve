/**
 * Unit coverage for the `resolve(import.meta.dir, <literal>)` detector, in
 * isolation from the planning pipeline: both the direct call and the
 * single-parameter helper indirection from the concrete failure this exists
 * to fix, plus the guardrails — a computed argument, and a plain relative
 * string that never passes through `import.meta.dir` at all — that must stay
 * invisible to it.
 */

import { describe, expect, test } from "bun:test";

import { findStaticFsReferences, relativeFsLiteral, rewriteStaticFsReference } from "../src/plan/static-fs-references.ts";

const FILE = "/repo/app/backend/src/leaderboard/facts-routing.test.ts";

describe("findStaticFsReferences", () => {
  test("finds a literal passed through a local read() helper closing over import.meta.dir", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      "",
      'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
      'const routingSource = read("../leaderboard/facts-routing.ts");',
      "",
    ].join("\n");

    const matches = findStaticFsReferences(source, FILE);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.literal).toBe("../leaderboard/facts-routing.ts");
    expect(matches[0]?.resolvedAbsolute).toBe("/repo/app/backend/src/leaderboard/facts-routing.ts");
  });

  test("finds a direct resolve(import.meta.dir, literal) call with no helper indirection", () => {
    const source = ['import { resolve } from "node:path";', "", 'readFileSync(resolve(import.meta.dir, "../leaderboard/facts-routing.ts"), "utf8");', ""].join(
      "\n",
    );
    const matches = findStaticFsReferences(source, FILE);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.literal).toBe("../leaderboard/facts-routing.ts");
  });

  test("ignores a computed argument to the helper", () => {
    const source = [
      'import { resolve } from "node:path";',
      "",
      'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
      "const name = suffix();",
      "const routingSource = read(`../leaderboard/${name}.ts`);",
      "",
    ].join("\n");
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });

  test("ignores resolve(import.meta.dir, literal) when resolve is undeclared anywhere in scope", () => {
    const source = 'readFileSync(resolve(import.meta.dir, "../leaderboard/facts-routing.ts"), "utf8");\n';
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });

  test("ignores a plain relative string that never reaches import.meta.dir", () => {
    const source = 'readFileSync("../leaderboard/facts-routing.ts", "utf8");\n';
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });

  test("ignores a call to a same-shaped helper that never closes over import.meta.dir", () => {
    const source = ["const label = (path: string) => path.toUpperCase();", 'const routingSource = label("../leaderboard/facts-routing.ts");', ""].join("\n");
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });

  test("ignores a call through a parameter that shadows the real helper's name", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      "",
      'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
      'function nested(read: (path: string) => string) { return read("../unrelated.ts"); }',
      "",
    ].join("\n");
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });

  test("ignores a local resolve() that isn't node:path's, even shaped like the real call", () => {
    const source = [
      'import { readFileSync } from "node:fs";',
      "",
      "function resolve(base: string, target: string) { return target; }",
      'readFileSync(resolve(import.meta.dir, "../leaderboard/facts-routing.ts"), "utf8");',
      "",
    ].join("\n");
    expect(findStaticFsReferences(source, FILE)).toHaveLength(0);
  });
});

describe("rewriteStaticFsReference", () => {
  test("splices only the literal, preserving quote style and every other byte", () => {
    const source = [
      'import { resolve } from "node:path";',
      "",
      'const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");',
      "const routingSource = read('../leaderboard/facts-routing.ts');",
      'const other = read("./unrelated.txt");',
      "",
    ].join("\n");
    const donor = "/repo/app/backend/src/leaderboard/facts-routing.ts";
    const rewritten = rewriteStaticFsReference(source, FILE, donor, "../../../libs/leaderboard/src/leaderboard/facts-routing.ts");
    expect(rewritten).toContain("read('../../../libs/leaderboard/src/leaderboard/facts-routing.ts')");
    expect(rewritten).toContain('read("./unrelated.txt")');
  });
});

describe("relativeFsLiteral", () => {
  test("is always forward-slashed and prefixed", () => {
    expect(relativeFsLiteral("app/backend/src/leaderboard/facts-routing.test.ts", "libs/leaderboard/src/leaderboard/facts-routing.ts")).toBe(
      "../../../../libs/leaderboard/src/leaderboard/facts-routing.ts",
    );
    expect(relativeFsLiteral("libs/leaderboard/src/leaderboard/facts-routing.test.ts", "libs/leaderboard/src/leaderboard/facts-routing.ts")).toBe(
      "./facts-routing.ts",
    );
  });
});
