import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as realBuildIdentity from "../src/build-identity.ts";
import { loadConfig } from "../src/config.ts";
import { committedWorkspace } from "./support/cli.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";

let activeCompilerIdentity = realBuildIdentity.compilerBuildIdentity();
let identitySpy: { mockRestore(): void } | undefined;

const { resetGraphCaches, scanDependencyGraph } = await import("../src/graph/cruiser.ts");

beforeEach(() => {
  // The scanner receives the behavioral identity from the executable. Changing
  // this test seam models a new executable in the same process without
  // touching tool-owned source bytes or relying on a target/HEAD change.
  identitySpy = spyOn(realBuildIdentity, "compilerBuildIdentity").mockImplementation(() => activeCompilerIdentity);
});

afterEach(() => {
  identitySpy?.mockRestore();
  activeCompilerIdentity = realBuildIdentity.compilerBuildIdentity();
  resetGraphCaches();
  cleanupFixtures();
});

test("behavioral compiler identity invalidates a cached graph", async () => {
  const rootDir = committedWorkspace();
  const { config } = await loadConfig({ cwd: rootDir });
  const first = await scanDependencyGraph({ config, rootDir });
  const newSource = join(rootDir, "apps/web/src/widgets/cache-identity.ts");
  writeFileSync(newSource, "export const cacheIdentity = true;\n");
  activeCompilerIdentity = { artifactIntegrity: "a".repeat(64) };

  const second = await scanDependencyGraph({ config, rootDir });

  expect(first.nodes.has("apps/web/src/widgets/cache-identity.ts")).toBeFalse();
  expect(second.nodes.has("apps/web/src/widgets/cache-identity.ts")).toBeTrue();
});
