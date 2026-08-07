import type { PlanOperation } from "../manifest.ts";
import { triggeredPathMigrations } from "../../config.ts";
import { isFileState, isSha256 } from "../../util/hash.ts";
import { relativeWorkspacePath } from "../../util/paths.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

/** Validate one configured path-key migration and add its path to the mutation ledger. */
export function validatePathMigrationOperation(
  operation: Extract<PlanOperation, { kind: "migrate-path-keys" }>,
  index: number,
  options: ValidatePlanOptions,
  issues: Issues,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  mutated: Set<string>,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.path };
  try {
    relativeWorkspacePath(options.rootDir, operation.path);
  } catch (error) {
    issues.add("path-migration-path", (error as Error).message, at);
  }
  if (mutated.has(operation.path)) issues.add("multiple-mutations", `multiple operations mutate ${operation.path}`, at);
  const configured = triggeredPathMigrations(options.config, moves.map((move) => move.source)).find((artifact) => artifact.path === operation.path);
  if (!configured) {
    issues.add("path-migration-config", `plan declares an unconfigured path migration: ${operation.path}`, at);
  } else if (configured.command !== operation.command) {
    issues.add("path-migration-config", `path migration command differs from config for ${operation.path}`, at);
  }
  const expectedMoves = moves
    .map((move) => ({ source: move.source, target: move.target }))
    .sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
  if (JSON.stringify(operation.moves) !== JSON.stringify(expectedMoves)) {
    issues.add("path-migration-moves", `path migration does not carry the exact sorted move map: ${operation.path}`, at);
  }
  if (!isFileState(operation.preconditionHash) || operation.preconditionHash === "missing" || !isSha256(operation.resultHash)) {
    issues.add("path-migration-hash", `path migration hashes must describe an existing artifact: ${operation.path}`, at);
  }
  if (operation.preconditionHash === operation.resultHash) issues.add("path-migration-identity", `path migration must change the artifact: ${operation.path}`, at);
  mutated.add(operation.path);
}
