/** Consumer package manifests, project references, and lockfile wiring. */

import { resolve } from "node:path";

import type { ConsumerDependencySection, PackageManagerAdapter } from "../adapters/types.ts";
import { applicationOwner } from "../config.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import type { ConsumerDependencyOwner } from "./consumers.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { PlanOperation } from "./manifest.ts";
import { insertSorted, parseJsonFile, stringifyJson, writeOperation } from "./scaffold-shared.ts";
import type { ScaffoldInput } from "./scaffold.ts";

export interface ConsumerWiringInput extends ScaffoldInput {
  readonly consumerOwners: readonly (string | ConsumerDependencyOwner)[];
  readonly lockfileText: string;
}

export function consumerWiringOperations(input: ConsumerWiringInput): PlanOperation[] {
  let lockfile = input.lockfileText;
  const operations: PlanOperation[] = [];
  for (const owner of normalizedConsumerOwners(input.consumerOwners)) {
    const result = wireConsumer(input, owner, lockfile);
    operations.push(...result.operations);
    lockfile = result.lockfile;
  }
  return operations;
}

function wireConsumer(input: ConsumerWiringInput, owner: ConsumerDependencyOwner, lockfile: string): { operations: PlanOperation[]; lockfile: string } {
  const manifestFile = ownerPath(owner.owner, "package.json");
  if (!input.context.exists(manifestFile)) return { operations: [], lockfile };
  const operations = [consumerManifestOperation(input, owner, manifestFile), consumerReferenceOperation(input, owner.owner)].filter(
    (operation): operation is PlanOperation => operation !== undefined,
  );
  const importer = consumerImporterOperation(input, owner, lockfile);
  return { operations: [...operations, ...(importer ? [importer.operation] : [])], lockfile: importer?.lockfile ?? lockfile };
}

function normalizedConsumerOwners(owners: readonly (string | ConsumerDependencyOwner)[]): ConsumerDependencyOwner[] {
  const sections = new Map<string, ConsumerDependencySection>();
  for (const entry of owners) {
    const owner = typeof entry === "string" ? { owner: entry, dependencySection: "runtime" as const } : entry;
    const previous = sections.get(owner.owner);
    sections.set(owner.owner, previous === "runtime" || owner.dependencySection === "runtime" ? "runtime" : "dev");
  }
  return [...sections].map(([owner, dependencySection]) => ({ owner, dependencySection })).sort((left, right) => byCodeUnit(left.owner, right.owner));
}

function consumerManifestOperation(input: ConsumerWiringInput, owner: ConsumerDependencyOwner, path: string): PlanOperation | undefined {
  const manifest = parseJsonFile(input.context.text(path), path) as ManifestDependencies;
  assertDependencySections(manifest, path, input.packageName);
  const next = nextConsumerManifest(manifest, input.packageName, owner.dependencySection);
  return next ? writeOperation(input.context, path, stringifyJson(next), "wiring:consumer-dependency") : undefined;
}

type ManifestDependencies = Record<string, unknown> & {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function assertDependencySections(manifest: ManifestDependencies, path: string, packageName: string): void {
  if (manifest.optionalDependencies?.[packageName] !== undefined)
    throw new PlanningError(`${path} declares ${packageName} as optional; consumer dependency section is ambiguous`);
  if (manifest.dependencies?.[packageName] !== undefined && manifest.devDependencies?.[packageName] !== undefined)
    throw new PlanningError(`${path} declares ${packageName} in both dependencies and devDependencies`);
}

function nextConsumerManifest(manifest: ManifestDependencies, packageName: string, section: ConsumerDependencySection): Record<string, unknown> | undefined {
  const runtime = manifest.dependencies ?? {};
  const dev = manifest.devDependencies ?? {};
  if (section === "runtime" && runtime[packageName] === undefined) return runtimeManifest(manifest, runtime, dev, packageName);
  if (section === "dev" && dev[packageName] === undefined && runtime[packageName] === undefined) return devManifest(manifest, dev, packageName);
  return undefined;
}

function runtimeManifest(
  manifest: ManifestDependencies,
  runtime: Record<string, string>,
  dev: Record<string, string>,
  packageName: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...manifest, dependencies: Object.fromEntries(insertSorted(Object.entries(runtime), packageName, "workspace:*")) };
  const nextDev = Object.fromEntries(Object.entries(dev).filter(([name]) => name !== packageName));
  if (dev[packageName] !== undefined && Object.keys(nextDev).length === 0) delete next.devDependencies;
  else if (dev[packageName] !== undefined) next.devDependencies = nextDev;
  return next;
}

function devManifest(manifest: ManifestDependencies, dev: Record<string, string>, packageName: string): Record<string, unknown> {
  return { ...manifest, devDependencies: Object.fromEntries(insertSorted(Object.entries(dev), packageName, "workspace:*")) };
}

function consumerReferenceOperation(input: ConsumerWiringInput, owner: string): PlanOperation | undefined {
  const applicationConsumer = owner === applicationOwner(input.application);
  const path = applicationConsumer ? input.application.tsconfig : ownerPath(owner, "tsconfig.json");
  if (!input.context.exists(path)) return undefined;
  const tsconfig = parseJsonFile(input.context.text(path), path) as Record<string, unknown> & {
    references?: { path?: string }[];
    compilerOptions?: { composite?: unknown };
  };
  // A project reference is valid only for a composite build project (or an
  // existing solution config), except when the application explicitly names
  // its consumer tsconfig in configuration. Ordinary package configs commonly
  // use noEmit and must remain typecheck-only consumers.
  if (!applicationConsumer && tsconfig.compilerOptions?.composite !== true && !Array.isArray(tsconfig.references)) return undefined;
  const dependencyTarget = input.templates?.projectReferences.dependencyTarget ?? "tsconfig.json";
  const target = relativePosix(resolve("/", owner), resolve("/", input.packageRoot, dependencyTarget));
  const references = tsconfig.references ?? [];
  // Compare where each reference points, not how it is spelled. `./libs/x`,
  // `libs/x` and `libs/x/` are one project reference; a string comparison sees
  // three, and inserting a fourth spelling of the same path is a duplicate
  // TypeScript then rejects. Resolution is lexical against the owner directory,
  // so it stays a pure function of the plan.
  const targetPath = resolve("/", owner, target);
  if (references.some((reference) => typeof reference.path === "string" && resolve("/", owner, reference.path) === targetPath)) return undefined;
  const index = references.findIndex((reference) => target < (reference.path ?? ""));
  const next = index < 0 ? [...references, { path: target }] : [...references.slice(0, index), { path: target }, ...references.slice(index)];
  return writeOperation(input.context, path, stringifyJson({ ...tsconfig, references: next }), "wiring:consumer-project-references");
}

function ownerPath(owner: string, file: string): string {
  return owner === "." || owner === "" ? file : `${owner}/${file}`;
}

function consumerImporterOperation(
  input: ConsumerWiringInput,
  owner: ConsumerDependencyOwner,
  lockfile: string,
): { operation: PlanOperation; lockfile: string } | undefined {
  if (!lockfile) return undefined;
  const block = input.packageManager.importerBlock(lockfile, owner.owner);
  if (block === undefined)
    throw new PlanningError(
      `${input.packageManager.lockfileName} has no importer entry for ${owner.owner}, which this plan must add ${input.packageName} to; the lockfile is out of date with the workspace`,
    );
  const nextBlock = input.packageManager.addBlockDependency(
    block,
    input.packageName,
    "workspace:*",
    input.packageManager.linkVersion(owner.owner, input.packageRoot),
    owner.dependencySection,
  );
  if (nextBlock === block) return undefined;
  const nextLockfile = input.packageManager.replaceImporter(lockfile, owner.owner, nextBlock);
  return {
    operation: {
      kind: "lockfile-importer",
      lockfile: input.packageManager.lockfileName,
      packageRoot: owner.owner,
      block: nextBlock,
      mode: "replace",
      preconditionHash: hashText(lockfile),
      resultHash: hashText(nextLockfile),
    },
    lockfile: nextLockfile,
  };
}

export function projectedLockfile(context: WorkspaceContext, packageManager: PackageManagerAdapter, operations: readonly PlanOperation[]): string {
  if (!context.exists(packageManager.lockfileName)) return "";
  return operations.reduce(
    (text, operation) =>
      operation.kind === "lockfile-importer" ? packageManager.applyImporter(text, operation.packageRoot, operation.block, operation.mode) : text,
    context.text(packageManager.lockfileName),
  );
}
