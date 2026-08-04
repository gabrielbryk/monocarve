/**
 * Campaign waves are only safe when every collision that can invalidate a
 * same-baseline journal becomes an edge. Each structured-edit case below has a
 * distinct key; if the analyzer merely treated shared paths as hard conflicts,
 * the test would fail on disposition. Each hard case is paired with a plausible
 * edit that must not be described as mergeable.
 */

import { describe, expect, test } from "bun:test";

import {
  analyzePlanConflicts,
  CampaignConflictAnalysisError,
  type CampaignPlan,
  type ConflictCategory,
} from "../src/campaign/conflicts.ts";
import type { GeneratedFileRecord, PlanOperation } from "../src/plan/manifest.ts";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASELINE = "baseline";
const GRAPH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface PlanOptions {
  readonly priority?: number;
  readonly packageRoot?: string;
  readonly packageName?: string;
  readonly projectId?: string;
  readonly generatedFiles?: readonly GeneratedFileRecord[];
  readonly baselineCommit?: string;
  readonly graphDigest?: string;
}

function plan(id: string, operations: readonly PlanOperation[], options: PlanOptions = {}): CampaignPlan {
  const packageRoot = options.packageRoot ?? `libs/${id}`;
  return {
    candidateId: id,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    manifest: {
      planId: `plan-${id}`,
      baselineCommit: options.baselineCommit ?? BASELINE,
      graphDigest: options.graphDigest ?? GRAPH,
      target: {
        packageName: options.packageName ?? `@acme/${id}`,
        packageRoot,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      },
      operations,
      generatedFiles: options.generatedFiles ?? [],
    },
  };
}

function write(path: string, generator: string): PlanOperation {
  return {
    kind: "write-file",
    path,
    contents: `${generator}\n`,
    preconditionHash: HASH,
    resultHash: HASH,
    generator,
  };
}

function lock(packageRoot: string, mode: "insert" | "replace" = "insert"): PlanOperation {
  return {
    kind: "lockfile-importer",
    lockfile: "workspace.lock",
    packageRoot,
    block: `${packageRoot}: {}\n`,
    mode,
    preconditionHash: HASH,
    resultHash: HASH,
  };
}

function rewrite(donor: string): PlanOperation {
  return {
    kind: "rewrite-import",
    file: "apps/consumer/src/main.ts",
    donors: [donor],
    rewrites: [{ from: `./${donor}`, to: `@acme/${donor}`, donor }],
    preconditionHash: HASH,
    resultHash: HASH,
  };
}

function move(source: string, target: string): PlanOperation {
  return { kind: "move", source, target, preconditionHash: HASH, resultHash: HASH };
}

function rewritePathReference(donor: string, file: string = "docs/architecture.md"): PlanOperation {
  return {
    kind: "rewrite-path-reference",
    file,
    documentKind: "markdown",
    rewrites: [{ from: donor, to: `libs/${donor}`, donor, line: 5, column: 1 }],
    preconditionHash: HASH,
    resultHash: HASH,
  };
}

function category(
  analysis: ReturnType<typeof analyzePlanConflicts>,
  name: ConflictCategory,
): ReturnType<typeof analyzePlanConflicts>["conflicts"][number] {
  const conflict = analysis.conflicts.find((entry) => entry.category === name);
  if (conflict === undefined) throw new Error(`missing ${name} conflict`);
  return conflict;
}

describe("same-baseline operation conflict analysis", () => {
  test("classifies distinct structured edits as mergeable-after-replan with exact operation evidence", () => {
    const alpha = plan(
      "alpha",
      [
        rewrite("apps/api/src/alpha.ts"),
        write("apps/consumer/package.json", "wiring:consumer-dependency"),
        write("apps/consumer/tsconfig.json", "wiring:consumer-project-references"),
        write("workspace.yaml", "scaffold:workspace-membership"),
        write("task-runner.yaml", "scaffold:project-registration"),
        lock("libs/alpha"),
        lock("apps/consumer", "replace"),
      ],
      { priority: 20, projectId: "alpha-project" },
    );
    const bravo = plan(
      "bravo",
      [
        rewrite("apps/api/src/bravo.ts"),
        write("apps/consumer/package.json", "wiring:consumer-dependency"),
        write("apps/consumer/tsconfig.json", "wiring:consumer-project-references"),
        write("workspace.yaml", "scaffold:workspace-membership"),
        write("task-runner.yaml", "scaffold:project-registration"),
        lock("libs/bravo"),
        lock("apps/consumer", "replace"),
      ],
      { priority: 10, projectId: "bravo-project" },
    );

    const analysis = analyzePlanConflicts([bravo, alpha]);
    expect(analysis.conflicts.map((conflict) => conflict.category)).toEqual([
      "package-manifest",
      "consumer-source",
      "project-references",
      "task-registry",
      "lockfile-importer",
      "workspace-registry",
    ]);
    expect(analysis.conflicts.every((conflict) => conflict.disposition === "mergeable")).toBe(true);
    expect(analysis.conflicts.every((conflict) => conflict.requiresReplan)).toBe(true);

    const consumer = category(analysis, "consumer-source");
    expect(consumer.path).toBe("apps/consumer/src/main.ts");
    expect(consumer.candidates).toEqual(["alpha", "bravo"]);
    expect(consumer.left).toEqual([
      expect.objectContaining({ candidateId: "alpha", operationIndex: 0, operationKind: "rewrite-import" }),
    ]);
    expect(consumer.right[0]?.keys).toEqual(["apps/api/src/bravo.ts"]);
    expect(consumer.explanation).toContain("compose them by replanning");

    const importer = category(analysis, "lockfile-importer");
    expect(importer.left.map((evidence) => evidence.keys)).toEqual([
      ["importer:libs/alpha"],
      ["dependency:@acme/alpha"],
    ]);
    expect(importer.right.map((evidence) => evidence.keys)).toEqual([
      ["importer:libs/bravo"],
      ["dependency:@acme/bravo"],
    ]);
  });

  test("produces deterministic, path-disjoint waves independent of input order", () => {
    const alpha = plan("alpha", [rewrite("apps/api/src/alpha.ts")], { priority: 20 });
    const bravo = plan("bravo", [rewrite("apps/api/src/bravo.ts")], { priority: 10 });
    const charlie = plan("charlie", [move("apps/api/src/charlie.ts", "libs/charlie/src/charlie.ts")], {
      priority: 1,
    });

    const forward = analyzePlanConflicts([alpha, bravo, charlie]);
    const reversed = analyzePlanConflicts([charlie, bravo, alpha]);
    expect(reversed).toEqual(forward);
    expect(forward.waves).toEqual([
      {
        index: 0,
        candidateIds: ["alpha", "charlie"],
        requiresReplanAfterPreviousWave: false,
        execution: "replan-between-every-child",
      },
      {
        index: 1,
        candidateIds: ["bravo"],
        requiresReplanAfterPreviousWave: true,
        execution: "replan-between-every-child",
      },
    ]);
  });

  test("treats overlapping moves and same-key structured edits as hard conflicts", () => {
    const alpha = plan("alpha", [move("apps/api/src/shared.ts", "libs/shared/src/shared.ts"), lock("apps/api")]);
    const bravo = plan("bravo", [move("apps/api/src/shared.ts", "libs/other/src/shared.ts"), lock("apps/api")]);
    const analysis = analyzePlanConflicts([alpha, bravo]);

    expect(category(analysis, "moved-path")).toMatchObject({
      path: "apps/api/src/shared.ts",
      disposition: "hard",
    });
    expect(category(analysis, "lockfile-importer")).toMatchObject({ disposition: "hard" });
  });

  test("treats package surfaces, barrels, and path-key migrations as hard conflicts", () => {
    const migration = (command: string): PlanOperation => ({
      kind: "migrate-path-keys",
      path: "generated/path-index.json",
      command,
      moves: [],
      preconditionHash: HASH,
      resultHash: HASH,
    });
    const alpha = plan("alpha", [
      write("libs/shared/package.json", "scaffold:package-json"),
      write("libs/shared/src/index.ts", "scaffold:entrypoint"),
      migration("update-alpha"),
    ]);
    const bravo = plan("bravo", [
      write("libs/shared/package.json", "scaffold:package-json"),
      write("libs/shared/src/index.ts", "scaffold:entrypoint"),
      migration("update-bravo"),
    ]);
    const analysis = analyzePlanConflicts([alpha, bravo]);

    expect(category(analysis, "package-manifest").disposition).toBe("hard");
    expect(category(analysis, "scaffold-output")).toMatchObject({
      path: "libs/shared/src/index.ts",
      disposition: "hard",
    });
    expect(category(analysis, "path-key-artifact").disposition).toBe("hard");
  });

  test("detects generated output collisions and tree reads invalidated by another plan", () => {
    const generated = (path: string, source: string): GeneratedFileRecord => ({
      path,
      source,
      regenerate: "run-generator",
      exemptReason: "regenerated after source moves",
      regenerateOnApply: true,
    });
    const alpha = plan("alpha", [], { generatedFiles: [generated("generated/index.json", "apps/api/src")] });
    const bravo = plan(
      "bravo",
      [move("apps/api/src/bravo.ts", "libs/bravo/src/bravo.ts")],
      { generatedFiles: [generated("generated/index.json", "apps/worker/src")] },
    );
    const analysis = analyzePlanConflicts([alpha, bravo]);
    const generatedConflicts = analysis.conflicts.filter((conflict) => conflict.category === "generated-artifact");

    expect(generatedConflicts.map((conflict) => conflict.path)).toEqual([
      "apps/api/src/bravo.ts",
      "generated/index.json",
    ]);
    expect(generatedConflicts.every((conflict) => conflict.disposition === "hard")).toBe(true);
    expect(generatedConflicts[0]?.left[0]).toMatchObject({
      role: "generated-source",
      scope: "tree",
      mode: "read",
      operationKind: "regenerate-artifact",
    });
  });

  test("does not invent edges for disjoint paths or shared read-only generator inputs", () => {
    const generated = (path: string): GeneratedFileRecord => ({
      path,
      source: "inputs/schema",
      regenerate: "run-generator",
      exemptReason: "fixture",
      regenerateOnApply: true,
    });
    const alpha = plan("alpha", [move("apps/api/src/alpha.ts", "libs/alpha/src/alpha.ts")], {
      generatedFiles: [generated("generated/alpha.json")],
    });
    const bravo = plan("bravo", [move("apps/api/src/bravo.ts", "libs/bravo/src/bravo.ts")], {
      generatedFiles: [generated("generated/bravo.json")],
    });

    expect(analyzePlanConflicts([alpha, bravo]).conflicts).toEqual([]);
  });

  test("treats disjoint rewrite-path-reference operations as mergeable", () => {
    const alpha = plan("alpha", [
      move("apps/api/src/alpha.ts", "libs/alpha/src/alpha.ts"),
      rewritePathReference("apps/api/src/alpha.ts", "docs/alpha.md"),
    ]);
    const bravo = plan("bravo", [
      move("apps/api/src/bravo.ts", "libs/bravo/src/bravo.ts"),
      rewritePathReference("apps/api/src/bravo.ts", "docs/bravo.md"),
    ]);

    const analysis = analyzePlanConflicts([alpha, bravo]);
    expect(analysis.conflicts).toEqual([]);
  });

  test("refuses mixed baselines, mixed graph inputs, and duplicate identities", () => {
    const alpha = plan("alpha", []);
    expect(() => analyzePlanConflicts([alpha, plan("bravo", [], { baselineCommit: "other" })])).toThrow(
      "plans do not share a baseline commit",
    );
    expect(() => analyzePlanConflicts([alpha, plan("bravo", [], { graphDigest: "other" })])).toThrow(
      "plans do not share a graph digest",
    );
    expect(() => analyzePlanConflicts([alpha, { ...plan("bravo", []), candidateId: "alpha" }])).toThrow(
      CampaignConflictAnalysisError,
    );
    expect(() =>
      analyzePlanConflicts([
        alpha,
        { ...plan("bravo", []), manifest: { ...plan("bravo", []).manifest, planId: "plan-alpha" } },
      ]),
    ).toThrow("duplicate plan id");
    expect(() => analyzePlanConflicts([{ ...alpha, priority: Number.NaN }])).toThrow(
      "candidate priority must be finite",
    );
  });
});
