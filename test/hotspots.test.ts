import { expect, test } from "bun:test";

import type { DependencyGraph } from "../src/graph/model.ts";
import { analyzeCouplingHotspots } from "../src/portfolio/hotspots.ts";
import type { Portfolio, PortfolioCandidate } from "../src/portfolio/types.ts";

function candidate(id: string, files: string[], lineCount: number, domains: string[]): PortfolioCandidate {
  return { id, application: "web", suggestedPackageName: `@acme/${id}`, files, tests: [], assets: [], sccs: [], seed: { id, members: [files[0]!] }, lineCount, owners: ["apps/web"], domains, dependencies: [], consumers: [], consumerChurn: 0, coverage: 0, score: lineCount, eligible: true, rejectionReasons: [], warnings: [], rewriteEscapes: [], recommendation: { status: domains.length > 1 ? "discouraged" : "recommended", cohesion: domains.length > 1 ? "low" : "high", reasons: [], requiresExplicitPackageName: false, highInboundModules: [], targetOptions: [] } };
}

test("ranks a high-inbound cross-domain module above leaf modules", () => {
  const paths = ["apps/web/src/context.ts", "apps/web/src/a.ts", "apps/web/src/b.ts"];
  const graph = { paths, nodes: new Map(paths.map((path) => [path, { path, zone: "application", owner: "apps/web", application: "web", domain: "web", lineCount: 10 }])), incoming: new Map([[paths[0], Array.from({ length: 9 }, (_, index) => `consumer-${index}`)]]), outgoing: new Map([[paths[0], [paths[1], paths[2]]]]), edges: [], testImporters: new Map(), workspace: { owners: [], packageNames: new Map() }, rootDir: "/repo" } as unknown as DependencyGraph;
  const candidates = [candidate("large", paths, 5000, ["admin", "routes"]), candidate("leaf", [paths[1]!], 100, ["admin"])];
  const portfolio = { rootDir: "/repo", candidates, selected: [], equivalenceGroups: candidates.map((item) => ({ id: `g-${item.id}`, representativeId: item.id, candidateIds: [item.id], sharedFileCount: item.files.length, similarity: 1 })) } satisfies Portfolio;
  expect(analyzeCouplingHotspots(graph, portfolio)[0]).toMatchObject({ path: paths[0], suggestedAction: "split-capabilities", largestClosureLines: 5000 });
});

test("breaks equal-pressure hotspot ties by code unit", () => {
  const paths = ["apps/web/src/a.ts", "apps/web/src/Z.ts"];
  const graph = { paths, nodes: new Map(paths.map((path) => [path, { path, zone: "application", owner: "apps/web", application: "web", domain: "web", lineCount: 10 }])), incoming: new Map(), outgoing: new Map(), edges: [], testImporters: new Map(), workspace: { owners: [], packageNames: new Map() }, rootDir: "/repo" } as unknown as DependencyGraph;
  const candidates = paths.map((path, index) => candidate(`candidate-${index}`, [path], 10, ["web"]));
  const portfolio = { rootDir: "/repo", candidates, selected: [], equivalenceGroups: candidates.map((item) => ({ id: `g-${item.id}`, representativeId: item.id, candidateIds: [item.id], sharedFileCount: 1, similarity: 1 })) } satisfies Portfolio;
  expect(analyzeCouplingHotspots(graph, portfolio).map((entry) => entry.path)).toEqual([
    "apps/web/src/Z.ts",
    "apps/web/src/a.ts",
  ]);
});
