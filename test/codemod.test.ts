/**
 * Codemod and public-surface correctness.
 *
 * This is the floor the whole tool stands on: if a specifier can be missed, or
 * rewritten with a byte out of place, or an export can be inferred that does
 * not exist, then every proof above it is proving the wrong thing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inventoryModuleReferences, rewriteResolvedImportSpecifier, unsupportedModuleReferences, applyEscapeRewrites } from "../src/codemod/imports.ts";
import { sourceExportsFromBaseline, sourceExportsFromFile } from "../src/plan/public-surface.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";

const scratch: string[] = [];

function scratchFile(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "monocarve-codemod-"));
  scratch.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
  cleanupFixtures();
});

describe("module reference inventory", () => {
  test("inventories dynamic, CommonJS, and type-position references", () => {
    const source = [
      'const lazy = import("./helpers");',
      'const value = require("./helpers.js");',
      'const path = require.resolve("./helpers");',
      'type Row = import("./helpers").TimingEntry;',
    ].join("\n");
    const references = inventoryModuleReferences(source, "/workspace/apps/api/src/service.ts");

    expect(references.map((reference) => reference.kind)).toEqual(["dynamic-import", "require", "require-resolve", "import-type"]);
    expect(references.every((reference) => reference.supported)).toBe(true);
    expect(references.filter((reference) => reference.dynamic)).toHaveLength(1);
  });

  test("reports a computed specifier as unsupported, which is what blocks a plan", () => {
    expect(unsupportedModuleReferences("import(`./${name}`);", "/workspace/apps/api/src/service.ts")).toHaveLength(1);
    expect(unsupportedModuleReferences('import "./static.ts";', "/workspace/apps/api/src/service.ts")).toHaveLength(0);
  });

  test("inventories only config-declared module-specifier calls", () => {
    const source = ['vi.mock("./helpers", () => ({}));', 'custom.mock("./ignored", () => ({}));', "vi.mock(`./${name}`);"].join("\n");
    const references = inventoryModuleReferences(source, "/workspace/apps/api/src/service.test.ts", false, "/workspace", ["vi.mock"]);

    expect(references.map(({ kind, specifier, supported }) => ({ kind, specifier, supported }))).toEqual([
      { kind: "configured-call", specifier: "./helpers", supported: true },
      { kind: "configured-call", specifier: null, supported: false },
    ]);
  });
});

describe("resolution boundary", () => {
  test("ignores a tsconfig above the analyzed root", () => {
    // Not hypothetical: simulation worktrees default to a directory under the
    // system temp directory, so a stray `/tmp/tsconfig.json` would otherwise
    // decide how the tree under analysis resolves its own imports.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "monocarve-boundary-")));
    scratch.push(outside);
    const root = join(outside, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(outside, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "outside/*": ["repo/src/*"] } } }));
    writeFileSync(join(root, "src", "target.ts"), "export const value = 1;\n");
    const importer = join(root, "src", "service.ts");
    const source = 'import { value } from "outside/target";\n';
    writeFileSync(importer, source);

    expect(inventoryModuleReferences(source, importer, true, root).map((reference) => reference.resolved)).toEqual([null]);
    // The same specifier does resolve when nothing bounds the walk. That is what
    // makes the assertion above a proof rather than a specifier that was never
    // going to resolve — and, because it runs second, it also proves the
    // boundary reaches the resolution cache key.
    expect(inventoryModuleReferences(source, importer).map((reference) => reference.resolved)).toEqual([join(root, "src", "target.ts")]);
  });
});

describe("import rewriting", () => {
  test("rewrites a config-declared mock call with byte-level fidelity", () => {
    const directory = mkdtempSync(join(tmpdir(), "monocarve-mock-rewrite-"));
    scratch.push(directory);
    writeFileSync(join(directory, "helpers.ts"), "export const value = 1;\n");
    const importer = join(directory, "service.test.ts");
    const source = 'vi.mock("./helpers", () => ({ value: 2 }));\n';

    expect(rewriteResolvedImportSpecifier(source, importer, join(directory, "helpers.ts"), "@acme/helpers", directory, ["vi.mock"])).toBe(
      'vi.mock("@acme/helpers", () => ({ value: 2 }));\n',
    );
  });

  test("rewrites a tsconfig path alias after its donor has been removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "monocarve-alias-rewrite-"));
    scratch.push(directory);
    mkdirSync(join(directory, "src", "features", "agent-graph"), { recursive: true });
    writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#/*": ["./src/*"] } } }));
    const donor = join(directory, "src", "features", "agent-graph", "graph-schema.ts");
    writeFileSync(donor, "export const value = 1;\n");
    rmSync(donor);
    const importer = join(directory, "src", "consumer.ts");
    const source = 'import { value } from "#/features/agent-graph/graph-schema";\n';

    expect(rewriteResolvedImportSpecifier(source, importer, donor, "@acme/agent-graph", directory)).toBe('import { value } from "@acme/agent-graph";\n');
  });

  test("rewrites a type-position import after the donor has been removed", () => {
    const source = 'type Row = import("./helpers").TimingEntry;\n';
    expect(rewriteResolvedImportSpecifier(source, "/workspace/apps/api/src/service.test.ts", "/workspace/apps/api/src/helpers.ts", "@acme/analytics")).toBe(
      'type Row = import("@acme/analytics").TimingEntry;\n',
    );
  });

  test("rewrites every reference form and touches nothing else", () => {
    // Real files on disk: a `./helpers.js` specifier only resolves to
    // `helpers.ts` through the module resolver, so a synthetic path would test
    // a weaker rewrite than the one that actually runs.
    const directory = mkdtempSync(join(tmpdir(), "monocarve-rewrite-"));
    scratch.push(directory);
    writeFileSync(join(directory, "helpers.ts"), "export const a = 1;\nexport type B = string;\n");
    writeFileSync(join(directory, "unrelated.ts"), "export const u = 1;\n");
    const importer = join(directory, "service.ts");
    const source = [
      "// keep this comment exactly as it is",
      'import { a } from "./helpers";',
      "import type { B } from './helpers.js';",
      'export * from "./helpers";',
      'const lazy = await import("./helpers");',
      'const other = require("./unrelated");',
      "",
    ].join("\n");
    writeFileSync(importer, source);
    const rewritten = rewriteResolvedImportSpecifier(source, importer, join(directory, "helpers.ts"), "@acme/analytics");

    expect(rewritten).toContain("// keep this comment exactly as it is");
    expect(rewritten).toContain('import { a } from "@acme/analytics";');
    // Single quotes stay single quotes: the rewrite is a splice, not a reprint.
    expect(rewritten).toContain("import type { B } from '@acme/analytics';");
    expect(rewritten).toContain('export * from "@acme/analytics";');
    expect(rewritten).toContain('await import("@acme/analytics")');
    expect(rewritten).toContain('require("./unrelated")');
  });

  test("applies escape rewrites in order, relative to the donor's own directory", () => {
    const source = 'import { x } from "../shared/telemetry.ts";\nimport { y } from "./sibling.ts";\n';
    const rewritten = applyEscapeRewrites(source, "/workspace/apps/api/src/widget/donor.ts", [
      { donorlessSpecifier: "../shared/telemetry.ts", packageSpecifier: "@acme/telemetry" },
    ]);
    expect(rewritten).toBe('import { x } from "@acme/telemetry";\nimport { y } from "./sibling.ts";\n');
  });
});

describe("public surface", () => {
  test("preserves aliased type-only exports and rejects export assignment", () => {
    const path = scratchFile("surface.ts", "interface Internal { value: string }\nexport type { Internal as PublicRow };\nexport const value = 1;\n");
    expect(sourceExportsFromFile(path)).toEqual([
      { name: "PublicRow", typeOnly: true },
      { name: "value", typeOnly: false },
    ]);

    const assignment = scratchFile("assignment.ts", "const value = 1;\nexport = value;\n");
    expect(() => sourceExportsFromFile(assignment)).toThrow("unsupported export assignment");
  });

  test("infers default, namespace, export-star, and destructured exports", () => {
    const directory = mkdtempSync(join(tmpdir(), "monocarve-surface-"));
    scratch.push(directory);
    writeFileSync(join(directory, "nested.ts"), "export const nested = 1;\nexport interface NestedType { value: string }\n");
    const path = join(directory, "surface.ts");
    writeFileSync(
      path,
      [
        "const source = { value: 1, other: 2 };",
        "export const { value, other: renamed } = source;",
        "export default source;",
        'export * as namespace from "./nested.ts";',
        'export * from "./nested.ts";',
        "",
      ].join("\n"),
    );

    const exports = sourceExportsFromFile(path);
    expect(exports).toEqual(
      expect.arrayContaining([
        { name: "default", typeOnly: false },
        { name: "namespace", typeOnly: false },
        { name: "value", typeOnly: false },
        { name: "renamed", typeOnly: false },
        { name: "nested", typeOnly: false },
        { name: "NestedType", typeOnly: true },
      ]),
    );
  });

  test("resolves re-export chains from immutable baseline files after the live files disappear", () => {
    const root = fixtureRepo({
      "src/nested.ts": "export const nested = 1;\nexport interface NestedType { value: string }\n",
      "src/surface.ts": 'export * from "./nested.ts";\n',
    });
    const baseline = fixtureGit(root, "rev-parse", "HEAD");
    rmSync(join(root, "src"), { recursive: true });

    expect(sourceExportsFromBaseline(root, baseline, "src/surface.ts")).toEqual([
      { name: "NestedType", typeOnly: true },
      { name: "nested", typeOnly: false },
    ]);
  });

  test("resolves baseline facades through installed package exports", () => {
    const root = fixtureRepo({ "src/surface.ts": 'export * from "@acme/contracts";\n' });
    const baseline = fixtureGit(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "node_modules/@acme/contracts"), { recursive: true });
    writeFileSync(
      join(root, "node_modules/@acme/contracts/package.json"),
      JSON.stringify({ name: "@acme/contracts", type: "module", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(join(root, "node_modules/@acme/contracts/index.ts"), "export interface Contract { value: string }\nexport const contract = 1;\n");

    expect(sourceExportsFromBaseline(root, baseline, "src/surface.ts")).toEqual([
      { name: "Contract", typeOnly: true },
      { name: "contract", typeOnly: false },
    ]);
  });
});
