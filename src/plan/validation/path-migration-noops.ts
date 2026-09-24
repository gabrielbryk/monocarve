/** Validation for configured path migrations a plan must carry, either as an operation or as a no-op proof. */
import { resolve } from "node:path";

import { triggeredPathMigrations } from "../../config.ts";
import { hashText, isSha256 } from "../../util/hash.ts";
import type { ExtractionManifest, PlanOperation } from "../manifest.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "../path-migrations.ts";
import type { Issues, ValidatePlanOptions } from "./shared.ts";

type MoveOperation = Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>;
type NoopProof = NonNullable<ExtractionManifest["pathMigrationNoops"]>[number];
type RequiredMigration = { readonly path: string; readonly command: string };

/** Every migration the moves trigger must be recorded exactly once, and every no-op proof must replay. */
export function validatePathMigrationCoverage(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  moves: readonly MoveOperation[],
): void {
  const migrationOperations = manifest.operations.filter((operation) => operation.kind === "migrate-path-keys");
  const migrationNoops = manifest.pathMigrationNoops ?? [];
  const requiredMigrations = triggeredPathMigrations(
    options.config,
    moves.map((move) => move.source),
  );
  for (const artifact of requiredMigrations) {
    const operationCount = migrationOperations.filter((operation) => operation.path === artifact.path).length;
    const noopCount = migrationNoops.filter((proof) => proof.path === artifact.path).length;
    if (operationCount + noopCount === 0) {
      issues.add("path-migration-config", `configured path migration is missing from the plan: ${artifact.path}`);
    } else if (operationCount + noopCount > 1) {
      issues.add("path-migration-config", `configured path migration has multiple plan records: ${artifact.path}`);
    }
  }
  validatePathMigrationNoops(manifest, options, issues, moves, requiredMigrations);
}

function validatePathMigrationNoops(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  moves: readonly MoveOperation[],
  required: readonly RequiredMigration[],
): void {
  const proofs = manifest.pathMigrationNoops ?? [];
  const expectedMoves = moves.map(({ source, target }) => ({ source, target })).toSorted(compareMoves);
  const seen = new Set<string>();
  for (const proof of proofs) {
    const at = { path: proof.path };
    if (seen.has(proof.path)) issues.add("path-migration-config", `duplicate no-op path migration proof: ${proof.path}`, at);
    seen.add(proof.path);
    validateNoopConfiguration(proof, required, issues, at);
    if (JSON.stringify(proof.moves) !== JSON.stringify(expectedMoves)) {
      issues.add("path-migration-moves", `no-op path migration does not carry the exact sorted move map: ${proof.path}`, at);
    }
    if (!isSha256(proof.artifactHash)) {
      issues.add("path-migration-hash", `no-op path migration artifact hash must be SHA-256: ${proof.path}`, at);
      continue;
    }
    if (!options.offline) replayNoopProof(proof, options, issues, at);
  }
}

function compareMoves(left: { source: string; target: string }, right: { source: string; target: string }): number {
  if (left.source !== right.source) return left.source < right.source ? -1 : 1;
  if (left.target !== right.target) return left.target < right.target ? -1 : 1;
  return 0;
}

function validateNoopConfiguration(proof: NoopProof, required: readonly RequiredMigration[], issues: Issues, at: { path: string }): void {
  const configured = required.find((artifact) => artifact.path === proof.path);
  if (!configured) issues.add("path-migration-config", `plan declares an unconfigured no-op path migration: ${proof.path}`, at);
  else if (configured.command !== proof.command) issues.add("path-migration-config", `no-op path migration command differs from config for ${proof.path}`, at);
}

function replayNoopProof(proof: NoopProof, options: ValidatePlanOptions, issues: Issues, at: { path: string }): void {
  try {
    const contents = readUtf8Artifact(resolve(options.rootDir, proof.path), proof.path);
    if (hashText(contents) !== proof.artifactHash) {
      issues.add("path-migration-hash", `no-op path migration artifact changed since planning: ${proof.path}`, at);
      return;
    }
    const result = runPathMigrationCommand(options.rootDir, proof, contents, options.config.pathMigrations.timeoutMs);
    if (hashText(result) !== proof.artifactHash) {
      issues.add("path-migration-identity", `no-op path migration now changes the artifact: ${proof.path}`, at);
    }
  } catch (error) {
    issues.add("path-migration-proof", error instanceof Error ? error.message : String(error), at);
  }
}
