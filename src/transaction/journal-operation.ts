/** Effects for individual journal operations. All callers precheck state first. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PackageManagerAdapter } from "../adapters/types.ts";
import { applyEscapeRewrites, rewriteResolvedImportSpecifier } from "../codemod/imports.ts";
import type { MonocarveConfig } from "../config.ts";
import { HashMismatchError } from "../errors.ts";
import { git } from "../util/git.ts";
import { hashText } from "../util/hash.ts";
import { isAnyMove, type PlanOperation } from "../plan/manifest.ts";
import { rewriteStaticFsReference } from "../plan/static-fs-references.ts";
import { JournalError } from "./journal-error.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "./path-migrations.ts";

export function applyOperation(
  config: MonocarveConfig,
  adapter: PackageManagerAdapter,
  operation: PlanOperation,
  root: string,
  useGitMv: boolean,
): void {
  if (isAnyMove(operation)) return applyMove(config, operation, root, useGitMv);
  if (operation.kind === "rewrite-import") return applyImportRewrite(config, operation, root);
  if (operation.kind === "rewrite-fs-reference") return applyFsReferenceRewrite(operation, root);
  if (operation.kind === "lockfile-importer") return applyLockfileImporter(adapter, operation, root);
  if (operation.kind === "migrate-path-keys") return applyPathMigration(config, operation, root);
  return applyWrite(operation, root);
}

function applyMove(config: MonocarveConfig, operation: Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>, root: string, useGitMv: boolean): void {
  const source = resolve(root, operation.source);
  const target = resolve(root, operation.target);
  const rewritten = operation.kind === "move-with-rewrite"
    ? applyEscapeRewrites(readFileSync(source, "utf8"), source, operation.rewrites, root, config.moduleSpecifierCalls, config.assetExtensions, config.cssImportExtensions)
    : undefined;
  mkdirSync(dirname(target), { recursive: true });
  if (useGitMv && operation.kind === "move") git({ cwd: root, quiet: true }, "mv", "--", operation.source, operation.target);
  else renameSync(source, target);
  if (rewritten !== undefined) writeChecked(target, operation.target, rewritten, operation.resultHash);
}

function applyImportRewrite(config: MonocarveConfig, operation: Extract<PlanOperation, { kind: "rewrite-import" }>, root: string): void {
  const file = resolve(root, operation.file);
  const next = operation.rewrites.some((rewrite) => rewrite.donor !== undefined)
    ? rewriteDonorSpecific(config, operation, file, root)
    : rewriteLegacy(config, operation, file, root);
  writeChecked(file, operation.file, next, operation.resultHash);
}

function rewriteDonorSpecific(config: MonocarveConfig, operation: Extract<PlanOperation, { kind: "rewrite-import" }>, file: string, root: string): string {
  if (operation.rewrites.some((rewrite) => rewrite.donor === undefined)) {
    throw new JournalError(`rewrite operation for ${operation.file} mixes donor-specific and legacy rewrites`);
  }
  const declared = new Set(operation.donors);
  const rewrites = operation.rewrites as ReadonlyArray<{ readonly donor: string; readonly to: string }>;
  const received = new Set(rewrites.map((rewrite) => rewrite.donor));
  const undeclared = [...received].filter((donor) => !declared.has(donor));
  if (undeclared.length > 0) throw new JournalError(`rewrite operation for ${operation.file} names undeclared donor(s): ${undeclared.join(", ")}`);
  const missing = operation.donors.filter((donor) => !received.has(donor));
  if (missing.length > 0) throw new JournalError(`rewrite operation for ${operation.file} has no donor-specific rewrite for: ${missing.join(", ")}`);
  return rewrites.reduce(
    (text, rewrite) => rewriteResolvedImportSpecifier(text, file, resolve(root, rewrite.donor), rewrite.to, root, config.moduleSpecifierCalls, config.assetExtensions, config.cssImportExtensions),
    readFileSync(file, "utf8"),
  );
}

function rewriteLegacy(config: MonocarveConfig, operation: Extract<PlanOperation, { kind: "rewrite-import" }>, file: string, root: string): string {
  const target = operation.rewrites[0]?.to;
  if (target === undefined) throw new JournalError(`rewrite operation for ${operation.file} declares no target`);
  return operation.donors.reduce(
    (text, donor) => rewriteResolvedImportSpecifier(text, file, resolve(root, donor), target, root, config.moduleSpecifierCalls, config.assetExtensions, config.cssImportExtensions),
    readFileSync(file, "utf8"),
  );
}

function applyFsReferenceRewrite(operation: Extract<PlanOperation, { kind: "rewrite-fs-reference" }>, root: string): void {
  const file = resolve(root, operation.file);
  const next = operation.rewrites.reduce(
    (text, rewrite) => rewriteStaticFsReference(text, file, resolve(root, rewrite.donor), rewrite.to),
    readFileSync(file, "utf8"),
  );
  writeChecked(file, operation.file, next, operation.resultHash);
}

function applyLockfileImporter(
  adapter: PackageManagerAdapter,
  operation: Extract<PlanOperation, { kind: "lockfile-importer" }>,
  root: string,
): void {
  const lockfile = resolve(root, operation.lockfile);
  const current = readFileSync(lockfile, "utf8");
  const next = adapter.applyImporter(current, operation.packageRoot, operation.block, operation.mode);
  if (adapter.lockfileImporterHash(next, operation.packageRoot) !== hashText(operation.block)) {
    throw new JournalError(`lockfile importer block mismatch: ${operation.packageRoot}`);
  }
  if (hashText(current) === operation.preconditionHash) writeChecked(lockfile, operation.lockfile, next, operation.resultHash);
  else writeFileSync(lockfile, next);
}

function applyPathMigration(
  config: MonocarveConfig,
  operation: Extract<PlanOperation, { kind: "migrate-path-keys" }>,
  root: string,
): void {
  const path = resolve(root, operation.path);
  const next = runPathMigrationCommand(root, operation, readUtf8Artifact(path, operation.path), config.pathMigrations.timeoutMs);
  writeChecked(path, operation.path, next, operation.resultHash);
}

function applyWrite(operation: Extract<PlanOperation, { kind: "write-file" }>, root: string): void {
  const path = resolve(root, operation.path);
  mkdirSync(dirname(path), { recursive: true });
  writeChecked(path, operation.path, operation.contents, operation.resultHash);
}

function writeChecked(absolute: string, displayPath: string, contents: string, expectedHash: string): void {
  const actualHash = hashText(contents);
  if (actualHash !== expectedHash) throw new HashMismatchError(displayPath, expectedHash, actualHash);
  writeFileSync(absolute, contents);
}
