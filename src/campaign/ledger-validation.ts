import { MonocarveError } from "../errors.ts";
import { hashJson, isSha256, stableStringify } from "../util/hash.ts";
import {
  CAMPAIGN_LEDGER_SCHEMA_VERSION,
  type AppliedCampaignChild,
  type CampaignAuditEvidence,
  type CampaignChildPlan,
  type CampaignChildRecord,
  type CampaignLedger,
  type CampaignLedgerInput,
  type CampaignStopCondition,
  type GraphMetricSnapshot,
} from "./ledger-types.ts";

export class CampaignLedgerValidationError extends MonocarveError {
  override readonly name = "CampaignLedgerValidationError";
}

export function assertCampaignLedgerInputValid(input: CampaignLedgerInput): void {
  assertRecord(input, "campaign ledger input");
  nonEmpty(input.campaignId, "campaign id");
  nonEmpty(input.objective, "campaign objective");
  nonEmpty(input.baselineCommit, "campaign baseline commit");
  assertGraphSnapshot(input.initialGraph, "initial graph");
  if (!Array.isArray(input.stopConditions)) throw new CampaignLedgerValidationError("campaign stop conditions must be an array");
  const keys = new Set<string>();
  for (const condition of input.stopConditions) {
    const key = stableStringify(condition);
    if (keys.has(key)) throw new CampaignLedgerValidationError(`duplicate campaign stop condition: ${key}`);
    keys.add(key);
    assertStopCondition(condition);
  }
}

/** Reject every sequence that could skip a replan or label an unchecked apply as safe. */
export function assertCampaignLedgerValid(ledger: CampaignLedger): void {
  assertRecord(ledger, "campaign ledger");
  if (ledger.schemaVersion !== CAMPAIGN_LEDGER_SCHEMA_VERSION) {
    throw new CampaignLedgerValidationError(`unsupported campaign ledger schema version: ${ledger.schemaVersion}`);
  }
  assertCampaignLedgerInputValid(ledger);
  nonEmpty(ledger.currentCommit, "campaign current commit");
  assertGraphSnapshot(ledger.currentGraph, "campaign current graph");
  if (!Array.isArray(ledger.children)) throw new CampaignLedgerValidationError("campaign children must be an array");
  if (ledger.status !== "active" && ledger.status !== "completed" && ledger.status !== "stopped") {
    throw new CampaignLedgerValidationError(`invalid campaign status: ${String(ledger.status)}`);
  }

  const childIds = new Set<string>();
  const planIds = new Set<string>();
  let expectedCommit = ledger.baselineCommit;
  let expectedGraph = ledger.initialGraph;
  let pending = false;
  const completedPairs = new Set<string>();
  for (const [index, child] of ledger.children.entries()) {
    assertChildIdentity(child, index, childIds, planIds);
    assertChildSequence(ledger.children[index - 1], child, completedPairs);
    if (child.baselineCommit !== expectedCommit) {
      throw new CampaignLedgerValidationError(`stale or misordered child ${child.id}: baseline ${child.baselineCommit}, expected ${expectedCommit}`);
    }
    if (pending) throw new CampaignLedgerValidationError(`child ${child.id} follows an un-applied child`);
    if (child.status === "planned") {
      pending = true;
      continue;
    }
    assertAppliedChild(child, expectedGraph);
    expectedCommit = child.application.resultingCommit;
    expectedGraph = child.application.graph.after;
    if (child.kind === "extraction") completedPairs.add(child.pairId);
  }

  if (ledger.currentCommit !== expectedCommit) {
    throw new CampaignLedgerValidationError(`campaign current commit ${ledger.currentCommit} does not match the ordered child result ${expectedCommit}`);
  }
  if (!sameGraph(ledger.currentGraph, expectedGraph)) {
    throw new CampaignLedgerValidationError("campaign current graph does not match the ordered child result");
  }
  if (ledger.status === "completed" && pending) {
    throw new CampaignLedgerValidationError("completed campaign has an un-applied child");
  }
}

export function assertAppendableChild(ledger: CampaignLedger, child: CampaignChildPlan): void {
  assertCampaignLedgerValid(ledger);
  if (ledger.status !== "active") throw new CampaignLedgerValidationError(`cannot plan a child for ${ledger.status} campaign`);
  if (ledger.children.some((entry) => entry.status === "planned")) {
    throw new CampaignLedgerValidationError("cannot plan a child while another child awaits application");
  }
  nonEmpty(child.id, "child id");
  nonEmpty(child.planId, "child plan id");
  nonEmpty(child.baselineCommit, "child baseline commit");
  if (child.graphDigest !== undefined && !isSha256(child.graphDigest)) throw new CampaignLedgerValidationError(`invalid graph digest for child ${child.id}`);
  if (child.baselineCommit !== ledger.currentCommit) {
    throw new CampaignLedgerValidationError(`stale child ${child.id}: baseline ${child.baselineCommit}, campaign is at ${ledger.currentCommit}`);
  }
  if (ledger.children.some((entry) => entry.id === child.id)) throw new CampaignLedgerValidationError(`duplicate child id: ${child.id}`);
  if (ledger.children.some((entry) => entry.planId === child.planId)) throw new CampaignLedgerValidationError(`duplicate child plan id: ${child.planId}`);
}

function assertChildIdentity(child: CampaignChildRecord, index: number, childIds: Set<string>, planIds: Set<string>): void {
  assertRecord(child, `child ${index}`);
  nonEmpty(child.id, `child ${index} id`);
  nonEmpty(child.pairId, `child ${index} pair id`);
  nonEmpty(child.planId, `child ${child.id} plan id`);
  nonEmpty(child.baselineCommit, `child ${child.id} baseline commit`);
  if (!isSha256(child.graphDigest)) throw new CampaignLedgerValidationError(`invalid graph digest for child ${child.id}`);
  if (child.kind !== "preparation" && child.kind !== "extraction") {
    throw new CampaignLedgerValidationError(`invalid kind for child ${child.id}: ${String(child.kind)}`);
  }
  if (child.status !== "planned" && child.status !== "applied") {
    throw new CampaignLedgerValidationError(`invalid status for child ${child.id}: ${String(child.status)}`);
  }
  if (childIds.has(child.id)) throw new CampaignLedgerValidationError(`duplicate child id: ${child.id}`);
  if (planIds.has(child.planId)) throw new CampaignLedgerValidationError(`duplicate child plan id: ${child.planId}`);
  childIds.add(child.id);
  planIds.add(child.planId);
}

function assertAppliedChild(child: AppliedCampaignChild, expectedGraph: GraphMetricSnapshot): void {
  const { application } = child;
  assertRecord(application, `application for child ${child.id}`);
  nonEmpty(application.resultingCommit, `resulting commit for child ${child.id}`);
  assertRecord(application.graph, `graph transition for child ${child.id}`);
  assertGraphSnapshot(application.graph.before, `graph before child ${child.id}`);
  assertGraphSnapshot(application.graph.after, `graph after child ${child.id}`);
  if (!sameGraph(application.graph.before, expectedGraph)) {
    throw new CampaignLedgerValidationError(`graph before child ${child.id} does not match the prior graph result`);
  }
  assertAuditEvidence(child, application.audit);
}

function assertAuditEvidence(child: AppliedCampaignChild, audit: CampaignAuditEvidence): void {
  assertRecord(audit, `audit for child ${child.id}`);
  if (audit.kind !== "preparation" && audit.kind !== "extraction") {
    throw new CampaignLedgerValidationError(`invalid audit kind for child ${child.id}: ${String(audit.kind)}`);
  }
  if (audit.kind !== child.kind) {
    throw new CampaignLedgerValidationError(`audit kind ${audit.kind} does not match ${child.kind} child ${child.id}`);
  }
  assertRecord(audit.report, `audit report for child ${child.id}`);
  if (!isSha256(audit.digest)) throw new CampaignLedgerValidationError(`invalid audit digest for child ${child.id}`);
  if (hashJson(audit.report) !== audit.digest) {
    throw new CampaignLedgerValidationError(`audit digest does not match report for child ${child.id}`);
  }
  if (audit.report.passed !== true) throw new CampaignLedgerValidationError(`applied child ${child.id} has a failed audit`);
  nonEmpty(audit.report.planId, `audit plan id for child ${child.id}`);
  nonEmpty(audit.report.baselineCommit, `audit baseline for child ${child.id}`);
  if (audit.report.planId !== child.planId) {
    throw new CampaignLedgerValidationError(`audit plan id for child ${child.id} does not match its planned id`);
  }
  if (audit.report.baselineCommit !== child.baselineCommit) {
    throw new CampaignLedgerValidationError(`audit baseline for child ${child.id} does not match its planned baseline`);
  }
}

function assertGraphSnapshot(snapshot: GraphMetricSnapshot, label: string): void {
  assertRecord(snapshot, label);
  if (!isSha256(snapshot.digest)) throw new CampaignLedgerValidationError(`invalid ${label} digest`);
  assertRecord(snapshot.metrics, `${label} metrics`);
  for (const [metric, value] of Object.entries(snapshot.metrics)) {
    nonEmpty(metric, `${label} metric name`);
    if (!Number.isFinite(value) || value < 0) throw new CampaignLedgerValidationError(`invalid ${label} metric ${metric}`);
  }
  if (hashJson(snapshot.metrics) !== snapshot.digest) {
    throw new CampaignLedgerValidationError(`${label} digest does not match its metrics`);
  }
}

function assertChildSequence(previous: CampaignChildRecord | undefined, child: CampaignChildRecord, completedPairs: ReadonlySet<string>): void {
  if (previous === undefined) {
    if (child.kind !== "preparation") throw new CampaignLedgerValidationError(`first child ${child.id} must be a preparation`);
    if (completedPairs.has(child.pairId)) throw new CampaignLedgerValidationError(`duplicate completed pair id: ${child.pairId}`);
    return;
  }
  if (previous.kind === "preparation") {
    if (child.kind !== "extraction") {
      throw new CampaignLedgerValidationError(`child ${child.id} must extract after preparation ${previous.id}`);
    }
    if (child.pairId !== previous.pairId) {
      throw new CampaignLedgerValidationError(`extraction child ${child.id} must share pair id ${previous.pairId}`);
    }
    return;
  }
  if (child.kind !== "preparation") throw new CampaignLedgerValidationError(`child ${child.id} must prepare after extraction ${previous.id}`);
  if (completedPairs.has(child.pairId)) throw new CampaignLedgerValidationError(`duplicate completed pair id: ${child.pairId}`);
}

function assertStopCondition(condition: CampaignStopCondition): void {
  assertRecord(condition, "campaign stop condition");
  if (condition.kind === "all-children-applied") return;
  if (condition.kind === "max-children") {
    if (!Number.isSafeInteger(condition.maximum) || condition.maximum < 1) {
      throw new CampaignLedgerValidationError("campaign max-children must be a positive integer");
    }
    return;
  }
  nonEmpty(condition.metric, "campaign metric-threshold metric");
  if (!Number.isFinite(condition.value)) throw new CampaignLedgerValidationError("campaign metric-threshold value must be finite");
}

function nonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new CampaignLedgerValidationError(`${label} must be non-empty`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CampaignLedgerValidationError(`${label} must be an object`);
  }
}

function sameGraph(left: GraphMetricSnapshot, right: GraphMetricSnapshot): boolean {
  return left.digest === right.digest && stableStringify(left.metrics) === stableStringify(right.metrics);
}
