import { afterEach, describe, expect, test } from "bun:test";
import ts from "typescript";

import { advanceCampaign } from "../src/campaign/advance.ts";
import { appendCampaignChild, createCampaignLedger, recordCampaignChildApplication } from "../src/campaign/ledger.ts";
import { applyPreparation } from "../src/prepare/apply.ts";
import { auditPreparationSync } from "../src/prepare/audit.ts";
import { compilePreparationManifest } from "../src/prepare/build.ts";
import { preparationCompilerOptions } from "../src/prepare/compiler-policy.ts";
import { executePreparationJournal, verifyPreparationOperations } from "../src/prepare/journal.ts";
import { serializePreparationManifest, validatePreparationManifest } from "../src/prepare/manifest.ts";
import { selectTypeOnlyDeclarations } from "../src/prepare/selectors.ts";
import { commitPreparationScope, preparationFilesystemOperations, simulatePreparation } from "../src/prepare/simulate.ts";
import { planSeam } from "../src/seams/plan.ts";
import { classifyTypeOnlyExtraction } from "../src/seams/safety.ts";
import { analyzeTypeScriptSource } from "../src/symbols/analyze.ts";
import { analyzeWorkspaceSymbols } from "../src/symbols/workspace.ts";
import { hashJson } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";
import { PREPARATION_DONOR, PREPARATION_TARGET, preparationFixture } from "./support/preparation-fixture.ts";

function contractPlan() {
  const fixture = preparationFixture();
  const analysis = analyzeWorkspaceSymbols({
    rootDir: fixture.root,
    tsconfigPath: "apps/api/tsconfig.json",
    sourcePath: PREPARATION_DONOR,
    affinityForPath: () => "billing",
  });
  const candidate = analysis.splitCandidates.find((entry) => entry.names.includes("Contract"));
  if (!candidate) throw new Error("fixture did not produce the Contract split candidate");
  const seam = planSeam({ analysis, sourceText: read(fixture.root, PREPARATION_DONOR), candidateId: candidate.id, targetPath: PREPARATION_TARGET });
  const selection = selectTypeOnlyDeclarations({
    sourcePath: PREPARATION_DONOR,
    sourceText: read(fixture.root, PREPARATION_DONOR),
    groupIds: seam.movedGroups.map((group) => group.id),
    compilerOptions: preparationCompilerOptions(fixture.root, fixture.config, PREPARATION_DONOR),
  });
  const manifest = compilePreparationManifest({
    rootDir: fixture.root,
    config: fixture.config,
    baselineCommit: "HEAD",
    graphDigest: hashJson(analysis),
    seam,
    targetPath: PREPARATION_TARGET,
    targetModuleSpecifier: "./contracts-types.ts",
    reviewedGroupIds: seam.movedGroups.map((group) => group.id),
    rendering: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare contract types" } },
  });
  return { fixture, analysis, seam, selection, manifest };
}

function graphSnapshot(analysis: ReturnType<typeof analyzeWorkspaceSymbols>) {
  const metrics = { groups: analysis.source.groups.length };
  return { digest: hashJson(metrics), metrics };
}

function snapshot(root: string, sourcePath: string) {
  const analysis = analyzeWorkspaceSymbols({ rootDir: root, tsconfigPath: "apps/api/tsconfig.json", sourcePath, affinityForPath: () => "billing" });
  return graphSnapshot(analysis);
}

afterEach(cleanupFixtures);

describe("type-only seam preparation", () => {
  test("plans, simulates, applies, audits, rescans, then permits its dependent extraction", async () => {
    const { fixture, analysis, seam, selection, manifest } = contractPlan();
    const group = seam.movedGroups[0];
    if (!group) throw new Error("fixture seam has no moved group");
    const safety = classifyTypeOnlyExtraction({
      sourceText: read(fixture.root, PREPARATION_DONOR),
      graph: analysis.source,
      groupId: group.id,
      selectedDeclarationIds: group.declarationIds,
    });
    expect(safety.eligible).toBe(true);
    expect(selection.closureGroupIds).toEqual([group.id]);
    expect(manifest.changedFiles).toEqual([PREPARATION_TARGET, PREPARATION_DONOR]);

    const simulation = await simulatePreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });
    expect(simulation.ok).toBe(true);
    expect(simulation.audit?.passed).toBe(true);
    const operations = preparationFilesystemOperations(manifest);
    verifyPreparationOperations(fixture.root, operations);
    expect(executePreparationJournal({ rootDir: fixture.root, operations }).applied).toEqual(operations.map((operation) => operation.path));
    commitPreparationScope(fixture.root, manifest, true);
    const preparationAudit = auditPreparationSync({
      config: fixture.config,
      rootDir: fixture.root,
      manifest,
      freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest },
    });
    expect(preparationAudit.passed).toBe(true);
    expect(read(fixture.root, PREPARATION_DONOR)).toContain('export type { Contract } from "./contracts-types.ts";');

    const before = graphSnapshot(analysis);
    const after = snapshot(fixture.root, PREPARATION_TARGET);
    const preparationChild = {
      id: "prepare-contract-types",
      pairId: "contract-types",
      kind: "preparation" as const,
      planId: manifest.planId,
      baselineCommit: manifest.baseline.commit,
    };
    const ledger = appendCampaignChild(
      createCampaignLedger({
        campaignId: "contract-seam",
        objective: "prepare a contract seam",
        stopConditions: [],
        baselineCommit: manifest.baseline.commit,
        initialGraph: before,
      }),
      preparationChild,
    );
    const applied = recordCampaignChildApplication(ledger, {
      childId: preparationChild.id,
      resultingCommit: fixtureGit(fixture.root, "rev-parse", "HEAD"),
      audit: { kind: "preparation", report: preparationAudit, digest: hashJson(preparationAudit) },
      graph: { before, after },
    });
    const result = await advanceCampaign({
      campaign: applied,
      headCommit: () => fixtureGit(fixture.root, "rev-parse", "HEAD"),
      rescan: () => snapshot(fixture.root, PREPARATION_TARGET),
      compileNext: ({ headCommit }) => ({
        id: "extract-contract-boundary",
        pairId: "contract-types",
        kind: "extraction",
        planId: "reviewed-dependent-extraction",
        baselineCommit: headCommit,
      }),
    });
    expect(result).toMatchObject({ outcome: "review-required", child: { kind: "extraction" } });
    expect(result.campaign.children.map((child) => child.status)).toEqual(["applied", "planned"]);
  }, 30_000);

  test("refuses runtime declarations and stale span evidence before a write", () => {
    const runtimeText = "export enum RuntimeState { Active }\n";
    const runtimeGraph = analyzeTypeScriptSource({ sourcePath: "apps/api/src/runtime.ts", sourceText: runtimeText });
    const runtimeGroup = runtimeGraph.groups[0];
    if (!runtimeGroup) throw new Error("runtime fixture has no declaration group");
    const runtimeSafety = classifyTypeOnlyExtraction({ sourceText: runtimeText, graph: runtimeGraph, groupId: runtimeGroup.id });
    expect(runtimeSafety.eligible).toBe(false);
    expect(runtimeSafety.evidence.map((item) => item.code)).toContain("enum-declaration");
    const { fixture, manifest } = contractPlan();
    const stale = validatePreparationManifest(manifest, {
      currentContents: { [PREPARATION_DONOR]: read(fixture.root, PREPARATION_DONOR).replace("Contract", "ChangedContract") },
    });
    expect(stale.issues.map((issue) => issue.rule)).toContain("stale-selector");
  }, 30_000);

  test("audit rejects a tampered preparation target and campaign advance rejects auditless preparation", async () => {
    const { fixture, analysis, manifest } = contractPlan();
    executePreparationJournal({ rootDir: fixture.root, operations: preparationFilesystemOperations(manifest) });
    write(fixture.root, PREPARATION_TARGET, "export interface Contract { readonly altered: true; }\n");
    expect(
      auditPreparationSync({
        config: fixture.config,
        rootDir: fixture.root,
        manifest,
        freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest },
      }).byteReplay.passed,
    ).toBe(false);
    const before = graphSnapshot(analysis);
    const planned = appendCampaignChild(
      createCampaignLedger({
        campaignId: "audit-required",
        objective: "prove audited ordering",
        stopConditions: [],
        baselineCommit: manifest.baseline.commit,
        initialGraph: before,
      }),
      { id: "prepare-contract-types", pairId: "contract-types", kind: "preparation", planId: manifest.planId, baselineCommit: manifest.baseline.commit },
    );
    await expect(
      advanceCampaign({
        campaign: planned,
        headCommit: () => manifest.baseline.commit,
        rescan: () => before,
        compileNext: () => ({
          id: "extract-contract-boundary",
          pairId: "contract-types",
          kind: "extraction",
          planId: "blocked",
          baselineCommit: manifest.baseline.commit,
        }),
      }),
    ).rejects.toThrow("awaits application and audit");
  }, 30_000);

  test("commits and independently audits a relocated relative inline import type", async () => {
    const source = 'export type Money = import("./model.js").Model;\nexport const runtimeMarker = 1;\n';
    const fixture = preparationCase(source, { "apps/api/src/model.ts": "export interface Model { readonly cents: number; }\n" });
    const manifest = compileCase(fixture, "Money", ({ originalSpecifier }) => {
      expect(originalSpecifier).toBe("./model.js");
      return { targetSpecifier: "../model.js", resolvedSourcePath: "apps/api/src/model.ts" };
    });

    approveManifest(fixture.root, manifest);
    const applied = await applyPreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest,
      manifestPath: fixture.planPath,
      commit: true,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });

    expect(applied.ok).toBe(true);
    expect(applied.audit?.passed).toBe(true);
    expect(read(fixture.root, fixture.targetPath)).toContain('import("../model.js").Model');
    expect(independentAudit(fixture.root, fixture.config, manifest, fixture.planPath).failures).toEqual([]);
  }, 30_000);

  test("commits and independently audits exported ambient types with empty JavaScript output", async () => {
    const source = ["export declare type AmbientContract = { readonly name: string };", "export const runtimeMarker = 1;", ""].join("\n");
    const fixture = preparationCase(source);
    const manifest = compileCase(fixture, "AmbientContract");

    approveManifest(fixture.root, manifest);
    const applied = await applyPreparation({
      config: fixture.config,
      rootDir: fixture.root,
      manifest,
      manifestPath: fixture.planPath,
      commit: true,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });

    expect(applied.ok).toBe(true);
    expect(independentAudit(fixture.root, fixture.config, manifest, fixture.planPath).passed).toBe(true);
    const target = read(fixture.root, fixture.targetPath);
    expect(target).toContain("export declare type AmbientContract");
    expect(ts.transpileModule(target, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText).toBe("export {};\n");
  }, 30_000);
});

function preparationCase(source: string, extra: Record<string, string> = {}) {
  const donorPath = "apps/api/src/source.ts";
  const targetPath = "apps/api/src/types/prepared.ts";
  const planPath = "plans/preparation.json";
  const root = preparationFixtureRepo({ [donorPath]: source, ...extra });
  const config = preparationCaseConfig(root);
  return { root, config, donorPath, targetPath, planPath };
}

function preparationFixtureRepo(sourceFiles: Record<string, string>): string {
  return fixtureRepo(
    {
      "package.json": '{"name":"@acme/workspace","private":true}\n',
      "apps/api/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src/**/*.ts"],
      }),
      ...sourceFiles,
    },
    "preparation-e2e",
  );
}

function preparationCaseConfig(root: string) {
  return fixtureConfig(root, {
    preparation: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare compact e2e" } },
  });
}

function compileCase(
  fixture: ReturnType<typeof preparationCase>,
  candidateName: string,
  rewriteRelativeTypeImport?: NonNullable<Parameters<typeof compilePreparationManifest>[0]["rewriteRelativeTypeImport"]>,
) {
  const analysis = analyzeWorkspaceSymbols({
    rootDir: fixture.root,
    tsconfigPath: "apps/api/tsconfig.json",
    sourcePath: fixture.donorPath,
    affinityForPath: () => "boundary",
  });
  const candidate = analysis.splitCandidates.find((item) => item.names.includes(candidateName));
  if (!candidate) throw new Error(`fixture did not produce the ${candidateName} split candidate`);
  const seam = planSeam({ analysis, sourceText: read(fixture.root, fixture.donorPath), candidateId: candidate.id, targetPath: fixture.targetPath });
  return compilePreparationManifest({
    rootDir: fixture.root,
    config: fixture.config,
    baselineCommit: "HEAD",
    graphDigest: hashJson(analysis),
    seam,
    targetPath: fixture.targetPath,
    targetModuleSpecifier: "./types/prepared.ts",
    reviewedGroupIds: seam.movedGroups.map((group) => group.id),
    ...(rewriteRelativeTypeImport === undefined ? {} : { rewriteRelativeTypeImport }),
    rendering: { gates: { package: [], project: [], workspace: ["true"] }, commit: { subject: "refactor: prepare compact e2e" } },
  });
}

function approveManifest(root: string, manifest: ReturnType<typeof compilePreparationManifest>): void {
  write(root, "plans/preparation.json", serializePreparationManifest(manifest));
  fixtureGit(root, "add", "--", "plans/preparation.json");
  fixtureGit(root, "commit", "-qm", manifest.commits.prepare.subject);
}

function independentAudit(
  root: string,
  config: ReturnType<typeof preparationCaseConfig>,
  manifest: ReturnType<typeof compilePreparationManifest>,
  approvedManifestPath: string,
) {
  return auditPreparationSync({
    config,
    rootDir: root,
    manifest,
    approvedManifestPath,
    freshGraph: { commit: manifest.baseline.commit, digest: manifest.graphDigest },
  });
}
