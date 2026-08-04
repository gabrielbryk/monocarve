import { describe, expect, test } from "bun:test";

import {
  appendCampaignChild,
  createCampaignLedger,
  recordCampaignApplication,
  type CampaignChildPlan,
  type CampaignLedger,
  type GraphMetricSnapshot,
} from "../src/campaign/index.ts";
import type { PreparationAuditReport } from "../src/prepare/audit.ts";
import { hashJson } from "../src/util/hash.ts";

const BASELINE = "baseline-commit";
const RESULT = "resulting-commit";

function graph(metrics: Readonly<Record<string, number>>): GraphMetricSnapshot {
  return { metrics, digest: hashJson(metrics) };
}

function child(): CampaignChildPlan {
  return { id: "prepare-types", pairId: "types-pair", kind: "preparation", planId: "prepare-types-plan", baselineCommit: BASELINE };
}

function ledger(): CampaignLedger {
  return appendCampaignChild(createCampaignLedger({
    campaignId: "record-campaign",
    objective: "prepare a type-only seam",
    stopConditions: [],
    baselineCommit: BASELINE,
    initialGraph: graph({ modules: 4, edges: 3 }),
  }), child());
}

function report(plan = child(), passed = true): PreparationAuditReport {
  const proof = { passed, checked: 1, failures: passed ? [] : ["audit failed"] };
  return {
    planId: plan.planId,
    baselineCommit: plan.baselineCommit,
    auditedRoot: "/fixture",
    passed,
    byteReplay: proof,
    fileModes: proof,
    selectorIntegrity: proof,
    declarationOwnership: proof,
    compatibilitySurface: proof,
    targetImportResolution: proof,
    renderedReplay: proof,
    changedPathScope: proof,
    typeValueClaims: proof,
    graphDigest: proof,
    failures: proof.failures,
  };
}

function input(overrides: Partial<Parameters<typeof recordCampaignApplication>[0]> = {}) {
  const plan = overrides.plan ?? child();
  const auditReport = report(plan);
  return {
    campaign: ledger(),
    plan,
    resultingHead: RESULT,
    auditedHead: RESULT,
    scannedHead: RESULT,
    audit: { kind: "preparation" as const, report: auditReport, digest: hashJson(auditReport) },
    postScan: graph({ modules: 3, edges: 2 }),
    ...overrides,
  };
}

describe("campaign application recording", () => {
  test("records only a verified plan, immediate audit, and fresh stable post-scan", () => {
    const applied = recordCampaignApplication(input());
    expect(applied.currentCommit).toBe(RESULT);
    expect(applied.children[0]).toMatchObject({
      status: "applied",
      application: { resultingCommit: RESULT, graph: { after: graph({ modules: 3, edges: 2 }) } },
    });
  });

  test("refuses a plan identity that differs from the planned tail", () => {
    expect(() => recordCampaignApplication(input({
      plan: { ...child(), planId: "other-plan" },
    }))).toThrow("does not match planned campaign child");
  });

  test("refuses audit or scan evidence from a different resulting HEAD", () => {
    expect(() => recordCampaignApplication(input({ auditedHead: "other-head" }))).toThrow("must observe the exact resulting HEAD");
    expect(() => recordCampaignApplication(input({ scannedHead: "other-head" }))).toThrow("must observe the exact resulting HEAD");
  });

  test("refuses failed or wrong-kind audit evidence and absent post-scan evidence", () => {
    const failed = report(child(), false);
    expect(() => recordCampaignApplication(input({
      audit: { kind: "preparation", report: failed, digest: hashJson(failed) },
    }))).toThrow("immediate audit failed");
    const valid = report();
    expect(() => recordCampaignApplication(input({
      audit: { kind: "extraction", report: valid as never, digest: hashJson(valid) },
    }))).toThrow("does not match preparation plan");
    expect(() => recordCampaignApplication(input({ postScan: undefined as unknown as GraphMetricSnapshot }))).toThrow("fresh post-scan evidence is required");
  });
});
