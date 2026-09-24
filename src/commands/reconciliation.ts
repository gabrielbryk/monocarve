/** Commands that compile immutable post-application evidence without changing plans. */
import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { UsageError, PreflightError } from "../errors.ts";
import { operationTargets } from "../plan/manifest.ts";
import { assertPlanValid } from "../plan/validate.ts";
import {
  approveReconciliation,
  compileAppliedPlanReceipt,
  compileReconciliationRecord,
  readReconciliationRecord,
  reconciliationApprovalEvidence,
  reconciliationAuditManifest,
  serializeAppliedPlanReceipt,
  serializeReconciliationRecord,
  verifyReconciliationLink,
} from "../reconciliation/index.ts";
import { auditPlanSync } from "../transaction/audit.ts";
import { inspectCommitChain } from "../transaction/commit-evidence.ts";
import { fileState } from "../util/files.ts";
import { headCommit, resolveCommit, showBaseline, statusShort } from "../util/git.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { load, loadManifest, outputPath, print, writeOutput } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

async function reconcile(args: ParsedArgs): Promise<void> {
  const reason = requiredFlag(args, "reason");
  const approvalSubject = requiredFlag(args, "approval-subject");
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  assertPlanValid(manifest, { config, rootDir });
  assertClean(rootDir);
  const head = headCommit(rootDir);
  const chain = inspectCommitChain({ rootDir, manifest, manifestPath: path, headCommit: head });
  if (
    !chain.valid ||
    chain.phase !== "applied" ||
    chain.approvalCommit === undefined ||
    (chain.moveCommit === undefined && chain.wiringCommit === undefined) ||
    chain.appliedCommit === undefined
  ) {
    throw new PreflightError(`reconciliation requires an exact applied commit chain: ${chain.failures.join("; ") || `found ${chain.phase}`}`);
  }
  const manifestBytes = showBaseline(rootDir, chain.approvalCommit, path);
  if (manifestBytes === null) throw new PreflightError(`approved manifest bytes are missing at ${chain.approvalCommit}:${path}`);
  const audit = auditPlanSync({ config, rootDir, manifest });
  const discrepancies = observedDiscrepancies(rootDir, manifest);
  const record = compileReconciliationRecord({
    manifest,
    manifestBytes,
    manifestPath: path,
    approvalCommit: chain.approvalCommit,
    ...(chain.moveCommit === undefined ? {} : { moveCommit: chain.moveCommit }),
    ...(chain.wiringCommit === undefined ? {} : { wiringCommit: chain.wiringCommit }),
    observedHead: head,
    observedCommitDate: resolveCommit(rootDir, head).committedAt,
    audit,
    discrepancies,
    reason,
    approval: { subject: approvalSubject },
  });
  const out = outputPath(rootDir, flagString(args, "out") ?? `${config.planDir}/${manifest.planId}.reconcile.${head}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(rootDir, out, serializeReconciliationRecord(record), { exclusive: true });
  print({ schema: "reconciliation-preview-v1", record, output: out, written }, args);
}

async function receipt(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  assertPlanValid(manifest, { config, rootDir });
  assertClean(rootDir);
  const head = headCommit(rootDir);
  const chain = inspectCommitChain({ rootDir, manifest, manifestPath: path, headCommit: head });
  if (
    !chain.valid ||
    chain.phase !== "applied" ||
    chain.approvalCommit === undefined ||
    (chain.moveCommit === undefined && chain.wiringCommit === undefined) ||
    chain.appliedCommit === undefined
  ) {
    throw new PreflightError(`receipt requires an exact applied commit chain: ${chain.failures.join("; ") || `found ${chain.phase}`}`);
  }
  const manifestBytes = showBaseline(rootDir, chain.approvalCommit, path);
  if (manifestBytes === null) throw new PreflightError(`approved manifest bytes are missing at ${chain.approvalCommit}:${path}`);
  const reconciliationPath = flagString(args, "reconciliation");
  const reconciliation = reconciliationPath === undefined ? undefined : readReconciliationRecord(rootDir, reconciliationPath);
  const approval =
    reconciliation === undefined
      ? undefined
      : verifyReconciliationLink({ rootDir, manifest, manifestPath: path, manifestBytes, chain, evidence: reconciliation });
  if (reconciliation === undefined && head !== chain.appliedCommit)
    throw new PreflightError("unreconciled receipt must be created at the exact application result commit");
  if (approval !== undefined && head !== approval.approvalCommit)
    throw new PreflightError("reconciled receipt must be created at the exact reconciliation approval commit");
  if (reconciliation !== undefined) assertCurrentDiscrepancies(rootDir, manifest, reconciliation.value);
  const auditManifest = reconciliation === undefined ? manifest : reconciliationAuditManifest(manifest, reconciliation.value);
  const audit = auditPlanSync({ config, rootDir, manifest: auditManifest });
  const receiptValue = compileAppliedPlanReceipt({
    plan: { planId: manifest.planId, path, digest: hashText(manifestBytes), baselineCommit: manifest.baselineCommit, approvalCommit: chain.approvalCommit },
    application: {
      ...(chain.moveCommit === undefined ? {} : { moveCommit: chain.moveCommit }),
      ...(chain.wiringCommit === undefined ? {} : { wiringCommit: chain.wiringCommit }),
      resultingCommit: chain.appliedCommit,
    },
    observedCommit: head,
    observedCommitDate: resolveCommit(rootDir, head).committedAt,
    audit,
    manifest,
    ...(reconciliation === undefined || approval === undefined
      ? {}
      : { record: { path: reconciliation.path, bytes: reconciliation.bytes, value: reconciliation.value, approvalCommit: approval.approvalCommit } }),
  });
  const out = outputPath(rootDir, flagString(args, "out") ?? `${config.planDir}/${manifest.planId}.receipt.${head}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(rootDir, out, serializeAppliedPlanReceipt(receiptValue), { exclusive: true });
  print({ schema: "applied-plan-receipt-preview-v1", receipt: receiptValue, output: out, written }, args);
}

async function reconcileApprove(args: ParsedArgs): Promise<void> {
  const recordPath = flagString(args, "record") ?? args.positionals[0];
  if (recordPath === undefined) throw new UsageError("--record <path> is required");
  const { config, rootDir } = await load(args);
  const evidence = readReconciliationRecord(rootDir, recordPath);
  if (!flagBool(args, "commit")) {
    print({ ...reconciliationApprovalEvidence(rootDir, evidence), commit: false }, args);
    return;
  }
  print({ ...approveReconciliation({ rootDir, config, evidence }), committed: true }, args);
}

function observedDiscrepancies(
  rootDir: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>["manifest"],
): { path: string; actual: ReturnType<typeof fileState> }[] {
  const expected = new Map<string, string>();
  for (const operation of manifest.operations) for (const path of operationTargets(operation)) expected.set(path, operation.resultHash);
  for (const generated of manifest.generatedFiles) {
    if (generated.regenerateOnApply && generated.expectedHash) expected.set(generated.path, generated.expectedHash);
  }
  return [...expected]
    .flatMap(([path, expectedState]) => {
      const actual = fileState(workspacePath(rootDir, path));
      return actual === expectedState ? [] : [{ path, actual }];
    })
    .sort((left, right) => byCodeUnit(left.path, right.path));
}

function assertCurrentDiscrepancies(
  rootDir: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>["manifest"],
  record: Awaited<ReturnType<typeof readReconciliationRecord>>["value"],
): void {
  const actual = observedDiscrepancies(rootDir, manifest);
  if (
    actual.length !== record.discrepancies.length ||
    actual.some((entry, index) => entry.path !== record.discrepancies[index]?.path || entry.actual !== record.discrepancies[index]?.actual)
  ) {
    throw new PreflightError("current discrepancies do not exactly match the approved reconciliation record");
  }
}

function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} <value> is required`);
  return value;
}

function assertClean(rootDir: string): void {
  const dirty = statusShort(rootDir);
  if (dirty !== "") throw new PreflightError(`immutable evidence requires a clean worktree: ${dirty.split("\n").join(", ")}`);
}

export const reconciliationCommands: Record<string, CommandSpec> = {
  reconcile: {
    summary: "compile a linked post-apply reconciliation record",
    usage: "reconcile --plan <path> --reason <text> --approval-subject <subject> [--out <path>] [--write]",
    details:
      "Preview by default. Records only declared byte drift after proving the original approval and exact application chain. --write exclusively creates a new linked record and never changes the approved plan.",
    run: reconcile,
  },
  receipt: {
    summary: "compile an immutable applied-plan receipt",
    usage: "receipt --plan <path> [--reconciliation <approved-record>] [--out <path>] [--write]",
    details:
      "Preview by default. Requires the exact application-result commit and a passing independent audit. --write exclusively creates a new receipt and never changes the approved plan.",
    run: receipt,
  },
  "reconcile-approve": {
    summary: "inspect or commit one reconciliation record approval",
    usage: "reconcile-approve --record <path> [--commit]",
    details:
      "Without --commit, reports the reviewed record boundary. --commit creates an exact record-only approval directly atop the observed head and verifies hook output.",
    run: reconcileApprove,
  },
};
