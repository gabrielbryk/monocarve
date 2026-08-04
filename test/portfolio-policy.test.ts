/**
 * `portfolio.protectedPaths` is a hard policy boundary. A failure looks like a
 * ranked/selected candidate still carrying a path its repository said must not
 * move, or a prefix match accidentally blocking a similarly named sibling.
 */

import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, parseConfig, type MonocarveConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import type { DependencyGraph } from "../src/graph/model.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");
const CHART = "apps/web/src/widgets/chart.ts";
const CHART_TEST = "apps/web/src/widgets/chart.test.ts";
const CHART_ASSET = "apps/web/src/widgets/chart.css";

let loaded: { readonly config: MonocarveConfig; readonly graph: DependencyGraph } | undefined;

async function fixture(): Promise<{ readonly config: MonocarveConfig; readonly graph: DependencyGraph }> {
  if (loaded) return loaded;
  const { config } = await loadConfig({ cwd: FIXTURE });
  const graph = await scanDependencyGraph({ config, rootDir: FIXTURE, noCache: true });
  loaded = { config, graph };
  return loaded;
}

function withProtectedPaths(config: MonocarveConfig, protectedPaths: readonly string[]): MonocarveConfig {
  return parseConfig({ ...config, portfolio: { ...config.portfolio, protectedPaths } }, "<policy fixture>");
}

async function chartCandidate(config: MonocarveConfig) {
  const { graph } = await fixture();
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.files.includes(CHART));
  if (!candidate) throw new Error("fixture no longer produces the chart candidate");
  return candidate;
}

describe("portfolio protected-path policy", () => {
  test("default policy preserves the previously eligible top candidate", async () => {
    const { config, graph } = await fixture();
    const portfolio = buildPortfolio({ config, graph });
    const chart = await chartCandidate(config);

    expect(config.portfolio.protectedPaths).toEqual([]);
    expect(chart.eligible).toBe(true);
    expect(portfolio.selected[0]).toBe(chart.id);
  });

  test("hard-rejects the top candidate and selects the next eligible candidate", async () => {
    const { config, graph } = await fixture();
    const protectedConfig = withProtectedPaths(config, [CHART]);
    const portfolio = buildPortfolio({ config: protectedConfig, graph });
    const chart = await chartCandidate(protectedConfig);

    expect(chart.eligible).toBe(false);
    expect(chart.rejectionReasons).toContainEqual({
      code: "protected-path",
      detail: "1 movable path(s) are protected by portfolio.protectedPaths",
      edges: [CHART],
    });
    expect(portfolio.selected).not.toContain(chart.id);
    expect(portfolio.selected).toHaveLength(1);
    expect(portfolio.candidates.find((entry) => entry.id === portfolio.selected[0])?.application).toBe("api");
  });

  test("matches an exact file or directory boundary, never a similarly named sibling", async () => {
    const { config } = await fixture();
    const exact = await chartCandidate(withProtectedPaths(config, [CHART]));
    const descendant = await chartCandidate(withProtectedPaths(config, ["apps/web/src/widgets"]));
    const sibling = await chartCandidate(withProtectedPaths(config, ["apps/web/src/widget"]));

    expect(exact.rejectionReasons.find((reason) => reason.code === "protected-path")?.edges).toEqual([CHART]);
    expect(descendant.rejectionReasons.find((reason) => reason.code === "protected-path")?.edges).toEqual([
      CHART_ASSET,
      CHART_TEST,
      CHART,
    ]);
    expect(sibling.rejectionReasons.some((reason) => reason.code === "protected-path")).toBe(false);
    expect(sibling.eligible).toBe(true);
  });

  test.each([CHART_TEST, CHART_ASSET])("rejects a travelling movable path: %s", async (path) => {
    const { config } = await fixture();
    const chart = await chartCandidate(withProtectedPaths(config, [path]));
    const reason = chart.rejectionReasons.find((entry) => entry.code === "protected-path");

    expect(reason).toEqual({
      code: "protected-path",
      detail: "1 movable path(s) are protected by portfolio.protectedPaths",
      edges: [path],
    });
    expect(chart.eligible).toBe(false);
  });
});
