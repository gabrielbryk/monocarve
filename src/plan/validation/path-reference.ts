/** Validation for the `rewrite-path-reference` operation. Split out of operations.ts to keep that file under its line budget. */
import { byCodeUnit, isFileState, isSha256 } from "../../util/hash.ts";
import { expectedEmittedModuleSpecifierTarget } from "../emitted-module-specifiers.ts";
import type { PlanOperation } from "../manifest.ts";
import { documentKindFor, expectedPathReferenceTarget } from "../path-reference-rewrites.ts";
import { expectedRuntimeModuleRegistryTarget } from "../runtime-module-registries.ts";
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
  const sorted = [...operation.rewrites].toSorted((left, right) => left.line - right.line || left.column - right.column || byCodeUnit(left.donor, right.donor));
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

type RewritePathReference = Extract<PlanOperation, { kind: "rewrite-path-reference" }>;
type PathReferenceRewrite = RewritePathReference["rewrites"][number];
type MoveOperation = Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>;
type IssueAt = { operationIndex: number; operationKind: PlanOperation["kind"]; path: string };

function validateRewrites(operation: RewritePathReference, at: IssueAt, issues: Issues, moves: readonly MoveOperation[]): void {
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
      validateRewriteAgainstMove(operation.file, rewrite, move, at, issues);
    }
    if (rewrite.from === rewrite.to) issues.add("path-reference-noop", `rewrite-path-reference for ${operation.file} is a no-op`, at);
  }
}

function validateRewriteAgainstMove(file: string, rewrite: PathReferenceRewrite, move: MoveOperation, at: IssueAt, issues: Issues): void {
  // Cross-check `to` against the manifest's own move for this donor — not
  // against anything reconstructed from `to` itself — so a forged target
  // that would otherwise validate against its own say-so is rejected
  // here, before it ever reaches apply.
  const expected = expectedRewriteTarget(rewrite, move);
  validateRewriteIdentity(file, rewrite, at, issues);
  if (expected === null || expected !== rewrite.to) {
    issues.add(
      "path-reference-target",
      `rewrite-path-reference for ${file} at ${rewrite.line}:${rewrite.column} targets ${JSON.stringify(rewrite.to)}, but donor ${move.source} moves to ${move.target} implying ${JSON.stringify(expected)}`,
      at,
    );
  }
}

function expectedRewriteTarget(rewrite: PathReferenceRewrite, move: MoveOperation): string | null {
  if (rewrite.resolutionBase === undefined) return expectedPathReferenceTarget(rewrite.from, move.source, move.target, rewrite.referenceBase);
  return rewrite.emittedModuleSpecifier
    ? expectedEmittedModuleSpecifierTarget(rewrite.resolutionBase, move.target)
    : expectedRuntimeModuleRegistryTarget(rewrite.resolutionBase, move.target, rewrite.strippedPrefix);
}

function validateRewriteIdentity(file: string, rewrite: PathReferenceRewrite, at: IssueAt, issues: Issues): void {
  const structured = rewrite.resolutionBase !== undefined;
  const identities = Number(rewrite.jsonPointer !== undefined) + Number(rewrite.emittedModuleSpecifier === true);
  if (identities !== (structured ? 1 : 0)) {
    issues.add("path-reference-structured-identity", `structured rewrite must record resolutionBase and exactly one identity: ${file}`, at);
  }
  if (rewrite.strippedPrefix !== undefined && !structured) {
    issues.add("path-reference-registry-identity", `strippedPrefix requires structured registry identity: ${file}`, at);
  }
  if (rewrite.referenceBase !== undefined && structured) {
    issues.add("path-reference-base-identity", `ordinary referenceBase cannot be combined with structured resolutionBase: ${file}`, at);
  }
  if (rewrite.strippedPrefix !== undefined && rewrite.emittedModuleSpecifier)
    issues.add("path-reference-registry-identity", `emitted module specifier cannot carry strippedPrefix: ${file}`, at);
  if (rewrite.strippedPrefix !== undefined && !rewrite.from.startsWith(rewrite.strippedPrefix)) {
    issues.add("path-reference-registry-prefix", `structured registry value does not carry its declared strippedPrefix: ${file}`, at);
  }
}
