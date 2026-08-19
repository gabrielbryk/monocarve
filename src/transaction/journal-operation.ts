/** Effects for individual journal operations. All callers precheck state first. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { PackageManagerAdapter } from "../adapters/types.ts";
import { applyEscapeRewrites, rewriteResolvedImportSpecifier } from "../codemod/imports.ts";
import type { MonocarveConfig } from "../config.ts";
import { HashMismatchError } from "../errors.ts";
import { git } from "../util/git.ts";
import { hashText } from "../util/hash.ts";
import { isAnyMove, type PathMove, type PlanOperation } from "../plan/manifest.ts";
import {
  rewritePathReferenceText,
  scanPathReferenceRewrites,
  type PathReferenceRewriteMatch,
} from "../plan/path-reference-rewrites.ts";
import { scanEmittedModuleSpecifiers } from "../plan/emitted-module-specifiers.ts";
import { normalizeToken } from "../plan/path-tokens.ts";
import { scanRuntimeModuleRegistry } from "../plan/runtime-module-registries.ts";
import { rewriteStaticFsReference } from "../plan/static-fs-references.ts";
import { JournalError } from "./journal-error.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "./path-migrations.ts";

export function applyOperation(
  config: MonocarveConfig,
  adapter: PackageManagerAdapter,
  operation: PlanOperation,
  root: string,
  useGitMv: boolean,
  moves: readonly PathMove[],
): void {
  if (isAnyMove(operation)) return applyMove(config, operation, root, useGitMv);
  if (operation.kind === "rewrite-import") return applyImportRewrite(config, operation, root);
  if (operation.kind === "rewrite-fs-reference") return applyFsReferenceRewrite(operation, root);
  if (operation.kind === "rewrite-path-reference") return applyPathReferenceRewrite(operation, root, moves);
  if (operation.kind === "lockfile-importer") return applyLockfileImporter(adapter, operation, root);
  if (operation.kind === "migrate-path-keys") return applyPathMigration(config, operation, root);
  if (operation.kind === "delete-file") return applyDelete(operation, root);
  return applyWrite(operation, root);
}

function applyDelete(operation: Extract<PlanOperation, { kind: "delete-file" }>, root: string): void {
  const path = resolve(root, operation.path);
  unlinkSync(path);
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

/**
 * Apply a `rewrite-path-reference` operation by re-running the planner's own
 * scan against the manifest's real move operations, not by trusting the
 * bytes — or even the `to` — the plan recorded. The operation stores
 * `from`/`to`/`donor`/position per rewrite but not the final text: writing
 * stored contents would let a corrupted or hand-edited plan slip a byte
 * change past `preconditionHash` (which only proves the *input* text hasn't
 * moved) straight into the working tree. Re-deriving the edit from
 * `scanPathReferenceRewrites` — the exact function `pathReferenceRewriteOperations`
 * called to produce this operation — fed with `moves`, the manifest's own
 * `move`/`move-with-rewrite` operations (ground truth for where every donor
 * actually lands, independent of anything this operation claims), means
 * apply can only write what a fresh scan of the live, precondition-checked
 * text independently agrees the plan claimed. Every recorded rewrite must
 * reproduce byte-for-byte at its recorded position against that independent
 * move list; anything else fails closed rather than guessing. A `to` forged
 * to point anywhere the real move does not land cannot reproduce here, so
 * this — unlike deriving the move from the recorded `to`, which validated
 * only that the operation agreed with itself — is actually load-bearing.
 */
function applyPathReferenceRewrite(
  operation: Extract<PlanOperation, { kind: "rewrite-path-reference" }>,
  root: string,
  moves: readonly PathMove[],
): void {
  const file = resolve(root, operation.file);
  const text = readFileSync(file, "utf8");
  const liveHash = hashText(text);
  if (liveHash !== operation.preconditionHash) throw new HashMismatchError(operation.file, operation.preconditionHash, liveHash);
  const matches = rederivePathReferenceMatches(operation, text, moves, root);
  const next = rewritePathReferenceText(text, matches);
  writeChecked(file, operation.file, next, operation.resultHash);
}

/**
 * Rescan the live text against `moves` — the manifest's complete, independent
 * move list, not anything reconstructed from this operation's own records —
 * then intersect the result with the recorded rewrites. Using the full move
 * list (not just the donors this operation happened to produce rewrites for)
 * matters both for security and correctness: a forged `to` cannot be
 * replayed because the rescan computes `to` itself from the real move
 * target, and a plan-time-ambiguous position that only resolves uniquely
 * once every move is present will not spuriously fail to replay just because
 * some sibling donor's rewrite landed in a different operation. A recorded
 * rewrite that the live rescan cannot reproduce at the same line/column with
 * the same `from`/`to`/`donor` is refused rather than replayed from memory.
 */
function rederivePathReferenceMatches(
  operation: Extract<PlanOperation, { kind: "rewrite-path-reference" }>,
  text: string,
  moves: readonly PathMove[],
  root: string,
): PathReferenceRewriteMatch[] {
  const registries = operation.rewrites.filter((rewrite) => rewrite.jsonPointer !== undefined && rewrite.resolutionBase !== undefined);
  const emitted = operation.rewrites.filter((rewrite) => rewrite.emittedModuleSpecifier && rewrite.resolutionBase !== undefined);
  const ordinary = operation.rewrites.filter((rewrite) => rewrite.jsonPointer === undefined && !rewrite.emittedModuleSpecifier && rewrite.resolutionBase === undefined && rewrite.referenceBase === undefined);
  const based = operation.rewrites.filter((rewrite) => rewrite.jsonPointer === undefined && !rewrite.emittedModuleSpecifier && rewrite.resolutionBase === undefined && rewrite.referenceBase !== undefined);
  const matchExtensionless = ordinary.length > 0 && ordinary.some((rewrite) => !lastSegmentHasExtension(rewrite.from));
  // minSegments: 2 (the schema's own floor) rather than the configured value —
  // this rederive only needs to reproduce a rewrite the plan already recorded,
  // and that rewrite's donor necessarily cleared whatever floor was configured
  // at plan time. Using the loosest possible floor here means replay can never
  // spuriously reject a legitimately recorded rewrite just because apply time
  // has no access to the planning-time config.
  const scan = scanPathReferenceRewrites(text, operation.file, moves, { onAmbiguousMatch: "skip", matchExtensionless, minSegments: 2 });
  const basedMatches = [...new Set(based.map((rewrite) => rewrite.referenceBase!))].flatMap((referenceBase) =>
    scanPathReferenceRewrites(text, operation.file, moves, { onAmbiguousMatch: "skip", matchExtensionless: based.some((rewrite) => rewrite.referenceBase === referenceBase && !lastSegmentHasExtension(rewrite.from)), minSegments: 2, referenceBase, workspaceRoot: root }).rewrites
  );
  const registryMatches = registries.flatMap((rewrite) => scanRuntimeModuleRegistry(text, {
    file: operation.file,
    pointer: rewrite.jsonPointer!,
    resolveFrom: rewrite.resolutionBase!,
    ...(rewrite.strippedPrefix === undefined ? {} : { stripPrefix: rewrite.strippedPrefix }),
  }, moves));
  const emittedMatches = emitted.flatMap((rewrite) => scanEmittedModuleSpecifiers(text, {
    source: operation.file,
    resolutionBase: rewrite.resolutionBase!,
  }, moves));
  const live = new Map([...scan.rewrites, ...basedMatches, ...registryMatches, ...emittedMatches].map((match) => [`${match.line}:${match.column}`, match] as const));
  if (ordinary.length + based.length + registries.length + emitted.length !== operation.rewrites.length) throw new JournalError(`rewrite-path-reference structured identity is incomplete in ${operation.file}`);
  return operation.rewrites.map((recorded) => {
    const found = live.get(`${recorded.line}:${recorded.column}`);
    if (!found || found.from !== recorded.from || found.to !== recorded.to || found.donor !== recorded.donor || found.jsonPointer !== recorded.jsonPointer || found.resolutionBase !== recorded.resolutionBase || found.strippedPrefix !== recorded.strippedPrefix || found.emittedModuleSpecifier !== recorded.emittedModuleSpecifier || found.referenceBase !== recorded.referenceBase) {
      throw new JournalError(
        `rewrite-path-reference replay mismatch in ${operation.file} at ${recorded.line}:${recorded.column}: live rescan does not reproduce the recorded rewrite`,
      );
    }
    return found;
  });
}

function lastSegmentHasExtension(rawToken: string): boolean {
  const normalized = normalizeToken(rawToken);
  return normalized === null ? false : (normalized.path.split("/").at(-1) ?? "").includes(".");
}

function applyLockfileImporter(
  adapter: PackageManagerAdapter,
  operation: Extract<PlanOperation, { kind: "lockfile-importer" }>,
  root: string,
): void {
  const lockfile = resolve(root, operation.lockfile);
  const current = readFileSync(lockfile, "utf8");
  const next = adapter.applyImporter(current, operation.packageRoot, operation.block, operation.mode);
  if (operation.mode === "delete") {
    if (adapter.lockfileImporterHash(next, operation.packageRoot) !== undefined) throw new JournalError(`lockfile importer deletion did not remove ${operation.packageRoot}`);
    writeFileSync(resolve(root, operation.lockfile), next);
    return;
  }
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
