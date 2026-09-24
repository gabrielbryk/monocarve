import type { ExtractionManifest } from "../plan/manifest.ts";
import { operationTargets } from "../plan/manifest.ts";
import type { AuditReport } from "../transaction/audit.ts";
import { byCodeUnit, hashJson, hashText, stableStringify, type FileState } from "../util/hash.ts";
import type { ReconciliationRecord, ReconciliationRecordPayload, ReconciledDiscrepancy } from "./types.ts";
import { assertReconcilableAudit, assertReconciliationRecordValid, ReconciliationValidationError, reconciliationRecordId } from "./validate.ts";

export interface CompileReconciliationInput {
  readonly manifest: ExtractionManifest;
  /** Exact approved bytes, including formatting and final newline. */
  readonly manifestBytes: string;
  readonly manifestPath: string;
  readonly approvalCommit: string;
  readonly moveCommit?: string;
  readonly wiringCommit?: string;
  readonly observedHead: string;
  readonly observedCommitDate: string;
  readonly audit: AuditReport;
  readonly discrepancies: readonly { readonly path: string; readonly actual: FileState }[];
  readonly reason: string;
  readonly approval: { readonly subject: string; readonly body?: string };
}

/** Compile evidence only. Lifecycle ancestry and committed-byte proofs remain caller obligations. */
export function compileReconciliationRecord(input: CompileReconciliationInput): ReconciliationRecord {
  assertManifestBytes(input.manifestBytes, input.manifest);
  assertReconcilableAudit(input.audit);
  const audit = normalizedAudit(input.audit);
  const expected = expectedStates(input.manifest);
  const seen = new Set<string>();
  const discrepancies: ReconciledDiscrepancy[] = input.discrepancies
    .map(({ path, actual }) => {
      if (seen.has(path)) throw new ReconciliationValidationError(`duplicate observed discrepancy: ${path}`);
      seen.add(path);
      const ownership = expected.get(path);
      if (ownership === undefined) throw new ReconciliationValidationError(`undeclared discrepancy cannot be reconciled: ${path}`);
      if (ownership.expected === actual) throw new ReconciliationValidationError(`observed discrepancy ${path} matches its declared state`);
      return { path, actual, ...ownership };
    })
    .toSorted((left, right) => byCodeUnit(left.path, right.path));
  const payload: ReconciliationRecordPayload = {
    schemaVersion: 1,
    createdAt: new Date(input.observedCommitDate).toISOString(),
    generator: input.manifest.generator,
    ...(input.manifest.provenance === undefined ? {} : { provenance: input.manifest.provenance }),
    plan: {
      planId: input.manifest.planId,
      path: input.manifestPath,
      digest: hashText(input.manifestBytes),
      baselineCommit: input.manifest.baselineCommit,
      approvalCommit: input.approvalCommit,
    },
    application: {
      ...(input.moveCommit === undefined ? {} : { moveCommit: input.moveCommit }),
      ...(input.wiringCommit === undefined ? {} : { wiringCommit: input.wiringCommit }),
      resultingCommit: input.wiringCommit ?? input.moveCommit ?? "",
    },
    observed: { headCommit: input.observedHead, auditDigest: hashJson(audit), audit },
    discrepancies,
    reason: input.reason,
    approval: input.approval,
  };
  const record = { ...payload, recordId: reconciliationRecordId(payload) };
  assertReconciliationRecordValid(record);
  return record;
}

export function normalizedAudit(report: AuditReport): AuditReport {
  return { ...report, auditedRoot: "." };
}

function assertManifestBytes(bytes: string, manifest: ExtractionManifest): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new ReconciliationValidationError("approved manifest bytes are not JSON");
  }
  if (stableStringify(parsed) !== stableStringify(manifest)) {
    throw new ReconciliationValidationError("approved manifest bytes do not encode the supplied plan");
  }
}

function expectedStates(manifest: ExtractionManifest): Map<string, Omit<ReconciledDiscrepancy, "path" | "actual">> {
  const operations = new Map<string, { expected: FileState; operationIndexes: number[] }>();
  manifest.operations.forEach((operation, index) => {
    for (const path of operationTargets(operation)) {
      const current = operations.get(path) ?? { expected: operation.resultHash, operationIndexes: [] };
      current.expected = operation.resultHash;
      current.operationIndexes.push(index);
      operations.set(path, current);
    }
  });
  const result = new Map<string, Omit<ReconciledDiscrepancy, "path" | "actual">>();
  for (const [path, value] of operations) result.set(path, { ownership: "operation", ...value });
  for (const generated of manifest.generatedFiles) {
    if (generated.regenerateOnApply !== true || generated.expectedHash === undefined) continue;
    const indexes = operations.get(generated.path)?.operationIndexes ?? [];
    result.set(generated.path, { ownership: "generated-artifact", expected: generated.expectedHash, operationIndexes: indexes });
  }
  return result;
}
