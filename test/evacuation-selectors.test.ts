import { describe, expect, test } from "bun:test";

import {
  EvacuationSelectorError,
  resolveEvacuationSelectors,
} from "../src/evacuation/index.ts";
import type { DependencyGraph, ModuleNode } from "../src/graph/model.ts";

const backend = [
  "apps/backend/src/erp/client.ts",
  "apps/backend/src/erp/http/request.ts",
  "apps/backend/src/erp-next/client.ts",
  "apps/backend/src/shared.ts",
];
const frontend = ["apps/frontend/src/erp/client.ts"];
const packages = ["libs/erp/src/index.ts"];

function graph(paths: readonly string[] = [...backend, ...frontend, ...packages]): DependencyGraph {
  const nodes = new Map<string, ModuleNode>();
  for (const path of paths) {
    const application = path.startsWith("apps/backend/")
      ? "backend"
      : path.startsWith("apps/frontend/") ? "frontend" : undefined;
    nodes.set(path, {
      path,
      zone: application ? "application" : "package",
      ...(application ? { application } : {}),
      owner: application ? `apps/${application}` : "libs/erp",
      domain: "erp",
      isTest: false,
      isAsset: false,
      isDeclaration: false,
      lineCount: 1,
      hasExports: true,
    });
  }
  return {
    rootDir: "/workspace",
    nodes,
    paths: [...paths].sort(),
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
    workspace: {
      files: [],
      owners: [],
      packageNames: new Map(),
    },
  };
}

describe("evacuation selector resolution", () => {
  test("resolves exact files and directory prefixes without sibling collisions", () => {
    expect(resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/shared.ts"]))
      .toEqual(["apps/backend/src/shared.ts"]);
    expect(resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/erp"]))
      .toEqual([
        "apps/backend/src/erp/client.ts",
        "apps/backend/src/erp/http/request.ts",
      ]);
  });

  test("supports segment and recursive workspace-relative globs", () => {
    expect(resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/*/client.ts"]))
      .toEqual([
        "apps/backend/src/erp-next/client.ts",
        "apps/backend/src/erp/client.ts",
      ]);
    expect(resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/erp/**"]))
      .toEqual([
        "apps/backend/src/erp/client.ts",
        "apps/backend/src/erp/http/request.ts",
      ]);
  });

  test("deduplicates repeated and overlapping selectors into code-unit order", () => {
    expect(resolveEvacuationSelectors(graph(), "backend", [
      "apps/backend/src/shared.ts",
      "apps/backend/src/erp/**",
      "apps/backend/src/erp",
      "apps/backend/src/shared.ts",
    ])).toEqual([
      "apps/backend/src/erp/client.ts",
      "apps/backend/src/erp/http/request.ts",
      "apps/backend/src/shared.ts",
    ]);
  });

  test("refuses selectors that cross the requested application", () => {
    expect(() => resolveEvacuationSelectors(graph(), "backend", ["apps/*/src/erp/client.ts"]))
      .toThrow(EvacuationSelectorError);
    expect(() => resolveEvacuationSelectors(graph(), "backend", ["libs/erp"]))
      .toThrow(/crosses application "backend"/);
  });

  test("refuses unmatched, non-production, and non-workspace-relative selectors", () => {
    expect(() => resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/missing"]))
      .toThrow(/matches no production graph nodes/);
    expect(() => resolveEvacuationSelectors(graph(), "backend", ["apps/backend/src/erp/client.test.ts"]))
      .toThrow(/matches no production graph nodes/);
    expect(() => resolveEvacuationSelectors(graph(), "backend", ["../backend/src/erp"]))
      .toThrow(/must be workspace-relative/);
  });
});
