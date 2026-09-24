/** Validation for the `lockfile-importer` operation. Split out of operations.ts to keep that file under its line budget. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPackageManagerAdapter } from "../../adapters/registry.ts";
import { isPackageOwner } from "../../config.ts";
import { applicationOwner } from "../../config/helpers.ts";
import { hashText, isFileState, isSha256 } from "../../util/hash.ts";
import type { ExtractionManifest, PlanOperation } from "../manifest.ts";
import type { Issues, ValidatePlanOptions, ValidationIssue } from "./shared.ts";

type LockfileImporterOperation = Extract<PlanOperation, { kind: "lockfile-importer" }>;
type PackageManagerAdapter = ReturnType<typeof createPackageManagerAdapter>;

export function validateLockfileImporter(
  operation: LockfileImporterOperation,
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
  if (!isImporterTarget(operation, options, mode)) {
    issues.add("lockfile-target", "lockfile importer must target a workspace package", at);
  }
  if (!operation.block || !adapter.blockDeclaresImporter(operation.block, operation.packageRoot)) {
    issues.add("lockfile-block", `lockfile importer block must declare ${operation.packageRoot}`, at);
  }
  if (!isFileState(operation.preconditionHash) || !isSha256(operation.resultHash)) issues.add("lockfile-hash", "lockfile importer hashes must be SHA-256", at);
  if (operation.preconditionHash === operation.resultHash) issues.add("lockfile-identity", "lockfile importer result must differ from precondition", at);
  if (mode === "replace" && !options.offline && lacksExistingBlock(operation, options, adapter)) {
    issues.add("lockfile-replace", `lockfile importer replace has no existing block for ${operation.packageRoot}`, at);
  }
  if (mode === "delete" && !options.offline && lacksExistingBlock(operation, options, adapter)) {
    issues.add("lockfile-delete", `lockfile importer delete has no existing block for ${operation.packageRoot}`, at);
  }
  validateImporterEcho(operation, manifest, issues, at);
  mutated.add(operation.lockfile);
}

function isImporterTarget(operation: LockfileImporterOperation, options: ValidatePlanOptions, mode: string): boolean {
  const isPackage = isPackageOwner(options.config, operation.packageRoot);
  const isApplicationOwner = options.config.applications.some((app) => applicationOwner(app) === operation.packageRoot);
  return (isPackage || (mode === "replace" && isApplicationOwner)) && !operation.packageRoot.includes("..");
}

/** True only when the lockfile is readable and has no importer block for the operation's package root. */
function lacksExistingBlock(operation: LockfileImporterOperation, options: ValidatePlanOptions, adapter: PackageManagerAdapter): boolean {
  const lockfile = resolve(options.rootDir, operation.lockfile);
  const text = existsSync(lockfile) ? readFileSyncSafe(lockfile) : undefined;
  return text !== undefined && adapter.importerBlock(text, operation.packageRoot) === undefined;
}

function validateImporterEcho(operation: LockfileImporterOperation, manifest: ExtractionManifest, issues: Issues, at: Partial<ValidationIssue>): void {
  const echo = manifest.lockfileImporter;
  if (echo && echo.packageRoot === operation.packageRoot && echo.hash !== hashText(operation.block)) {
    issues.add("lockfile-echo", "lockfileImporter.hash must be the SHA-256 of the declared importer block", at);
  }
}

const readFileSyncSafe = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
