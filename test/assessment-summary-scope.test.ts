import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizedGraphFacts } from "../src/assessment/reports.ts";
import { parseConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

test("selected application summary ignores another application's edges and unresolved imports", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/one/src"), { recursive: true });
  mkdirSync(join(root, "apps/two/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "apps/one/src/main.ts"), "export const one = 1;\n");
  writeFileSync(join(root, "apps/two/src/main.ts"), "export const two = 2;\n");
  writeFileSync(join(root, "apps/two/src/child.ts"), "export const child = 3;\n");
  const config = parseConfig({
    applications: [
      { name: "one", sourceRoot: "apps/one/src", tsconfig: "apps/one/tsconfig.json" },
      { name: "two", sourceRoot: "apps/two/src", tsconfig: "apps/two/tsconfig.json" },
    ],
    packageRoots: ["packages"], packageManager: "bun",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
  const one: ScanReport = { modules: [{ source: "apps/one/src/main.ts", dependencies: [] }] };
  const first = buildDependencyGraph({ config, rootDir: root, reports: { one, two: { modules: [{ source: "apps/two/src/main.ts", dependencies: [] }] } } });
  const second = buildDependencyGraph({ config, rootDir: root, reports: { one, two: { modules: [
    { source: "apps/two/src/main.ts", dependencies: [
      { module: "./child.ts", resolved: "apps/two/src/child.ts", dynamic: true },
      { module: "./missing.ts", couldNotResolve: true },
    ] },
    { source: "apps/two/src/child.ts", dependencies: [] },
  ] } } });
  expect(normalizedGraphFacts(config, first, "one").facts).toEqual(normalizedGraphFacts(config, second, "one").facts);
  expect(normalizedGraphFacts(config, second, "two").facts).toMatchObject({ edges: 1, dynamicImports: 1, unresolvedImports: 1 });
});
