import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { getApplication, packageNameOf } from "../../config.ts";
import { readManifest } from "../../graph/workspace.ts";
import { fileState } from "../../util/files.ts";
import { hashText, isFileState, isSha256 } from "../../util/hash.ts";
import { relativeWorkspacePath } from "../../util/paths.ts";
import { isAnyMove, regeneratedArtifactPaths, type ExtractionManifest, type ImportRewrite, type PlanOperation } from "../manifest.ts";
import { relativeFsLiteral } from "../static-fs-references.ts";
import { validateLockfileImporter } from "./lockfile-importer.ts";
import { validatePathMigrationCoverage } from "./path-migration-noops.ts";
import { validatePathMigrationOperation } from "./path-migration-operation.ts";
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
  readonly selectedDonors: ReadonlySet<string>;
  readonly packageRoot: string;
  readonly entrypoint: string;
}

/** Validate ordered journal operations and their declared transaction footprint. */
export function validateOperations(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues, context: OperationContext): void {
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

function workspacePackageNames(manifest: ExtractionManifest, options: ValidatePlanOptions): Set<string> | undefined {
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
  // A move-with-rewrite may point a travelling test at the package this
  // manifest creates. It is absent at baseline but present in the projected
  // workspace by construction, so validate it as a legitimate target.
  packages?.add(manifest.target.packageName);
  return packages;
}

interface OperationScope {
  readonly manifest: ExtractionManifest;
  readonly options: ValidatePlanOptions;
  readonly issues: Issues;
  readonly context: OperationContext;
  readonly moves: readonly MoveOperation[];
  readonly movePaths: ReadonlySet<string>;
  readonly moved: Set<string>;
  readonly mutated: Set<string>;
  readonly workspacePackages: ReadonlySet<string> | undefined;
}

type MoveOperation = Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>;

function validateOperation(
  operation: PlanOperation,
  index: number,
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: OperationContext,
  moves: readonly MoveOperation[],
  movePaths: ReadonlySet<string>,
  moved: Set<string>,
  mutated: Set<string>,
  workspacePackages: ReadonlySet<string> | undefined,
): void {
  const scope: OperationScope = { manifest, options, issues, context, moves, movePaths, moved, mutated, workspacePackages };
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      validateMove(operation, index, options, issues, context, moved, mutated, workspacePackages);
      return;
    case "rewrite-import":
      validateRewriteImportOperation(operation, index, scope);
      return;
    case "rewrite-fs-reference":
      flagMovedFile(scope, operation.file, index);
      validateFsReferenceRewrite(operation, index, issues, moves, mutated);
      return;
    case "write-file":
      validateWriteOperation(operation, index, scope);
      return;
    case "delete-file":
      validateDelete(operation, index, issues, mutated);
      return;
    case "lockfile-importer":
      validateLockfileImporter(operation, index, options, issues, manifest, mutated);
      return;
    case "migrate-path-keys":
      validatePathMigrationOperation(operation, index, options, issues, moves, mutated);
      return;
    case "rewrite-path-reference":
      flagMovedFile(scope, operation.file, index);
      validatePathReferenceRewrite(operation, index, issues, moves, mutated);
      return;
    default:
      issues.add("unknown-operation", `unsupported operation kind ${(operation as { kind: string }).kind}`, { operationIndex: index });
  }
}

function flagMovedFile(scope: OperationScope, file: string, index: number): void {
  if (scope.movePaths.has(file)) {
    scope.issues.add("multiple-mutations", `multiple operations mutate ${file}`, { operationIndex: index });
  }
}

function validateRewriteImportOperation(operation: Extract<PlanOperation, { kind: "rewrite-import" }>, index: number, scope: OperationScope): void {
  const { movePaths } = scope;
  const crossDonorMove = movePaths.has(operation.file) && operation.donors.some((donor) => donor !== operation.file && movePaths.has(donor));
  if (movePaths.has(operation.file) && !crossDonorMove) {
    scope.issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, { operationIndex: index });
  }
  validateRewrite(operation, index, scope.issues, scope.context, scope.mutated, crossDonorMove);
}

function validateWriteOperation(operation: Extract<PlanOperation, { kind: "write-file" }>, index: number, scope: OperationScope): void {
  if (scope.movePaths.has(operation.path) && !isPromotionCompatibilityWrite(scope.manifest, operation)) {
    scope.issues.add("multiple-mutations", `multiple operations mutate ${operation.path}`, { operationIndex: index });
  }
  validateWrite(operation, index, scope.options, scope.issues, scope.mutated, isPromotionCompatibilityWrite(scope.manifest, operation));
}

function validateDelete(operation: Extract<PlanOperation, { kind: "delete-file" }>, index: number, issues: Issues, mutated: Set<string>): void {
  if (operation.preconditionHash === "missing") issues.add("invalid-precondition", `cannot delete missing file ${operation.path}`, { operationIndex: index });
  if (!isFileState(operation.preconditionHash) || !isFileState(operation.resultHash) || operation.resultHash !== "missing")
    issues.add("delete-hash", "delete result must be the missing file state", { operationIndex: index, operationKind: operation.kind, path: operation.path });
  mutated.add(operation.path);
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

  validatePathMigrationCoverage(manifest, options, issues, moves);

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
  if (operation.kind === "write-file" || operation.kind === "delete-file" || operation.kind === "migrate-path-keys")
    return `${operation.kind}:${operation.path}`;
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
  allowMovedRewrite = false,
): void {
  const at = { operationIndex: index, operationKind: operation.kind, path: operation.file };
  if (!context.consumers.has(operation.file)) issues.add("rewrite-consumer", `rewrite has no declared consumer ${operation.file}`, at);
  if (mutated.has(operation.file) && !allowMovedRewrite) issues.add("multiple-mutations", `multiple operations mutate ${operation.file}`, at);
  if (operation.donors.length === 0) issues.add("rewrite-donor", "rewrite must declare at least one donor", at);
  for (const rewrite of operation.rewrites) {
    if (!context.rewriteTargets.has(rewrite.to)) {
      issues.add("rewrite-target", `rewrite target must be a declared ${context.packageName} surface`, at);
    }
    if (rewrite.from === rewrite.to) issues.add("rewrite-noop", `rewrite for ${operation.file} is a no-op`, at);
    if (rewrite.donor !== undefined && !operation.donors.includes(rewrite.donor)) {
      issues.add("rewrite-donor", `rewrite names undeclared donor ${rewrite.donor}`, at);
    }
    validateDonorSurface(rewrite, context.packageName, context.publicSpecifierByDonor, context.selectedDonors, issues, "rewrite-donor", at);
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
  selectedDonors: ReadonlySet<string>,
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
    if (!selectedDonors.has(rewrite.donor)) issues.add(rule, `rewrite donor ${rewrite.donor} is not a selected source`, at);
    else if (rewrite.to !== packageName) issues.add(rule, `rewrite donor ${rewrite.donor} without a public module must target package root ${packageName}`, at);
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
  return (
    manifest.modulePromotion?.retireSource === false &&
    operation.path === manifest.modulePromotion.source &&
    operation.generator === "module-promotion:compatibility-reexport" &&
    operation.preconditionHash === "missing"
  );
}
