/**
 * Plan validation.
 *
 * Each case is a manifest that would apply cleanly and still be wrong: an asset
 * left behind, a barrel that would eat a moved file, a write that lands on a
 * move target, a rewrite pointed at a package that does not exist, a lockfile
 * echo that disagrees with the block it claims to describe. The validator's
 * whole job is to make those unrepresentable before anything is executed.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { assertPlanValid, validatePlan } from "../src/plan/validate.ts";
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../src/adapters/registry.ts";
import { moonAdapter, noneTaskRunner } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { getApplication, resolveExtractionProfile } from "../src/config.ts";
import { buildPlanProvenance } from "../src/plan/provenance.ts";
import { hashText } from "../src/util/hash.ts";
import { PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation } from "../src/plan/manifest.ts";
import { projectedArtifactEvidence } from "../src/plan/projected-workspace.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const DONOR = "apps/api/src/widget/widget.ts";
const TARGET = "libs/analytics/src/widget/widget.ts";
const ASSET = "apps/api/src/widget/widget.css";
const ASSET_TARGET = "libs/analytics/src/widget/widget.css";
const ENTRYPOINT = "libs/analytics/src/index.ts";
const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";

const donorHash = hashText("export const widgetValue = 1;\n");
const assetHash = hashText(".widget { color: red; }\n");
const barrel = 'export * from "./widget/widget.ts";\n';

function repo(): { root: string; config: ReturnType<typeof fixtureConfig> } {
  const root = fixtureRepo({
    "package.json": '{ "name": "fixture-workspace", "private": true }\n',
    "apps/api/tsconfig.json": '{ "include": ["src"] }\n',
    [DONOR]: "export const widgetValue = 1;\n",
    [ASSET]: ".widget { color: red; }\n",
    [`${PACKAGE_ROOT}/package.json`]: `{ "name": "${PACKAGE}", "main": "./src/index.ts" }\n`,
  });
  return { root, config: fixtureConfig(root) };
}

function manifest(): ExtractionManifest {
  const operations: PlanOperation[] = [
    { kind: "move", source: DONOR, target: TARGET, preconditionHash: donorHash, resultHash: donorHash },
    { kind: "move", source: ASSET, target: ASSET_TARGET, preconditionHash: assetHash, resultHash: assetHash },
    {
      kind: "write-file",
      path: ENTRYPOINT,
      contents: barrel,
      preconditionHash: "missing",
      resultHash: hashText(barrel),
    },
  ];
  return {
    schemaVersion: 2,
    planId: "shape-fixture",
    createdAt: new Date().toISOString(),
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: "0123456789abcdef0123456789abcdef01234567",
    graphDigest: hashText("shape"),
    application: "api",
    target: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [DONOR], tests: [], assets: [ASSET], sccs: { "scc-a": [DONOR] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [DONOR]: donorHash, [ASSET]: assetHash },
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [DONOR, TARGET, ASSET, ASSET_TARGET, ENTRYPOINT].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 2, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: "chore(@acme/analytics): compile extraction plan shape-fixture" },
      move: { subject: "refactor(@acme/analytics): move 2 files into libs/analytics" },
      wiring: { subject: "refactor(@acme/analytics): wire @acme/analytics into the workspace" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
}

describe("plan validation", () => {
  afterEach(cleanupFixtures);

  test("accepts a well-formed plan", () => {
    const { root, config } = repo();
    expect(() => assertPlanValid(manifest(), { config, rootDir: root })).not.toThrow();
  });

  test("accepts legacy v2 plans and deterministic current provenance", () => {
    const { root, config } = repo();
    const profile = resolveExtractionProfile(config, getApplication(config, "api"), undefined);
    const input = { config, profileGates: profile.gates, scaffoldTemplates: profile.scaffoldTemplates, packageManager: createPackageManagerAdapter(config), taskRunner: createTaskRunnerAdapter(config), rootPackageJson: '{ "name": "fixture-workspace", "private": true }\n' };
    expect(buildPlanProvenance(input)).toEqual(buildPlanProvenance(input));
    expect(input.packageManager.declaredVersion?.('{ "packageManager": "pnpm@9.15.0" }')).toBe("9.15.0");
    const current: ExtractionManifest = { ...manifest(), schemaVersion: 3, provenance: buildPlanProvenance(input) };
    expect(validatePlan(current, { config, rootDir: root }).issues).toEqual([]);
    expect(validatePlan(manifest(), { config, rootDir: root }).issues).toEqual([]);
    const { provenance: _stripped, ...stripped } = current;
    expect(validatePlan(stripped as ExtractionManifest, { config, rootDir: root }).issues.some((issue) => issue.rule === "provenance")).toBe(true);
  });

  test("rejects independently forged provenance claims", () => {
    const { root, config } = repo();
    const profile = resolveExtractionProfile(config, getApplication(config, "api"), undefined);
    const provenance = buildPlanProvenance({ config, profileGates: profile.gates, scaffoldTemplates: profile.scaffoldTemplates, packageManager: createPackageManagerAdapter(config), taskRunner: createTaskRunnerAdapter(config), rootPackageJson: '{ "name": "fixture-workspace" }\n' });
    const cases = [
      { value: { ...provenance, configDigest: hashText("forged-config") }, rule: "config-digest" },
      { value: { ...provenance, policyDigest: hashText("forged-policy") }, rule: "policy-digest" },
      { value: { ...provenance, adapters: { ...provenance.adapters, packageManager: { ...provenance.adapters.packageManager, contractVersion: 99 } } }, rule: "adapter-provenance" },
      { value: { ...provenance, compiler: { artifactIntegrity: hashText("forged-compiler") } }, rule: "compiler-integrity" },
    ];
    for (const entry of cases) {
      const result = validatePlan({ ...manifest(), schemaVersion: 3, provenance: entry.value }, { config, rootDir: root });
      expect(result.issues.some((issue) => issue.rule === entry.rule)).toBe(true);
    }
  });

  test("rejects architectural assessment evidence whose ordering can hide a changed claim", () => {
    const { root, config } = repo();
    const profile = resolveExtractionProfile(config, getApplication(config, "api"), undefined);
    const provenance = buildPlanProvenance({ config, profileGates: profile.gates, scaffoldTemplates: profile.scaffoldTemplates, packageManager: createPackageManagerAdapter(config), taskRunner: createTaskRunnerAdapter(config), rootPackageJson: '{ "name": "fixture-workspace", "private": true }\n' });
    const assessed: ExtractionManifest = {
      ...manifest(), schemaVersion: PLAN_SCHEMA_VERSION, provenance,
      assessment: {
        status: "review-required", cohesion: "medium",
        reasons: [{ code: "high-inbound", detail: "review hub ownership", paths: ["z.ts", "a.ts"] }],
        compatibilityShims: [], targetOptions: [], selectedTarget: { packageName: PACKAGE, packageRoot: PACKAGE_ROOT, action: "extend" },
      },
    };
    expect(validatePlan(assessed, { config, rootDir: root }).issues.map(({ rule }) => rule)).toContain("assessment");
  });

  test("adapter provenance uses tracked declarations and never executable PATH state", () => {
    const { config } = repo();
    const profile = resolveExtractionProfile(config, getApplication(config, "api"), undefined);
    const base = { config, profileGates: profile.gates, scaffoldTemplates: profile.scaffoldTemplates };
    const declared = JSON.stringify({ packageManager: "pnpm@9.15.0", devDependencies: { "@moonrepo/cli": "^1.31.0" } });
    const previousPath = process.env.PATH;
    const first = buildPlanProvenance({ ...base, packageManager: pnpmAdapter, taskRunner: moonAdapter, rootPackageJson: declared });
    process.env.PATH = "/definitely/not/a/toolchain";
    try {
      expect(buildPlanProvenance({ ...base, packageManager: pnpmAdapter, taskRunner: moonAdapter, rootPackageJson: declared })).toEqual(first);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(first.adapters).toEqual({
      packageManager: { id: "pnpm", contractVersion: 1, declaredVersion: "9.15.0" },
      taskRunner: { id: "moon", contractVersion: 1, declaredVersion: "^1.31.0" },
    });
    const absent = buildPlanProvenance({ ...base, packageManager: pnpmAdapter, taskRunner: noneTaskRunner, rootPackageJson: "not-json" });
    expect(absent.adapters).toEqual({
      packageManager: { id: "pnpm", contractVersion: 1 },
      taskRunner: { id: "none", contractVersion: 1 },
    });
  });

  test("rejects forged projected artifact and dependency-decision evidence", () => {
    const { root, config } = repo();
    const base = manifest();
    const forged: ExtractionManifest = {
      ...base,
      projectedArtifacts: projectedArtifactEvidence(base.operations).map((entry) => ({ ...entry, resultHash: hashText("forged") })),
      dependencyDecisions: [{ name: "missing", decision: "target-runtime", sources: [DONOR], reasons: ["production-import"] }],
    };
    const issues = validatePlan(forged, { config, rootDir: root }).issues;
    expect(issues.some(({ rule }) => rule === "projected-artifacts")).toBeTrue();
    expect(issues.some(({ rule }) => rule === "dependency-evidence")).toBeTrue();
  });

  test("rejects incomplete dependency-decision coverage", () => {
    const { root, config } = repo();
    const base = manifest();
    const incomplete: ExtractionManifest = {
      ...base,
      dependencies: { runtime: { library: "1" }, dev: {}, packageReferences: [] },
      dependencyDecisions: [],
    };
    expect(validatePlan(incomplete, { config, rootDir: root }).issues).toContainEqual(expect.objectContaining({
      rule: "dependency-evidence", message: "missing dependency decision library:target-runtime",
    }));
  });

  test("rejects an asset that is not moved, and a TypeScript file declared as an asset", () => {
    const { root, config } = repo();
    const base = manifest();

    const missingAssetMove: ExtractionManifest = {
      ...base,
      operations: base.operations.filter((operation) => operation.kind !== "move" || operation.source !== ASSET),
      changedFiles: base.changedFiles.filter((path) => path !== ASSET && path !== ASSET_TARGET),
    };
    expect(() => assertPlanValid(missingAssetMove, { config, rootDir: root })).toThrow(
      "operations must move every source, test, and asset exactly once",
    );

    const sourceAsAsset: ExtractionManifest = { ...base, source: { ...base.source, assets: [DONOR] } };
    expect(() => assertPlanValid(sourceAsAsset, { config, rootDir: root })).toThrow(
      "source.assets must not contain configured source modules",
    );
  });

  test("rejects a multi-line commit subject", () => {
    const { root, config } = repo();
    const base = manifest();
    const broken: ExtractionManifest = {
      ...base,
      commits: { ...base.commits, move: { subject: "refactor(x): move\nrogue trailer" } },
    };
    expect(() => assertPlanValid(broken, { config, rootDir: root })).toThrow("invalid Conventional Commit");
  });

  test("rejects a barrel that would be overwritten by a moved file", () => {
    const { root, config } = repo();
    const base = manifest();
    const collision: ExtractionManifest = {
      ...base,
      source: { files: [DONOR], tests: [], sccs: { "scc-a": [DONOR] } },
      sourceBlobs: { [DONOR]: donorHash },
      changedFiles: [DONOR, ENTRYPOINT].sort(),
      operations: [
        { kind: "move", source: DONOR, target: ENTRYPOINT, preconditionHash: donorHash, resultHash: donorHash },
        {
          kind: "write-file",
          path: ENTRYPOINT,
          contents: barrel,
          preconditionHash: "missing",
          resultHash: hashText(barrel),
        },
      ],
    };
    expect(() => assertPlanValid(collision, { config, rootDir: root })).toThrow("barrel self-import");
  });

  test("rejects a write that lands on a move target, whatever the order", () => {
    const { root, config } = repo();
    const base = manifest();
    const writeBeforeMove: ExtractionManifest = {
      ...base,
      operations: [
        {
          kind: "write-file",
          path: TARGET,
          contents: barrel,
          preconditionHash: "missing",
          resultHash: hashText(barrel),
        },
        ...base.operations,
      ],
    };
    expect(() => assertPlanValid(writeBeforeMove, { config, rootDir: root })).toThrow(
      `multiple operations mutate ${TARGET}`,
    );
  });

  test("rejects move-with-rewrite whose target is not an existing package, or which rewrites nothing", () => {
    const { root, config } = repo();
    const base = manifest();

    const badTarget: ExtractionManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "move" && operation.source === DONOR
          ? {
              kind: "move-with-rewrite",
              source: DONOR,
              target: TARGET,
              rewrites: [{ donorlessSpecifier: "../shared/helper.ts", packageSpecifier: "@acme/not-a-package" }],
              preconditionHash: donorHash,
              resultHash: hashText("rewritten"),
            }
          : operation,
      ),
    };
    expect(() => assertPlanValid(badTarget, { config, rootDir: root })).toThrow("not an existing workspace package");

    const emptyRewrites: ExtractionManifest = {
      ...base,
      operations: base.operations.map((operation) =>
        operation.kind === "move" && operation.source === DONOR
          ? {
              kind: "move-with-rewrite",
              source: DONOR,
              target: TARGET,
              rewrites: [],
              preconditionHash: donorHash,
              resultHash: hashText("rewritten"),
            }
          : operation,
      ),
    };
    expect(() => assertPlanValid(emptyRewrites, { config, rootDir: root })).toThrow("at least one rewrite");
  });

  test("rejects a lockfile echo that disagrees with the block it describes", () => {
    const { root, config } = repo();
    const base = manifest();
    const block = "  libs/analytics:\n    dependencies: {}\n\n";
    const drifted: ExtractionManifest = {
      ...base,
      lockfileImporter: { packageRoot: PACKAGE_ROOT, hash: hashText("wrong") },
      changedFiles: [...base.changedFiles, "pnpm-lock.yaml"].sort(),
      operations: [
        ...base.operations,
        {
          kind: "lockfile-importer",
          lockfile: "pnpm-lock.yaml",
          packageRoot: PACKAGE_ROOT,
          block,
          mode: "insert",
          preconditionHash: hashText("before"),
          resultHash: hashText("after"),
        },
      ],
    };
    expect(() => assertPlanValid(drifted, { config, rootDir: root })).toThrow(
      "lockfileImporter.hash must be the SHA-256 of the declared importer block",
    );
  });

  test("rejects an importer insert aimed at an application, and a duplicate importer operation", () => {
    const { root, config } = repo();
    const base = manifest();
    const block = "  apps/api:\n    dependencies: {}\n\n";
    const insertingAnApp: ExtractionManifest = {
      ...base,
      changedFiles: [...base.changedFiles, "pnpm-lock.yaml"].sort(),
      operations: [
        ...base.operations,
        {
          kind: "lockfile-importer",
          lockfile: "pnpm-lock.yaml",
          packageRoot: "apps/api",
          block,
          mode: "insert",
          preconditionHash: hashText("before"),
          resultHash: hashText("after"),
        },
      ],
    };
    expect(() => assertPlanValid(insertingAnApp, { config, rootDir: root })).toThrow(
      "lockfile importer must target a workspace package",
    );

    const duplicated: ExtractionManifest = {
      ...base,
      operations: [...base.operations, base.operations[0]!],
    };
    expect(() => assertPlanValid(duplicated, { config, rootDir: root })).toThrow("duplicate operation");
  });

  test("rejects changedFiles that do not match the operation paths, and a missing package reference", () => {
    const { root, config } = repo();
    const base = manifest();

    expect(() => assertPlanValid({ ...base, changedFiles: [DONOR] }, { config, rootDir: root })).toThrow(
      "changedFiles must exactly match operation paths",
    );

    const missingReference: ExtractionManifest = {
      ...base,
      dependencies: { runtime: {}, dev: {}, packageReferences: ["libs/does-not-exist"] },
    };
    expect(() => assertPlanValid(missingReference, { config, rootDir: root })).toThrow(
      "package reference does not exist",
    );
  });

  test("rejects an SCC map that does not partition the production files", () => {
    const { root, config } = repo();
    const base = manifest();
    const broken: ExtractionManifest = { ...base, source: { ...base.source, sccs: { "scc-a": [ASSET] } } };
    const result = validatePlan(broken, { config, rootDir: root });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.rule === "scc-partition")).toBe(true);
  });

  test("reports every error at once rather than only the first", () => {
    const { root, config } = repo();
    const base = manifest();
    const broken: ExtractionManifest = {
      ...base,
      graphDigest: "not-a-hash",
      target: { ...base.target, packageName: "not scoped" },
    };
    const result = validatePlan(broken, { config, rootDir: root });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.severity === "error").length).toBeGreaterThanOrEqual(2);
  });

  test("keeps independently-owned validation families in reviewable issue order", () => {
    const { root, config } = repo();
    const base = manifest();
    const broken: ExtractionManifest = {
      ...base,
      graphDigest: "not-a-hash",
      target: { ...base.target, packageName: "not scoped" },
      commits: { ...base.commits, move: { subject: "invalid" } },
    };

    // A refactor may split rule families, but it must not reshuffle their
    // review output: callers use this deterministic order to diagnose a
    // forged manifest without diffing an incidental traversal order.
    expect(validatePlan(broken, { config, rootDir: root }).issues.map((issue) => issue.rule)).toEqual([
      "graph-digest",
      "target-name",
      "commit-subject",
    ]);
  });
});
