import { expect, test } from "bun:test";

import type { DependencyGraph } from "../src/graph/model.ts";
import { analyzeLazyRegistry } from "../src/portfolio/lazy-registry.ts";
import type { Portfolio, PortfolioCandidate } from "../src/portfolio/types.ts";

test("maps only compiler-resolved dynamic entries to candidate targets", () => {
  const source = "apps/web/src/registry.ts";
  const target = "apps/web/src/admin/page.ts";
  const graph = {
    nodes: new Map([
      [source, { domain: "registry", lineCount: 10 }],
      [target, { domain: "admin", lineCount: 200 }],
    ]),
    edges: [
      { from: source, to: target, kind: "dynamic", specifier: "./admin/page", dynamic: true },
      { from: source, to: "apps/web/src/eager.ts", kind: "static", specifier: "./eager", dynamic: false },
    ],
  } as unknown as DependencyGraph;
  const candidate = { id: "admin", files: [target], suggestedPackageName: "@acme/admin" } as unknown as PortfolioCandidate;
  const portfolio = { candidates: [candidate] } as unknown as Portfolio;
  expect(analyzeLazyRegistry(graph, portfolio, source)).toEqual([
    {
      source,
      specifier: "./admin/page",
      resolvedPath: target,
      domain: "admin",
      lineCount: 200,
      candidateIds: ["admin"],
      suggestedPackageNames: ["@acme/admin"],
    },
  ]);
});
