import { afterEach, describe, expect, test } from "bun:test";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../src/adapters/registry.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { serializeManifest } from "../src/plan/build.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { compileModulePromotion, modulePromotionImporterEvidence } from "../src/plan/module-promotion.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { commitAppliedPlan } from "../src/transaction/apply-commit.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { inspectCommitChain } from "../src/transaction/commit-evidence.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { classifyLifecycle } from "../src/transaction/lifecycle-status.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { runIn } from "./support/cli.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";
import { landManifest } from "./support/transaction-fixture.ts";

afterEach(cleanupFixtures);

const SOURCE = "apps/api/src/resources/schemas.ts";
const CONSUMER = "apps/api/src/routes.ts";
const OTHER = "apps/api/src/other.ts";
const OWNED_TEST = "apps/api/src/resources/schemas.test.ts";
const TERRITORY_TEST = "apps/api/src/territory/service.test.ts";
const TERRITORY_SERVICE = "apps/api/src/territory/service.ts";
const CONSUMER_ROOT_TEST = "apps/api/tests/admin/helpers.test.ts";

function setup(
  options: {
    cycle?: boolean;
    hiddenConsumer?: boolean;
    retireSource?: boolean;
    noGraphEdges?: boolean;
    sourceDependsOnApp?: boolean;
    directTests?: boolean;
    consumerRootTest?: boolean;
    subpathSurface?: boolean;
    existingTarget?: boolean;
    targetModule?: string;
  } = {},
) {
  const root = fixtureRepo({
    "package.json": '{"name":"fixture","private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n${options.existingTarget ? "\n  libs/resource-contracts: {}\n" : ""}`,
    "apps/api/package.json": '{"name":"@acme/api","private":true}\n',
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    [SOURCE]: "export const Contract = { id: 1 };\nexport type Contract = typeof Contract;\n",
    [CONSUMER]: 'import { Contract } from "./resources/schemas.ts";\nexport const route = Contract;\n',
    [OTHER]: 'import { Contract } from "./resources/schemas.ts";\nexport const other = Contract;\n',
    ...(options.directTests
      ? {
          [OWNED_TEST]: 'import { Contract } from "./schemas.ts";\nvoid Contract;\n',
          [TERRITORY_SERVICE]: "export const territory = true;\n",
          [TERRITORY_TEST]: 'import { Contract } from "../resources/schemas.ts";\nimport { territory } from "./service.ts";\nvoid [Contract, territory];\n',
        }
      : {}),
    ...(options.consumerRootTest ? { [CONSUMER_ROOT_TEST]: 'import { Contract } from "../../src/resources/schemas.ts";\nvoid Contract;\n' } : {}),
    ...(options.existingTarget
      ? {
          "libs/resource-contracts/package.json": `${JSON.stringify({ name: "@acme/resource-contracts", version: "0.1.0", private: true, type: "module", exports: { ".": "./src/index.ts", "./product-data-scope": "./src/resources/schemas.ts" } }, null, 2)}\n`,
          "libs/resource-contracts/src/index.ts": "export const existing = true;\n",
        }
      : {}),
  });
  const config = fixtureConfig(root, {
    applications: [
      {
        name: "api",
        sourceRoot: "apps/api/src",
        consumerRoots: options.consumerRootTest ? ["apps/api/tests"] : [],
        tsconfig: "apps/api/tsconfig.json",
        packageName: "@acme/api",
        compositionRoots: [],
      },
    ],
    testKinds: { unit: ["\\.test\\.ts$"], integration: [], e2e: [] },
    ...(options.subpathSurface
      ? {
          scaffoldTemplates: {
            entrypoint: "src/index.ts",
            publicSurface: { mode: "subpaths", keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" },
            packageJson: {
              contents: `${JSON.stringify({ name: "{package}", version: "0.1.0", private: true, type: "module", exports: { ".": "./src/index.ts" } }, null, 2)}\n`,
            },
          },
        }
      : {}),
    modulePromotions: [
      {
        id: "resource-contracts",
        source: SOURCE,
        targetPackage: "@acme/resource-contracts",
        targetModule: options.targetModule ?? "index",
        retireSource: options.retireSource ?? true,
      },
    ],
  });
  const baseline = resolveCommit(root, "HEAD");
  const dependencies: ScanReport["modules"][number]["dependencies"] =
    options.cycle === false && !options.sourceDependsOnApp ? [] : [{ module: "../routes.ts", resolved: CONSUMER }];
  const modules: ScanReport["modules"] = [
    { source: SOURCE, dependencies },
    { source: CONSUMER, dependencies: options.noGraphEdges || options.sourceDependsOnApp ? [] : [{ module: "./resources/schemas.ts", resolved: SOURCE }] },
    ...(options.hiddenConsumer ? [] : [{ source: OTHER, dependencies: options.noGraphEdges ? [] : [{ module: "./resources/schemas.ts", resolved: SOURCE }] }]),
    ...(options.directTests
      ? [
          { source: OWNED_TEST, dependencies: [{ module: "./schemas.ts", resolved: SOURCE }] },
          { source: TERRITORY_SERVICE, dependencies: [] },
          {
            source: TERRITORY_TEST,
            dependencies: [
              { module: "../resources/schemas.ts", resolved: SOURCE },
              { module: "./service.ts", resolved: TERRITORY_SERVICE },
            ],
          },
        ]
      : []),
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  return { root, config, graph, baseline };
}

describe("module promotion", () => {
  test("compiles one SCC member through the normal extraction manifest with graph proofs", () => {
    const fixture = setup();
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    expect(manifest.source.files).toEqual([SOURCE]);
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, CONSUMER]);
    expect(manifest.modulePromotion?.cycleCut?.before).toEqual([SOURCE, CONSUMER]);
    expect(manifest.modulePromotion?.cycleCut?.after).toEqual([[CONSUMER]]);
    const move = manifest.operations.find((item) => item.kind === "move");
    expect(move?.resultHash).toBe(manifest.sourceBlobs[SOURCE]);
    expect(move?.target).toBe("libs/resource-contracts/src/index.ts");
    expect(manifest.target.publicModules?.[0]?.target).toBe("libs/resource-contracts/src/index.ts");
    expect(manifest.operations.some((item) => item.kind === "write-file" && item.path === "libs/resource-contracts/src/index.ts")).toBe(false);
    expect(manifest.consumers.map((item) => item.specifiers[0]?.to)).toEqual(["@acme/resource-contracts", "@acme/resource-contracts"]);
  });

  test("promotes a singleton module when incoming imports cut architectural containment edges", () => {
    const fixture = setup({ cycle: false });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    expect(manifest.modulePromotion?.cycleCut).toBeUndefined();
    expect(manifest.modulePromotion?.containmentCut).toEqual({
      architecturalEdgesBefore: 2,
      architecturalEdgesAfter: 0,
      removedEdges: [
        { from: OTHER, to: SOURCE },
        { from: CONSUMER, to: SOURCE },
      ],
      introducedApplicationDependencies: [],
    });
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, CONSUMER]);
  });

  test("refuses a singleton selection that cuts no architectural containment edge", () => {
    const fixture = setup({ cycle: false, noGraphEdges: true });
    expect(() =>
      compileModulePromotion({
        rootDir: fixture.root,
        config: fixture.config,
        graph: fixture.graph,
        context: new WorkspaceContext(fixture.config, fixture.root),
        baselineCommit: fixture.baseline.commit,
        promotionId: "resource-contracts",
      }),
    ).toThrow(/neither a multi-module SCC nor an architectural containment edge/);
  });

  test("refuses a singleton promotion that would make the package depend on an application", () => {
    const fixture = setup({ cycle: false, sourceDependsOnApp: true });
    expect(() =>
      compileModulePromotion({
        rootDir: fixture.root,
        config: fixture.config,
        graph: fixture.graph,
        context: new WorkspaceContext(fixture.config, fixture.root),
        baselineCommit: fixture.baseline.commit,
        promotionId: "resource-contracts",
      }),
    ).toThrow(/package dependency on application modules.*routes/);
  });

  test("augments graph importer evidence from the compiler reference index", () => {
    const fixture = setup({ hiddenConsumer: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    expect(fixture.graph.incoming.get(SOURCE)).not.toContain(OTHER);
    expect(manifest.modulePromotion?.importerProof).toContain(OTHER);
    expect(manifest.consumers.map((item) => item.file)).toContain(OTHER);
  });

  test("moves only source-owned tests and rewrites another domain's service test as a consumer", async () => {
    const fixture = setup({ cycle: false, directTests: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });

    expect(manifest.source.tests).toEqual([OWNED_TEST]);
    const ownedTestMove = manifest.operations.find((item) => item.kind === "move-with-rewrite" && item.source === OWNED_TEST);
    expect(ownedTestMove?.kind === "move-with-rewrite" ? ownedTestMove.rewrites : undefined).toEqual([
      { donorlessSpecifier: "./schemas.ts", packageSpecifier: "@acme/resource-contracts" },
    ]);
    expect(manifest.consumers.map((item) => item.file)).toEqual([OTHER, CONSUMER, TERRITORY_TEST]);
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, OWNED_TEST, CONSUMER, TERRITORY_TEST]);
    expect(manifest.operations.some((item) => item.kind === "rewrite-import" && item.file === TERRITORY_TEST)).toBe(true);
    expect(
      validatePlan(manifest, { config: fixture.config, rootDir: fixture.root }).issues.filter((item) => item.rule === "module-promotion-importers"),
    ).toEqual([]);
    expect(validatePlan(manifest, { config: fixture.config, rootDir: fixture.root }).issues.filter((item) => item.rule === "rewrite-target")).toEqual([]);
    await executeJournal({ config: fixture.config, treeRoot: fixture.root, manifest, useGitMv: false });
    expect(auditPlanSync({ rootDir: fixture.root, config: fixture.config, manifest }).passed).toBe(true);
  });

  test("rewrites an associated test to an existing package's promoted public subpath", async () => {
    const fixture = setup({ cycle: false, directTests: true, existingTarget: true, subpathSurface: true, targetModule: "product-data-scope" });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const movedTest = manifest.operations.find((item) => item.kind === "move-with-rewrite" && item.source === OWNED_TEST);
    expect(manifest.target.publicModules?.find((item) => item.source === SOURCE)?.specifier).toBe("@acme/resource-contracts/product-data-scope");
    expect(movedTest?.kind === "move-with-rewrite" ? movedTest.rewrites : undefined).toEqual([
      { donorlessSpecifier: "./schemas.ts", packageSpecifier: "@acme/resource-contracts/product-data-scope" },
    ]);

    const simulation = await simulatePlan({ config: fixture.config, rootDir: fixture.root, manifest, skipGates: true });
    expect(simulation.ok, simulation.failure).toBe(true);
    await executeJournal({ config: fixture.config, treeRoot: fixture.root, manifest, useGitMv: false });
    expect(auditPlanSync({ rootDir: fixture.root, config: fixture.config, manifest }).passed).toBe(true);

    if (movedTest?.kind !== "move-with-rewrite") throw new Error("fixture has no rewritten associated test");
    const tampered = {
      ...manifest,
      operations: manifest.operations.map((operation) =>
        operation === movedTest ? { ...operation, rewrites: [{ ...operation.rewrites[0]!, packageSpecifier: "@acme/resource-contracts" }] } : operation,
      ),
    };
    const tamperedAudit = auditPlanSync({ rootDir: fixture.root, config: fixture.config, manifest: tampered });
    expect(tamperedAudit.passed).toBe(false);
    expect(tamperedAudit.codemodReplay.passed).toBe(false);
  }, 120_000);

  test("committed promotion with a rewritten owned test has an exact applied lifecycle", async () => {
    const fixture = setup({ cycle: false, directTests: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const manifestPath = landManifest(fixture.root, manifest);

    const applied = await applyPlan({ config: fixture.config, rootDir: fixture.root, manifest, manifestPath, commit: true });
    expect(applied.ok).toBe(true);
    const chain = inspectCommitChain({ rootDir: fixture.root, manifest, manifestPath });
    expect(chain).toMatchObject({ valid: true, phase: "applied" });
    expect(classifyLifecycle({ manifestPath, atBaseline: false, planWritten: true, chain, currentTreeValid: true }).state).toBe("applied");
    expect(auditPlanSync({ rootDir: fixture.root, config: fixture.config, manifest }).passed).toBe(true);

    write(fixture.root, "libs/resource-contracts/src/resources/schemas.test.ts", "tampered\n");
    fixtureGit(fixture.root, "add", "--", "libs/resource-contracts/src/resources/schemas.test.ts");
    fixtureGit(fixture.root, "commit", "--amend", "--no-edit", "-q");
    const tampered = inspectCommitChain({ rootDir: fixture.root, manifest, manifestPath });
    expect(tampered.valid).toBeFalse();
    expect(tampered.failures).toContain("wiring bytes do not match the manifest: libs/resource-contracts/src/resources/schemas.test.ts");
  }, 120_000);

  test("validation rejects importer evidence that omits a legitimately relocated test", () => {
    const fixture = setup({ cycle: false, directTests: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const promotion = manifest.modulePromotion!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, importerProof: promotion.importerProof.filter((path) => path !== OWNED_TEST) } };

    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-importers")).toBe(
      true,
    );
  });

  test("reviews and rewrites a test importer from a configured consumer root", () => {
    const fixture = setup({ cycle: false, consumerRootTest: true });
    const context = new WorkspaceContext(fixture.config, fixture.root);
    expect(modulePromotionImporterEvidence({ graph: fixture.graph, context, source: SOURCE })).toEqual([OTHER, CONSUMER, CONSUMER_ROOT_TEST]);

    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context,
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    expect(manifest.source.tests).toEqual([]);
    expect(manifest.consumers.map((item) => item.file)).toEqual([OTHER, CONSUMER, CONSUMER_ROOT_TEST]);
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, CONSUMER, CONSUMER_ROOT_TEST]);
    expect(manifest.operations.some((item) => item.kind === "rewrite-import" && item.file === CONSUMER_ROOT_TEST)).toBe(true);
  });

  test("boundary simulate and non-committing apply route a schema-v3 promotion as extraction", async () => {
    const fixture = setup({ cycle: false, subpathSurface: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const planPath = "resource-contracts-v3.json";
    write(fixture.root, planPath, serializeManifest(manifest));

    const simulated = await runIn(fixture.root, "boundary", "simulate", "--plan", planPath, "--json");
    expect(simulated.code).toBe(0);
    expect(JSON.parse(simulated.stdout).planId).toBe(manifest.planId);
    const applied = await runIn(fixture.root, "boundary", "apply", "--plan", planPath, "--json");
    expect(applied.code, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ ok: true, planId: manifest.planId, rolledBack: false });

    const invalidPath = "resource-contracts-v3-invalid.json";
    write(fixture.root, invalidPath, serializeManifest({ ...manifest, modulePromotion: { ...manifest.modulePromotion!, importerProof: [] } }));
    const invalid = await runIn(fixture.root, "boundary", "apply", "--plan", invalidPath, "--json");
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("module promotion importer proof");
    expect(invalid.stderr).not.toContain("groups.length");

    await executeJournal({ config: fixture.config, treeRoot: fixture.root, manifest, useGitMv: false });
    expect(read(fixture.root, "libs/resource-contracts/src/index.ts")).toBe("export const Contract = { id: 1 };\nexport type Contract = typeof Contract;\n");
    expect(auditPlanSync({ rootDir: fixture.root, config: fixture.config, manifest }).passed).toBe(true);
  }, 30_000);

  test("validation rejects a manifest whose cycle-cut proof is made non-failing", () => {
    const fixture = setup();
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const promotion = manifest.modulePromotion!;
    const cycleCut = promotion.cycleCut!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, cycleCut: { ...cycleCut, after: [cycleCut.before] } } };
    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-cycle-cut")).toBe(
      true,
    );
  });

  test("validation rejects containment evidence whose architectural metric does not improve", () => {
    const fixture = setup({ cycle: false });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const promotion = manifest.modulePromotion!;
    const containmentCut = promotion.containmentCut!;
    const tampered = {
      ...manifest,
      modulePromotion: { ...promotion, containmentCut: { ...containmentCut, architecturalEdgesAfter: containmentCut.architecturalEdgesBefore } },
    };
    expect(
      validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-containment-cut"),
    ).toBe(true);
  });

  test("validation rejects a root promotion whose public target is not the byte-identical move", () => {
    const fixture = setup({ cycle: false });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const rootModule = manifest.target.publicModules![0]!;
    const tampered = {
      ...manifest,
      target: { ...manifest.target, publicModules: [{ ...rootModule, target: "libs/resource-contracts/src/resources/schemas.ts" }] },
    };

    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "target-subpaths")).toBe(true);
  });

  test("validation refuses two production owners of the package entrypoint", () => {
    const fixture = setup({ cycle: false, subpathSurface: true });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    const rootModule = manifest.target.publicModules![0]!;
    expect(() =>
      packageOperations({
        context: new WorkspaceContext(fixture.config, fixture.root),
        config: fixture.config,
        application: fixture.config.applications[0]!,
        packageManager: createPackageManagerAdapter(fixture.config),
        taskRunner: createTaskRunnerAdapter(fixture.config),
        packageName: manifest.target.packageName,
        packageRoot: manifest.target.packageRoot,
        projectId: "resource-contracts",
        production: [SOURCE, CONSUMER],
        tests: [],
        assets: [],
        publicModules: [rootModule, { ...rootModule, source: CONSUMER }],
        dependencies: { runtime: {}, dev: {}, packageReferences: [] },
      }),
    ).toThrow(/multiple production modules claim package entrypoint/);
  });

  test("a compatibility re-export still lands the move as a pure R100 commit", async () => {
    const fixture = setup({ retireSource: false });
    const manifest = compileModulePromotion({
      rootDir: fixture.root,
      config: fixture.config,
      graph: fixture.graph,
      context: new WorkspaceContext(fixture.config, fixture.root),
      baselineCommit: fixture.baseline.commit,
      promotionId: "resource-contracts",
    });
    expect(validatePlan(manifest, { config: fixture.config, rootDir: fixture.root }).issues.filter((item) => item.rule === "multiple-mutations")).toEqual([]);
    await executeJournal({ config: fixture.config, treeRoot: fixture.root, manifest, useGitMv: true });
    const commits = commitAppliedPlan(fixture.root, manifest, "pre-apply");
    expect(fixtureGit(fixture.root, "show", "--format=", "--name-status", "--find-renames=100%", commits.moveCommit!)).toContain(`R100\t${SOURCE}\t`);
    expect(read(fixture.root, SOURCE)).toBe('export * from "@acme/resource-contracts";\n');
    expect(auditPlanSync({ config: fixture.config, rootDir: fixture.root, manifest, skipCompileProof: true }).sourceConservation.passed).toBe(true);
  });
});
