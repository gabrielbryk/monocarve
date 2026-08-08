import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { buildEvacuationCandidate } from "../src/evacuation/index.ts";
import type { DependencyGraph, ModuleEdge, ModuleNode } from "../src/graph/model.ts";

const APP = "apps/api/src";
const path = (name: string): string => `${APP}/${name}.ts`;
const alpha = path("alpha");
const beta = path("beta");
const shared = path("shared");
const cycleA = path("cycle-a");
const cycleB = path("cycle-b");
const consumer = path("consumer");
const route = path("route");
const pkg = "libs/runtime/src/index.ts";

const config = parseConfig({
  applications: [{
    name: "api",
    sourceRoot: APP,
    tsconfig: "apps/api/tsconfig.json",
    compositionRoots: [route],
  }],
  packageRoots: ["libs"],
  packageScope: "@acme/",
  portfolio: { minFiles: 1 },
  scaffoldTemplates: { packageJson: { contents: "{}" } },
});

function edge(from: string, to: string, specifier = `./${to.split("/").at(-1)}`): ModuleEdge {
  return { from, to, specifier, kind: "static", typeOnly: false, dynamic: false };
}

function graph(paths: readonly string[], edges: readonly ModuleEdge[], tests: ReadonlyMap<string, ReadonlySet<string>> = new Map()): DependencyGraph {
  const nodes = new Map<string, ModuleNode>();
  for (const item of paths) {
    const isPackage = item.startsWith("libs/");
    nodes.set(item, {
      path: item,
      zone: isPackage ? "package" : "application",
      ...(isPackage ? {} : { application: "api" }),
      owner: isPackage ? "libs/runtime" : "apps/api",
      domain: "api:core",
      isTest: false,
      isAsset: false,
      isDeclaration: false,
      lineCount: 10,
      hasExports: true,
    });
  }
  const adjacency = (reverse: boolean): Map<string, string[]> => {
    const result = new Map<string, Set<string>>();
    for (const item of edges) {
      const from = reverse ? item.to : item.from;
      const to = reverse ? item.from : item.to;
      const values = result.get(from) ?? new Set<string>();
      values.add(to);
      result.set(from, values);
    }
    return new Map([...result].map(([key, values]) => [key, [...values].sort()]));
  };
  return {
    rootDir: "/workspace",
    nodes,
    paths: [...paths].sort(),
    edges,
    outgoing: adjacency(false),
    incoming: adjacency(true),
    unresolved: [],
    specifiers: new Map(),
    externalPackages: new Map(),
    externalBySource: new Map(),
    workspaceDependenciesBySource: new Map([[alpha, new Set(["libs/runtime"])]]),
    unresolvedWorkspaceEdges: [],
    testImporters: tests,
    testKinds: new Map(),
    workspace: { files: [pkg], owners: ["libs/runtime"], packageNames: new Map([["@acme/runtime", "libs/runtime"]]) },
  };
}

describe("evacuation candidate unions", () => {
  test("deduplicates selected SCCs and aggregates package and consumer provenance", () => {
    const testPath = `${APP}/alpha.test.ts`;
    const dependencyGraph = graph(
      [alpha, beta, shared, cycleA, cycleB, consumer, pkg],
      [edge(alpha, shared), edge(beta, shared), edge(shared, cycleA), edge(cycleA, cycleB), edge(cycleB, cycleA), edge(consumer, shared), edge(alpha, pkg, "@acme/runtime")],
      new Map([[alpha, new Set([testPath])]]),
    );

    const candidate = buildEvacuationCandidate({
      config,
      graph: dependencyGraph,
      application: "api",
      selected: [beta, cycleA, shared, alpha, alpha],
    });

    expect(candidate.files).toEqual([alpha, beta, cycleA, cycleB, shared]);
    expect(candidate.absorbedSccPeers).toEqual([cycleB]);
    expect(candidate.unselectedDependencies).toEqual([]);
    expect(candidate.sccs.find((scc) => scc.members.includes(cycleA))?.members).toEqual([cycleA, cycleB]);
    expect(candidate.dependencies).toEqual(["@acme/runtime"]);
    expect(candidate.consumers).toEqual([
      { file: testPath, owner: "apps/api", specifiers: [], external: false },
      { file: consumer, owner: "apps/api", specifiers: ["./shared.ts"], external: false },
    ]);
  });

  test("absorbs a selected member's whole SCC and records deterministic seed provenance", () => {
    const dependencyGraph = graph([cycleA, cycleB], [edge(cycleA, cycleB), edge(cycleB, cycleA)]);
    const first = buildEvacuationCandidate({ config, graph: dependencyGraph, application: "api", selected: [cycleB] });
    const second = buildEvacuationCandidate({ config, graph: dependencyGraph, application: "api", selected: [cycleB, cycleB] });

    expect(first.files).toEqual([cycleA, cycleB]);
    expect(first.absorbedSccPeers).toEqual([cycleA]);
    expect(first.seedSccs).toEqual(first.sccs);
    expect(first.id).toMatch(/^e-[a-f0-9]{12}$/);
    expect(second).toEqual(first);
  });

  test("retains an entire composition-root SCC while moving its dependency closure", () => {
    const routePeer = path("route-peer");
    const dependencyGraph = graph(
      [route, routePeer, shared],
      [edge(route, routePeer), edge(routePeer, route), edge(route, shared)],
    );
    const candidate = buildEvacuationCandidate({ config, graph: dependencyGraph, application: "api", selected: [route, shared] });

    expect(candidate.files).toEqual([shared]);
    expect(candidate.absorbedSccPeers).toEqual([]);
    expect(candidate.retainedComposition).toHaveLength(1);
    expect(candidate.retainedComposition[0]?.members).toEqual([routePeer, route]);
    expect(candidate.seedSccs).toContainEqual(candidate.retainedComposition[0]!);
    expect(candidate.consumers).toEqual([
      { file: route, owner: "apps/api", specifiers: ["./shared.ts"], external: false },
    ]);
  });

  test("does not absorb unselected application dependencies", () => {
    const service = path("estimating/service");
    const database = path("db/client");
    const infrastructure = path("infra/secrets");
    const dependencyGraph = graph(
      [service, database, infrastructure],
      [edge(service, database, "../../db/client.ts"), edge(service, infrastructure, "../../infra/secrets.ts")],
    );

    const candidate = buildEvacuationCandidate({ config, graph: dependencyGraph, application: "api", selected: [service] });

    expect(candidate.files).toEqual([service]);
    expect(candidate.absorbedSccPeers).toEqual([]);
    expect(candidate.unselectedDependencies).toEqual([database, infrastructure]);
  });
});
