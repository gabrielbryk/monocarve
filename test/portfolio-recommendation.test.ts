import { describe, expect, test } from "bun:test";
import ts from "typescript";

import { groupEquivalentCandidates } from "../src/portfolio/groups.ts";
import { targetRecommendations } from "../src/portfolio/recommendation.ts";
import { describePureReexport } from "../src/portfolio/shims.ts";
import type { DependencyGraph } from "../src/graph/model.ts";
import type { PortfolioCandidate } from "../src/portfolio/types.ts";

function candidate(id: string, files: readonly string[], score: number): PortfolioCandidate {
  return {
    id, application: "web", suggestedPackageName: `@acme/${id}`, files, tests: [], assets: [],
    sccs: [], seed: { id: `scc-${id}`, members: [files[0]!] }, lineCount: files.length,
    owners: ["apps/web"], domains: ["web:feature"], dependencies: [], consumers: [],
    consumerChurn: 0, coverage: 0, score, eligible: true, rejectionReasons: [], warnings: [],
    rewriteEscapes: [], classification: "extraction",
    recommendation: { status: "recommended", cohesion: "high", reasons: [], requiresExplicitPackageName: false, highInboundModules: [], targetOptions: [] },
  };
}

describe("architectural portfolio evidence", () => {
  test("groups near-identical closures but leaves a distinct idea separate", () => {
    const groups = groupEquivalentCandidates([
      candidate("a", ["a.ts", "b.ts", "c.ts"], 3),
      candidate("b", ["a.ts", "b.ts", "c.ts"], 4),
      candidate("c", ["other.ts"], 10),
    ], 0.95);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.candidateIds.includes("a"))).toMatchObject({
      representativeId: "b", candidateIds: ["a", "b"], similarity: 1,
    });
  });

  test("a pure workspace re-export is detectable, while one own declaration makes the proof fail", () => {
    const parse = (text: string) => ts.createSourceFile("shim.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(describePureReexport(parse('export { PublicHelp } from "@acme/page-help/help";'), ["@acme/page-help"]))
      .toEqual({ packageName: "@acme/page-help", specifier: "@acme/page-help/help", symbols: ["PublicHelp"] });
    expect(describePureReexport(parse('const local = 1; export { PublicHelp } from "@acme/page-help/help";'), ["@acme/page-help"]))
      .toBeUndefined();
  });

  test("renamed forwarding is not called a byte-obvious compatibility shim", () => {
    const source = ts.createSourceFile("shim.ts", 'export { PublicHelp as LocalHelp } from "@acme/page-help";', ts.ScriptTarget.Latest, true);
    expect(describePureReexport(source, ["@acme/page-help"])).toBeUndefined();
  });

  test("an existing suggested package requires extension review instead of being called a compatible creation", () => {
    const graph = {
      workspace: { packageNames: new Map([["@acme/existing", "libs/existing"]]) },
    } as unknown as DependencyGraph;
    const extraction = { ...candidate("existing", ["apps/web/src/existing.ts"], 10), dependencies: ["@acme/existing"] };

    expect(targetRecommendations(extraction, graph)).toEqual([{
      packageName: "@acme/existing",
      action: "extend",
      confidence: "low",
      compatibility: "requires-review",
      reasons: ["suggested package already exists; extending it requires compatibility review"],
    }]);
  });
});
