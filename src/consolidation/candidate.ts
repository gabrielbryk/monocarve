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
import { byCodeUnit, hashText } from "../util/hash.ts";
import type { ConsumerRef } from "../portfolio/types.ts";

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

  // Collect production files from each donor.
  const allFiles: string[] = [];
  const allTests: string[] = [];
  const allAssets: string[] = [];

  for (const donor of donors) {
    const donorRoot = donor.root.replace(/\/+$/, "");
    const donorFiles = graph.paths.filter(
      (path) => path.startsWith(`${donorRoot}/`) && path !== donorRoot && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );
    const donorTests = graph.paths.filter(
      (path) => path.startsWith(`${donorRoot}/`) && (path.endsWith(".test.ts") || path.endsWith(".test.tsx")),
    );
    const donorAssets = graph.paths.filter(
      (path) => path.startsWith(`${donorRoot}/`) && !path.endsWith(".ts") && !path.endsWith(".tsx") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"),
    );

    allFiles.push(...donorFiles);
    allTests.push(...donorTests);
    allAssets.push(...donorAssets);
  }

  // Deduplicate and sort.
  const files = [...new Set(allFiles)].sort(byCodeUnit);
  const tests = [...new Set(allTests)].sort(byCodeUnit);
  const assets = [...new Set(allAssets)].sort(byCodeUnit);

  // Build SCCs from the production files using the application graph.
  const appGraph = buildApplicationGraph(graph, undefined);
  const fileSet = new Set(files);
  const sccs = toSccs(appGraph.condensed)
    .map((scc) => ({ id: scc.id, members: scc.members.filter((m) => fileSet.has(m)).sort(byCodeUnit) }))
    .filter((scc) => scc.members.length > 0)
    .sort((a, b) => byCodeUnit(a.id, b.id));

  // Collect dependencies (external workspace packages the moved union depends on).
  const dependencies = new Set<string>();
  for (const file of files) {
    const deps = graph.workspaceDependenciesBySource.get(file);
    if (deps) {
      for (const dep of deps) {
        const pkgName = graph.workspace.packageNames.get(dep);
        if (pkgName) dependencies.add(pkgName);
      }
    }
  }

  // Collect consumers (files outside the moved union that import into it).
  const consumers = collectConsumers(graph, fileSet, donors);

  const lineCount = files.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0);

  return {
    id: consolidationId(target, donors, files),
    target,
    donors,
    files,
    tests,
    assets,
    sccs,
    dependencies: [...dependencies].sort(byCodeUnit),
    consumers,
    lineCount,
  };
}

function collectConsumers(
  graph: DependencyGraph,
  fileSet: Set<string>,
  donors: readonly { readonly name: string; readonly root: string }[],
): ConsumerRef[] {
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
    .map(([file, specifiers]) => ({
      file,
      owner: graph.nodes.get(file)?.owner ?? "",
      specifiers: [...specifiers].sort(byCodeUnit),
      external: false,
    }))
    .sort((a, b) => byCodeUnit(a.file, b.file));
}

function consolidationId(
  target: { readonly name: string; readonly root: string },
  donors: readonly { readonly name: string; readonly root: string }[],
  files: readonly string[],
): string {
  const identity = [
    "consolidation",
    target.name,
    ...donors.map((d) => d.name).sort(),
    "--files--",
    ...[...files].sort(byCodeUnit),
  ].join("\n");
  return `c-${hashText(identity).slice(0, 12)}`;
}
