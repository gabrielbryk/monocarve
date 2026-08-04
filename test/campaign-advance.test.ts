import { describe, expect, test } from "bun:test";

import {
  advanceCampaign,
  type CampaignCompileNextInput,
  type CampaignRescanInput,
} from "../src/campaign/advance.ts";
import {
  appendCampaignChild,
  createCampaignLedger,
  graphMetricSnapshot,
  recordCampaignChildApplication,
  type CampaignChildPlan,
  type CampaignLedger,
  type GraphMetricSnapshot,
} from "../src/campaign/ledger.ts";
import type { PreparationAuditReport } from "../src/prepare/audit.ts";
import type { AuditReport } from "../src/transaction/audit.ts";
import { hashJson } from "../src/util/hash.ts";

const INITIAL_GRAPH: GraphMetricSnapshot = graphMetricSnapshot({ modules: 4 });
const RESCANNED_GRAPH: GraphMetricSnapshot = graphMetricSnapshot({ modules: 3 });
const EXTRACTION_GRAPH: GraphMetricSnapshot = graphMetricSnapshot({ modules: 2 });
const BASELINE = "baseline-commit";
const APPLIED = "preparation-commit";
const EXTRACTED = "extraction-commit";

function child(kind: CampaignChildPlan["kind"], id: string = kind, pairId: string = "widget-types"): CampaignChildPlan {
  return { id, pairId, kind, planId: `plan-${id}`, baselineCommit: kind === "preparation" ? BASELINE : APPLIED };
}

function ledger(): CampaignLedger {
  return createCampaignLedger({
    campaignId: "campaign",
    objective: "decompose one application",
    stopConditions: [],
    baselineCommit: BASELINE,
    initialGraph: INITIAL_GRAPH,
  });
}

function preparationAudit(plan: CampaignChildPlan): PreparationAuditReport {
  return {
    planId: plan.planId,
    baselineCommit: plan.baselineCommit,
    auditedRoot: "/synthetic",
    passed: true,
    byteReplay: proof(),
    fileModes: proof(),
    selectorIntegrity: proof(),
    declarationOwnership: proof(),
    compatibilitySurface: proof(),
    targetImportResolution: proof(),
    renderedReplay: proof(),
    changedPathScope: proof(),
    typeValueClaims: proof(),
    graphDigest: proof(),
    retainedRootClearance: proof(),
    adapterSurfaceParity: proof(),
    failures: [],
  };
}

function proof() {
  return { passed: true, checked: 1, failures: [] };
}

function extractionAudit(plan: CampaignChildPlan): AuditReport {
  return {
    planId: plan.planId,
    baselineCommit: plan.baselineCommit,
    auditedRoot: "/synthetic",
    passed: true,
    byteFidelity: proof(),
    consumerCompleteness: proof(),
    boundaryRules: proof(),
    externalConsumerCompile: proof(),
    codemodReplay: proof(),
    entrypointClosure: proof(),
    lockfileIntegrity: proof(),
    generatedArtifacts: proof(),
    sourceConservation: { ...proof(), plannedFiles: 1, plannedTests: 0, plannedAssets: 0, landedFiles: 1, landedTests: 0, landedAssets: 0 },
    graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: true },
    failures: [],
  };
}

function appliedPreparation(): CampaignLedger {
  const preparation = child("preparation");
  const planned = appendCampaignChild(ledger(), preparation);
  const report = preparationAudit(preparation);
  return recordCampaignChildApplication(planned, {
    childId: preparation.id,
    resultingCommit: APPLIED,
    audit: { kind: "preparation", report, digest: hashJson(report) },
    graph: { before: INITIAL_GRAPH, after: RESCANNED_GRAPH },
  });
}

function appliedExtraction(): CampaignLedger {
  const extraction = child("extraction");
  const planned = appendCampaignChild(appliedPreparation(), extraction);
  const report = extractionAudit(extraction);
  return recordCampaignChildApplication(planned, {
    childId: extraction.id,
    resultingCommit: EXTRACTED,
    audit: { kind: "extraction", report, digest: hashJson(report) },
    graph: { before: RESCANNED_GRAPH, after: EXTRACTION_GRAPH },
  });
}

function callbacks(next: CampaignChildPlan, head = APPLIED) {
  const rescans: CampaignRescanInput[] = [];
  const compiles: CampaignCompileNextInput[] = [];
  return {
    headCommit: () => head,
    rescan: (input: CampaignRescanInput) => {
      rescans.push(input);
      return RESCANNED_GRAPH;
    },
    compileNext: (input: CampaignCompileNextInput) => {
      compiles.push(input);
      return next;
    },
    calls: { rescans, compiles },
  };
}

describe("campaign advancement", () => {
  test("rescans then queues exactly one reviewed dependent extraction", async () => {
    const campaign = appliedPreparation();
    const callback = callbacks(child("extraction"));

    const result = await advanceCampaign({ campaign, ...callback });

    expect(result).toMatchObject({ outcome: "review-required", child: { id: "extraction", kind: "extraction" } });
    expect(result.campaign.children.map((entry) => [entry.id, entry.status])).toEqual([
      ["preparation", "applied"],
      ["extraction", "planned"],
    ]);
    expect(callback.calls.rescans).toEqual([{ campaign, headCommit: APPLIED }]);
    expect(callback.calls.compiles).toEqual([{ campaign, headCommit: APPLIED, graph: RESCANNED_GRAPH }]);
  });

  test("refuses a stale checkout before rescanning or compiling", async () => {
    const callback = callbacks(child("extraction"));

    await expect(advanceCampaign({ campaign: appliedPreparation(), ...callback, headCommit: () => "different-head" })).rejects.toThrow("campaign HEAD is stale");

    expect(callback.calls).toEqual({ rescans: [], compiles: [] });
  });

  test("refuses an unaudited prior child", async () => {
    const preparation = child("preparation");
    const campaign = appendCampaignChild(ledger(), preparation);
    const callback = callbacks(child("extraction"));

    await expect(advanceCampaign({ campaign, ...callback, headCommit: () => BASELINE })).rejects.toThrow("awaits application and audit");

    expect(callback.calls).toEqual({ rescans: [], compiles: [] });
  });

  test("refuses extraction without an immediately preceding preparation", async () => {
    const campaign = ledger();
    const callback = callbacks({ ...child("extraction"), baselineCommit: BASELINE });

    await expect(advanceCampaign({ campaign, ...callback, headCommit: () => BASELINE })).rejects.toThrow("first child extraction must be a preparation");

    expect(callback.calls).toEqual({ rescans: [{ campaign, headCommit: BASELINE }], compiles: [{ campaign, headCommit: BASELINE, graph: RESCANNED_GRAPH }] });
  });

  test("refuses a same-baseline child after a previous child changed HEAD", async () => {
    const campaign = appliedPreparation();
    const callback = callbacks({ ...child("extraction"), baselineCommit: BASELINE });

    await expect(advanceCampaign({ campaign, ...callback })).rejects.toThrow("stale child extraction");
  });

  test("refuses a second preparation before the existing pair is extracted", async () => {
    const campaign = appliedPreparation();
    const callback = callbacks({ ...child("preparation", "next-preparation", "other-types"), baselineCommit: APPLIED });

    await expect(advanceCampaign({ campaign, ...callback })).rejects.toThrow("must extract after preparation preparation");
  });

  test("refuses a second extraction before a new preparation", async () => {
    const campaign = appliedExtraction();
    const callback = callbacks({ ...child("extraction", "next-extraction", "other-types"), baselineCommit: EXTRACTED }, EXTRACTED);

    await expect(advanceCampaign({ campaign, ...callback })).rejects.toThrow("must prepare after extraction extraction");
  });

  test("refuses an extraction that claims a different preparation pair", async () => {
    const campaign = appliedPreparation();
    const callback = callbacks(child("extraction", "wrong-pair", "other-types"));

    await expect(advanceCampaign({ campaign, ...callback })).rejects.toThrow("must share pair id widget-types");
  });

  test("durably completes a fully applied campaign when review finds no next child", async () => {
    const campaign = appliedExtraction();
    const result = await advanceCampaign({
      campaign,
      headCommit: () => EXTRACTED,
      rescan: () => EXTRACTION_GRAPH,
      compileNext: () => undefined,
    });

    expect(result).toMatchObject({ outcome: "stopped", reason: "no-next-child", campaign: { status: "completed" } });
  });

  test("refuses to call a preparation-only campaign complete when no child is available", async () => {
    await expect(advanceCampaign({
      campaign: appliedPreparation(),
      headCommit: () => APPLIED,
      rescan: () => RESCANNED_GRAPH,
      compileNext: () => undefined,
    })).rejects.toThrow("before an applied extraction closes the current pair");
  });
});
