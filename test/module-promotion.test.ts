import { afterEach, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { compileModulePromotion } from "../src/plan/module-promotion.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { commitAppliedPlan } from "../src/transaction/apply-commit.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

const SOURCE = "apps/api/src/resources/schemas.ts";
const CONSUMER = "apps/api/src/routes.ts";
const OTHER = "apps/api/src/other.ts";
const OWNED_TEST = "apps/api/src/resources/schemas.test.ts";
const TERRITORY_TEST = "apps/api/src/territory/service.test.ts";
const TERRITORY_SERVICE = "apps/api/src/territory/service.ts";

function setup(options: { cycle?: boolean; hiddenConsumer?: boolean; retireSource?: boolean; noGraphEdges?: boolean; sourceDependsOnApp?: boolean; directTests?: boolean } = {}) {
  const root = fixtureRepo({
    "package.json": '{"name":"fixture","private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
    "apps/api/package.json": '{"name":"@acme/api","private":true}\n',
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    [SOURCE]: "export const Contract = { id: 1 };\nexport type Contract = typeof Contract;\n",
    [CONSUMER]: 'import { Contract } from "./resources/schemas.ts";\nexport const route = Contract;\n',
    [OTHER]: 'import { Contract } from "./resources/schemas.ts";\nexport const other = Contract;\n',
    ...(options.directTests ? {
      [OWNED_TEST]: 'import { Contract } from "./schemas.ts";\nvoid Contract;\n',
      [TERRITORY_SERVICE]: "export const territory = true;\n",
      [TERRITORY_TEST]: 'import { Contract } from "../resources/schemas.ts";\nimport { territory } from "./service.ts";\nvoid [Contract, territory];\n',
    } : {}),
  });
  const config = fixtureConfig(root, { testKinds: { unit: ["\\.test\\.ts$"], integration: [], e2e: [] }, modulePromotions: [{ id: "resource-contracts", source: SOURCE, targetPackage: "@acme/resource-contracts", targetModule: "index", retireSource: options.retireSource ?? true }] });
  const baseline = resolveCommit(root, "HEAD");
  const dependencies: ScanReport["modules"][number]["dependencies"] = options.cycle === false && !options.sourceDependsOnApp ? [] : [{ module: "../routes.ts", resolved: CONSUMER }];
  const modules: ScanReport["modules"] = [
    { source: SOURCE, dependencies },
    { source: CONSUMER, dependencies: options.noGraphEdges || options.sourceDependsOnApp ? [] : [{ module: "./resources/schemas.ts", resolved: SOURCE }] },
    ...(options.hiddenConsumer ? [] : [{ source: OTHER, dependencies: options.noGraphEdges ? [] : [{ module: "./resources/schemas.ts", resolved: SOURCE }] }]),
    ...(options.directTests ? [
      { source: OWNED_TEST, dependencies: [{ module: "./schemas.ts", resolved: SOURCE }] },
      { source: TERRITORY_SERVICE, dependencies: [] },
      { source: TERRITORY_TEST, dependencies: [{ module: "../resources/schemas.ts", resolved: SOURCE }, { module: "./service.ts", resolved: TERRITORY_SERVICE }] },
    ] : []),
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  return { root, config, graph, baseline };
}

describe("module promotion", () => {
  test("compiles one SCC member through the normal extraction manifest with graph proofs", () => {
    const fixture = setup();
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    expect(manifest.source.files).toEqual([SOURCE]);
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, CONSUMER]);
    expect(manifest.modulePromotion?.cycleCut?.before).toEqual([SOURCE, CONSUMER]);
    expect(manifest.modulePromotion?.cycleCut?.after).toEqual([[CONSUMER]]);
    expect(manifest.operations.find((item) => item.kind === "move")?.resultHash).toBe(manifest.sourceBlobs[SOURCE]);
    expect(manifest.consumers.map((item) => item.specifiers[0]?.to)).toEqual(["@acme/resource-contracts", "@acme/resource-contracts"]);
  });

  test("promotes a singleton module when incoming imports cut architectural containment edges", () => {
    const fixture = setup({ cycle: false });
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    expect(manifest.modulePromotion?.cycleCut).toBeUndefined();
    expect(manifest.modulePromotion?.containmentCut).toEqual({ architecturalEdgesBefore: 2, architecturalEdgesAfter: 0, removedEdges: [{ from: OTHER, to: SOURCE }, { from: CONSUMER, to: SOURCE }], introducedApplicationDependencies: [] });
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, CONSUMER]);
  });

  test("refuses a singleton selection that cuts no architectural containment edge", () => {
    const fixture = setup({ cycle: false, noGraphEdges: true });
    expect(() => compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" })).toThrow(/neither a multi-module SCC nor an architectural containment edge/);
  });

  test("refuses a singleton promotion that would make the package depend on an application", () => {
    const fixture = setup({ cycle: false, sourceDependsOnApp: true });
    expect(() => compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" })).toThrow(/package dependency on application modules.*routes/);
  });

  test("refuses when the graph-derived importer proof omits a real compiler consumer", () => {
    const fixture = setup({ hiddenConsumer: true });
    expect(() => compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" })).toThrow(/importer proof differs/);
  });

  test("moves only source-owned tests and rewrites another domain's service test as a consumer", () => {
    const fixture = setup({ cycle: false, directTests: true });
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });

    expect(manifest.source.tests).toEqual([OWNED_TEST]);
    expect(manifest.consumers.map((item) => item.file)).toEqual([OTHER, CONSUMER, TERRITORY_TEST]);
    expect(manifest.modulePromotion?.importerProof).toEqual([OTHER, OWNED_TEST, CONSUMER, TERRITORY_TEST]);
    expect(manifest.operations.some((item) => item.kind === "rewrite-import" && item.file === TERRITORY_TEST)).toBe(true);
    expect(validatePlan(manifest, { config: fixture.config, rootDir: fixture.root }).issues.filter((item) => item.rule === "module-promotion-importers")).toEqual([]);
  });

  test("validation rejects importer evidence that omits a legitimately relocated test", () => {
    const fixture = setup({ cycle: false, directTests: true });
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    const promotion = manifest.modulePromotion!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, importerProof: promotion.importerProof.filter((path) => path !== OWNED_TEST) } };

    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-importers")).toBe(true);
  });

  test("validation rejects a manifest whose cycle-cut proof is made non-failing", () => {
    const fixture = setup();
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    const promotion = manifest.modulePromotion!;
    const cycleCut = promotion.cycleCut!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, cycleCut: { ...cycleCut, after: [cycleCut.before] } } };
    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-cycle-cut")).toBe(true);
  });

  test("validation rejects containment evidence whose architectural metric does not improve", () => {
    const fixture = setup({ cycle: false });
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    const promotion = manifest.modulePromotion!;
    const containmentCut = promotion.containmentCut!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, containmentCut: { ...containmentCut, architecturalEdgesAfter: containmentCut.architecturalEdgesBefore } } };
    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-containment-cut")).toBe(true);
  });

  test("a compatibility re-export still lands the move as a pure R100 commit", async () => {
    const fixture = setup({ retireSource: false });
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    expect(validatePlan(manifest, { config: fixture.config, rootDir: fixture.root }).issues.filter((item) => item.rule === "multiple-mutations")).toEqual([]);
    await executeJournal({ config: fixture.config, treeRoot: fixture.root, manifest, useGitMv: true });
    const commits = commitAppliedPlan(fixture.root, manifest, "pre-apply");
    expect(fixtureGit(fixture.root, "show", "--format=", "--name-status", "--find-renames=100%", commits.moveCommit!)).toContain(`R100\t${SOURCE}\t`);
    expect(read(fixture.root, SOURCE)).toBe('export * from "@acme/resource-contracts";\n');
    expect(auditPlanSync({ config: fixture.config, rootDir: fixture.root, manifest, skipCompileProof: true }).sourceConservation.passed).toBe(true);
  });
});
