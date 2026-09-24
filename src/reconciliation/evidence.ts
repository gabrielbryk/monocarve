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
  } catch (error) {
    throw new ReconciliationValidationError(`evidence is not JSON: ${path}`, { cause: error });
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
  const record = options.evidence.value;
  const chain = options.chain;
  if (!isAppliedChain(chain)) fail("reconciliation does not link to an applied chain");
  if (!planLinkMatches(record.plan, options.manifest, options.manifestPath, options.manifestBytes, chain))
    fail("reconciliation plan linkage does not match the approved manifest");
  if (!provenanceMatches(record, options.manifest)) fail("reconciliation provenance does not match the approved manifest");
  if (!applicationLinkMatches(record.application, chain)) {
    fail("reconciliation application linkage does not match the exact chain");
  }
  return { approvalCommit: verifiedApprovalCommit(options, record) };
}

/** The single commit directly atop the observed head that adds exactly the reviewed record. */
function verifiedApprovalCommit(options: ReconciliationLinkOptions, record: ReconciliationRecord): string {
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
  return commit;
}

export function verifyReceiptLink(
  receipt: ReadEvidence<AppliedPlanReceipt>,
  manifest: ExtractionManifest,
  manifestPath: string,
  manifestBytes: string,
  chain: CommitChainEvidence,
): void {
  const value = receipt.value;
  if (!isAppliedChain(chain)) fail("receipt does not link to an applied chain");
  if (!planLinkMatches(value.plan, manifest, manifestPath, manifestBytes, chain)) fail("receipt plan linkage does not match the approved manifest");
  if (!applicationLinkMatches(value.application, chain)) {
    fail("receipt application linkage does not match the exact chain");
  }
  if (!provenanceMatches(value, manifest)) {
    fail("receipt provenance does not match the manifest");
  }
}

function isAppliedChain(chain: CommitChainEvidence): boolean {
  return chain.valid && chain.phase === "applied" && Boolean(chain.approvalCommit) && Boolean(chain.appliedCommit);
}

function planLinkMatches(
  plan: ReconciliationRecord["plan"],
  manifest: ExtractionManifest,
  manifestPath: string,
  manifestBytes: string,
  chain: CommitChainEvidence,
): boolean {
  return (
    plan.planId === manifest.planId &&
    plan.path === manifestPath &&
    plan.digest === hashText(manifestBytes) &&
    plan.baselineCommit === manifest.baselineCommit &&
    plan.approvalCommit === chain.approvalCommit
  );
}

function applicationLinkMatches(application: ReconciliationRecord["application"], chain: CommitChainEvidence): boolean {
  return application.moveCommit === chain.moveCommit && application.wiringCommit === chain.wiringCommit && application.resultingCommit === chain.appliedCommit;
}

function provenanceMatches(evidence: Pick<ReconciliationRecord, "generator" | "provenance">, manifest: ExtractionManifest): boolean {
  return (
    evidence.generator.name === manifest.generator.name &&
    evidence.generator.version === manifest.generator.version &&
    stableStringify(evidence.provenance) === stableStringify(manifest.provenance)
  );
}

function fail(message: string): never {
  throw new ReconciliationValidationError(message);
}
