/** Exact, opt-in pruning of dependencies no retained donor source references. */

import type { PackageManagerAdapter } from "../adapters/types.ts";
import type { InferredDependencies } from "./dependencies.ts";
import type { WorkspaceContext } from "./context.ts";
import { collectDependencyUsage } from "./dependency-usage.ts";
import type { PlanOperation } from "./manifest.ts";
import { ProjectedWorkspace } from "./projected-workspace.ts";
import { parseJsonFile } from "./scaffold-shared.ts";

interface ManifestShape extends Record<string, unknown> {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface DonorDependencyPruningCandidate {
  readonly name: string;
  readonly section: "runtime" | "dev" | "optional";
}

export function donorDependencyPruningCandidates(input: {
  readonly context: WorkspaceContext;
  readonly donorRoot: string;
  readonly movedSources: readonly string[];
  readonly dependencies: InferredDependencies;
}): DonorDependencyPruningCandidate[] {
  const manifestPath = `${input.donorRoot}/package.json`;
  if (!input.context.exists(manifestPath)) return [];
  const manifest = parseJsonFile(input.context.text(manifestPath), manifestPath) as ManifestShape;
  const names = [...new Set([...Object.keys(input.dependencies.runtime), ...Object.keys(input.dependencies.dev)])].sort();
  const usage = collectDependencyUsage({ context: input.context, donorRoot: input.donorRoot, movedSources: input.movedSources, dependencyNames: names });
  return usage.flatMap(({ name, retainedSources, tsconfigTypes, explicitlyKept }): DonorDependencyPruningCandidate[] => {
      const section = dependencySection(manifest, name);
      return section === undefined || explicitlyKept || tsconfigTypes.length > 0 || retainedSources.length > 0
        ? [] : [{ name, section }];
    });
}

export function composeDonorDependencyPruning(input: {
  readonly context: WorkspaceContext;
  readonly donorRoot: string;
  readonly movedSources: readonly string[];
  readonly dependencies: InferredDependencies;
  readonly packageManager: PackageManagerAdapter;
  readonly operations: readonly PlanOperation[];
}): PlanOperation[] {
  const manifestPath = `${input.donorRoot}/package.json`;
  if (!input.context.exists(manifestPath)) return [...input.operations];
  const declared = donorDependencyPruningCandidates(input).map(({ name }) => name);
  if (declared.length === 0) return [...input.operations];
  const projected = new ProjectedWorkspace(input.context, input.packageManager, input.operations);
  projected.transformJson(manifestPath, "donor-dependency-pruning", (value) => pruneManifest(value as ManifestShape, declared));
  projected.transformImporter(input.donorRoot, (block) => declared.reduce((current, name) => input.packageManager.removeBlockDependency(current, name), block));
  return projected.finalize();
}

function dependencySection(manifest: ManifestShape, name: string): DonorDependencyPruningCandidate["section"] | undefined {
  if (manifest.dependencies?.[name] !== undefined) return "runtime";
  if (manifest.devDependencies?.[name] !== undefined) return "dev";
  if (manifest.optionalDependencies?.[name] !== undefined) return "optional";
  return undefined;
}

function pruneManifest(manifest: ManifestShape, names: readonly string[]): ManifestShape {
  const next: ManifestShape = { ...manifest };
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const values = manifest[section];
    if (!values) continue;
    const retained = Object.fromEntries(Object.entries(values).filter(([name]) => !names.includes(name)));
    if (Object.keys(retained).length === 0) delete next[section];
    else next[section] = retained;
  }
  return next;
}
