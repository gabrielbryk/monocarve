/** Proof 7: lockfile importer blocks and generated artifacts match their evidence. */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { PackageManagerAdapter } from "../adapters/types.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { hashText, type FileState } from "../util/hash.ts";
import { stateAt, textAt } from "./audit-helpers.ts";
import { proof, type ProofResult } from "./audit-types.ts";

/**
 * An internal-consistency check, and only that. Both sides of this comparison
 * come from the same adapter: the landed block is re-read with the adapter's
 * parser and hashed against the block the plan spliced with it. So it fails on
 * a lockfile that was hand-edited, half-applied, or replayed from a different
 * plan — the tampering it exists for — and it cannot fail on a splice whose
 * shape the package manager itself would never write. That question is the
 * opt-in `--verify-lockfile` run's, and nothing here answers it.
 */
export function lockfileIntegrityProof(adapter: PackageManagerAdapter, manifest: ExtractionManifest, rootDir: string): ProofResult {
  const lockfileFailures: string[] = [];
  let lockfileChecks = 0;
  for (const operation of manifest.operations) {
    if (operation.kind !== "lockfile-importer") continue;
    lockfileChecks += 1;
    const text = textAt(rootDir, operation.lockfile);
    const current = text === "" ? undefined : adapter.lockfileImporterHash(text, operation.packageRoot);
    const expected = operation.mode === "delete" ? undefined : hashText(operation.block);
    if (current !== expected) {
      lockfileFailures.push(`lockfile importer block does not match the worktree: ${operation.packageRoot}`);
    }
  }
  if (manifest.lockfileImporter) {
    lockfileChecks += 1;
    const text = textAt(rootDir, adapter.lockfileName);
    const current = text === "" ? undefined : adapter.lockfileImporterHash(text, manifest.lockfileImporter.packageRoot);
    if (current !== manifest.lockfileImporter.hash) {
      lockfileFailures.push("lockfile importer declaration does not match the worktree");
    }
  }
  return proof(lockfileFailures, lockfileChecks);
}

function generatedFileFailures(
  rootDir: string,
  generated: ExtractionManifest["generatedFiles"][number],
  regenerated: Readonly<Record<string, FileState>> | undefined,
): string[] {
  if (!existsSync(resolve(rootDir, generated.path))) return [`generated file is missing: ${generated.path}`];
  if (!existsSync(resolve(rootDir, generated.source))) {
    return [`generated file ${generated.path} declares a source that does not exist: ${generated.source}`];
  }
  if (regenerated !== undefined && generated.regenerateOnApply) {
    // The exemption covers "the plan could not know these bytes", not "these
    // bytes are nobody's business". Once the transaction has regenerated the
    // artifact, the bytes the generator produced are known, and an artifact
    // that no longer matches them is stale again — by a later step, a hook,
    // or a second generator undoing the first.
    const produced = regenerated[generated.path];
    if (produced === undefined) {
      return [`generated artifact declares a regeneration this transaction never ran: ${generated.path}`];
    }
    if (stateAt(rootDir, generated.path) !== produced) {
      return [`generated artifact was changed after it was regenerated: ${generated.path}`];
    }
  }
  if (generated.exemptReason) return [];
  if (generated.expectedHash) {
    return stateAt(rootDir, generated.path) === generated.expectedHash ? [] : [`generated file does not match its recorded hash: ${generated.path}`];
  }
  return [`generated file ${generated.path} carries neither a hash nor an exemption`];
}

export function generatedArtifactsProof(
  manifest: ExtractionManifest,
  rootDir: string,
  regenerated: Readonly<Record<string, FileState>> | undefined,
): ProofResult {
  const generatedFailures = manifest.generatedFiles.flatMap((generated) => generatedFileFailures(rootDir, generated, regenerated));
  return proof(generatedFailures, manifest.generatedFiles.length);
}

export function postJournalDeclarativeProof(manifest: ExtractionManifest, rootDir: string): ProofResult {
  const postJournalFailures = (manifest.postJournalPreparers ?? []).flatMap((preparer) =>
    preparer.mutations.flatMap((mutation) => {
      const path = resolve(rootDir, mutation.path);
      if (stateAt(rootDir, mutation.path) !== mutation.resultHash)
        return [`post-journal declarative result does not match its recorded hash: ${mutation.path}`];
      const mode = existsSync(path) ? (statSync(path).mode & 0o111 ? 0o755 : 0o644) : "missing";
      return mode === mutation.resultMode ? [] : [`post-journal declarative result does not match its recorded mode: ${mutation.path}`];
    }),
  );
  return proof(postJournalFailures, (manifest.postJournalPreparers ?? []).flatMap((item) => item.mutations).length);
}
