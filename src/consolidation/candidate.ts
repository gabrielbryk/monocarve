/**
 * Consolidation candidate: the set of files to move from donor packages into
 * the target domain package.
 *
 * A consolidation candidate is the union of each donor's production files
 * (excluding tests and assets, which travel with their production parent).
 * The candidate preserves the SCC structure of each donor so the plan builder
 * can respect cyclic boundaries.
 */

import type { MonocarveConfig } from "../config.ts";
import { buildApplicationGraph, toSccs } from "../graph/components.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { ConsumerRef } from "../portfolio/types.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";

export interface ConsolidationCandidate {
  /** Stable, content-derived id safe to reference across runs. */
  readonly id: string;
  /** The target domain package. */
  readonly target: { readonly name: string; readonly root: string };
  /** Donor packages contributing files. */
  readonly donors: readonly { readonly name: string; readonly root: string }[];
  /** Production files to move, sorted. */
  readonly files: readonly string[];
  /** Tests that travel with the moved files, sorted. */
  readonly tests: readonly string[];
  /** Assets that travel with the moved files, sorted. */
  readonly assets: readonly string[];
  /** SCCs partitioning `files`. */
  readonly sccs: readonly { readonly id: string; readonly members: readonly string[] }[];
  /** Existing workspace packages the moved union depends on. */
  readonly dependencies: readonly string[];
  /** Consumers outside the moved union that import into it. */
  readonly consumers: readonly ConsumerRef[];
  /** Total line count of moved production files. */
  readonly lineCount: number;
}

export interface ConsolidationCandidateOptions {
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly target: { readonly name: string; readonly root: string };
  readonly donors: readonly { readonly name: string; readonly root: string }[];
}

/** Build the consolidation candidate from validated donors and target. */
export function buildConsolidationCandidate(options: ConsolidationCandidateOptions): ConsolidationCandidate {
  const { graph, target, donors } = options;

  const { files, tests, assets } = donorInventory(graph, donors);

  // Build SCCs from the production files using the application graph.
  const appGraph = buildApplicationGraph(graph, undefined);
  const fileSet = new Set(files);
  const sccs = toSccs(appGraph.condensed)
    .map((scc) => ({ id: scc.id, members: scc.members.filter((m) => fileSet.has(m)).toSorted(byCodeUnit) }))
    .filter((scc) => scc.members.length > 0)
    .toSorted((a, b) => byCodeUnit(a.id, b.id));

  const dependencies = workspaceDependencies(graph, files);

  // Collect consumers (files outside the moved union that import into it).
  const consumers = collectConsumers(graph, fileSet, donors);

  const lineCount = files.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0);

  return { id: consolidationId(target, donors, files), target, donors, files, tests, assets, sccs, dependencies, consumers, lineCount };
}

type DonorRef = { readonly name: string; readonly root: string };

function isTestPath(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

/** Every donor's production files, tests, and assets, deduplicated and sorted. */
function donorInventory(graph: DependencyGraph, donors: readonly DonorRef[]): { files: string[]; tests: string[]; assets: string[] } {
  const allFiles: string[] = [];
  const allTests: string[] = [];
  const allAssets: string[] = [];

  for (const donor of donors) {
    const donorRoot = donor.root.replace(/\/+$/, "");
    const inDonor = graph.paths.filter((path) => path.startsWith(`${donorRoot}/`));
    allFiles.push(...inDonor.filter((path) => path !== donorRoot && !isTestPath(path) && graph.nodes.get(path)?.isAsset !== true));
    allTests.push(...inDonor.filter(isTestPath));
    allAssets.push(...inDonor.filter((path) => !path.endsWith(".ts") && !path.endsWith(".tsx") && !isTestPath(path)));
  }

  return {
    files: [...new Set(allFiles)].toSorted(byCodeUnit),
    tests: [...new Set(allTests)].toSorted(byCodeUnit),
    assets: [...new Set(allAssets)].toSorted(byCodeUnit),
  };
}

/** Existing workspace packages the moved union depends on, sorted. */
function workspaceDependencies(graph: DependencyGraph, files: readonly string[]): string[] {
  const dependencies = new Set<string>();
  for (const file of files) {
    for (const dep of graph.workspaceDependenciesBySource.get(file) ?? []) {
      const pkgName = graph.workspace.packageNames.get(dep);
      if (pkgName) dependencies.add(pkgName);
    }
  }
  return [...dependencies].toSorted(byCodeUnit);
}

function collectConsumers(graph: DependencyGraph, fileSet: Set<string>, donors: readonly { readonly name: string; readonly root: string }[]): ConsumerRef[] {
  const byFile = new Map<string, Set<string>>();
  const donorRoots = new Set(donors.map((d) => d.root));

  for (const edge of graph.edges) {
    if (fileSet.has(edge.from) || !fileSet.has(edge.to)) continue;
    // Consumer must not be in a donor package.
    const consumerNode = graph.nodes.get(edge.from);
    if (consumerNode === undefined) continue;
    const consumerRoot = consumerNode.owner;
    if (donorRoots.has(consumerRoot)) continue;

    const specifiers = byFile.get(edge.from) ?? new Set<string>();
    specifiers.add(edge.specifier);
    byFile.set(edge.from, specifiers);
  }

  return [...byFile.entries()]
    .map(([file, specifiers]) => ({ file, owner: graph.nodes.get(file)?.owner ?? "", specifiers: [...specifiers].toSorted(byCodeUnit), external: false }))
    .toSorted((a, b) => byCodeUnit(a.file, b.file));
}

function consolidationId(
  target: { readonly name: string; readonly root: string },
  donors: readonly { readonly name: string; readonly root: string }[],
  files: readonly string[],
): string {
  const identity = ["consolidation", target.name, ...donors.map((d) => d.name).toSorted(), "--files--", ...[...files].toSorted(byCodeUnit)].join("\n");
  return `c-${hashText(identity).slice(0, 12)}`;
}
