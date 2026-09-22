/** Idempotency and baseline-state checks for journal operations. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { PackageManagerAdapter } from "../adapters/types.ts";
import type { MonocarveConfig } from "../config.ts";
import { isAnyMove, operationPaths, type ExtractionManifest, type PlanOperation } from "../plan/manifest.ts";
import { fileState } from "../util/files.ts";
import { hashText, MISSING, type FileState } from "../util/hash.ts";
import { JournalError } from "./journal-error.ts";

export function stateAt(root: string, path: string): FileState {
  return fileState(resolve(root, path));
}

function textAt(root: string, path: string): string {
  const absolute = resolve(root, path);
  return fileState(absolute) === MISSING ? "" : readFileSync(absolute, "utf8");
}

function blockState(
  adapter: PackageManagerAdapter,
  operation: Extract<PlanOperation, { kind: "lockfile-importer" }>,
  root: string,
): { current: string | undefined; expected: string } {
  const text = textAt(root, operation.lockfile);
  return { current: text === "" ? undefined : adapter.lockfileImporterHash(text, operation.packageRoot), expected: hashText(operation.block) };
}

export function isCompleted(adapter: PackageManagerAdapter, operation: PlanOperation, root: string): boolean {
  if (isAnyMove(operation)) return stateAt(root, operation.source) === MISSING && stateAt(root, operation.target) === operation.resultHash;
  if (operation.kind === "delete-file") return stateAt(root, operation.path) === MISSING;
  if (operation.kind === "lockfile-importer") {
    if (operation.mode === "delete") return blockState(adapter, operation, root).current === undefined;
    const state = blockState(adapter, operation, root);
    return state.current === state.expected;
  }
  return stateAt(root, operation.kind === "write-file" || operation.kind === "migrate-path-keys" ? operation.path : operation.file) === operation.resultHash;
}

export function isAtPrecondition(adapter: PackageManagerAdapter, operation: PlanOperation, root: string): boolean {
  if (isAnyMove(operation)) return stateAt(root, operation.source) === operation.preconditionHash && stateAt(root, operation.target) === MISSING;
  if (operation.kind === "delete-file") return stateAt(root, operation.path) === operation.preconditionHash;
  if (operation.kind === "lockfile-importer") {
    if (operation.mode === "delete") return blockState(adapter, operation, root).current !== undefined;
    const state = blockState(adapter, operation, root);
    return operation.mode === "replace" ? state.current !== undefined && state.current !== state.expected : state.current === undefined;
  }
  return (
    stateAt(root, operation.kind === "write-file" || operation.kind === "migrate-path-keys" ? operation.path : operation.file) === operation.preconditionHash
  );
}

export function preflightJournal(config: MonocarveConfig, manifest: ExtractionManifest, root: string): void {
  const adapter = createPackageManagerAdapter(config);
  for (const operation of manifest.operations) {
    if (
      operation.kind === "write-file" &&
      operation.generator === "module-promotion:compatibility-reexport" &&
      manifest.modulePromotion?.source === operation.path &&
      manifest.operations.some((item) => isAnyMove(item) && item.source === operation.path)
    )
      continue;
    if (isCompleted(adapter, operation, root) || isAtPrecondition(adapter, operation, root)) continue;
    throw new JournalError(`operation precondition failed: ${operation.kind} (${operationPaths(operation).join(" -> ")})`);
  }
}
