/**
 * Consolidation selectors: validate donor and target packages.
 *
 * Consolidation moves files FROM existing packages INTO a target domain
 * package. Unlike evacuation (app → package), consolidation operates entirely
 * within the package layer. Every donor must be an existing workspace package;
 * the target must be an existing workspace package (extending it) or a new
 * package root (creating it).
 */

import { MonocarveError } from "../errors.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";

/** A donor or target package is not a workspace package. */
class ConsolidationSelectorError extends MonocarveError {
  override readonly name = "ConsolidationSelectorError";
}

/** Validate that every named package is a workspace package and return their roots. */
export function resolveConsolidationPackages(
  graph: DependencyGraph,
  targetName: string,
  donorNames: readonly string[],
): { readonly target: { readonly name: string; readonly root: string }; readonly donors: readonly { readonly name: string; readonly root: string }[] } {
  if (donorNames.length === 0) {
    throw new ConsolidationSelectorError("consolidation requires at least one donor package");
  }

  const target = resolveWorkspacePackage(graph, targetName, "target");
  const donors = donorNames.map((name) => resolveWorkspacePackage(graph, name, "donor"));

  const donorNamesSet = new Set(donors.map((d) => d.name));
  if (donorNamesSet.size !== donorNames.length) {
    throw new ConsolidationSelectorError(`donor package names must be unique: ${[...donorNames].toSorted().join(", ")}`);
  }

  if (donors.some((d) => d.name === target.name)) {
    throw new ConsolidationSelectorError(`target package ${JSON.stringify(target.name)} cannot also be a donor`);
  }

  const donorRoots = new Set(donors.map((d) => d.root));
  if (donorRoots.size !== donors.length) {
    throw new ConsolidationSelectorError(`donor package roots must be unique`);
  }

  return { target, donors: [...donors].toSorted((a, b) => byCodeUnit(a.name, b.name)) };
}

function resolveWorkspacePackage(graph: DependencyGraph, name: string, role: "target" | "donor"): { readonly name: string; readonly root: string } {
  const root = graph.workspace.packageNames.get(name);
  if (root === undefined) {
    throw new ConsolidationSelectorError(`${role} package ${JSON.stringify(name)} is not a workspace package`);
  }
  return { name, root };
}

/**
 * Validate that the target package root does not already contain files from
 * any donor. A pre-existing collision means the consolidation would overwrite
 * content, which is a safety violation.
 */
export function assertNoTargetDonorCollision(graph: DependencyGraph, targetRoot: string, donorRoots: readonly string[]): void {
  const targetNode = graph.nodes.get(targetRoot);
  if (targetNode === undefined) return;
  const targetChildren = graph.paths.filter((path) => path.startsWith(`${targetRoot}/`) && path !== targetRoot);
  for (const donorRoot of donorRoots) {
    const donorChildren = graph.paths.filter((path) => path.startsWith(`${donorRoot}/`) && path !== donorRoot);
    const overlap = targetChildren.filter((child) => donorChildren.some((donorChild) => donorChild === child));
    if (overlap.length > 0) {
      throw new ConsolidationSelectorError(
        `target package root ${JSON.stringify(targetRoot)} already contains paths that overlap with donor ${JSON.stringify(donorRoot)}: ${overlap.sort(byCodeUnit).join(", ")}`,
      );
    }
  }
}
