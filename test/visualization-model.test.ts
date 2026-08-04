import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { loadConfig } from "../src/config.ts";
import type { DependencyGraph, ModuleEdge, ModuleNode } from "../src/graph/index.ts";
import { scanDependencyGraph } from "../src/graph/index.ts";
import { projectVisualizationGraph } from "../src/visualization/model.ts";

const records: readonly ModuleNode[] = [
  node("apps/web/src/a.ts", "ui", 10),
  node("apps/web/src/b.ts", "ui", 20),
  node("apps/web/src/c.ts", "data", 30),
];
const edges: readonly ModuleEdge[] = [
  edge("apps/web/src/a.ts", "apps/web/src/b.ts", "static"),
  edge("apps/web/src/b.ts", "apps/web/src/a.ts", "type-only"),
  edge("apps/web/src/a.ts", "apps/web/src/c.ts", "static"),
  edge("apps/web/src/b.ts", "apps/web/src/c.ts", "type-only"),
];

describe("dependency graph visualization projection", () => {
  test("collapses SCCs and aggregates exact cross-component edge evidence", () => {
    const result = projectVisualizationGraph(graph(records, edges));
    const cycle = result.nodes.find((entry) => entry.members.length === 2)!;
    const leaf = result.nodes.find((entry) => entry.members.length === 1)!;

    expect(cycle).toMatchObject({ cyclic: true, lineCount: 30, domains: ["ui"], layer: 1 });
    expect(leaf).toMatchObject({ cyclic: false, lineCount: 30, domains: ["data"], layer: 0 });
    expect(result.edges).toEqual([{ id: `${cycle.id}->${leaf.id}`, from: cycle.id, to: leaf.id, kinds: ["static", "type-only"], count: 2 }]);
  });

  test("is byte-deterministic when map and edge insertion order change", () => {
    const forward = projectVisualizationGraph(graph(records, edges));
    const reverse = projectVisualizationGraph(graph([...records].reverse(), [...edges].reverse()));
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
  });

  test("projects the real synthetic workspace scanner result", async () => {
    const rootDir = resolve(import.meta.dir, "../fixtures/basic-monorepo");
    const { config } = await loadConfig({ cwd: rootDir });
    const scanned = await scanDependencyGraph({ config, rootDir, noCache: true });
    const result = projectVisualizationGraph(scanned);

    expect(result.generatedFrom.modules).toBe(5);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });
});

function node(path: string, domain: string, lineCount: number): ModuleNode {
  return { path, zone: "application", application: "web", owner: "apps/web", domain, isTest: false, isAsset: false, isDeclaration: false, lineCount, hasExports: true };
}

function edge(from: string, to: string, kind: ModuleEdge["kind"]): ModuleEdge {
  return { from, to, kind, specifier: `./${to.slice(to.lastIndexOf("/") + 1)}`, typeOnly: kind === "type-only", dynamic: false };
}

function graph(nodes: readonly ModuleNode[], inputEdges: readonly ModuleEdge[]): DependencyGraph {
  const sortedNodes = [...nodes].sort((left, right) => left.path.localeCompare(right.path));
  const paths = sortedNodes.map((entry) => entry.path);
  const outgoing = new Map(paths.map((path) => [path, inputEdges.filter((edge) => edge.from === path).map((edge) => edge.to).sort()]));
  const incoming = new Map(paths.map((path) => [path, inputEdges.filter((edge) => edge.to === path).map((edge) => edge.from).sort()]));
  return {
    rootDir: "/workspace", commit: "a".repeat(40), nodes: new Map(nodes.map((entry) => [entry.path, entry])), paths,
    edges: inputEdges, outgoing, incoming, unresolved: [], specifiers: new Map(), externalPackages: new Map(),
    externalBySource: new Map(), workspaceDependenciesBySource: new Map(), unresolvedWorkspaceEdges: [],
    testImporters: new Map(), testKinds: new Map(), workspace: {} as DependencyGraph["workspace"],
  };
}
