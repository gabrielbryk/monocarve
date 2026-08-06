import type { AuditReport } from "../transaction/audit.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { hashJson, hashText, stableStringify } from "../util/hash.ts";
import type { AppliedPlanReceipt, AppliedPlanReceiptPayload, ReconciliationRecord } from "./types.ts";
import { appliedPlanReceiptId, assertAppliedPlanReceiptValid, assertReconciliationRecordValid, ReconciliationValidationError } from "./validate.ts";
import { normalizedAudit } from "./compile.ts";

export interface CompileAppliedPlanReceiptInput {
  readonly record?: { readonly path: string; readonly bytes: string; readonly value: ReconciliationRecord; readonly approvalCommit: string };
  readonly plan: ReconciliationRecord["plan"];
  readonly application: ReconciliationRecord["application"];
  readonly observedCommit: string;
  readonly observedCommitDate: string;
  readonly audit: AuditReport;
  readonly manifest: ExtractionManifest;
}

export function compileAppliedPlanReceipt(input: CompileAppliedPlanReceiptInput): AppliedPlanReceipt {
  if (!input.audit.passed) throw new ReconciliationValidationError("cannot issue a receipt for a failed audit");
  if (input.audit.planId !== input.plan.planId || input.audit.baselineCommit !== input.plan.baselineCommit) {
    throw new ReconciliationValidationError("receipt audit does not identify its plan");
  }
  if (input.observedCommit !== input.application.resultingCommit && input.record === undefined) {
    throw new ReconciliationValidationError("a later audit commit requires an approved reconciliation record");
  }
  if (input.record !== undefined) {
    assertReconciliationRecordValid(input.record.value);
    let parsed: unknown;
    try { parsed = JSON.parse(input.record.bytes); } catch { throw new ReconciliationValidationError("reconciliation bytes are not JSON"); }
    if (stableStringify(parsed) !== stableStringify(input.record.value)) {
      throw new ReconciliationValidationError("reconciliation bytes do not encode the supplied record");
    }
    if (input.record.value.generator.name !== input.manifest.generator.name || input.record.value.generator.version !== input.manifest.generator.version ||
        stableStringify(input.record.value.provenance) !== stableStringify(input.manifest.provenance)) {
      throw new ReconciliationValidationError("reconciliation provenance does not match the supplied manifest");
    }
  }
  if (input.plan.planId !== input.manifest.planId || input.plan.baselineCommit !== input.manifest.baselineCommit) {
    throw new ReconciliationValidationError("receipt plan evidence does not match the supplied manifest");
  }
  const audit = normalizedAudit(input.audit);
  const payload: AppliedPlanReceiptPayload = {
    schemaVersion: 1,
    createdAt: new Date(input.observedCommitDate).toISOString(),
    generator: input.manifest.generator,
    ...(input.manifest.provenance === undefined ? {} : { provenance: input.manifest.provenance }),
    plan: input.plan,
    application: input.application,
    audit: { observedCommit: input.observedCommit, report: audit, digest: hashJson(audit) },
    ...(input.record === undefined ? {} : { reconciliation: {
      path: input.record.path, digest: hashText(input.record.bytes), recordId: input.record.value.recordId,
      approvalCommit: input.record.approvalCommit,
    } }),
  };
  const receipt = { ...payload, receiptId: appliedPlanReceiptId(payload) };
  assertAppliedPlanReceiptValid(receipt);
  return receipt;
}
