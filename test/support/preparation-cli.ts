import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendCampaignChild,
  createCampaignLedger,
  graphMetricSnapshot,
  recordCampaignChildApplication,
  type CampaignChildPlan,
  type GraphMetricSnapshot,
} from "../../src/campaign/index.ts";
import type { PreparationAuditReport } from "../../src/prepare/audit.ts";
import type { AuditReport } from "../../src/transaction/audit.ts";
import { hashJson } from "../../src/util/hash.ts";
import { fixtureGit } from "./fixture-repo.ts";
import { committedWorkspace, runJsonIn } from "./cli.ts";

export interface PreparedManifestOutput {
  readonly planId: string;
  readonly output: string;
  readonly baseline: { readonly commit: string };
  readonly commits: { readonly prepare: { readonly subject: string } };
}

export async function reviewedPreparationPlan(): Promise<{ root: string; manifest: PreparedManifestOutput; graph: GraphMetricSnapshot }> {
  const root = committedWorkspace();
  const source = "apps/web/src/campaign-preparation.ts";
  configurePreparationPolicy(root);
  writeFileSync(join(root, source), "export interface CampaignPreparation { readonly id: string; }\n");
  fixtureGit(root, "add", "--", "monocarve.config.json", source);
  fixtureGit(root, "commit", "-qm", "test: add campaign preparation fixture");
  const candidates = await runJsonIn<{ splitCandidates: { id: string; groupIds: string[] }[] }>(root, "split-candidates", "--file", source);
  const candidate = candidates.splitCandidates[0];
  const group = candidate?.groupIds[0];
  if (!candidate || !group) throw new Error("fixture did not produce a declaration SCC");
  const manifest = await runJsonIn<PreparedManifestOutput>(
    root,
    "prepare-plan", "--file", source, "--candidate", candidate.id,
    "--target", "apps/web/src/campaign-preparation-types.ts",
    "--module-specifier", "./campaign-preparation-types.ts", "--group", group, "--write",
  );
  return { root, manifest, graph: await scanMetrics(root) };
}

export function configurePreparationPolicy(root: string): void {
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparation = { commit: { subject: "refactor: prepare {sourcePath}" }, gates: { workspace: ["true"] } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export async function scanMetrics(root: string): Promise<GraphMetricSnapshot> {
  const scan = await runJsonIn<{
    moduleCount: number;
    edgeCount: number;
    unresolvedCount: number;
    dynamicImportCount: number;
    byZone: { application: number; package: number; repo: number; external: number };
  }>(root, "scan");
  return graphMetricSnapshot({
    moduleCount: scan.moduleCount,
    edgeCount: scan.edgeCount,
    unresolvedCount: scan.unresolvedCount,
    dynamicImportCount: scan.dynamicImportCount,
    applicationModuleCount: scan.byZone.application,
    packageModuleCount: scan.byZone.package,
    repositoryModuleCount: scan.byZone.repo,
    externalModuleCount: scan.byZone.external,
  });
}

export function appliedPairLedger(head: string, graph: GraphMetricSnapshot) {
  const preparation: CampaignChildPlan = { id: "prepare", pairId: "fixture-pair", kind: "preparation", planId: "prepare-plan", baselineCommit: head };
  const preparationReport = preparationAudit(preparation);
  const preparationApplied = recordCampaignChildApplication(appendCampaignChild(createCampaignLedger({
    campaignId: "terminal-fixture", objective: "finish a complete pair", stopConditions: [], baselineCommit: head, initialGraph: graph,
  }), preparation), {
    childId: preparation.id,
    resultingCommit: head,
    audit: { kind: "preparation", report: preparationReport, digest: hashJson(preparationReport) },
    graph: { before: graph, after: graph },
  });
  const extraction: CampaignChildPlan = { id: "extract", pairId: "fixture-pair", kind: "extraction", planId: "extract-plan", baselineCommit: head };
  const report = extractionAudit(extraction);
  return recordCampaignChildApplication(appendCampaignChild(preparationApplied, extraction), {
    childId: extraction.id,
    resultingCommit: head,
    audit: { kind: "extraction", report, digest: hashJson(report) },
    graph: { before: graph, after: graph },
  });
}

function preparationAudit(plan: CampaignChildPlan): PreparationAuditReport {
  return {
    planId: plan.planId, baselineCommit: plan.baselineCommit, auditedRoot: "/synthetic", passed: true,
    byteReplay: proof(), fileModes: proof(), selectorIntegrity: proof(), declarationOwnership: proof(), compatibilitySurface: proof(),
    targetImportResolution: proof(), renderedReplay: proof(), changedPathScope: proof(), typeValueClaims: proof(), graphDigest: proof(),
    retainedRootClearance: proof(), adapterSurfaceParity: proof(), failures: [],
  };
}

function extractionAudit(plan: CampaignChildPlan): AuditReport {
  return {
    planId: plan.planId, baselineCommit: plan.baselineCommit, auditedRoot: "/synthetic", passed: true,
    byteFidelity: proof(), consumerCompleteness: proof(), boundaryRules: proof(), externalConsumerCompile: proof(), codemodReplay: proof(),
    entrypointClosure: proof(), lockfileIntegrity: proof(), generatedArtifacts: proof(),
    sourceConservation: { ...proof(), plannedFiles: 1, plannedTests: 0, plannedAssets: 0, landedFiles: 1, landedTests: 0, landedAssets: 0 },
    boundaryBaseline: { recorded: 0, observed: [], cleared: [] }, graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: true }, failures: [],
  };
}

function proof() { return { passed: true, checked: 1, failures: [] }; }
