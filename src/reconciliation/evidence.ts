import { readFileSync } from "node:fs";

import type { ExtractionManifest } from "../plan/manifest.ts";
import type { CommitChainEvidence } from "../transaction/commit-evidence.ts";
import { showBaseline, tryGit, repositoryPrefix } from "../util/git.ts";
import { hashText, stableStringify } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { parseRecord } from "./parsing.ts";
import type { AppliedPlanReceipt, ReconciliationRecord } from "./types.ts";
import { ReconciliationValidationError } from "./validate.ts";

export interface ReadEvidence<T> {
  readonly path: string;
  readonly bytes: string;
  readonly value: T;
}

export function readReconciliationRecord(rootDir: string, inputPath: string): ReadEvidence<ReconciliationRecord> {
  return read(rootDir, inputPath, (value) => parseRecord.reconciliation(value), canonical);
}

export function readAppliedPlanReceipt(rootDir: string, inputPath: string): ReadEvidence<AppliedPlanReceipt> {
  return read(rootDir, inputPath, (value) => parseRecord.receipt(value), canonical);
}

function canonical(value: unknown): string {
  return `${stableStringify(value, 2)}\n`;
}

function read<T>(rootDir: string, inputPath: string, parse: (value: unknown) => T, serialize: (value: T) => string): ReadEvidence<T> {
  const path = relativeWorkspacePath(rootDir, inputPath);
  const bytes = readFileSync(workspacePath(rootDir, path), "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new ReconciliationValidationError(`evidence is not JSON: ${path}`);
  }
  const value = parse(raw);
  if (bytes !== serialize(value)) throw new ReconciliationValidationError(`evidence bytes are not canonical: ${path}`);
  return { path, bytes, value };
}

export interface ReconciliationLinkOptions {
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly manifestPath: string;
  readonly manifestBytes: string;
  readonly chain: CommitChainEvidence;
  readonly evidence: ReadEvidence<ReconciliationRecord>;
}

export function verifyReconciliationLink(options: ReconciliationLinkOptions): { readonly approvalCommit: string } {
  const { record } = { record: options.evidence.value };
  const chain = options.chain;
  if (!chain.valid || chain.phase !== "applied" || !chain.approvalCommit || !chain.appliedCommit) fail("reconciliation does not link to an applied chain");
  if (
    record.plan.planId !== options.manifest.planId ||
    record.plan.path !== options.manifestPath ||
    record.plan.digest !== hashText(options.manifestBytes) ||
    record.plan.baselineCommit !== options.manifest.baselineCommit ||
    record.plan.approvalCommit !== chain.approvalCommit
  )
    fail("reconciliation plan linkage does not match the approved manifest");
  if (
    record.generator.name !== options.manifest.generator.name ||
    record.generator.version !== options.manifest.generator.version ||
    stableStringify(record.provenance) !== stableStringify(options.manifest.provenance)
  )
    fail("reconciliation provenance does not match the approved manifest");
  if (
    record.application.moveCommit !== chain.moveCommit ||
    record.application.wiringCommit !== chain.wiringCommit ||
    record.application.resultingCommit !== chain.appliedCommit
  ) {
    fail("reconciliation application linkage does not match the exact chain");
  }
  const approval = tryGit({ cwd: options.rootDir }, "rev-parse", `${record.observed.headCommit}^0`);
  if (approval === null) fail("reconciliation observed head does not exist");
  const children = (tryGit({ cwd: options.rootDir }, "rev-list", "--first-parent", "--reverse", `${record.observed.headCommit}..HEAD`) ?? "")
    .split("\n")
    .filter(Boolean);
  const commit = children[0];
  if (commit === undefined || tryGit({ cwd: options.rootDir }, "rev-parse", `${commit}^`) !== record.observed.headCommit)
    fail("reconciliation approval is not directly atop its observed head");
  if (tryGit({ cwd: options.rootDir }, "log", "-1", "--format=%s", commit) !== record.approval.subject)
    fail("reconciliation approval subject does not match the record");
  const paths = (tryGit({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit) ?? "").split("\n").filter(Boolean);
  const expectedPath = `${repositoryPrefix(options.rootDir)}${options.evidence.path}`;
  if (paths.length !== 1 || paths[0] !== expectedPath) fail("reconciliation approval does not change exactly the record path");
  if (showBaseline(options.rootDir, commit, options.evidence.path) !== options.evidence.bytes)
    fail("committed reconciliation bytes do not match the reviewed record");
  return { approvalCommit: commit };
}

export function verifyReceiptLink(
  receipt: ReadEvidence<AppliedPlanReceipt>,
  manifest: ExtractionManifest,
  manifestPath: string,
  manifestBytes: string,
  chain: CommitChainEvidence,
): void {
  const value = receipt.value;
  if (!chain.valid || chain.phase !== "applied" || !chain.approvalCommit || !chain.appliedCommit) fail("receipt does not link to an applied chain");
  if (
    value.plan.planId !== manifest.planId ||
    value.plan.path !== manifestPath ||
    value.plan.digest !== hashText(manifestBytes) ||
    value.plan.baselineCommit !== manifest.baselineCommit ||
    value.plan.approvalCommit !== chain.approvalCommit
  )
    fail("receipt plan linkage does not match the approved manifest");
  if (
    value.application.moveCommit !== chain.moveCommit ||
    value.application.wiringCommit !== chain.wiringCommit ||
    value.application.resultingCommit !== chain.appliedCommit
  ) {
    fail("receipt application linkage does not match the exact chain");
  }
  if (
    value.generator.name !== manifest.generator.name ||
    value.generator.version !== manifest.generator.version ||
    stableStringify(value.provenance) !== stableStringify(manifest.provenance)
  ) {
    fail("receipt provenance does not match the manifest");
  }
}

function fail(message: string): never {
  throw new ReconciliationValidationError(message);
}
