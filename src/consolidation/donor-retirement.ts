/**
 * Donor retirement for consolidation plans: delete each donor's package
 * scaffolding and lockfile importer, then strip donor dependencies from the
 * root and target manifests. Split out of `plan-support.ts`.
 */

import type { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import type { PlanOperation } from "../plan/manifest.ts";
import { parseJsonFile, stringifyJson, writeOperation } from "../plan/scaffold-shared.ts";
import { hashText } from "../util/hash.ts";
import type { ConsolidationCandidate } from "./candidate.ts";

type PackageManagerAdapter = ReturnType<typeof createPackageManagerAdapter>;

/** Push donor-retirement operations (manifest deletion, lockfile importer removal) onto `operations`. */
export function applyConsolidationDonorRetirement(input: {
  readonly context: WorkspaceContext;
  readonly packageManager: PackageManagerAdapter;
  readonly candidate: ConsolidationCandidate;
  readonly packageRoot: string;
  readonly operations: PlanOperation[];
}): void {
  const { context, packageManager, candidate, packageRoot, operations } = input;
  for (const donor of candidate.donors) {
    operations.push(...donorFileDeletions(context, donor.root));
    const importerDeletion = donorImporterDeletion(context, packageManager, donor.root);
    if (importerDeletion !== undefined) operations.push(importerDeletion);
  }
  operations.push(
    ...retirementDependencyOperations({ context, packageManager, donorNames: candidate.donors.map((donor) => donor.name), owners: [".", packageRoot] }),
  );
}

/** Remove donor-package entries from one manifest's dependency sections. */
function pruneManifestDependencies(manifest: Record<string, unknown>, donorNames: readonly string[]): { next: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next = { ...manifest };
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const values: unknown = next[section];
    if (!values) continue;
    const retained = Object.fromEntries(Object.entries(values).filter(([name]) => !donorNames.includes(name)));
    if (Object.keys(retained).length !== Object.keys(values).length) changed = true;
    if (Object.keys(retained).length === 0) delete next[section];
    else next[section] = retained;
  }
  return { next, changed };
}

/** Strip donor entries from one owner's lockfile importer block, if it has any. */
function retireLockfileImporterBlock(input: {
  readonly packageManager: PackageManagerAdapter;
  readonly context: WorkspaceContext;
  readonly lockfile: string;
  readonly lockfileText: string;
  readonly owner: string;
  readonly donorNames: readonly string[];
}): { operation?: PlanOperation; lockfileText: string } {
  const { packageManager, context, lockfile, lockfileText, owner, donorNames } = input;
  const block = packageManager.importerBlock(lockfileText, owner);
  if (block === undefined) return { lockfileText };
  let nextBlock = block;
  for (const name of donorNames) nextBlock = packageManager.removeBlockDependency(nextBlock, name);
  if (nextBlock === block) return { lockfileText };
  const operation: PlanOperation = {
    kind: "lockfile-importer",
    lockfile,
    packageRoot: owner,
    block: nextBlock,
    mode: "replace",
    preconditionHash: context.state(lockfile),
    resultHash: hashText(nextBlock),
  };
  return { operation, lockfileText: packageManager.applyImporter(lockfileText, owner, nextBlock, "replace") };
}

function retirementDependencyOperations(input: {
  readonly context: WorkspaceContext;
  readonly packageManager: PackageManagerAdapter;
  readonly donorNames: readonly string[];
  readonly owners: readonly string[];
}): PlanOperation[] {
  const operations: PlanOperation[] = [];
  const lockfile = input.packageManager.lockfileName;
  let lockfileText = input.context.exists(lockfile) ? input.context.text(lockfile) : "";
  for (const owner of [...new Set(input.owners)].toSorted()) {
    const manifestPath = owner === "." ? "package.json" : `${owner}/package.json`;
    if (!input.context.exists(manifestPath)) continue;
    const manifest = parseJsonFile(input.context.text(manifestPath), manifestPath);
    const { next, changed } = pruneManifestDependencies(manifest, input.donorNames);
    if (!changed) continue;
    const contents = stringifyJson(next);
    operations.push(writeOperation(input.context, manifestPath, contents, "consolidation:retire-donor-dependency"));
    const retired = retireLockfileImporterBlock({
      packageManager: input.packageManager,
      context: input.context,
      lockfile,
      lockfileText,
      owner,
      donorNames: input.donorNames,
    });
    lockfileText = retired.lockfileText;
    if (retired.operation) operations.push(retired.operation);
  }
  return operations;
}

const RETIREMENT_FILES = ["package.json", "tsconfig.json", "moon.yml", "README.md"];

function donorFileDeletions(context: WorkspaceContext, donorRoot: string): PlanOperation[] {
  const operations: PlanOperation[] = [];
  for (const name of RETIREMENT_FILES) {
    const path = `${donorRoot}/${name}`;
    const preconditionHash = context.state(path);
    if (preconditionHash === "missing") continue;
    operations.push({ kind: "delete-file", path, file: path, source: path, target: path, preconditionHash, resultHash: "missing" });
  }
  return operations;
}

function donorImporterDeletion(context: WorkspaceContext, packageManager: PackageManagerAdapter, donorRoot: string): PlanOperation | undefined {
  const lockfile = packageManager.lockfileName;
  const block = context.exists(lockfile) ? packageManager.importerBlock(context.text(lockfile), donorRoot) : undefined;
  if (block === undefined) return undefined;
  return {
    kind: "lockfile-importer",
    lockfile,
    packageRoot: donorRoot,
    block,
    mode: "delete",
    preconditionHash: context.state(lockfile),
    resultHash: hashText(""),
  };
}
