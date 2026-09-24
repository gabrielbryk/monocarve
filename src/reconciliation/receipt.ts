import type { ExtractionManifest } from "../plan/manifest.ts";
import type { AuditReport } from "../transaction/audit.ts";
import { hashJson, hashText, stableStringify } from "../util/hash.ts";
import { normalizedAudit } from "./compile.ts";
import type { AppliedPlanReceipt, AppliedPlanReceiptPayload, ReconciliationRecord } from "./types.ts";
import { appliedPlanReceiptId, assertAppliedPlanReceiptValid, assertReconciliationRecordValid, ReconciliationValidationError } from "./validate.ts";

export interface CompileAppliedPlanReceiptInput {
  readonly record?: { readonly path: string; readonly bytes: string; readonly value: ReconciliationRecord; readonly approvalCommit: string };
  readonly plan: ReconciliationRecord["plan"];
  readonly application: ReconciliationRecord["application"];
  readonly observedCommit: string;
  readonly observedCommitDate: string;
  readonly audit: AuditReport;
  readonly manifest: ExtractionManifest;
}

type SuppliedRecord = NonNullable<CompileAppliedPlanReceiptInput["record"]>;

export function compileAppliedPlanReceipt(input: CompileAppliedPlanReceiptInput): AppliedPlanReceipt {
  assertReceiptIdentity(input);
  if (input.record !== undefined) assertSuppliedRecord(input.record, input.manifest);
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
    ...(input.record === undefined ? {} : { reconciliation: reconciliationReference(input.record) }),
  };
  const receipt = { ...payload, receiptId: appliedPlanReceiptId(payload) };
  assertAppliedPlanReceiptValid(receipt);
  return receipt;
}

function assertReceiptIdentity(input: CompileAppliedPlanReceiptInput): void {
  if (!input.audit.passed) throw new ReconciliationValidationError("cannot issue a receipt for a failed audit");
  if (input.audit.planId !== input.plan.planId || input.audit.baselineCommit !== input.plan.baselineCommit) {
    throw new ReconciliationValidationError("receipt audit does not identify its plan");
  }
  if (input.observedCommit !== input.application.resultingCommit && input.record === undefined) {
    throw new ReconciliationValidationError("a later audit commit requires an approved reconciliation record");
  }
}

/** The supplied bytes encode the supplied record, and that record was compiled from this manifest. */
function assertSuppliedRecord(record: SuppliedRecord, manifest: ExtractionManifest): void {
  assertReconciliationRecordValid(record.value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.bytes);
  } catch (error) {
    throw new ReconciliationValidationError("reconciliation bytes are not JSON", { cause: error });
  }
  if (stableStringify(parsed) !== stableStringify(record.value)) {
    throw new ReconciliationValidationError("reconciliation bytes do not encode the supplied record");
  }
  if (
    record.value.generator.name !== manifest.generator.name ||
    record.value.generator.version !== manifest.generator.version ||
    stableStringify(record.value.provenance) !== stableStringify(manifest.provenance)
  ) {
    throw new ReconciliationValidationError("reconciliation provenance does not match the supplied manifest");
  }
}

function reconciliationReference(record: SuppliedRecord): NonNullable<AppliedPlanReceiptPayload["reconciliation"]> {
  return { path: record.path, digest: hashText(record.bytes), recordId: record.value.recordId, approvalCommit: record.approvalCommit };
}
