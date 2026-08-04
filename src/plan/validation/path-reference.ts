/** Validation for the `rewrite-path-reference` operation. Split out of operations.ts to keep that file under its line budget. */
import { byCodeUnit, isFileState, isSha256 } from "../../util/hash.ts";
import type { PlanOperation } from "../manifest.ts";
import { documentKindFor, expectedPathReferenceTarget } from "../path-reference-rewrites.ts";
import { Issues } from "./shared.ts";

export function validatePathReferenceRewrite(
  operation: Extract<PlanOperation, { kind: "rewrite-path-reference" }>,
  index: number,
  issues: Issues,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  mutated: Set<string>,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.file };
  if (mutated.has(operation.file)) issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, at);
  if (operation.rewrites.length === 0) {
    issues.add("path-reference-empty", `rewrite-path-reference must declare at least one rewrite: ${operation.file}`, at);
  }
  const expectedKind = documentKindFor(operation.file);
  if (operation.documentKind !== expectedKind) {
    issues.add("path-reference-kind", `rewrite-path-reference documentKind for ${operation.file} must be ${expectedKind}, got ${operation.documentKind}`, at);
  }
  const sorted = [...operation.rewrites].sort((left, right) => left.line - right.line || left.column - right.column || byCodeUnit(left.donor, right.donor));
  if (JSON.stringify(operation.rewrites) !== JSON.stringify(sorted)) {
    issues.add("path-reference-sort", `rewrite-path-reference rewrites must be sorted by (line, column, donor): ${operation.file}`, at);
  }
  validateRewrites(operation, at, issues, moves);
  if (!isFileState(operation.preconditionHash) || !isSha256(operation.resultHash)) {
    issues.add("path-reference-hash", `rewrite-path-reference hashes for ${operation.file} must be SHA-256`, at);
  }
  if (operation.preconditionHash === operation.resultHash) {
    issues.add("path-reference-identity", `rewrite-path-reference result must differ from precondition ${operation.file}`, at);
  }
  mutated.add(operation.file);
}

function validateRewrites(
  operation: Extract<PlanOperation, { kind: "rewrite-path-reference" }>,
  at: { operationIndex: number; operationKind: PlanOperation["kind"]; path: string },
  issues: Issues,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
): void {
  const seen = new Set<string>();
  for (const rewrite of operation.rewrites) {
    const key = `${rewrite.from}:${rewrite.line}:${rewrite.column}`;
    if (seen.has(key)) {
      issues.add("path-reference-unique", `rewrite-path-reference has duplicate (from, line, column): ${operation.file}`, at);
      break;
    }
    seen.add(key);
    if (rewrite.donor.startsWith("/") || rewrite.donor.includes("..")) {
      issues.add("path-reference-donor", `rewrite-path-reference donor must be a workspace-relative path: ${rewrite.donor}`, at);
    }
    const move = moves.find((candidate) => candidate.source === rewrite.donor);
    if (!move) {
      issues.add("path-reference-donor", `rewrite-path-reference donor is not a moved source: ${rewrite.donor}`, at);
    } else {
      // Cross-check `to` against the manifest's own move for this donor — not
      // against anything reconstructed from `to` itself — so a forged target
      // that would otherwise validate against its own say-so is rejected
      // here, before it ever reaches apply.
      const expected = expectedPathReferenceTarget(rewrite.from, move.source, move.target);
      if (expected === null || expected !== rewrite.to) {
        issues.add(
          "path-reference-target",
          `rewrite-path-reference for ${operation.file} at ${rewrite.line}:${rewrite.column} targets ${JSON.stringify(rewrite.to)}, but donor ${move.source} moves to ${move.target} implying ${JSON.stringify(expected)}`,
          at,
        );
      }
    }
    if (rewrite.from === rewrite.to) issues.add("path-reference-noop", `rewrite-path-reference for ${operation.file} is a no-op`, at);
  }
}
