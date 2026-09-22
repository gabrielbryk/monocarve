import { describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { includeCompositionRoots } from "../src/evacuation/index.ts";
import type { DependencyGraph, ModuleNode } from "../src/graph/model.ts";

const root = "apps/api/src/routes.ts";
const service = "apps/api/src/service.ts";
const other = "apps/web/src/routes.ts";
const config = parseConfig({
  applications: [
    { name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json", compositionRoots: [root] },
    { name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json", compositionRoots: [other] },
  ],
  packageRoots: ["libs"],
  packageScope: "@acme/",
  portfolio: { minFiles: 1 },
  scaffoldTemplates: { packageJson: { contents: "{}" } },
});

function graph(): DependencyGraph {
  const nodes = new Map<string, ModuleNode>(
    [root, service, other].map((path) => [
      path,
      {
        path,
        zone: "application",
        application: path.startsWith("apps/api/") ? "api" : "web",
        owner: path.startsWith("apps/api/") ? "apps/api" : "apps/web",
        domain: "core",
        isTest: false,
        isAsset: false,
        isDeclaration: false,
        lineCount: 1,
        hasExports: true,
      },
    ]),
  );
  return {
    rootDir: "/workspace",
    nodes,
    paths: [...nodes.keys()].sort(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
    unresolved: [],
    specifiers: new Map(),
    externalPackages: new Map(),
    externalBySource: new Map(),
    workspaceDependenciesBySource: new Map(),
    unresolvedWorkspaceEdges: [],
    testImporters: new Map(),
    testKinds: new Map(),
    workspace: { files: [], owners: [], packageNames: new Map() },
  };
}

describe("evacuation composition-root inclusion", () => {
  test("canonicalizes repeatable exact selected roots", () => {
    expect(includeCompositionRoots(config, graph(), "api", [service, root], [root, root])).toEqual([root]);
  });

  test("refuses unselected, non-composition, cross-application, and broad paths", () => {
    expect(() => includeCompositionRoots(config, graph(), "api", [service], [root])).toThrow(/outside the selected evacuation/);
    expect(() => includeCompositionRoots(config, graph(), "api", [service], [service])).toThrow(/exactly name a configured composition root/);
    expect(() => includeCompositionRoots(config, graph(), "api", [other], [other])).toThrow(/crosses application/);
    expect(() => includeCompositionRoots(config, graph(), "api", [root], ["apps/api/src"])).toThrow(/exactly name a configured composition root/);
  });
});
