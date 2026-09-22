import { MonocarveError } from "../errors.ts";
import type { AuditReport } from "../transaction/audit.ts";
import { byCodeUnit, hashJson, isFileState, isSha256 } from "../util/hash.ts";
import {
  APPLIED_PLAN_RECEIPT_SCHEMA_VERSION,
  RECONCILIATION_SCHEMA_VERSION,
  type AppliedPlanReceipt,
  type AppliedPlanReceiptPayload,
  type ReconciliationRecord,
  type ReconciliationRecordPayload,
} from "./types.ts";

export class ReconciliationValidationError extends MonocarveError {
  override readonly name = "ReconciliationValidationError";
}

export function reconciliationRecordId(payload: ReconciliationRecordPayload): string {
  return hashJson(payload);
}

export function appliedPlanReceiptId(payload: AppliedPlanReceiptPayload): string {
  return hashJson(payload);
}

export function assertReconciliationRecordValid(record: ReconciliationRecord): void {
  if (record.schemaVersion !== RECONCILIATION_SCHEMA_VERSION) fail("unsupported reconciliation schema version");
  const { recordId, ...payload } = record;
  if (!isSha256(recordId) || reconciliationRecordId(payload) !== recordId) fail("reconciliation record id does not match its payload");
  assertCommon(payload);
  nonEmpty(payload.reason, "reconciliation reason");
  nonEmpty(payload.approval.subject, "reconciliation approval subject");
  if (payload.discrepancies.length === 0) fail("reconciliation must contain at least one discrepancy");
  let previous: string | undefined;
  for (const discrepancy of payload.discrepancies) {
    nonEmpty(discrepancy.path, "discrepancy path");
    if (previous !== undefined && byCodeUnit(previous, discrepancy.path) >= 0) fail("reconciliation discrepancies must have unique code-unit-sorted paths");
    previous = discrepancy.path;
    if (!isFileState(discrepancy.expected) || !isFileState(discrepancy.actual)) fail(`invalid file state for ${discrepancy.path}`);
    if (discrepancy.expected === discrepancy.actual) fail(`discrepancy ${discrepancy.path} does not differ`);
    if (discrepancy.ownership !== "operation" && discrepancy.ownership !== "generated-artifact") fail(`invalid ownership for ${discrepancy.path}`);
    if (!strictlyIncreasing(discrepancy.operationIndexes)) fail(`operation indexes for ${discrepancy.path} must be unique and sorted`);
    if (discrepancy.ownership === "operation" && discrepancy.operationIndexes.length === 0)
      fail(`operation-owned discrepancy ${discrepancy.path} names no operation`);
  }
  if (hashJson(payload.observed.audit) !== payload.observed.auditDigest) fail("observed audit digest does not match its report");
  sha(payload.observed.auditDigest, "observed audit digest");
  commit(payload.observed.headCommit, "observed head commit");
  assertAuditIdentity(payload.observed.audit, payload.plan.planId, payload.plan.baselineCommit);
  if (payload.observed.audit.auditedRoot !== ".") fail("persisted audit root must be workspace-relative");
  assertReconcilableAudit(payload.observed.audit);
}

export function assertReconcilableAudit(report: AuditReport): void {
  if (report.passed || (report.byteFidelity.passed && report.generatedArtifacts.passed)) {
    fail("reconciliation requires a failed byte-fidelity or generated-artifact proof");
  }
  const structural = [
    report.consumerCompleteness,
    report.boundaryRules,
    report.externalConsumerCompile,
    report.codemodReplay,
    report.entrypointClosure,
    report.lockfileIntegrity,
    report.sourceConservation,
  ];
  if (structural.some((proof) => !proof.passed) || !report.graphEvidence.passed || report.unauditable?.length) {
    fail("structural or semantic audit failures cannot be reconciled as byte drift");
  }
}

export function assertAppliedPlanReceiptValid(receipt: AppliedPlanReceipt): void {
  if (receipt.schemaVersion !== APPLIED_PLAN_RECEIPT_SCHEMA_VERSION) fail("unsupported applied-plan receipt schema version");
  const { receiptId, ...payload } = receipt;
  if (!isSha256(receiptId) || appliedPlanReceiptId(payload) !== receiptId) fail("applied-plan receipt id does not match its payload");
  assertCommon(payload);
  if (!payload.audit.report.passed) fail("applied-plan receipt requires a passing audit");
  commit(payload.audit.observedCommit, "audit observed commit");
  if (hashJson(payload.audit.report) !== payload.audit.digest) fail("receipt audit digest does not match its report");
  assertAuditIdentity(payload.audit.report, payload.plan.planId, payload.plan.baselineCommit);
  if (payload.audit.report.auditedRoot !== ".") fail("persisted audit root must be workspace-relative");
  if (payload.audit.observedCommit !== payload.application.resultingCommit && payload.reconciliation === undefined) {
    fail("unreconciled receipt audit must observe the exact application result");
  }
  if (payload.reconciliation !== undefined) {
    nonEmpty(payload.reconciliation.path, "reconciliation path");
    sha(payload.reconciliation.digest, "reconciliation digest");
    sha(payload.reconciliation.recordId, "reconciliation record id");
    commit(payload.reconciliation.approvalCommit, "reconciliation approval commit");
  }
}

function assertCommon(payload: ReconciliationRecordPayload | AppliedPlanReceiptPayload): void {
  if (Number.isNaN(Date.parse(payload.createdAt))) fail("createdAt must be an ISO date");
  nonEmpty(payload.generator.name, "generator name");
  nonEmpty(payload.generator.version, "generator version");
  nonEmpty(payload.plan.planId, "plan id");
  nonEmpty(payload.plan.path, "plan path");
  sha(payload.plan.digest, "plan digest");
  commit(payload.plan.baselineCommit, "baseline commit");
  commit(payload.plan.approvalCommit, "plan approval commit");
  if (payload.application.moveCommit !== undefined) commit(payload.application.moveCommit, "move commit");
  if (payload.application.wiringCommit !== undefined) commit(payload.application.wiringCommit, "wiring commit");
  if (payload.application.moveCommit === undefined && payload.application.wiringCommit === undefined) fail("application must contain a move or wiring commit");
  commit(payload.application.resultingCommit, "resulting commit");
  if (payload.application.resultingCommit !== (payload.application.wiringCommit ?? payload.application.moveCommit)) {
    fail("application result must be its wiring commit, or move commit when wiring is absent");
  }
}

function assertAuditIdentity(report: { readonly planId: string; readonly baselineCommit: string }, planId: string, baseline: string): void {
  if (report.planId !== planId || report.baselineCommit !== baseline) fail("audit does not identify the reconciled plan");
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => Number.isSafeInteger(value) && value >= 0 && (index === 0 || value > values[index - 1]!));
}

function sha(value: string, label: string): void {
  if (!isSha256(value)) fail(`${label} must be sha256`);
}
function commit(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${label} must be a full commit id`);
}
function nonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) fail(`${label} must be non-empty`);
}
function fail(message: string): never {
  throw new ReconciliationValidationError(message);
}
