/**
 * A campaign ledger must make every applied transition independently reviewable.
 * These negatives exercise the tempting shortcuts: queueing from a stale HEAD,
 * skipping a planned child, and recording an apply without its successful audit.
 */
import { describe, expect, test } from "bun:test";

import { CAMPAIGN_LEDGER_SCHEMA_VERSION, type CampaignChildApplication, type CampaignLedger, type GraphMetricSnapshot } from "../src/campaign/ledger-types.ts";
import { assertCampaignLedgerValid, CampaignLedgerValidationError } from "../src/campaign/ledger-validation.ts";
import {
  appendCampaignChild,
  completeCampaign,
  createCampaignLedger,
  evaluateCampaignStopConditions,
  graphMetricSnapshot,
  parseCampaignLedger,
  recordCampaignChildApplication,
  serializeCampaignLedger,
} from "../src/campaign/ledger.ts";
import type { PreparationAuditReport } from "../src/prepare/audit.ts";
import type { AuditReport } from "../src/transaction/audit-types.ts";
import { hashJson } from "../src/util/hash.ts";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASELINE = "base-commit";
const APPLIED = "applied-commit";
const EXTRACTED = "extracted-commit";

function graph(edgeCount = 4): GraphMetricSnapshot {
  return graphMetricSnapshot({ edges: edgeCount, nodes: edgeCount + 1 });
}

function extractionReport(planId: string, baselineCommit = BASELINE, passed = true): AuditReport {
  const proof = { passed, checked: 1, failures: passed ? [] : ["fixture audit failure"] };
  return {
    planId,
    baselineCommit,
    auditedRoot: "/workspace",
    passed,
    byteFidelity: proof,
    consumerCompleteness: proof,
    boundaryRules: proof,
    boundaryBaseline: { recorded: 0, observed: [], cleared: [] },
    externalConsumerCompile: proof,
    codemodReplay: proof,
    entrypointClosure: proof,
    lockfileIntegrity: proof,
    generatedArtifacts: proof,
    sourceConservation: { ...proof, plannedFiles: 1, plannedTests: 0, plannedAssets: 0, landedFiles: 1, landedTests: 0, landedAssets: 0 },
    graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed },
    failures: proof.failures,
  };
}

function preparationReport(planId: string, baselineCommit = BASELINE, passed = true): PreparationAuditReport {
  const proof = { passed, checked: 1, failures: passed ? [] : ["fixture audit failure"] };
  return {
    planId,
    baselineCommit,
    auditedRoot: "/workspace",
    passed,
    byteReplay: proof,
    fileModes: proof,
    selectorIntegrity: proof,
    declarationOwnership: proof,
    compatibilitySurface: proof,
    changedPathScope: proof,
    typeValueClaims: proof,
    graphDigest: proof,
    targetImportResolution: proof,
    renderedReplay: proof,
    retainedRootClearance: proof,
    adapterSurfaceParity: proof,
    failures: proof.failures,
  };
}

function application(childId = "prepare-types", planId = "prepare-types-plan", baselineCommit = BASELINE): CampaignChildApplication {
  const auditReport = preparationReport(planId, baselineCommit);
  return {
    childId,
    resultingCommit: APPLIED,
    audit: { kind: "preparation", report: auditReport, digest: hashJson(auditReport) },
    graph: { before: graph(), after: graph(3) },
  };
}

function extractionApplication(childId = "extract-types", planId = "extract-types-plan"): CampaignChildApplication {
  const auditReport = extractionReport(planId, APPLIED);
  return {
    childId,
    resultingCommit: EXTRACTED,
    audit: { kind: "extraction", report: auditReport, digest: hashJson(auditReport) },
    graph: { before: graph(3), after: graph(2) },
  };
}

function ledger(): CampaignLedger {
  return createCampaignLedger({
    campaignId: "campaign-types",
    objective: "move type-only declarations first",
    stopConditions: [],
    baselineCommit: BASELINE,
    initialGraph: graph(),
  });
}

describe("campaign ledger", () => {
  test("records an applied-and-audited child before the next replan and serializes deterministically", () => {
    const planned = appendCampaignChild(ledger(), {
      id: "prepare-types",
      pairId: "types-boundary",
      kind: "preparation",
      planId: "prepare-types-plan",
      baselineCommit: BASELINE,
    });
    const applied = recordCampaignChildApplication(planned, application());
    const next = appendCampaignChild(applied, {
      id: "extract-types",
      pairId: "types-boundary",
      kind: "extraction",
      planId: "extract-types-plan",
      baselineCommit: APPLIED,
    });

    expect(applied.currentCommit).toBe(APPLIED);
    expect(applied.children[0]).toMatchObject({ status: "applied", application: { resultingCommit: APPLIED } });
    expect(next.children.map((child) => child.status)).toEqual(["applied", "planned"]);
    expect(serializeCampaignLedger(next)).toBe(serializeCampaignLedger(JSON.parse(serializeCampaignLedger(next))));
  });

  test("refuses a stale child baseline and a second child before the first one audits", () => {
    const planned = appendCampaignChild(ledger(), {
      id: "prepare-types",
      pairId: "types-boundary",
      kind: "preparation",
      planId: "prepare-types-plan",
      baselineCommit: BASELINE,
    });
    expect(() =>
      appendCampaignChild(planned, {
        id: "extract-types",
        pairId: "types-boundary",
        kind: "extraction",
        planId: "extract-types-plan",
        baselineCommit: BASELINE,
      }),
    ).toThrow("awaits application");
    expect(() =>
      appendCampaignChild(ledger(), {
        id: "prepare-types",
        pairId: "types-boundary",
        kind: "preparation",
        planId: "prepare-types-plan",
        baselineCommit: "old-commit",
      }),
    ).toThrow("stale child");
  });

  test("refuses skipped child applications and auditless applied records", () => {
    const planned = appendCampaignChild(ledger(), {
      id: "prepare-types",
      pairId: "types-boundary",
      kind: "preparation",
      planId: "prepare-types-plan",
      baselineCommit: BASELINE,
    });
    expect(() => recordCampaignChildApplication(planned, application("some-other-child"))).toThrow("cannot skip planned child");

    const auditless = {
      ...ledger(),
      children: [
        { id: "prepare-types", pairId: "types-boundary", kind: "preparation", planId: "prepare-types-plan", baselineCommit: BASELINE, status: "applied" },
      ],
    } as unknown as CampaignLedger;
    expect(() => assertCampaignLedgerValid(auditless)).toThrow(CampaignLedgerValidationError);
  });

  test("refuses duplicate plan identities, invalid audit evidence, and a completion with pending work", () => {
    const planned = appendCampaignChild(ledger(), {
      id: "prepare-types",
      pairId: "types-boundary",
      kind: "preparation",
      planId: "prepare-types-plan",
      baselineCommit: BASELINE,
    });
    const duplicate = { ...planned, children: [...planned.children, planned.children[0]!] };
    expect(() => assertCampaignLedgerValid(duplicate)).toThrow("duplicate child id");

    const failed = application();
    const failedReport = preparationReport("prepare-types-plan", BASELINE, false);
    const failedAudit = { ...failed, audit: { kind: "preparation" as const, report: failedReport, digest: hashJson(failedReport) } };
    expect(() => recordCampaignChildApplication(planned, failedAudit)).toThrow("failed audit");
    const mismatchedReport = extractionReport("prepare-types-plan");
    expect(() =>
      recordCampaignChildApplication(planned, {
        ...application(),
        audit: { kind: "extraction", report: mismatchedReport, digest: hashJson(mismatchedReport) },
      }),
    ).toThrow("does not match preparation child");
    const wrongPlanReport = preparationReport("other-preparation-plan");
    expect(() =>
      recordCampaignChildApplication(planned, { ...application(), audit: { kind: "preparation", report: wrongPlanReport, digest: hashJson(wrongPlanReport) } }),
    ).toThrow("does not match its planned id");
    expect(() =>
      recordCampaignChildApplication(planned, {
        ...application(),
        audit: { kind: "preparation", report: preparationReport("prepare-types-plan"), digest: HASH },
      }),
    ).toThrow("digest does not match");
    expect(() => completeCampaign(planned)).toThrow("un-applied child");
  });

  test("rejects malformed serialized input rather than accepting a partial ledger", () => {
    expect(() => assertCampaignLedgerValid({ schemaVersion: CAMPAIGN_LEDGER_SCHEMA_VERSION } as CampaignLedger)).toThrow(CampaignLedgerValidationError);
    expect(() => parseCampaignLedger('{"schemaVersion":1}', "partial.json")).toThrow("campaign id must be non-empty");

    const planned = appendCampaignChild(ledger(), {
      id: "prepare-types",
      pairId: "types-boundary",
      kind: "preparation",
      planId: "prepare-types-plan",
      baselineCommit: BASELINE,
    });
    const serialized = JSON.parse(serializeCampaignLedger(planned)) as { children: Record<string, unknown>[] };
    delete serialized.children[0]?.graphDigest;
    expect(() => parseCampaignLedger(JSON.stringify(serialized), "missing-graph.json")).toThrow("invalid graph digest for child prepare-types");
  });

  test("binds graph digest to metrics and rejects a ledger that relabels scanner evidence", () => {
    const snapshot = graph();
    expect(snapshot.digest).toBe(hashJson(snapshot.metrics));
    expect(() =>
      createCampaignLedger({
        campaignId: "bad-graph",
        objective: "reject mismatched evidence",
        stopConditions: [],
        baselineCommit: BASELINE,
        initialGraph: { ...snapshot, digest: HASH },
      }),
    ).toThrow("digest does not match its metrics");
  });

  test("enforces pair ordering instead of accepting a batch with an unrelated extraction", () => {
    expect(() =>
      appendCampaignChild(ledger(), {
        id: "extract-first",
        pairId: "types-boundary",
        kind: "extraction",
        planId: "extract-first-plan",
        baselineCommit: BASELINE,
      }),
    ).toThrow("first child extract-first must be a preparation");
    const prepared = recordCampaignChildApplication(
      appendCampaignChild(ledger(), {
        id: "prepare-types",
        pairId: "types-boundary",
        kind: "preparation",
        planId: "prepare-types-plan",
        baselineCommit: BASELINE,
      }),
      application(),
    );
    expect(() =>
      appendCampaignChild(prepared, {
        id: "wrong-extract",
        pairId: "other-boundary",
        kind: "extraction",
        planId: "wrong-extract-plan",
        baselineCommit: APPLIED,
      }),
    ).toThrow("must share pair id types-boundary");
    expect(() =>
      appendCampaignChild(prepared, {
        id: "prepare-again",
        pairId: "new-boundary",
        kind: "preparation",
        planId: "prepare-again-plan",
        baselineCommit: APPLIED,
      }),
    ).toThrow("must extract after preparation");

    const extracted = recordCampaignChildApplication(
      appendCampaignChild(prepared, {
        id: "extract-types",
        pairId: "types-boundary",
        kind: "extraction",
        planId: "extract-types-plan",
        baselineCommit: APPLIED,
      }),
      extractionApplication(),
    );
    expect(() =>
      appendCampaignChild(extracted, {
        id: "reused-pair",
        pairId: "types-boundary",
        kind: "preparation",
        planId: "reused-pair-plan",
        baselineCommit: EXTRACTED,
      }),
    ).toThrow("duplicate completed pair id");
  });

  test("returns terminal ledger states for every configured stop condition before planning more work", () => {
    const withMax = createCampaignLedger({
      campaignId: "max-campaign",
      objective: "stop at one",
      stopConditions: [{ kind: "max-children", maximum: 1 }],
      baselineCommit: BASELINE,
      initialGraph: graph(),
    });
    const maxPrepared = recordCampaignChildApplication(
      appendCampaignChild(withMax, { id: "prepare-max", pairId: "max-boundary", kind: "preparation", planId: "prepare-max-plan", baselineCommit: BASELINE }),
      application("prepare-max", "prepare-max-plan"),
    );
    expect(maxPrepared.status).toBe("active");
    const maxStopped = recordCampaignChildApplication(
      appendCampaignChild(maxPrepared, { id: "extract-max", pairId: "max-boundary", kind: "extraction", planId: "extract-max-plan", baselineCommit: APPLIED }),
      extractionApplication("extract-max", "extract-max-plan"),
    );
    expect(maxStopped.status).toBe("stopped");
    expect(() =>
      appendCampaignChild(maxStopped, {
        id: "prepare-after-max",
        pairId: "after-max",
        kind: "preparation",
        planId: "prepare-after-max-plan",
        baselineCommit: EXTRACTED,
      }),
    ).toThrow("campaign is stopped");

    const withAllApplied = createCampaignLedger({
      campaignId: "complete-campaign",
      objective: "complete audited work",
      stopConditions: [{ kind: "all-children-applied" }],
      baselineCommit: BASELINE,
      initialGraph: graph(),
    });
    const allPrepared = recordCampaignChildApplication(
      appendCampaignChild(withAllApplied, {
        id: "prepare-complete",
        pairId: "complete-boundary",
        kind: "preparation",
        planId: "prepare-complete-plan",
        baselineCommit: BASELINE,
      }),
      application("prepare-complete", "prepare-complete-plan"),
    );
    expect(allPrepared.status).toBe("active");
    const completed = recordCampaignChildApplication(
      appendCampaignChild(allPrepared, {
        id: "extract-complete",
        pairId: "complete-boundary",
        kind: "extraction",
        planId: "extract-complete-plan",
        baselineCommit: APPLIED,
      }),
      extractionApplication("extract-complete", "extract-complete-plan"),
    );
    expect(completed.status).toBe("completed");
    expect(() =>
      appendCampaignChild(completed, {
        id: "prepare-after-complete",
        pairId: "after-complete",
        kind: "preparation",
        planId: "prepare-after-complete-plan",
        baselineCommit: EXTRACTED,
      }),
    ).toThrow("campaign is completed");

    const threshold = createCampaignLedger({
      campaignId: "threshold-campaign",
      objective: "reach graph target",
      stopConditions: [{ kind: "metric-threshold", metric: "edges", comparison: "at-most", value: 4 }],
      baselineCommit: BASELINE,
      initialGraph: graph(),
    });
    const evaluation = evaluateCampaignStopConditions(threshold);
    expect(evaluation).toMatchObject({ outcome: "active", ledger: { status: "active" } });
    const thresholdPrepared = recordCampaignChildApplication(
      appendCampaignChild(threshold, {
        id: "prepare-threshold",
        pairId: "threshold-boundary",
        kind: "preparation",
        planId: "prepare-threshold-plan",
        baselineCommit: BASELINE,
      }),
      application("prepare-threshold", "prepare-threshold-plan"),
    );
    expect(thresholdPrepared.status).toBe("active");
    const thresholdCompleted = recordCampaignChildApplication(
      appendCampaignChild(thresholdPrepared, {
        id: "extract-threshold",
        pairId: "threshold-boundary",
        kind: "extraction",
        planId: "extract-threshold-plan",
        baselineCommit: APPLIED,
      }),
      extractionApplication("extract-threshold", "extract-threshold-plan"),
    );
    expect(thresholdCompleted).toMatchObject({ status: "completed" });
  });
});
