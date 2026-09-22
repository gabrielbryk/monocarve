/**
 * Dynamic-import evidence.
 *
 * The audit records the change in dynamic imports as a multiset diff of the
 * specifiers themselves, and `DynamicImportDelta` says why: a count would be too
 * weak, because one dynamic import can be replaced by a different one and net to
 * zero. Nothing else in the suite holds that claim to account — every other
 * fixture declares an empty delta over a tree whose dynamic imports never moved
 * — so rewriting the diff as a count would pass the whole suite.
 *
 * The load-bearing case here is the one a count cannot see: one specifier out,
 * one different specifier in. Its tree is otherwise perfect, so the audit's only
 * complaint is the evidence itself, and the failure means exactly what it says.
 *
 * Every manifest below is one the validator accepts. That is deliberate: a
 * declared delta is a claim about the landed tree, and nothing before the audit
 * is in a position to check it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { rewriteResolvedImportSpecifier } from "../src/codemod/imports.ts";
import type { DynamicImportDelta, ExtractionManifest, PlanOperation } from "../src/plan/manifest.ts";
import { assertPlanValid } from "../src/plan/validate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const CONSUMER = "apps/api/src/consumer.ts";
const ALPHA = "apps/api/src/alpha.ts";
const ENTRYPOINT = "libs/analytics/src/index.ts";
const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";
const APP = "apps/api";
const BARREL = 'export * from "./widget/widget.ts";\n';
const DYNAMIC_FAILURE = "dynamic-import evidence does not match the declared plan";

/** Baseline consumer text, parameterised by the dynamic imports under test. */
function consumerSource(...dynamicLines: readonly string[]): string {
  return ['import { widgetValue } from "./widget/widget.ts";', "", "export const used = widgetValue + 1;", ...dynamicLines, ""].join("\n");
}

function fixtureFiles(consumer: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "fixture-workspace", private: true, type: "module" }, null, 2)}\n`,
    "apps/api/tsconfig.json": `${JSON.stringify({ include: ["src"] }, null, 2)}\n`,
    [DONOR]: "export const widgetValue = 1;\n",
    [ALPHA]: "export const alpha = 1;\n",
    [CONSUMER]: consumer,
    [`${PACKAGE_ROOT}/package.json`]: `${JSON.stringify(
      {
        name: PACKAGE,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        types: "./src/index.ts",
        exports: { ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" } },
      },
      null,
      2,
    )}\n`,
  };
}

/** What the codemod alone would produce for the consumer: donor -> package. */
function repointed(baseline: string, root: string): string {
  return rewriteResolvedImportSpecifier(baseline, join(root, CONSUMER), join(root, DONOR), PACKAGE);
}

function manifestFor(root: string, landedConsumer: string, delta: DynamicImportDelta): ExtractionManifest {
  const donorHash = hashText(read(root, DONOR));
  const operations: PlanOperation[] = [
    { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
    {
      kind: "rewrite-import",
      file: CONSUMER,
      donors: [DONOR],
      rewrites: [{ from: "./widget/widget.ts", to: PACKAGE }],
      preconditionHash: hashText(read(root, CONSUMER)),
      resultHash: hashText(landedConsumer),
    },
    { kind: "write-file", path: ENTRYPOINT, contents: BARREL, preconditionHash: "missing", resultHash: hashText(BARREL), generator: "scaffold:entrypoint" },
  ];

  return {
    schemaVersion: 2,
    planId: "dynamic-evidence",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("dynamic-evidence-graph"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [{ name: "widgetValue", typeOnly: false }] },
    source: { files: [DONOR], tests: [], sccs: { "scc-fixture": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash },
    operations,
    consumers: [
      {
        file: CONSUMER,
        owner: APP,
        expectedImporter: "./widget/widget.ts",
        specifiers: [{ from: "./widget/widget.ts", to: PACKAGE }],
        external: false,
        dependencySection: "runtime",
      },
    ],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, CONSUMER, ENTRYPOINT].sort(),
    expectedDynamicImportDelta: delta,
    evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 4, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: `chore(${PACKAGE}): compile extraction plan dynamic-evidence` },
      move: { subject: `refactor(${PACKAGE}): move 1 files into ${PACKAGE_ROOT}` },
      wiring: { subject: `refactor(${PACKAGE}): wire ${PACKAGE} into the workspace` },
    },
    gates: { package: [], project: [], workspace: ["true"] },
  };
}

interface Landed {
  readonly root: string;
  readonly config: ReturnType<typeof fixtureConfig>;
  readonly manifest: ExtractionManifest;
}

/**
 * A scratch repository with the extraction already landed on disk.
 *
 * `land` produces the consumer the tree ends up holding; the plan is built to
 * declare exactly those bytes, so byte fidelity, consumer completeness, the
 * boundary rules and the replay proof all pass. Whatever the audit then reports
 * is about the dynamic-import evidence and nothing else.
 */
function landed(options: {
  readonly consumer: string;
  readonly delta: DynamicImportDelta;
  readonly land?: (baseline: string, root: string) => string;
}): Landed {
  const root = fixtureRepo(fixtureFiles(options.consumer));
  const config = fixtureConfig(root);
  const land = options.land ?? repointed;
  const landedConsumer = land(read(root, CONSUMER), root);
  const manifest = manifestFor(root, landedConsumer, options.delta);

  // The validator cannot check a delta against a tree that does not exist yet,
  // and does not try: it only demands the two arrays. So a plan that lies about
  // its dynamic imports is well-formed, and the audit is the only thing between
  // that lie and a green build.
  expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();

  write(root, TARGET, read(root, DONOR));
  rmSync(join(root, DONOR));
  write(root, CONSUMER, landedConsumer);
  write(root, ENTRYPOINT, BARREL);
  return { root, config, manifest };
}

describe("dynamic-import evidence", () => {
  afterEach(cleanupFixtures);

  test("fails when one dynamic specifier replaces another and the count does not move", () => {
    // One dynamic import before, one after. A count-based check sees nothing.
    const { root, config, manifest } = landed({
      consumer: consumerSource('export const lazy = () => import("./widget/widget.ts");'),
      delta: { added: [], removed: [] },
    });
    expect(read(root, CONSUMER)).toContain(`import("${PACKAGE}")`);

    const report = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(report.passed).toBe(false);
    expect(report.graphEvidence.passed).toBe(false);
    expect(report.graphEvidence.dynamicImportDelta).toEqual({ added: [PACKAGE], removed: ["./widget/widget.ts"] });
    // The evidence is the *only* thing wrong with this tree. If this ever grows
    // a second entry, the case has stopped isolating what it claims to isolate.
    expect(report.failures).toEqual([DYNAMIC_FAILURE]);
  }, 60_000);

  test("passes when the declared delta is exactly what happened", () => {
    const { root, config, manifest } = landed({
      consumer: consumerSource('export const lazy = () => import("./widget/widget.ts");'),
      delta: { added: [PACKAGE], removed: ["./widget/widget.ts"] },
    });

    const report = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(report.graphEvidence.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  }, 60_000);

  test("diffs duplicate dynamic specifiers as a multiset, not as a set", () => {
    // Two identical dynamic imports before, one after: a set diff sees nothing
    // removed, because the specifier is still there.
    const { root, config, manifest } = landed({
      consumer: consumerSource('export const first = () => import("./alpha.ts");', 'export const second = () => import("./alpha.ts");'),
      delta: { added: [], removed: [] },
      land: (baseline, root) => repointed(baseline, root).replace('export const second = () => import("./alpha.ts");\n', ""),
    });

    const report = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(report.graphEvidence.dynamicImportDelta.removed).toEqual(["./alpha.ts"]);
    expect(report.graphEvidence.dynamicImportDelta.added).toEqual([]);
    expect(report.graphEvidence.passed).toBe(false);
    expect(report.failures).toEqual([DYNAMIC_FAILURE]);
  }, 60_000);

  test("counts a computed dynamic specifier as evidence rather than dropping it", () => {
    // `import(name)` cannot be named, so it is recorded as `<unsupported>`.
    // Dropping it would make a computed import silently becoming a literal one
    // invisible — the same blind spot as the count.
    const { root, config, manifest } = landed({
      consumer: consumerSource("export const lazy = (name: string) => import(name);"),
      delta: { added: ["./alpha.ts"], removed: ["<unsupported>"] },
      land: (baseline, root) => repointed(baseline, root).replace("import(name)", 'import("./alpha.ts")'),
    });

    const report = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(report.graphEvidence.dynamicImportDelta).toEqual({ added: ["./alpha.ts"], removed: ["<unsupported>"] });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  }, 60_000);

  test("fails when a declared dev consumer is tampered into runtime dependencies", () => {
    const { root, config, manifest } = landed({ consumer: consumerSource(), delta: { added: [], removed: [] } });
    const devManifest: ExtractionManifest = {
      ...manifest,
      consumers: manifest.consumers.map((consumer) => ({ ...consumer, dependencySection: "dev" as const })),
    };
    write(root, `${APP}/package.json`, `${JSON.stringify({ name: "@acme/api", dependencies: { [PACKAGE]: "workspace:*" } }, null, 2)}\n`);
    const report = auditPlanSync({ config, rootDir: root, manifest: devManifest, skipCompileProof: true });
    expect(report.consumerCompleteness.passed).toBe(false);
    expect(report.failures).toContain("consumer dependency section does not match manifest: apps/api/src/consumer.ts");
  }, 60_000);

  test("fails when a declared runtime consumer is tampered into dev dependencies", () => {
    const { root, config, manifest } = landed({ consumer: consumerSource(), delta: { added: [], removed: [] } });
    const runtimeManifest: ExtractionManifest = {
      ...manifest,
      consumers: manifest.consumers.map((consumer) => ({ ...consumer, dependencySection: "runtime" as const })),
    };
    write(root, `${APP}/package.json`, `${JSON.stringify({ name: "@acme/api", devDependencies: { [PACKAGE]: "workspace:*" } }, null, 2)}\n`);
    const report = auditPlanSync({ config, rootDir: root, manifest: runtimeManifest, skipCompileProof: true });
    expect(report.consumerCompleteness.passed).toBe(false);
    expect(report.failures).toContain("consumer dependency section does not match manifest: apps/api/src/consumer.ts");
  }, 60_000);
});
