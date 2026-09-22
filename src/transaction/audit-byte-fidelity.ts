/** Proof 1: moved, rewritten, and declared-write bytes match their evidence. */

import { type ExtractionManifest, type MoveOperation, type MoveWithRewriteOperation, type WriteFileOperation } from "../plan/manifest.ts";
import { MISSING } from "../util/hash.ts";
import { showBaselineHash, stateAt } from "./audit-helpers.ts";
import { proof, type ProofResult } from "./audit-types.ts";

type AnyMove = MoveOperation | MoveWithRewriteOperation;

function moveFailures(manifest: ExtractionManifest, rootDir: string, moves: readonly AnyMove[]): string[] {
  const failures: string[] = [];
  const compatibilitySource = manifest.modulePromotion?.retireSource === false ? manifest.modulePromotion.source : undefined;
  for (const move of moves) {
    if (stateAt(rootDir, move.source) !== MISSING && move.source !== compatibilitySource) failures.push(`moved source still present: ${move.source}`);
    const landed = stateAt(rootDir, move.target);
    if (landed !== move.resultHash) {
      failures.push(`moved bytes differ at ${move.target} (expected ${move.resultHash}, got ${landed})`);
    }
  }
  return failures;
}

function rewriteFailures(manifest: ExtractionManifest, rootDir: string): string[] {
  const failures: string[] = [];
  for (const operation of manifest.operations) {
    if (operation.kind !== "rewrite-import" && operation.kind !== "rewrite-fs-reference" && operation.kind !== "rewrite-path-reference") continue;
    // A declared post-journal generator owns the final bytes. The operation's
    // resultHash proves the intermediate journal state; regeneration then
    // deliberately replaces it before audit. Requiring that intermediate hash
    // here makes every generated consumer impossible to refresh. Its final
    // state remains covered by generated-artifact provenance, verification,
    // graph/consumer proofs, commit scope, and repository gates elsewhere in
    // the audit.
    if (manifest.generatedFiles.some((generated) => generated.path === operation.file && generated.regenerateOnApply)) continue;
    if (stateAt(rootDir, operation.file) !== operation.resultHash) {
      failures.push(`rewritten consumer does not match its declared result: ${operation.file}`);
    }
  }
  return failures;
}

/**
 * Proof 1, whole. The counted checks are the moves, the recorded baseline
 * blobs, the declared writes, and the path-key migrations — every claim this
 * proof actually re-derives from the worktree.
 */
export function byteFidelityProof(manifest: ExtractionManifest, rootDir: string, moves: readonly AnyMove[]): ProofResult {
  const byteFailures: string[] = [...moveFailures(manifest, rootDir, moves)];
  for (const [path, expected] of Object.entries(manifest.sourceBlobs)) {
    const baseline = showBaselineHash(rootDir, manifest.baselineCommit, path);
    if (baseline !== expected) byteFailures.push(`baseline blob does not match sourceBlobs: ${path}`);
  }
  byteFailures.push(...rewriteFailures(manifest, rootDir));
  // Unconditional, and there is no exemption for it. A `write-file` operation
  // carries the bytes verbatim, so unlike a `generatedFiles` entry — whose
  // post-move content a regenerating tool decides, which is what `exemptReason`
  // exists for — what these bytes should be is never unknowable at plan time.
  // A path is written at most once per journal (the validator rejects a second
  // operation mutating it), so `resultHash` is the plan's final word on it.
  const writes = manifest.operations.filter((operation): operation is WriteFileOperation => operation.kind === "write-file");
  for (const operation of writes) {
    const landed = stateAt(rootDir, operation.path);
    if (landed !== operation.resultHash) {
      byteFailures.push(`written file does not match its declared result: ${operation.path} (expected ${operation.resultHash}, got ${landed})`);
    }
  }
  const migrations = manifest.operations.filter((operation) => operation.kind === "migrate-path-keys");
  for (const operation of migrations) {
    const landed = stateAt(rootDir, operation.path);
    if (landed !== operation.resultHash) {
      byteFailures.push(
        `path-keyed artifact does not match its declared migration result: ${operation.path} ` + `(expected ${operation.resultHash}, got ${landed})`,
      );
    }
  }
  return proof(byteFailures, moves.length + Object.keys(manifest.sourceBlobs).length + writes.length + migrations.length);
}
