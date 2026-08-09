/**
 * Plan-level coverage for `rewrite-path-reference`: this is the first real
 * exercise of `pathReferenceRewriteOperations` (src/plan/build-support.ts)
 * wired through a manifest rather than the pure matcher in isolation
 * (src/plan/path-reference-rewrites.ts, covered by
 * test/path-reference-rewrites.test.ts). It follows the shape of
 * test/path-migrations.test.ts: build the operation directly against a
 * fixture repo, hand-assemble the manifest it would land in, and drive
 * `manifestPaths`, `summarizePlanReview`/`formatPlanReview`, and
 * `validatePlan` against it exactly as the real pipeline would.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pathReferenceRewriteOperations } from "../src/plan/build-support.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPathReferenceIndex } from "../src/plan/path-references.ts";
import type { ExtractionManifest, PlanOperation, RewritePathReferenceOperation } from "../src/plan/manifest.ts";
import { manifestPaths } from "../src/plan/manifest.ts";
import { formatPlanReview, summarizePlanReview } from "../src/plan/review.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, scratchDirectory } from "./support/fixture-repo.ts";

const SOURCE = "apps/api/src/widget.ts";
const TARGET = "libs/values/src/widget.ts";
const DOC = "docs/guide.md";

function files() {
  return {
    "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
    [SOURCE]: "export const widgetValue = 1;\n",
    [DOC]: `See \`${SOURCE}\` for the implementation.\n`,
  };
}

function enabledConfig(root: string) {
  return fixtureConfig(root, {
    pathReferenceRewrites: {
      enabled: true,
      roots: [{ root: "docs", extensions: [".md"], mode: "exact-path-token" }],
    },
    gates: { package: [], project: [], workspace: [] },
  });
}

function moveOperation(root: string): PlanOperation {
  const hash = hashText(read(root, SOURCE));
  return { kind: "move", source: SOURCE, target: TARGET, preconditionHash: hash, resultHash: hash };
}

function manifest(root: string, operations: readonly PlanOperation[]): ExtractionManifest {
  const sourceHash = hashText(read(root, SOURCE));
  return {
    schemaVersion: 2,
    planId: "path-reference-rewrite-fixture",
    createdAt: "2024-01-02T03:04:05.000Z",
    generator: { name: "fixture-engine", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("fixture-graph"),
    application: "api",
    target: { packageName: "@acme/values", packageRoot: "libs/values", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [SOURCE], tests: [], sccs: { "scc-widget": [SOURCE] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [SOURCE]: sourceHash },
    operations: [...operations],
    consumers: [],
    generatedFiles: [],
    changedFiles: [SOURCE, TARGET, DOC].sort(),
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

describe("plan-level rewrite-path-reference", () => {
  afterEach(cleanupFixtures);

  test("resolves RM-shaped shorthand markdown paths from a declared source base and records provenance", () => {
    const donor = "app/backend/src/governance/repository.ts";
    const target = "libs/governance-backend/src/governance/repository.ts";
    const rule = ".claude/rules/backend/server.md";
    const root = fixtureRepo({
      "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
      [SOURCE]: "export const widgetValue = 1;\n",
      "app/backend/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
      [donor]: "export const repository = true;\n",
      [rule]: "Repository rules: `governance/repository.ts`.\n",
    });
    const config = fixtureConfig(root, {
      pathReferences: { textRoots: [{ root: ".claude", extensions: [".md"] }] },
      pathReferenceRewrites: { enabled: true, roots: [{ root: ".claude", extensions: [".md"], mode: "exact-path-token", referenceBase: "app/backend/src" }] },
      gates: { package: [], project: [], workspace: [] },
    });
    const move: PlanOperation = { kind: "move", source: donor, target, preconditionHash: hashText(read(root, donor)), resultHash: hashText(read(root, donor)) };
    const operations = pathReferenceRewriteOperations(config, new WorkspaceContext(config, root), [move]);

    expect(operations).toHaveLength(1);
    expect(operations[0]!.rewrites).toEqual([{
      from: "governance/repository.ts", to: target, donor, line: 1, column: 20, referenceBase: "app/backend/src",
    }]);
    expect(buildPathReferenceIndex(new WorkspaceContext(config, root)).referencesTo([donor])).toEqual([expect.objectContaining({
      file: rule, target: donor, text: "governance/repository.ts",
    })]);
    const issues = validatePlan(manifest(root, [move, operations[0]!]), { config, rootDir: root }).issues;
    expect(issues.filter((issue) => issue.rule.startsWith("path-reference"))).toEqual([]);
  });

  test("resolves a Cloudflare-shaped parent-relative token and keeps the replacement relative to the same base", () => {
    const donor = "app/backend/src/ingest/territory-zips/route-handlers.ts";
    const target = "libs/ingest-runtime/src/ingest/territory-zips/route-handlers.ts";
    const doc = "app/cloudflare-stack/tests/routes.test.ts";
    const root = fixtureRepo({
      "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
      [SOURCE]: "export const widgetValue = 1;\n",
      [donor]: "export const handlers = true;\n",
      [doc]: 'const route = "../backend/src/ingest/territory-zips/route-handlers.ts";\n',
    });
    const config = fixtureConfig(root, {
      pathReferences: { textRoots: [{ root: "app/cloudflare-stack/tests", extensions: [".ts"] }] },
      pathReferenceRewrites: { enabled: true, roots: [{ root: "app/cloudflare-stack/tests", extensions: [".ts"], mode: "exact-path-token", referenceBase: "app/cloudflare-stack" }] },
      gates: { package: [], project: [], workspace: [] },
    });
    const move: PlanOperation = { kind: "move", source: donor, target, preconditionHash: hashText(read(root, donor)), resultHash: hashText(read(root, donor)) };
    const operations = pathReferenceRewriteOperations(config, new WorkspaceContext(config, root), [move]);

    expect(operations[0]?.rewrites).toEqual([{
      from: "../backend/src/ingest/territory-zips/route-handlers.ts",
      to: "../../libs/ingest-runtime/src/ingest/territory-zips/route-handlers.ts",
      donor, line: 1, column: 16, referenceBase: "app/cloudflare-stack",
    }]);
    expect(buildPathReferenceIndex(new WorkspaceContext(config, root)).referencesTo([donor])).toEqual([expect.objectContaining({ file: doc, target: donor })]);
  });

  test("refuses a reference whose exact lexical donor traverses a symlink outside the workspace", () => {
    const doc = "app/cloudflare-stack/tests/routes.test.ts";
    const donor = "app/cloudflare-stack/linked/route-handlers.ts";
    const root = fixtureRepo({
      "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
      [SOURCE]: "export const widgetValue = 1;\n",
      [doc]: 'const route = "../linked/route-handlers.ts";\n',
    });
    const external = scratchDirectory();
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "route-handlers.ts"), "export const escaped = true;\n");
    symlinkSync(external, join(root, "app/cloudflare-stack/linked"), "dir");
    const config = fixtureConfig(root, {
      pathReferences: { textRoots: [{ root: "app/cloudflare-stack/tests", extensions: [".ts"] }] },
      pathReferenceRewrites: { enabled: true, roots: [{ root: "app/cloudflare-stack/tests", extensions: [".ts"], mode: "exact-path-token", referenceBase: "app/cloudflare-stack" }] },
      gates: { package: [], project: [], workspace: [] },
    });
    const hash = hashText(read(root, donor));
    const move: PlanOperation = { kind: "move", source: donor, target: "libs/ingest-runtime/src/route-handlers.ts", preconditionHash: hash, resultHash: hash };

    expect(pathReferenceRewriteOperations(config, new WorkspaceContext(config, root), [move])).toEqual([]);
  });

  test("compiles exactly one rewrite-path-reference operation naming the document, with correct hashes and rewrites", () => {
    const root = fixtureRepo(files());
    const config = enabledConfig(root);
    const context = new WorkspaceContext(config, root);
    const move = moveOperation(root);

    const operations = pathReferenceRewriteOperations(config, context, [move]);

    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    expect(operation.kind).toBe("rewrite-path-reference");
    expect(operation.file).toBe(DOC);
    expect(operation.documentKind).toBe("markdown");
    expect(operation.rewrites).toEqual([{ from: SOURCE, to: TARGET, donor: SOURCE, line: 1, column: 6 }]);
    expect(operation.preconditionHash).toBe(context.state(DOC));
    expect(operation.resultHash).toBe(hashText(read(root, DOC).replace(SOURCE, TARGET)));
    expect(operation.preconditionHash).not.toBe(operation.resultHash);
  });

  test("manifestPaths includes the rewritten document so snapshot/restore covers it", () => {
    const root = fixtureRepo(files());
    const config = enabledConfig(root);
    const context = new WorkspaceContext(config, root);
    const move = moveOperation(root);
    const operation = pathReferenceRewriteOperations(config, context, [move])[0]!;

    const plan = manifest(root, [move, operation]);
    expect(manifestPaths(plan)).toContain(DOC);
  });

  test("plan review is byte-identical across two compiles and names the document and the from -> to pair", () => {
    const root = fixtureRepo(files());
    const config = enabledConfig(root);
    const move = moveOperation(root);

    const first = pathReferenceRewriteOperations(config, new WorkspaceContext(config, root), [move])[0]!;
    const second = pathReferenceRewriteOperations(config, new WorkspaceContext(config, root), [move])[0]!;
    expect(second).toEqual(first);

    const planA = manifest(root, [move, first]);
    const planB = manifest(root, [move, second]);
    const summaryA = summarizePlanReview(planA, { baselinePaths: [SOURCE, DOC], manifestPath: "plans/fixture.json" });
    const summaryB = summarizePlanReview(planB, { baselinePaths: [SOURCE, DOC], manifestPath: "plans/fixture.json" });
    expect(summaryB).toEqual(summaryA);

    const renderedA = formatPlanReview(summaryA);
    const renderedB = formatPlanReview(summaryB);
    expect(renderedB).toBe(renderedA);
    expect(renderedA).toContain(DOC);
    expect(renderedA).toContain(`${SOURCE} -> ${TARGET}`);
  });

  test("validation rejects unsorted rewrites, a duplicated (from, line, column), and a documentKind that disagrees with the extension", () => {
    const root = fixtureRepo(files());
    const config = enabledConfig(root);
    const context = new WorkspaceContext(config, root);
    const move = moveOperation(root);
    const good = pathReferenceRewriteOperations(config, context, [move])[0]!;

    const secondMove: PlanOperation = { kind: "move", source: "apps/api/src/other.ts", target: "libs/values/src/other.ts", preconditionHash: "missing", resultHash: hashText("x") };
    const withSecondRewrite: RewritePathReferenceOperation = {
      ...good,
      rewrites: [
        { from: "apps/api/src/other.ts", to: "libs/values/src/other.ts", donor: "apps/api/src/other.ts", line: 2, column: 1 },
        ...good.rewrites,
      ],
    };

    const unsorted = manifest(root, [move, secondMove, withSecondRewrite]);
    expect(validatePlan(unsorted, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain("path-reference-sort");

    const duplicated: RewritePathReferenceOperation = {
      ...good,
      rewrites: [good.rewrites[0]!, { ...good.rewrites[0]!, to: "libs/values/src/other-widget.ts" }],
    };
    const duplicatePlan = manifest(root, [move, duplicated]);
    expect(validatePlan(duplicatePlan, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain("path-reference-unique");

    const wrongKind: RewritePathReferenceOperation = { ...good, documentKind: "json" };
    const wrongKindPlan = manifest(root, [move, wrongKind]);
    expect(validatePlan(wrongKindPlan, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain("path-reference-kind");
  });

  test("with pathReferenceRewrites disabled (the default) no such operation is emitted, proving the feature is opt-in", () => {
    const root = fixtureRepo(files());
    const enabled = enabledConfig(root);
    const disabled = fixtureConfig(root, { gates: { package: [], project: [], workspace: [] } });
    const move = moveOperation(root);

    expect(disabled.pathReferenceRewrites.enabled).toBe(false);
    const withDisabled = pathReferenceRewriteOperations(disabled, new WorkspaceContext(disabled, root), [move]);
    expect(withDisabled).toEqual([]);

    // The plan is otherwise identical: the same move, on the same repo, under
    // config that differs only in pathReferenceRewrites, produces the same
    // move operation and touches nothing else.
    const withEnabled = pathReferenceRewriteOperations(enabled, new WorkspaceContext(enabled, root), [move]);
    expect(withEnabled).toHaveLength(1);
    const planDisabled = manifest(root, [move]);
    const planEnabled = manifest(root, [move, withEnabled[0]!]);
    expect(planDisabled.operations.filter((operation) => operation.kind === "move")).toEqual(
      planEnabled.operations.filter((operation) => operation.kind === "move"),
    );
    expect(planDisabled.operations.some((operation) => operation.kind === "rewrite-path-reference")).toBe(false);
  });

  test(".markdown documents round-trip through compile and validate", () => {
    const markdownDoc = "docs/guide.markdown";
    const root = fixtureRepo({
      "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
      "apps/api/tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}\n',
      [SOURCE]: "export const widgetValue = 1;\n",
      [markdownDoc]: `See \`${SOURCE}\` for the implementation.\n`,
    });
    const config = fixtureConfig(root, {
      pathReferenceRewrites: {
        enabled: true,
        roots: [{ root: "docs", extensions: [".markdown"], mode: "exact-path-token" }],
      },
      gates: { package: [], project: [], workspace: [] },
    });
    const context = new WorkspaceContext(config, root);
    const move = moveOperation(root);

    // Compile the operation
    const operations = pathReferenceRewriteOperations(config, context, [move]);
    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    expect(operation.kind).toBe("rewrite-path-reference");
    expect(operation.file).toBe(markdownDoc);
    expect(operation.documentKind).toBe("markdown");

    // Validate against the manifest
    const testManifest = {
      ...manifest(root, [move, operation]),
      changedFiles: [SOURCE, TARGET, markdownDoc].sort(),
    };
    const result = validatePlan(testManifest, { config, rootDir: root });
    expect(result.issues.filter((issue) => issue.rule === "path-reference-kind")).toHaveLength(0);
  });
});
