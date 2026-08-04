import { afterEach, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { resetGraphCaches, scanDependencyGraph } from "../src/graph/index.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";
import { committedWorkspace } from "./support/cli.ts";

afterEach(() => { resetGraphCaches(); cleanupFixtures(); });

test("graph cache identity includes configuration semantics", async () => {
  const rootDir = committedWorkspace();
  const { config } = await loadConfig({ cwd: rootDir });
  const first = await scanDependencyGraph({ config, rootDir });
  const path = "apps/web/src/widgets/chart.ts";
  const changed = {
    ...config,
    portfolio: { ...config.portfolio, domains: [{ name: "configured-chart", patterns: ["widgets/chart\\.ts$"] }] },
  };
  const second = await scanDependencyGraph({ config: changed, rootDir });
  expect(first.nodes.get(path)?.domain).not.toBe("configured-chart");
  expect(second.nodes.get(path)?.domain).toBe("configured-chart");
}, 60_000);

test("parallel scans restore the caller cwd", async () => {
  const firstRoot = committedWorkspace();
  const secondRoot = committedWorkspace();
  const first = await loadConfig({ cwd: firstRoot });
  const second = await loadConfig({ cwd: secondRoot });
  const cwd = process.cwd();
  const [left, right] = await Promise.all([
    scanDependencyGraph({ config: first.config, rootDir: firstRoot, noCache: true }),
    scanDependencyGraph({ config: second.config, rootDir: secondRoot, noCache: true }),
  ]);
  expect(left.rootDir).toBe(firstRoot);
  expect(right.rootDir).toBe(secondRoot);
  expect(process.cwd()).toBe(cwd);
}, 60_000);
