import { describe, expect, test } from "bun:test";

import { narrowCandidate } from "../src/commands/planning.ts";
import type { DependencyGraph } from "../src/graph/model.ts";
import type { PortfolioCandidate } from "../src/portfolio/types.ts";

const A = "apps/api/src/a.ts";
const B = "apps/api/src/b.ts";
const A_TEST = "apps/api/src/a.test.ts";
const A_ASSET = "apps/api/src/a.css";
const B_ASSET = "apps/api/src/b.css";

function candidate(): PortfolioCandidate {
  return {
    id: "c-selection",
    application: "api",
    suggestedPackageName: "@acme/selection",
    files: [A, B],
    tests: [A_TEST],
    assets: [A_ASSET, B_ASSET],
    sccs: [
      { id: "scc-a", members: [A] },
      { id: "scc-b", members: [B] },
    ],
    seed: { id: "scc-a", members: [A] },
    lineCount: 2,
    owners: ["apps/api"],
    domains: ["api"],
    dependencies: [],
    consumers: [],
    consumerChurn: 0,
    coverage: 1,
    score: 1,
    eligible: true,
    rejectionReasons: [],
    warnings: [],
    rewriteEscapes: [
      { file: A, specifier: "../shared/a", package: "@acme/shared-a" },
      { file: B, specifier: "../shared/b", package: "@acme/shared-b" },
    ],
  };
}

describe("explicit plan source selection", () => {
  test("narrows assets and escape rewrites with the selected production files", () => {
    const graph = {
      outgoing: new Map([
        [A, [A_ASSET]],
        [B, [B_ASSET]],
      ]),
    } as unknown as DependencyGraph;

    const narrowed = narrowCandidate(candidate(), [A], graph);

    expect(narrowed.files).toEqual([A]);
    expect(narrowed.tests).toEqual([A_TEST]);
    expect(narrowed.assets).toEqual([A_ASSET]);
    expect(narrowed.rewriteEscapes).toEqual([candidate().rewriteEscapes[0]!]);
  });
});
