import { describe, expect, test } from "bun:test";

import { marginalBlockers, type RejectionReason } from "../src/portfolio/types.ts";

type Candidate = Parameters<typeof marginalBlockers>[0][number];

function candidate(id: string, lineCount: number, rejectionReasons: readonly RejectionReason[]): Candidate {
  return { id, lineCount, rejectionReasons };
}

describe("marginalBlockers", () => {
  test("ranks candidates a single concrete edge really frees, not an often-seen multi-blocker", () => {
    const escapes: RejectionReason = {
      code: "closure-escapes-app-code",
      detail: "imports leave the closure",
      edges: ["apps/a.ts -> ../hub.ts"],
    };
    const result = marginalBlockers([
      candidate("c-multi-a", 100, [escapes, { code: "dynamic-imports", detail: "dynamic", edges: [] }]),
      candidate("c-multi-b", 90, [escapes, { code: "too-large", detail: "large", edges: [] }]),
      candidate("c-single-a", 40, [escapes]),
      candidate("c-single-b", 30, [escapes]),
    ]);

    expect(result).toEqual([
      {
        code: "closure-escapes-app-code",
        detail: "imports leave the closure",
        edge: "apps/a.ts -> ../hub.ts",
        occurrences: 4,
        freedCandidates: 2,
        freedLineCount: 70,
        candidateIds: ["c-single-a", "c-single-b"],
      },
      {
        code: "dynamic-imports",
        detail: "dynamic",
        occurrences: 1,
        freedCandidates: 0,
        freedLineCount: 0,
        candidateIds: [],
      },
      {
        code: "too-large",
        detail: "large",
        occurrences: 1,
        freedCandidates: 0,
        freedLineCount: 0,
        candidateIds: [],
      },
    ]);
  });

  test("does not credit either edge when one rejection itself requires two edges", () => {
    const result = marginalBlockers([
      candidate("c-two-edges", 200, [
        {
          code: "closure-escapes-app-code",
          detail: "two escapes",
          edges: ["apps/a.ts -> ../one.ts", "apps/a.ts -> ../two.ts"],
        },
      ]),
    ]);

    expect(result.map(({ edge, occurrences, freedCandidates }) => ({ edge, occurrences, freedCandidates }))).toEqual([
      { edge: "apps/a.ts -> ../one.ts", occurrences: 1, freedCandidates: 0 },
      { edge: "apps/a.ts -> ../two.ts", occurrences: 1, freedCandidates: 0 },
    ]);
  });
});
