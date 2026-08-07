import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getApplication, isPackageOwner, packageNameOf, triggeredPathMigrations } from "../../config.ts";
import { applicationOwner } from "../../config/helpers.ts";
import { createPackageManagerAdapter } from "../../adapters/registry.ts";
import { fileState } from "../../util/files.ts";
import { hashText, isFileState, isSha256 } from "../../util/hash.ts";
import { relativeWorkspacePath } from "../../util/paths.ts";
import { readManifest } from "../../graph/workspace.ts";
import { isAnyMove, regeneratedArtifactPaths, type ExtractionManifest, type ImportRewrite, type PlanOperation } from "../manifest.ts";
import { relativeFsLiteral } from "../static-fs-references.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "../../transaction/path-migrations.ts";
import { validatePathReferenceRewrite } from "./path-reference.ts";
import type { ValidatePlanOptions, ValidationIssue } from "./shared.ts";
import { Issues } from "./shared.ts";

export interface OperationContext {
  readonly files: readonly string[];
  readonly tests: readonly string[];
  readonly assets: readonly string[];
  readonly blobs: Readonly<Record<string, string>>;
  readonly consumers: ReadonlySet<string>;
  readonly packageName: string;
  readonly rewriteTargets: ReadonlySet<string>;
  readonly publicSpecifierByDonor: ReadonlyMap<string, string>;
  readonly packageRoot: string;
  readonly entrypoint: string;
}

/** Validate ordered journal operations and their declared transaction footprint. */
export function validateOperations(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: OperationContext,
): void {
  const operations = manifest.operations ?? [];
  if (operations.length === 0) {
    issues.add("operations", "operations must not be empty");
    return;
  }

  const workspacePackages = workspacePackageNames(manifest, options);
  const moved = new Set<string>();
  const mutated = new Set<string>();
  const seen = new Set<string>();
  const moves = operations.filter(isAnyMove);
  const movePaths = new Set(moves.flatMap((operation) => [operation.source, operation.target]));

  if (movePaths.has(context.entrypoint) && operations.some((operation) => operation.kind === "write-file" && operation.path === context.entrypoint)) {
    issues.add("barrel-self-import", `barrel self-import: a moved file lands on the generated entrypoint ${context.entrypoint}`);
  }

  operations.forEach((operation, index) => {
    const key = operationKey(operation);
    if (seen.has(key)) issues.add("duplicate-operation", `duplicate operation ${key}`, { operationIndex: index });
    seen.add(key);
    validateOperation(operation, index, manifest, options, issues, context, moves, movePaths, moved, mutated, workspacePackages);
  });

  validateMoveCoverage(manifest, options, issues, context, moves, moved);
  validateChangedFiles(manifest, issues, mutated);
}

function workspacePackageNames(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
): Set<string> | undefined {
  const packages = options.offline
    ? undefined
    : new Set(
        options.config.packageRoots.flatMap((root) => {
          const absolute = resolve(options.rootDir, root);
          if (!existsSync(absolute)) return [];
          return readdirNames(absolute)
            .map((name) => readManifest(resolve(absolute, name, "package.json"))?.name)
            .filter((name): name is string => name !== undefined);
        }),
      );
  if (packages && manifest.integrationTestSuite) {
    const donor = getApplication(options.config, manifest.integrationTestSuite.donorApplication);
    if (donor.packageName) packages.add(donor.packageName);
  }
  return packages;
}

function validateOperation(
  operation: PlanOperation,
  index: number,
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: OperationContext,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  movePaths: ReadonlySet<string>,
  moved: Set<string>,
  mutated: Set<string>,
  workspacePackages: ReadonlySet<string> | undefined,
): void {
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      validateMove(operation, index, options, issues, context, moved, mutated, workspacePackages);
      return;
    case "rewrite-import":
      if (movePaths.has(operation.file)) {
        issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, { operationIndex: index });
      }
      validateRewrite(operation, index, issues, context, mutated);
      return;
    case "rewrite-fs-reference":
      if (movePaths.has(operation.file)) {
        issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, { operationIndex: index });
      }
      validateFsReferenceRewrite(operation, index, issues, moves, mutated);
      return;
    case "write-file":
      if (movePaths.has(operation.path) && !isPromotionCompatibilityWrite(manifest, operation)) {
        issues.add("multiple-mutations", `multiple operations mutate ${operation.path}`, { operationIndex: index });
      }
      validateWrite(operation, index, options, issues, mutated, isPromotionCompatibilityWrite(manifest, operation));
      return;
    case "lockfile-importer":
      validateLockfileImporter(operation, index, options, issues, manifest, mutated);
      return;
    case "migrate-path-keys":
      validatePathMigration(operation, index, options, issues, moves, mutated);
      return;
    case "rewrite-path-reference":
      if (movePaths.has(operation.file)) {
        issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, { operationIndex: index });
      }
      validatePathReferenceRewrite(operation, index, issues, moves, mutated);
      return;
    default:
      issues.add("unknown-operation", `unsupported operation kind ${(operation as { kind: string }).kind}`, {
        operationIndex: index,
      });
  }
}

function validateMoveCoverage(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: OperationContext,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  moved: ReadonlySet<string>,
): void {
  const targets = moves.map((operation) => operation.target);
  if (new Set(targets).size !== targets.length) issues.add("move-targets", "move targets must be unique");

  const migrationOperations = manifest.operations.filter((operation) => operation.kind === "migrate-path-keys");
  const migrationNoops = manifest.pathMigrationNoops ?? [];
  const requiredMigrations = triggeredPathMigrations(options.config, moves.map((move) => move.source));
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

  const sources = [...context.files, ...context.tests, ...context.assets];
  if (moved.size !== sources.length || sources.some((path) => !moved.has(path))) {
    issues.add("move-coverage", "operations must move every source, test, and asset exactly once");
  }
  for (const operation of moves) {
    if (context.assets.includes(operation.source) && operation.kind !== "move") {
      issues.add("asset-move", `asset moves must be byte-identical: ${operation.source}`);
    }
    if (!operation.target.startsWith(`${context.packageRoot}/`)) {
      issues.add("target-containment", `move target escapes the package root: ${operation.target}`);
    }
  }
  for (const file of context.consumers) {
    if (!manifest.operations.some((operation) => operation.kind === "rewrite-import" && operation.file === file)) {
      issues.add("consumer-coverage", `missing rewrite operation for ${file}`);
    }
  }
}

function validatePathMigrationNoops(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  required: readonly { readonly path: string; readonly command: string }[],
): void {
  const proofs = manifest.pathMigrationNoops ?? [];
  const expectedMoves = moves
    .map(({ source, target }) => ({ source, target }))
    .sort((left, right) => left.source < right.source ? -1 : left.source > right.source ? 1 : left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
  const seen = new Set<string>();
  for (const proof of proofs) {
    const at = { path: proof.path };
    if (seen.has(proof.path)) issues.add("path-migration-config", `duplicate no-op path migration proof: ${proof.path}`, at);
    seen.add(proof.path);
    const configured = required.find((artifact) => artifact.path === proof.path);
    if (!configured) issues.add("path-migration-config", `plan declares an unconfigured no-op path migration: ${proof.path}`, at);
    else if (configured.command !== proof.command) issues.add("path-migration-config", `no-op path migration command differs from config for ${proof.path}`, at);
    if (JSON.stringify(proof.moves) !== JSON.stringify(expectedMoves)) {
      issues.add("path-migration-moves", `no-op path migration does not carry the exact sorted move map: ${proof.path}`, at);
    }
    if (!isSha256(proof.artifactHash)) {
      issues.add("path-migration-hash", `no-op path migration artifact hash must be SHA-256: ${proof.path}`, at);
      continue;
    }
    if (options.offline) continue;
    try {
      const contents = readUtf8Artifact(resolve(options.rootDir, proof.path), proof.path);
      if (hashText(contents) !== proof.artifactHash) {
        issues.add("path-migration-hash", `no-op path migration artifact changed since planning: ${proof.path}`, at);
        continue;
      }
      const result = runPathMigrationCommand(options.rootDir, proof, contents, options.config.pathMigrations.timeoutMs);
      if (hashText(result) !== proof.artifactHash) {
        issues.add("path-migration-identity", `no-op path migration now changes the artifact: ${proof.path}`, at);
      }
    } catch (error) {
      issues.add("path-migration-proof", (error as Error).message, at);
    }
  }
}

function validateChangedFiles(manifest: ExtractionManifest, issues: Issues, mutated: ReadonlySet<string>): void {
  const changed = new Set(manifest.changedFiles ?? []);
  for (const path of regeneratedArtifactPaths(manifest)) {
    if (mutated.has(path)) {
      issues.add("generated-file", `${path} is both written by the journal and regenerated`, { path });
    }
  }
  const declarable = new Set([...mutated, ...regeneratedArtifactPaths(manifest)]);
  if (changed.size !== declarable.size || [...declarable].some((path) => !changed.has(path))) {
    issues.add("changed-files", "changedFiles must exactly match operation paths and regenerated artifacts");
  }
}

function readdirNames(absolute: string): string[] {
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function operationKey(operation: PlanOperation): string {
  if (isAnyMove(operation)) return `${operation.kind}:${operation.source}:${operation.target}`;
  if (operation.kind === "lockfile-importer") return `${operation.kind}:${operation.packageRoot}`;
  if (operation.kind === "write-file" || operation.kind === "migrate-path-keys") return `${operation.kind}:${operation.path}`;
  if (operation.kind === "rewrite-path-reference") return `rewrite-path-reference:${operation.file}`;
  return `${operation.kind}:${operation.file}`;
}

function validateMove(
  operation: Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>,
  index: number,
  options: ValidatePlanOptions,
  issues: Issues,
  context: OperationContext,
  moved: Set<string>,
  mutated: Set<string>,
  workspacePackages: ReadonlySet<string> | undefined,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.source };
  if (operation.source === operation.target || moved.has(operation.source)) {
    issues.add("duplicate-move", `invalid duplicate move ${operation.source}`, at);
  }
  moved.add(operation.source);
  mutated.add(operation.source);
  mutated.add(operation.target);
  if (!isFileState(operation.preconditionHash)) issues.add("move-hash", "move precondition must be a SHA-256 hash", at);
  if (!isSha256(operation.resultHash)) issues.add("move-hash", "move result must be a SHA-256 hash", at);
  if (operation.preconditionHash !== context.blobs[operation.source]) {
    issues.add("move-precondition", `move precondition does not match the baseline blob ${operation.source}`, at);
  }
  if (operation.kind === "move-with-rewrite") {
      validateMoveWithRewrite(operation, issues, context, workspacePackages, at);
    return;
  }
  if (operation.resultHash !== context.blobs[operation.source]) {
    issues.add("move-not-byte-identical", `move hash does not preserve source bytes ${operation.source}`, at);
  }
  if (!options.offline) {
    const existing = fileState(resolve(options.rootDir, operation.target));
    if (existing !== "missing" && existing !== operation.resultHash) {
      issues.add("target-collision", `target collision: ${operation.target}`, at);
    }
  }
}

function validateMoveWithRewrite(
  operation: Extract<PlanOperation, { kind: "move-with-rewrite" }>,
  issues: Issues,
  context: OperationContext,
  workspacePackages: ReadonlySet<string> | undefined,
  at: Partial<ValidationIssue>,
): void {
  if (!context.files.includes(operation.source) && !context.tests.includes(operation.source)) {
    issues.add("rewrite-source", `move-with-rewrite source must be a declared source or test: ${operation.source}`, at);
  }
  if (operation.rewrites.length === 0) {
    issues.add("rewrite-empty", `move-with-rewrite must declare at least one rewrite: ${operation.source}`, at);
  }
  for (const rewrite of operation.rewrites) {
    if (!rewrite.donorlessSpecifier.startsWith(".")) {
      issues.add("rewrite-specifier", `rewrite donorlessSpecifier must be relative: ${rewrite.donorlessSpecifier}`, at);
    }
    if (workspacePackages && !workspacePackages.has(packageNameOf(rewrite.packageSpecifier))) {
      issues.add("rewrite-target", `rewrite packageSpecifier is not an existing workspace package: ${rewrite.packageSpecifier}`, at);
    }
  }
  if (operation.resultHash === operation.preconditionHash) {
    issues.add("rewrite-identity", `move-with-rewrite result must differ from the moved bytes ${operation.source}`, at);
  }
}

function validateRewrite(
  operation: Extract<PlanOperation, { kind: "rewrite-import" }>,
  index: number,
  issues: Issues,
  context: OperationContext,
  mutated: Set<string>,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.file };
  if (!context.consumers.has(operation.file)) issues.add("rewrite-consumer", `rewrite has no declared consumer ${operation.file}`, at);
  if (mutated.has(operation.file)) issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, at);
  if (operation.donors.length === 0) issues.add("rewrite-donor", "rewrite must declare at least one donor", at);
  for (const rewrite of operation.rewrites) {
    if (!context.rewriteTargets.has(rewrite.to)) {
      issues.add("rewrite-target", `rewrite target must be a declared ${context.packageName} surface`, at);
    }
    if (rewrite.from === rewrite.to) issues.add("rewrite-noop", `rewrite for ${operation.file} is a no-op`, at);
    if (rewrite.donor !== undefined && !operation.donors.includes(rewrite.donor)) {
      issues.add("rewrite-donor", `rewrite names undeclared donor ${rewrite.donor}`, at);
    }
    validateDonorSurface(rewrite, context.packageName, context.publicSpecifierByDonor, issues, "rewrite-donor", at);
  }
  if (!isFileState(operation.preconditionHash) || !isSha256(operation.resultHash)) {
    issues.add("rewrite-hash", `rewrite hashes for ${operation.file} must be SHA-256`, at);
  }
  if (operation.preconditionHash === operation.resultHash) {
    issues.add("rewrite-identity", `rewrite result must differ from precondition ${operation.file}`, at);
  }
  mutated.add(operation.file);
}

function validateFsReferenceRewrite(
  operation: Extract<PlanOperation, { kind: "rewrite-fs-reference" }>,
  index: number,
  issues: Issues,
  moves: readonly Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>[],
  mutated: Set<string>,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.file };
  if (mutated.has(operation.file)) issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, at);
  if (operation.rewrites.length === 0) {
    issues.add("fs-reference-empty", `rewrite-fs-reference must declare at least one rewrite: ${operation.file}`, at);
  }
  for (const rewrite of operation.rewrites) {
    const move = moves.find((candidate) => candidate.source === rewrite.donor);
    if (!move) {
      issues.add("fs-reference-donor", `rewrite-fs-reference donor is not a moved source: ${rewrite.donor}`, at);
      continue;
    }
    const expected = relativeFsLiteral(operation.file, move.target);
    if (rewrite.to !== expected) {
      issues.add(
        "fs-reference-target",
        `rewrite-fs-reference target for ${operation.file} must be the relative path to the moved file: expected ${expected}, got ${rewrite.to}`,
        at,
      );
    }
    if (rewrite.from === rewrite.to) issues.add("fs-reference-noop", `rewrite-fs-reference for ${operation.file} is a no-op`, at);
  }
  if (!isFileState(operation.preconditionHash) || !isSha256(operation.resultHash)) {
    issues.add("fs-reference-hash", `rewrite-fs-reference hashes for ${operation.file} must be SHA-256`, at);
  }
  if (operation.preconditionHash === operation.resultHash) {
    issues.add("fs-reference-identity", `rewrite-fs-reference result must differ from precondition ${operation.file}`, at);
  }
  mutated.add(operation.file);
}

export function validateDonorSurface(
  rewrite: ImportRewrite,
  packageName: string,
  publicSpecifierByDonor: ReadonlyMap<string, string>,
  issues: Issues,
  rule: string,
  at: Partial<ValidationIssue>,
): void {
  if (rewrite.donor === undefined) {
    if (rewrite.to !== packageName) issues.add(rule, `rewrite targeting public subpath ${rewrite.to} must name its donor`, at);
    return;
  }
  const expected = publicSpecifierByDonor.get(rewrite.donor);
  if (expected === undefined) {
    issues.add(rule, `rewrite donor ${rewrite.donor} has no declared public module`, at);
  } else if (rewrite.to !== expected) {
    issues.add(rule, `rewrite donor ${rewrite.donor} must target its declared public surface ${expected}`, at);
  }
}

function validateWrite(
  operation: Extract<PlanOperation, { kind: "write-file" }>,
  index: number,
  options: ValidatePlanOptions,
  issues: Issues,
  mutated: Set<string>,
  allowAfterMove = false,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.path };
  try {
    relativeWorkspacePath(options.rootDir, operation.path);
  } catch (error) {
    issues.add("write-path", (error as Error).message, at);
  }
  if (mutated.has(operation.path) && !allowAfterMove) issues.add("multiple-mutations", `multiple operations mutate ${operation.path}`, at);
  if (typeof operation.contents !== "string") issues.add("write-contents", "write contents must be a string", at);
  else if (operation.resultHash !== hashText(operation.contents)) issues.add("write-hash", `write hash mismatch ${operation.path}`, at);
  if (!isFileState(operation.preconditionHash)) {
    issues.add("write-hash", `write precondition for ${operation.path} must be a SHA-256 hash or "missing"`, at);
  }
  mutated.add(operation.path);
}

function isPromotionCompatibilityWrite(manifest: ExtractionManifest, operation: Extract<PlanOperation, { kind: "write-file" }>): boolean {
  return manifest.modulePromotion?.retireSource === false
    && operation.path === manifest.modulePromotion.source
    && operation.generator === "module-promotion:compatibility-reexport"
    && operation.preconditionHash === "missing";
}

function validateLockfileImporter(
  operation: Extract<PlanOperation, { kind: "lockfile-importer" }>,
  index: number,
  options: ValidatePlanOptions,
  issues: Issues,
  manifest: ExtractionManifest,
  mutated: Set<string>,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.packageRoot };
  const adapter = createPackageManagerAdapter(options.config);
  const mode = operation.mode ?? "insert";
  if (operation.lockfile !== adapter.lockfileName) issues.add("lockfile-name", `lockfile importer must target ${adapter.lockfileName}`, at);
  const isPackage = isPackageOwner(options.config, operation.packageRoot);
  const isApplicationOwner = options.config.applications.some((app) => applicationOwner(app) === operation.packageRoot);
  if (!(isPackage || (mode === "replace" && isApplicationOwner)) || operation.packageRoot.includes("..")) {
    issues.add("lockfile-target", "lockfile importer must target a workspace package", at);
  }
  if (!operation.block || !operation.block.includes(`  ${operation.packageRoot}:`)) {
    issues.add("lockfile-block", `lockfile importer block must declare ${operation.packageRoot}`, at);
  }
  if (!isFileState(operation.preconditionHash) || !isSha256(operation.resultHash)) issues.add("lockfile-hash", "lockfile importer hashes must be SHA-256", at);
  if (operation.preconditionHash === operation.resultHash) issues.add("lockfile-identity", "lockfile importer result must differ from precondition", at);
  if (mode === "replace" && !options.offline) {
    const lockfile = resolve(options.rootDir, operation.lockfile);
    const text = existsSync(lockfile) ? readFileSyncSafe(lockfile) : undefined;
    if (text !== undefined && adapter.importerBlock(text, operation.packageRoot) === undefined) {
      issues.add("lockfile-replace", `lockfile importer replace has no existing block for ${operation.packageRoot}`, at);
    }
  }
  const echo = manifest.lockfileImporter;
  if (echo && echo.packageRoot === operation.packageRoot && echo.hash !== hashText(operation.block)) {
    issues.add("lockfile-echo", "lockfileImporter.hash must be the SHA-256 of the declared importer block", at);
  }
  mutated.add(operation.lockfile);
}

function validatePathMigration(
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

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
