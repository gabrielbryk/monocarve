import { describe, expect, test } from "bun:test";

import {
  appendCampaignChild,
  completeCampaign,
  createCampaignLedger,
  describeCampaignStatus,
  graphMetricSnapshot,
  recordCampaignChildApplication,
  stopCampaign,
} from "../src/campaign/index.ts";
import type { PreparationAuditReport } from "../src/prepare/audit.ts";
import { hashJson } from "../src/util/hash.ts";

const graph = graphMetricSnapshot({ moduleCount: 2 });

function ledger() {
  return createCampaignLedger({
    campaignId: "fixture-campaign",
    objective: "split a synthetic module",
    stopConditions: [{ kind: "max-children", maximum: 4 }],
    baselineCommit: "baseline",
    initialGraph: graph,
  });
}

function appliedPreparation() {
  const planned = appendCampaignChild(ledger(), {
    id: "prepare-one",
    planId: "prepare-one",
    pairId: "pair-one",
    kind: "preparation",
    baselineCommit: "baseline",
  });
  const proof = { passed: true, checked: 1, failures: [] };
  const report: PreparationAuditReport = {
    planId: "prepare-one",
    baselineCommit: "baseline",
    auditedRoot: "/fixture",
    passed: true,
    byteReplay: proof,
    fileModes: proof,
    renderedReplay: proof,
    selectorIntegrity: proof,
    declarationOwnership: proof,
    compatibilitySurface: proof,
    targetImportResolution: proof,
    changedPathScope: proof,
    typeValueClaims: proof,
    graphDigest: proof,
    retainedRootClearance: proof,
    adapterSurfaceParity: proof,
    failures: [],
  };
  return recordCampaignChildApplication(planned, {
    childId: "prepare-one",
    resultingCommit: "prepared",
    audit: { kind: "preparation", report, digest: hashJson(report) },
    graph: { before: graph, after: graph },
  });
}

describe("campaign workflow status", () => {
  test("reports the exact initial action and stale HEAD evidence", () => {
    expect(describeCampaignStatus(ledger(), "baseline")).toMatchObject({ phase: "needs-preparation-review", staleHead: false, expectedCommit: "baseline" });
    expect(describeCampaignStatus(ledger(), "different")).toMatchObject({
      phase: "stale-head",
      staleHead: true,
      canProceed: false,
      observedCommit: "different",
    });
  });

  test("a planned preparation reports that exact pending application", () => {
    const planned = appendCampaignChild(ledger(), {
      id: "prepare-one",
      planId: "prepare-one",
      pairId: "pair-one",
      kind: "preparation",
      baselineCommit: "baseline",
    });
    expect(describeCampaignStatus(planned, "baseline")).toMatchObject({
      phase: "needs-preparation-application",
      pendingChildId: "prepare-one",
      pairId: "pair-one",
    });
  });

  test("covers paired extraction review/application and both terminal phases", () => {
    const prepared = appliedPreparation();
    expect(describeCampaignStatus(prepared, "prepared").phase).toBe("needs-paired-extraction-review");
    const extraction = appendCampaignChild(prepared, {
      id: "extract-one",
      planId: "extract-one",
      pairId: "pair-one",
      kind: "extraction",
      baselineCommit: "prepared",
    });
    expect(describeCampaignStatus(extraction, "prepared").phase).toBe("needs-paired-extraction-application");
    expect(describeCampaignStatus(completeCampaign(ledger()), "baseline")).toMatchObject({ phase: "completed", canProceed: false });
    expect(describeCampaignStatus(stopCampaign(ledger()), "baseline")).toMatchObject({ phase: "stopped", canProceed: false });
  });
});
