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

function setup(options: { cycle?: boolean; hiddenConsumer?: boolean; retireSource?: boolean } = {}) {
  const root = fixtureRepo({
    "package.json": '{"name":"fixture","private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'libs/*'\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
    "apps/api/package.json": '{"name":"@acme/api","private":true}\n',
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }),
    [SOURCE]: "export const Contract = { id: 1 };\nexport type Contract = typeof Contract;\n",
    [CONSUMER]: 'import { Contract } from "./resources/schemas.ts";\nexport const route = Contract;\n',
    [OTHER]: 'import { Contract } from "./resources/schemas.ts";\nexport const other = Contract;\n',
  });
  const config = fixtureConfig(root, { modulePromotions: [{ id: "resource-contracts", source: SOURCE, targetPackage: "@acme/resource-contracts", targetModule: "index", retireSource: options.retireSource ?? true }] });
  const baseline = resolveCommit(root, "HEAD");
  const dependencies: ScanReport["modules"][number]["dependencies"] = options.cycle === false ? [] : [{ module: "../routes.ts", resolved: CONSUMER }];
  const modules: ScanReport["modules"] = [
    { source: SOURCE, dependencies },
    { source: CONSUMER, dependencies: [{ module: "./resources/schemas.ts", resolved: SOURCE }] },
    ...(options.hiddenConsumer ? [] : [{ source: OTHER, dependencies: [{ module: "./resources/schemas.ts", resolved: SOURCE }] }]),
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
    expect(manifest.modulePromotion?.cycleCut.before).toEqual([SOURCE, CONSUMER]);
    expect(manifest.modulePromotion?.cycleCut.after).toEqual([[CONSUMER]]);
    expect(manifest.operations.find((item) => item.kind === "move")?.resultHash).toBe(manifest.sourceBlobs[SOURCE]);
    expect(manifest.consumers.map((item) => item.specifiers[0]?.to)).toEqual(["@acme/resource-contracts", "@acme/resource-contracts"]);
  });

  test("refuses a selection that does not cut a multi-module SCC", () => {
    const fixture = setup({ cycle: false });
    expect(() => compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" })).toThrow(/does not cut a multi-module SCC/);
  });

  test("refuses when the graph-derived importer proof omits a real compiler consumer", () => {
    const fixture = setup({ hiddenConsumer: true });
    expect(() => compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" })).toThrow(/importer proof differs/);
  });

  test("validation rejects a manifest whose cycle-cut proof is made non-failing", () => {
    const fixture = setup();
    const manifest = compileModulePromotion({ rootDir: fixture.root, config: fixture.config, graph: fixture.graph, context: new WorkspaceContext(fixture.config, fixture.root), baselineCommit: fixture.baseline.commit, promotionId: "resource-contracts" });
    const promotion = manifest.modulePromotion!;
    const tampered = { ...manifest, modulePromotion: { ...promotion, cycleCut: { ...promotion.cycleCut, after: [promotion.cycleCut.before] } } };
    expect(validatePlan(tampered, { config: fixture.config, rootDir: fixture.root }).issues.some((item) => item.rule === "module-promotion-cycle-cut")).toBe(true);
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
