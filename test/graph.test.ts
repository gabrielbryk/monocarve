/**
 * Graph model and layering.
 *
 * These run against synthetic scanner reports rather than a real cruise: the
 * question here is what the model *does* with resolution results — cycles,
 * layers, domain closure, test importers, unresolvable workspace subpaths — and
 * a hand-written report states each shape in two lines instead of a fixture.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { domainFor, ownerFor, parseConfig, type MonocarveConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { buildApplicationGraph } from "../src/graph/components.ts";
import { analyzeLayers } from "../src/graph/layers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");

function config(overrides: Record<string, unknown> = {}): MonocarveConfig {
  return parseConfig({
    applications: [
      { name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json" },
      { name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" },
    ],
    packageRoots: ["libs", "packages"],
    packageScope: "@acme/",
    // This synthetic workspace declares its own test convention. The engine
    // defaults to none: test-path classification is a workspace fact.
    testPathPatterns: ["\\.test\\.ts$"],
    scaffoldTemplates: { packageJson: { contents: "{}" } },
    ...overrides,
  });
}

function graphOf(reports: Record<string, ScanReport>, overrides: Record<string, unknown> = {}) {
  return buildDependencyGraph({ config: config(overrides), rootDir: FIXTURE, reports });
}

describe("dependency model", () => {
  test("condenses cycles and assigns dependency-first layers", () => {
    const graph = graphOf({
      api: {
        modules: [
          { source: "apps/api/src/a/high.ts", dependencies: [{ module: "../low/leaf.ts", resolved: "apps/api/src/low/leaf.ts" }] },
          { source: "apps/api/src/low/leaf.ts", dependencies: [] },
          { source: "apps/api/src/cycle/one.ts", dependencies: [{ module: "./two.ts", resolved: "apps/api/src/cycle/two.ts" }] },
          { source: "apps/api/src/cycle/two.ts", dependencies: [{ module: "./one.ts", resolved: "apps/api/src/cycle/one.ts" }] },
        ],
      },
    });
    const report = analyzeLayers(config(), graph);

    expect(report.summary.applicationSccs).toBe(3);
    expect(report.summary.cyclicSccs).toBe(1);
    expect(report.components.find((entry) => entry.nodes.includes("apps/api/src/low/leaf.ts"))?.layer).toBe(0);
    expect(report.components.find((entry) => entry.nodes.includes("apps/api/src/a/high.ts"))?.layer).toBe(1);
    expect(report.components.find((entry) => entry.nodes.includes("apps/api/src/cycle/one.ts"))?.cyclic).toBe(true);
  });

  test("marks only transitively same-domain files as dependency-closed", () => {
    const graph = graphOf({
      api: {
        modules: [
          { source: "apps/api/src/orders/value.ts", dependencies: [] },
          { source: "apps/api/src/orders/service.ts", dependencies: [{ module: "./value.ts", resolved: "apps/api/src/orders/value.ts" }] },
          { source: "apps/api/src/orders/route.ts", dependencies: [{ module: "../auth/service.ts", resolved: "apps/api/src/auth/service.ts" }] },
          { source: "apps/api/src/auth/service.ts", dependencies: [] },
        ],
      },
    });
    const report = analyzeLayers(config(), graph);
    const orders = report.domains.find((entry) => entry.domain === "api:orders");

    expect(orders?.dependencyClosedFiles).toBe(2);
    expect(orders?.blockedFiles).toEqual(["apps/api/src/orders/route.ts"]);
    expect(orders?.dependencyDomains).toEqual(["api:auth"]);
  });

  test("keeps tests out of the production graph but records them as importers", () => {
    const graph = graphOf({
      api: {
        modules: [
          { source: "apps/api/src/orders/models.ts", dependencies: [] },
          { source: "apps/api/src/orders/models.test.ts", dependencies: [{ module: "./models.ts", resolved: "apps/api/src/orders/models.ts" }] },
        ],
      },
    });

    expect(buildApplicationGraph(graph).nodes).toEqual(["apps/api/src/orders/models.ts"]);
    expect([...(graph.testImporters.get("apps/api/src/orders/models.ts") ?? [])]).toEqual(["apps/api/src/orders/models.test.ts"]);
    expect(graph.testKinds.get("apps/api/src/orders/models.test.ts")).toBe("unit");
  });

  test("records configured mock calls as test importers even when the scanner omits them", () => {
    const graph = graphOf(
      {
        web: {
          modules: [
            { source: "apps/web/src/widgets/chart.ts", dependencies: [] },
            { source: "apps/web/src/widgets/mock-only.test.ts", dependencies: [] },
          ],
        },
      },
      { moduleSpecifierCalls: ["vi.mock"] },
    );

    // The empty synthetic cruiser dependency list proves the configured-call
    // AST inventory, rather than the scanner report, supplies the edge.
    expect([...(graph.testImporters.get("apps/web/src/widgets/chart.ts") ?? [])]).toEqual(["apps/web/src/widgets/mock-only.test.ts"]);
  });

  test("records configured integration and e2e intent outside production nodes", () => {
    const graph = graphOf(
      {
        api: {
          modules: [
            { source: "apps/api/src/orders/models.ts", dependencies: [] },
            { source: "apps/api/src/orders/models.integration.ts", dependencies: [{ module: "./models.ts", resolved: "apps/api/src/orders/models.ts" }] },
            { source: "apps/api/src/orders/models.e2e.ts", dependencies: [{ module: "./models.ts", resolved: "apps/api/src/orders/models.ts" }] },
          ],
        },
      },
      { testPathPatterns: [], testKinds: { unit: [], integration: ["\\.integration\\.ts$"], e2e: ["\\.e2e\\.ts$"] } },
    );
    expect(buildApplicationGraph(graph).nodes).toEqual(["apps/api/src/orders/models.ts"]);
    expect([...graph.testKinds.entries()].sort()).toEqual([
      ["apps/api/src/orders/models.e2e.ts", "e2e"],
      ["apps/api/src/orders/models.integration.ts", "integration"],
    ]);
  });

  test("maps a workspace package specifier the resolver could not follow", () => {
    const graph = graphOf({
      api: {
        modules: [{ source: "apps/api/src/orders/repository.ts", dependencies: [{ module: "@acme/format", resolved: "@acme/format", couldNotResolve: true }] }],
      },
    });

    expect([...(graph.workspaceDependenciesBySource.get("apps/api/src/orders/repository.ts") ?? [])]).toEqual(["libs/format"]);
    expect(graph.unresolvedWorkspaceEdges.map((edge) => edge.toOwner)).toEqual(["libs/format"]);
    // The package really does export that entry, so it is not an unresolved import.
    expect(graph.unresolved).toEqual([]);
  });

  test("reports a workspace subpath the owning package does not export", () => {
    const graph = graphOf({
      api: {
        modules: [
          {
            source: "apps/api/src/orders/repository.ts",
            dependencies: [{ module: "@acme/format/schema", resolved: "@acme/format/schema", couldNotResolve: true }],
          },
        ],
      },
    });
    expect(graph.unresolved).toEqual([{ source: "apps/api/src/orders/repository.ts", specifier: "@acme/format/schema" }]);
  });

  test("classifies type-only, dynamic, and asset edges from the AST", () => {
    const graph = graphOf({
      web: {
        modules: [
          {
            source: "apps/web/src/widgets/chart.ts",
            dependencies: [
              { module: "../types.ts", resolved: "apps/web/src/types.ts" },
              { module: "./chart.css", resolved: "apps/web/src/widgets/chart.css" },
            ],
          },
          { source: "apps/web/src/types.ts", dependencies: [] },
        ],
      },
    });
    const edge = graph.edges.find((candidate) => candidate.to === "apps/web/src/types.ts");
    expect(edge?.kind).toBe("type-only");
    expect(edge?.typeOnly).toBe(true);
    // The asset is not a graph node, so the edge into it is not in the model;
    // assets are discovered by the containment analysis instead.
    expect(graph.nodes.has("apps/web/src/widgets/chart.css")).toBe(false);
  });
});

describe("path classification", () => {
  test("derives owners from configured roots", () => {
    const settings = config();
    expect(ownerFor(settings, "apps/api/src/server.ts")).toBe("apps/api");
    expect(ownerFor(settings, "libs/format/src/index.ts")).toBe("libs/format");
    expect(ownerFor(settings, "packages/db/src/index.ts")).toBe("packages/db");
    expect(ownerFor(settings, "scripts/tool.ts")).toBe("scripts");
  });

  test("derives domains from the path, and from configured patterns when given", () => {
    const derived = config();
    expect(domainFor(derived, "apps/web/src/widgets/chart.ts")).toBe("web:widgets");
    expect(domainFor(derived, "apps/web/src/types.ts")).toBe("web:__root__");

    const nested = config({ portfolio: { nestedDomainRoots: ["components"] } });
    expect(domainFor(nested, "apps/web/src/components/card.tsx")).toBe("web:components");
    expect(domainFor(nested, "apps/web/src/components/governance/card.tsx")).toBe("web:components/governance");

    const configured = config({ portfolio: { domains: [{ name: "browser", patterns: ["^apps/web/"] }] } });
    expect(domainFor(configured, "apps/web/src/widgets/chart.ts")).toBe("browser");
  });
});

describe("fixture workspace", () => {
  test("carries the shapes the engine has to survive", async () => {
    const chart = await Bun.file(join(FIXTURE, "apps/web/src/widgets/chart.ts")).text();
    expect(chart).toContain('import type { Point, Series } from "../types.ts"');
    expect(chart).toContain('import "./chart.css"');
    expect(chart).toContain('from "@acme/format"');

    const barrel = await Bun.file(join(FIXTURE, "libs/format/src/index.ts")).text();
    expect(barrel).toContain('export * from "./number.ts"');

    const lockfile = await Bun.file(join(FIXTURE, "pnpm-lock.yaml")).text();
    expect(lockfile).toContain("importers:");
    expect(lockfile).toContain("  apps/web:");
  });
});
