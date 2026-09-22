/**
 * Unit tests for the pure path-reference-rewrite engine: strings in, values
 * out, no filesystem. `path-reference-rewrites.ts` is the heart of the
 * `rewrite-path-reference` plan operation — everything else in the feature
 * (build-support emission, the journal-apply arm, the doctor/audit arms) is
 * plumbing around what this module decides. These tests exercise that
 * decision directly: which tokens match, which matches are ambiguous, and
 * that the byte-for-byte splice reproduces exactly the expected document.
 */

import { describe, expect, test } from "bun:test";

import { PlanningError } from "../src/plan/context.ts";
import type { PathMove } from "../src/plan/manifest-operations.ts";
import {
  documentKindFor,
  rewritePathReferenceText,
  scanPathReferenceRewrites,
  type PathReferenceRewriteSettings,
} from "../src/plan/path-reference-rewrites.ts";

const FILE = "docs/notes.md";

function settings(overrides: Partial<PathReferenceRewriteSettings> = {}): PathReferenceRewriteSettings {
  return { onAmbiguousMatch: "refuse", matchExtensionless: false, minSegments: 3, ...overrides };
}

function move(source: string, target: string): PathMove {
  return { source, target };
}

describe("documentKindFor", () => {
  test("classifies by extension", () => {
    expect(documentKindFor("docs/a.md")).toBe("markdown");
    expect(documentKindFor("docs/a.markdown")).toBe("markdown");
    expect(documentKindFor("config/a.json")).toBe("json");
    expect(documentKindFor("README")).toBe("plain-text");
    expect(documentKindFor("scripts/a.sh")).toBe("plain-text");
  });
});

describe("scanPathReferenceRewrites / rewritePathReferenceText", () => {
  test("a declared base permits contained parent traversal but refuses workspace escape and absolute tokens", () => {
    const based = settings({ referenceBase: "app/cloudflare-stack" });
    const valid = scanPathReferenceRewrites(
      "../backend/src/ingest/routes.ts",
      FILE,
      [move("app/backend/src/ingest/routes.ts", "libs/ingest-runtime/src/ingest/routes.ts")],
      based,
    );
    expect(valid.rewrites[0]).toMatchObject({
      from: "../backend/src/ingest/routes.ts",
      to: "../../libs/ingest-runtime/src/ingest/routes.ts",
      referenceBase: "app/cloudflare-stack",
    });
    expect(scanPathReferenceRewrites("../../../outside/routes.ts", FILE, [move("../outside/routes.ts", "libs/x/routes.ts")], based).rewrites).toEqual([]);
    expect(
      scanPathReferenceRewrites("/repo/app/backend/src/ingest/routes.ts", FILE, [move("app/backend/src/ingest/routes.ts", "libs/x/routes.ts")], based).rewrites,
    ).toEqual([]);
  });
  test("case 1: an exact token naming a moved source yields one correct rewrite whose span splices to the expected bytes", () => {
    const text = "See apps/api/src/alpha.ts for details.\n";
    const moves = [move("apps/api/src/alpha.ts", "libs/values/src/alpha.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.skipped).toEqual([]);
    expect(scan.rewrites).toHaveLength(1);
    const rewrite = scan.rewrites[0]!;
    expect(rewrite.from).toBe("apps/api/src/alpha.ts");
    expect(rewrite.to).toBe("libs/values/src/alpha.ts");
    expect(rewrite.donor).toBe("apps/api/src/alpha.ts");
    expect(rewrite.line).toBe(1);
    expect(rewrite.column).toBe(5);
    expect(rewrite.span).toEqual({ start: 4, end: 25 });

    const spliced = text.slice(0, rewrite.span.start) + rewrite.to + text.slice(rewrite.span.end);
    const output = rewritePathReferenceText(text, scan.rewrites);
    expect(output).toBe(spliced);
    expect(output).toBe("See libs/values/src/alpha.ts for details.\n");
  });

  test("case 2: a non-path quoted string and a path-shaped token naming an unmoved file are both left untouched", () => {
    const text = '"hello world" and apps/api/src/untouched.ts stay.\n';
    const moves = [move("apps/api/src/alpha.ts", "libs/values/src/alpha.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toEqual([]);
    expect(scan.skipped).toEqual([]);
    expect(rewritePathReferenceText(text, scan.rewrites)).toBe(text);
  });

  test("case 3: one token matching two different moved sources throws under refuse, and is reported skipped (both donors, no rewrite) under skip", () => {
    // Absolute token whose suffix matches two different-length moved sources
    // that are themselves suffixes of one another.
    const text = "see /repo/apps/api/src/x.ts here\n";
    const moves = [move("apps/api/src/x.ts", "libs/values/src/x.ts"), move("api/src/x.ts", "libs/other/src/x.ts")];

    expect(() => scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "refuse" }))).toThrow(PlanningError);
    expect(() => scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "refuse" }))).toThrow(/ambiguous path reference/);

    const scan = scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "skip" }));
    expect(scan.rewrites).toEqual([]);
    expect(scan.skipped).toHaveLength(2);
    for (const ambiguity of scan.skipped) {
      expect(ambiguity.token).toBe("/repo/apps/api/src/x.ts");
      expect(ambiguity.donors).toEqual(["api/src/x.ts", "apps/api/src/x.ts"]);
      expect(ambiguity.reason).toBe("token matches multiple moved sources");
    }
  });

  test("case 4: two moved sources producing the SAME replacement token in one file are both refused", () => {
    const text = "first apps/api/src/c.ts second apps/api/src/d.ts\n";
    const moves = [move("apps/api/src/c.ts", "libs/shared/dest.ts"), move("apps/api/src/d.ts", "libs/shared/dest.ts")];

    expect(() => scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "refuse" }))).toThrow(PlanningError);

    const scan = scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "skip" }));
    expect(scan.rewrites).toEqual([]);
    expect(scan.skipped).toHaveLength(2);
    expect(scan.skipped.map((s) => s.token).sort()).toEqual(["apps/api/src/c.ts", "apps/api/src/d.ts"]);
    for (const ambiguity of scan.skipped) {
      expect(ambiguity.donors).toEqual(["apps/api/src/c.ts", "apps/api/src/d.ts"]);
      expect(ambiguity.reason).toBe("would produce the same replacement token as another moved source in this file");
    }
  });

  test("case 4b: repeated references to one moved source are all rewritten", () => {
    const text = ["- apps/api/src/c.ts", "- apps/api/src/c.ts", "- apps/api/src/c.ts", ""].join("\n");
    const moves = [move("apps/api/src/c.ts", "libs/shared/dest.ts")];

    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());
    expect(scan.skipped).toEqual([]);
    expect(scan.rewrites).toHaveLength(3);
    expect(rewritePathReferenceText(text, scan.rewrites)).toBe(["- libs/shared/dest.ts", "- libs/shared/dest.ts", "- libs/shared/dest.ts", ""].join("\n"));
  });

  test("case 5: an absolute token matching a workspace-relative moved path keeps its absolute prefix untouched — the span is narrowed to the matched suffix, `to` holds only the suffix replacement", () => {
    const text = "/home/u/repo/apps/web/a.ts is referenced\n";
    const moves = [move("apps/web/a.ts", "libs/web/src/a.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toHaveLength(1);
    const rewrite = scan.rewrites[0]!;
    expect(rewrite.from).toBe("/home/u/repo/apps/web/a.ts");
    // `to` is the matched suffix's replacement alone, never a reconstructed
    // whole token — see F-A. The prefix "/home/u/repo/" is not this value's
    // business; it survives because the span excludes it, not because `to`
    // reconstructs it.
    expect(rewrite.to).toBe("libs/web/src/a.ts");
    expect(text.slice(rewrite.span.start, rewrite.span.end)).toBe("apps/web/a.ts");
    expect(rewritePathReferenceText(text, scan.rewrites)).toBe("/home/u/repo/libs/web/src/a.ts is referenced\n");
  });

  test("case 5b (F-A): a GitHub permalink URL keeps its scheme and host byte-for-byte — only the matched path suffix is rewritten", () => {
    const text = "See [chart](https://github.com/org/repo/blob/main/apps/web/src/widgets/chart.ts) for details.\n";
    const moves = [move("apps/web/src/widgets/chart.ts", "libs/chart/src/chart.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toHaveLength(1);
    const output = rewritePathReferenceText(text, scan.rewrites);
    expect(output).toBe("See [chart](https://github.com/org/repo/blob/main/libs/chart/src/chart.ts) for details.\n");
  });

  test("case 5c (F-A): a leading './' token is preserved verbatim; only the matched suffix moves", () => {
    const text = "run ./tools/scripts/build.sh now\n";
    const moves = [move("tools/scripts/build.sh", "ops/scripts/build.sh")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toHaveLength(1);
    const output = rewritePathReferenceText(text, scan.rewrites);
    expect(output).toBe("run ./ops/scripts/build.sh now\n");
  });

  test("case 5d (F-A): a backslash-written token keeps a leading './' prefix untouched, and writes its replacement suffix backslashed to match the document's own style", () => {
    const text = "run .\\tools\\scripts\\build.sh now\n";
    const moves = [move("tools/scripts/build.sh", "ops/scripts/build.sh")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toHaveLength(1);
    const rewrite = scan.rewrites[0]!;
    expect(rewrite.to).toBe("ops\\scripts\\build.sh");
    const output = rewritePathReferenceText(text, scan.rewrites);
    expect(output).toBe("run .\\ops\\scripts\\build.sh now\n");
  });

  test("case 5e (F-A): an absolute /-rooted token whose non-matching root segments are not moved-source segments keeps its root untouched", () => {
    const text = "artifact at /srv/build/out/apps/web/src/widgets/chart.ts on disk\n";
    const moves = [move("apps/web/src/widgets/chart.ts", "libs/chart/src/chart.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());

    expect(scan.rewrites).toHaveLength(1);
    const output = rewritePathReferenceText(text, scan.rewrites);
    expect(output).toBe("artifact at /srv/build/out/libs/chart/src/chart.ts on disk\n");
  });

  test("case 6: an extensionless stem token is ignored when matchExtensionless is false, matched when true", () => {
    const text = "import from apps/api/src/util\n";
    const moves = [move("apps/api/src/util.ts", "libs/values/src/util.ts")];

    const ignored = scanPathReferenceRewrites(text, FILE, moves, settings({ matchExtensionless: false }));
    expect(ignored.rewrites).toEqual([]);
    expect(ignored.skipped).toEqual([]);

    const matched = scanPathReferenceRewrites(text, FILE, moves, settings({ matchExtensionless: true }));
    expect(matched.rewrites).toHaveLength(1);
    expect(matched.rewrites[0]!.to).toBe("libs/values/src/util");
    expect(rewritePathReferenceText(text, matched.rewrites)).toBe("import from libs/values/src/util\n");
  });

  test("case 7: a moved source with fewer than minSegments segments is never matched", () => {
    const text = "path a/b.ts here\n";
    const moves = [move("a/b.ts", "c/d.ts")];

    const strict = scanPathReferenceRewrites(text, FILE, moves, settings({ minSegments: 3, matchExtensionless: false }));
    expect(strict.rewrites).toEqual([]);
    expect(strict.skipped).toEqual([]);

    // Even with matchExtensionless on, the segment-count floor still refuses
    // the move before tokens are even considered — this is not an ambiguity.
    const lenient = scanPathReferenceRewrites(text, FILE, moves, settings({ minSegments: 3, matchExtensionless: true }));
    expect(lenient.rewrites).toEqual([]);
    expect(lenient.skipped).toEqual([]);
  });

  test("case 8: every other byte of a multi-line document is preserved verbatim across a rewrite", () => {
    const text = [
      "# Notes\n",
      "\n",
      "First line unrelated.\n",
      "See apps/api/src/alpha.ts for the source.\n",
      "Last line unrelated, with trailing spaces.   \n",
    ].join("");
    const moves = [move("apps/api/src/alpha.ts", "libs/values/src/alpha.ts")];
    const scan = scanPathReferenceRewrites(text, FILE, moves, settings());
    expect(scan.rewrites).toHaveLength(1);
    expect(scan.rewrites[0]!.line).toBe(4);

    const output = rewritePathReferenceText(text, scan.rewrites);
    const expected = [
      "# Notes\n",
      "\n",
      "First line unrelated.\n",
      "See libs/values/src/alpha.ts for the source.\n",
      "Last line unrelated, with trailing spaces.   \n",
    ].join("");
    expect(output).toBe(expected);
  });

  test("case 9: determinism — identical inputs produce identically-ordered rewrites and skipped entries across two calls", () => {
    const text = ["apps/api/src/alpha.ts and apps/api/src/beta.ts\n", "collide: apps/api/src/c.ts vs apps/api/src/d.ts\n"].join("");
    const moves = [
      move("apps/api/src/beta.ts", "libs/values/src/beta.ts"),
      move("apps/api/src/alpha.ts", "libs/values/src/alpha.ts"),
      move("apps/api/src/c.ts", "libs/shared/dest.ts"),
      move("apps/api/src/d.ts", "libs/shared/dest.ts"),
    ];

    const first = scanPathReferenceRewrites(text, FILE, moves, settings({ onAmbiguousMatch: "skip" }));
    const second = scanPathReferenceRewrites(text, FILE, [...moves].reverse(), settings({ onAmbiguousMatch: "skip" }));

    expect(first.rewrites).toEqual(second.rewrites);
    expect(first.skipped).toEqual(second.skipped);
    expect(first.rewrites.map((r) => r.from)).toEqual(["apps/api/src/alpha.ts", "apps/api/src/beta.ts"]);
    expect(first.skipped.map((s) => s.token)).toEqual(["apps/api/src/c.ts", "apps/api/src/d.ts"]);
  });
});
