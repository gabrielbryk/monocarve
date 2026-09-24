/**
 * Transaction-layer proof for `rewrite-path-reference` (acceptance test 5 of
 * the feature proposal). `path-reference-rewrites.test.ts` proves the pure
 * matching engine; this file proves the journal actually behaves under the
 * same rules `rewrite-fs-reference` and `migrate-path-keys` are held to
 * elsewhere in this suite: exact bytes on success, fail-closed on a stale
 * precondition, fail-closed when the live text no longer reproduces the
 * recorded rewrite even though the precondition hash still matches (apply
 * must re-derive, never trust stored contents), full rollback on a later
 * failure, and inclusion in the audit's scope.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { FAIL_OPERATION_ENV } from "../src/branding.ts";
import { pathReferenceRewriteOperations } from "../src/plan/build-support.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import type { ExtractionManifest, PlanOperation, RewritePathReferenceOperation } from "../src/plan/manifest.ts";
import { manifestPaths, operationPaths } from "../src/plan/manifest.ts";
import { rewritePathReferenceText } from "../src/plan/path-reference-rewrites.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { JournalError } from "../src/transaction/journal-error.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const FIRST = "apps/api/src/alpha.ts";
const FIRST_TARGET = "libs/values/src/alpha.ts";
const DOC = "docs/guide.md";
const DOC_ORIGINAL = `See ${FIRST} for details.\n`;

function files(): Record<string, string> {
  return {
    ".gitignore": "\n",
    "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
    [FIRST]: "export const alpha = 1;\n",
    [DOC]: DOC_ORIGINAL,
  };
}

function configFor(root: string) {
  return fixtureConfig(root, {
    pathReferenceRewrites: { enabled: true, roots: [{ root: "docs", extensions: [".md"], mode: "exact-path-token" }] },
    gates: { package: [], project: [], workspace: [] },
  });
}

function moveOp(root: string): PlanOperation {
  const hash = hashText(read(root, FIRST));
  return { kind: "move", source: FIRST, target: FIRST_TARGET, preconditionHash: hash, resultHash: hash };
}

/** Compile the rewrite operation the way the planner does: scan the real doc. */
function rewriteOp(root: string, config: ReturnType<typeof configFor>): RewritePathReferenceOperation {
  const context = new WorkspaceContext(config, root);
  const [operation] = pathReferenceRewriteOperations(config, context, [moveOp(root)]);
  if (!operation) throw new Error("expected a rewrite-path-reference operation for the fixture doc");
  return operation;
}

function manifest(root: string, operations: readonly PlanOperation[]): ExtractionManifest {
  const sourceHash = hashText(read(root, FIRST));
  return {
    schemaVersion: 2,
    planId: "path-reference-rewrite-fixture",
    createdAt: "2024-01-02T03:04:05.000Z",
    generator: { name: "fixture-engine", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    // The entrypoint is the moved file itself: cheapest way to satisfy the
    // boundary-rules proof (proof 3) without adding a second write-file
    // operation this suite has no other use for.
    target: { packageName: "@acme/values", packageRoot: "libs/values", entrypoint: "src/alpha.ts", requiredExports: [] },
    source: { files: [FIRST], tests: [], sccs: { "scc-alpha": [FIRST] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [FIRST]: sourceHash },
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [...new Set(operations.flatMap(operationPaths))].toSorted(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: "chore(@acme/values): compile extraction plan path-reference-rewrite-fixture" },
      move: { subject: "refactor(@acme/values): move 1 files into libs/values" },
      wiring: { subject: "refactor(@acme/values): wire @acme/values into the workspace" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

describe("rewrite-path-reference transaction", () => {
  afterEach(cleanupFixtures);

  test("a tampered shorthand resolution base is refused during replay", async () => {
    const root = fixtureRepo({ ...files(), [DOC]: "See src/alpha.ts for details.\n" });
    const config = fixtureConfig(root, {
      pathReferences: { minSegments: 2, textRoots: [{ root: "docs", extensions: [".md"] }] },
      pathReferenceRewrites: {
        enabled: true,
        minSegments: 2,
        roots: [{ root: "docs", extensions: [".md"], mode: "exact-path-token", referenceBase: "apps/api" }],
      },
      gates: { package: [], project: [], workspace: [] },
    });
    const rewrite = rewriteOp(root, config);
    expect(rewrite.rewrites[0]?.referenceBase).toBe("apps/api");
    const forged: RewritePathReferenceOperation = { ...rewrite, rewrites: rewrite.rewrites.map((entry) => ({ ...entry, referenceBase: "apps/other" })) };

    await expect(executeJournal({ config, treeRoot: root, manifest: manifest(root, [moveOp(root), forged]) })).rejects.toThrow("replay mismatch");
    expect(read(root, DOC)).toBe("See src/alpha.ts for details.\n");
    expect(read(root, FIRST)).toBe("export const alpha = 1;\n");
  });

  test("apply writes exactly the planned bytes, and the post-state hash equals resultHash", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);
    expect(rewrite.rewrites).toHaveLength(1);
    expect(rewrite.rewrites[0]?.from).toBe(FIRST);
    expect(rewrite.rewrites[0]?.to).toBe(FIRST_TARGET);
    expect(rewrite.rewrites[0]?.donor).toBe(FIRST);

    const plan = manifest(root, [move, rewrite]);
    await executeJournal({ config, treeRoot: root, manifest: plan });

    const expectedText = rewritePathReferenceText(
      DOC_ORIGINAL,
      rewrite.rewrites.map((entry) => ({ ...entry, span: findSpan(DOC_ORIGINAL, entry.from) })),
    );
    const landed = read(root, DOC);
    expect(landed).toBe(expectedText);
    expect(landed).toBe(`See ${FIRST_TARGET} for details.\n`);
    expect(hashText(landed)).toBe(rewrite.resultHash);
    expect(existsSync(join(root, FIRST))).toBe(false);
    expect(read(root, FIRST_TARGET)).toBe("export const alpha = 1;\n");
  });

  test("a stale document — mutated after the plan was compiled — is refused, and the checkout is left untouched", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);
    const plan = manifest(root, [move, rewrite]);

    // Mutate the document after the plan was compiled: its precondition no
    // longer holds.
    const mutated = `${DOC_ORIGINAL}An unrelated edit landed after planning.\n`;
    write(root, DOC, mutated);

    await expect(executeJournal({ config, treeRoot: root, manifest: plan })).rejects.toThrow("operation precondition failed at 1: rewrite-path-reference");

    // The move (operation 0) ran before the stale precondition was discovered
    // at operation 1, and the journal's own rollback must undo it: nothing the
    // journal did is left half-applied.
    expect(existsSync(join(root, FIRST_TARGET))).toBe(false);
    expect(read(root, FIRST)).toBe("export const alpha = 1;\n");
    // The document itself was never touched by the journal — it still carries
    // exactly the mutation the test made, not the rewrite and not a revert of
    // the mutation (the journal never snapshotted a state older than this).
    expect(read(root, DOC)).toBe(mutated);
  });

  test("apply re-derives the rewrite rather than trusting stored contents: a forged rewrite is refused even though the precondition hash matches", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const rewrite = rewriteOp(root, config);

    // The document on disk is untouched, so `preconditionHash` still matches
    // its live hash: a check keyed only on that hash would wave this through.
    // The forgery is a *second*, fabricated rewrite entry naming a token that
    // is not actually anywhere in the document — exactly what a corrupted or
    // hand-edited plan (or a resultHash forged to match the fabricated output)
    // would look like. If apply trusted `operation.rewrites` and spliced them
    // in without re-scanning the live text for each one, this entry would
    // write bytes nothing in the document justifies; re-deriving from a fresh
    // scan (`rederivePathReferenceMatches` in journal-operation.ts) is what
    // makes that impossible, and it is a distinct defense from the final
    // `resultHash` check — it fires before that check is ever reached.
    const forged: RewritePathReferenceOperation = {
      ...rewrite,
      rewrites: [...rewrite.rewrites, { from: "apps/api/src/beta.ts", to: "libs/values/src/beta.ts", donor: "apps/api/src/beta.ts", line: 1, column: 1 }],
    };
    const plan = manifest(root, [forged]);

    await expect(executeJournal({ config, treeRoot: root, manifest: plan })).rejects.toThrow("replay mismatch");
    // Refused before any write: the document is byte-for-byte what it started
    // as, not a half-write and not the forged replacement.
    expect(read(root, DOC)).toBe(DOC_ORIGINAL);
  });

  test("apply refuses a forged `to` even when it is self-consistent with resultHash and the recorded from/donor/position are genuine", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);
    const original = rewrite.rewrites[0]!;

    // Forge `to` to point somewhere the move never lands, then recompute
    // preconditionHash/resultHash so the forged operation is entirely
    // self-consistent — the forgery a reviewer would actually construct
    // against a real plan, not merely a bit twiddled in isolation.
    const forgedTo = "totally/made/up/evil.ts";
    const forgedText = rewritePathReferenceText(DOC_ORIGINAL, [{ ...original, to: forgedTo, span: findSpan(DOC_ORIGINAL, original.from) }]);
    const forged: RewritePathReferenceOperation = { ...rewrite, rewrites: [{ ...original, to: forgedTo }], resultHash: hashText(forgedText) };
    const plan = manifest(root, [move, forged]);

    await expect(executeJournal({ config, treeRoot: root, manifest: plan })).rejects.toThrow("replay mismatch");
    // Refused, and the whole transaction rolled back: the document is
    // untouched and the move that ran before the rewrite was undone too —
    // nothing the forged operation wrote survives.
    expect(read(root, DOC)).toBe(DOC_ORIGINAL);
    expect(existsSync(join(root, FIRST_TARGET))).toBe(false);
    expect(read(root, FIRST)).toBe("export const alpha = 1;\n");
  });

  test("rollback restores both the moved source file and the rewritten document after a later failure", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);
    // A third operation that never actually runs — MONOCARVE_FAIL_OPERATION
    // throws before it does anything — but whose presence at index 2 proves
    // the failure happens *after* both the move and the rewrite have already
    // landed on disk.
    const doomed: PlanOperation = {
      kind: "write-file",
      path: "generated/marker.txt",
      contents: "marker\n",
      preconditionHash: "missing",
      resultHash: hashText("marker\n"),
    };
    const plan = manifest(root, [move, rewrite, doomed]);

    process.env[FAIL_OPERATION_ENV] = "2";
    let error: Error;
    try {
      error = await executeJournal({ config, treeRoot: root, manifest: plan }).then(
        () => {
          throw new Error("expected executeJournal to reject");
        },
        (caught: unknown) => caught as Error,
      );
    } finally {
      delete process.env[FAIL_OPERATION_ENV];
    }

    expect(error).toBeInstanceOf(JournalError);
    expect(error.message).toContain("injected operation failure 2");

    // Both artifacts the journal actually wrote are back to their
    // pre-transaction bytes — not merely "the transaction reported failure".
    expect(existsSync(join(root, FIRST_TARGET))).toBe(false);
    expect(read(root, FIRST)).toBe("export const alpha = 1;\n");
    expect(read(root, DOC)).toBe(DOC_ORIGINAL);
    expect(existsSync(join(root, "generated/marker.txt"))).toBe(false);
  });

  test("audit passes with the rewrite in scope, and the rewritten document is inside the audited path set", async () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);
    const plan = manifest(root, [move, rewrite]);

    expect(manifestPaths(plan)).toContain(DOC);

    await executeJournal({ config, treeRoot: root, manifest: plan });

    const audit = auditPlanSync({ config, rootDir: root, manifest: plan, skipCompileProof: true });
    expect(audit.failures).toEqual([]);
    expect(audit.passed).toBe(true);
    // The byte-fidelity proof is the one that actually re-checks the rewritten
    // document's landed hash against the operation's declared result.
    expect(audit.byteFidelity.passed).toBe(true);
  });

  test("validatePlan rejects a rewrite whose `to` disagrees with what its own move operation implies", () => {
    const root = fixtureRepo(files());
    const config = configFor(root);
    const move = moveOp(root);
    const rewrite = rewriteOp(root, config);

    const forged: RewritePathReferenceOperation = { ...rewrite, rewrites: [{ ...rewrite.rewrites[0]!, to: "totally/made/up/evil.ts" }] };
    const plan = manifest(root, [move, forged]);

    const issues = validatePlan(plan, { config, rootDir: root }).issues;
    expect(issues.map((issue) => issue.rule)).toContain("path-reference-target");
  });
});

/**
 * Recompute a rewrite's span within `text` from its `from` token, for the
 * one assertion that wants to reuse `rewritePathReferenceText` directly
 * rather than duplicating its splice logic by hand.
 */
function findSpan(text: string, token: string): { start: number; end: number } {
  const start = text.indexOf(token);
  if (start < 0) throw new Error(`token not found in text: ${token}`);
  return { start, end: start + token.length };
}
