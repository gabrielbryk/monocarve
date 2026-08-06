import type { ExtractionManifest, PlanProvenance } from "../plan/manifest.ts";
import type { AuditReport } from "../transaction/audit.ts";
import type { FileState, Sha256 } from "../util/hash.ts";

export const RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const APPLIED_PLAN_RECEIPT_SCHEMA_VERSION = 1 as const;

export type { PlanProvenance } from "../plan/manifest.ts";

export interface ReconciledDiscrepancy {
  readonly path: string;
  readonly ownership: "operation" | "generated-artifact";
  readonly expected: FileState;
  readonly actual: FileState;
  readonly operationIndexes: readonly number[];
}

export interface ReconciliationRecordPayload {
  readonly schemaVersion: typeof RECONCILIATION_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly generator: ExtractionManifest["generator"];
  readonly provenance?: PlanProvenance;
  readonly plan: {
    readonly planId: string;
    readonly path: string;
    readonly digest: Sha256;
    readonly baselineCommit: string;
    readonly approvalCommit: string;
  };
  readonly application: {
    readonly moveCommit?: string;
    readonly wiringCommit?: string;
    readonly resultingCommit: string;
  };
  readonly observed: {
    readonly headCommit: string;
    readonly auditDigest: Sha256;
    readonly audit: AuditReport;
  };
  readonly discrepancies: readonly ReconciledDiscrepancy[];
  readonly reason: string;
  readonly approval: { readonly subject: string; readonly body?: string };
}

export interface ReconciliationRecord extends ReconciliationRecordPayload {
  readonly recordId: Sha256;
}

export interface AppliedPlanReceiptPayload {
  readonly schemaVersion: typeof APPLIED_PLAN_RECEIPT_SCHEMA_VERSION;
  readonly createdAt: string;
  readonly generator: ExtractionManifest["generator"];
  readonly provenance?: PlanProvenance;
  readonly plan: ReconciliationRecord["plan"];
  readonly application: ReconciliationRecord["application"];
  readonly audit: {
    readonly observedCommit: string;
    readonly report: AuditReport;
    readonly digest: Sha256;
  };
  readonly reconciliation?: {
    readonly path: string;
    readonly digest: Sha256;
    readonly recordId: Sha256;
    readonly approvalCommit: string;
  };
}

export interface AppliedPlanReceipt extends AppliedPlanReceiptPayload {
  readonly receiptId: Sha256;
}
