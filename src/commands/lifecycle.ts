/** Read-only operator lifecycle classification. */
import { flagString, type ParsedArgs } from "../cli/args.ts";
import { headCommit, showBaseline } from "../util/git.ts";
import { inspectCommitChain } from "../transaction/commit-evidence.ts";
import { classifyLifecycle, type LifecycleStatus } from "../transaction/lifecycle-status.ts";
import { auditPlanSync } from "../transaction/audit.ts";
import { assertReconcilableAudit } from "../reconciliation/validate.ts";
import { readAppliedPlanReceipt, readReconciliationRecord, reconciliationAuditManifest, verifyReceiptLink, verifyReconciliationLink } from "../reconciliation/index.ts";
import type { ReadEvidence, ReconciliationRecord } from "../reconciliation/index.ts";
import { readApplyTransactionState } from "../transaction/apply-state.ts";
import type { CommandSpec } from "./types.ts";
import { load, loadManifest, print } from "./shared.ts";

async function status(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const head = headCommit(rootDir);
  const requestedPlan = flagString(args, "plan");
  if (requestedPlan === undefined) {
    const classified = classifyLifecycle({ atBaseline: false, planWritten: false });
    print({ ...classified, headCommit: head, evidence: { transaction: readApplyTransactionState(rootDir) ?? null } }, args);
    return;
  }
  const { path, manifest } = await loadManifest(args, rootDir);
  const chain = inspectCommitChain({ rootDir, manifest, manifestPath: path, headCommit: head });
  const manifestBytes = chain.approvalCommit === undefined ? null : showBaseline(rootDir, chain.approvalCommit, path);
  const reconciliation = loadReconciliation(args, rootDir, manifest, path, manifestBytes, chain);
  const auditedManifest = reconciliation?.value === undefined ? manifest : reconciliationAuditManifest(manifest, reconciliation.value);
  const audit = chain.phase === "applied" ? auditPlanSync({ config, rootDir, manifest: auditedManifest }) : undefined;
  const auditEvidence = audit === undefined ? undefined : {
    passed: audit.passed, reconcilable: !audit.passed && reconcilable(audit), failures: audit.failures,
  };
  const receipt = loadReceipt(args, rootDir, manifest, path, manifestBytes, chain, reconciliation);
  const evidence = {
    manifestPath: path, planId: manifest.planId, atBaseline: head === manifest.baselineCommit,
    planWritten: true, chain, ...(auditEvidence === undefined ? {} : { audit: auditEvidence }),
    ...(receipt === undefined ? {} : { receipt: receipt.evidence }), ...(reconciliation === undefined ? {} : { reconciliation: reconciliation.evidence }),
  };
  const classified = classifyLifecycle(evidence);
  const transaction = readApplyTransactionState(rootDir);
  const output: LifecycleStatus & { readonly transaction: typeof transaction | null } = {
    ...classified, planId: manifest.planId, manifestPath: path, headCommit: head,
    evidence,
    transaction: transaction ?? null,
  };
  print(output, args);
}

export const lifecycleCommands: Record<string, CommandSpec> = {
  status: {
    summary: "report the lifecycle state and one safe next command",
    usage: "status [--plan <path>] [--receipt <path>] [--reconciliation <path>]",
    details: "Read-only. Proves exact approval and application commit boundaries, audits an applied tree, validates optional immutable receipt and reconciliation records, reports durable transaction evidence, and emits exactly one next command.",
    run: status,
  },
};

function reconcilable(report: ReturnType<typeof auditPlanSync>): boolean {
  try { assertReconcilableAudit(report); return true; } catch { return false; }
}

function loadReconciliation(args: ParsedArgs, rootDir: string, manifest: Awaited<ReturnType<typeof loadManifest>>["manifest"], manifestPath: string, manifestBytes: string | null, chain: ReturnType<typeof inspectCommitChain>) {
  const path = flagString(args, "reconciliation");
  if (path === undefined) return undefined;
  const failures: string[] = [];
  let evidence: ReadEvidence<ReconciliationRecord> | undefined;
  let approvalCommit: string | undefined;
  try {
    if (manifestBytes === null) throw new Error("approved manifest bytes are unavailable");
    evidence = readReconciliationRecord(rootDir, path);
    approvalCommit = verifyReconciliationLink({ rootDir, manifest, manifestPath, manifestBytes, chain, evidence }).approvalCommit;
  } catch (error) { failures.push((error as Error).message); }
  return { path, value: evidence?.value, approvalCommit, evidence: { valid: failures.length === 0, failures } };
}

function loadReceipt(args: ParsedArgs, rootDir: string, manifest: Awaited<ReturnType<typeof loadManifest>>["manifest"], manifestPath: string, manifestBytes: string | null, chain: ReturnType<typeof inspectCommitChain>, reconciliation?: ReturnType<typeof loadReconciliation>) {
  const path = flagString(args, "receipt");
  if (path === undefined) return undefined;
  const failures: string[] = [];
  try {
    if (manifestBytes === null) throw new Error("approved manifest bytes are unavailable");
    const receipt = readAppliedPlanReceipt(rootDir, path);
    verifyReceiptLink(receipt, manifest, manifestPath, manifestBytes, chain);
    if (receipt.value.reconciliation !== undefined && (reconciliation?.value === undefined || reconciliation.approvalCommit === undefined ||
      receipt.value.reconciliation.recordId !== reconciliation.value.recordId || receipt.value.reconciliation.approvalCommit !== reconciliation.approvalCommit)) {
      throw new Error("receipt reconciliation linkage is not proven by the supplied approved record");
    }
  } catch (error) { failures.push((error as Error).message); }
  return { path, evidence: { valid: failures.length === 0, failures } };
}
