import { resolve } from "node:path";
import ts from "typescript";
import { applicationOwner, isPackageOwner } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { isBuiltinModule, type WorkspaceContext } from "./context.ts";

export type DependencySection = "runtime" | "dev";

export interface DependencyEvidence {
  readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sections: ReadonlyMap<string, DependencySection>;
  /** Exact moved source files whose imports demanded each package. */
  readonly sources: ReadonlyMap<string, ReadonlySet<string>>;
}

function noteDependency(
  evidence: { owners: Map<string, Set<string>>; sections: Map<string, DependencySection>; sources: Map<string, Set<string>> },
  name: string,
  section: DependencySection,
  source: string,
  context: WorkspaceContext,
): void {
  const previous = evidence.sections.get(name);
  evidence.sections.set(name, previous === "runtime" || section === "runtime" ? "runtime" : "dev");
  const dependencyOwners = evidence.owners.get(name) ?? new Set<string>();
  dependencyOwners.add(context.ownerOf(source));
  evidence.owners.set(name, dependencyOwners);
  const sources = evidence.sources.get(name) ?? new Set<string>();
  sources.add(source);
  evidence.sources.set(name, sources);
}

function sourceSpecifiers(context: WorkspaceContext, graph: DependencyGraph, source: string): string[] {
  return [
    ...new Set([
      ...(graph.specifiers.get(source) ?? []),
      ...context
        .moduleReferences(source)
        .map((reference) => reference.specifier)
        .filter((specifier): specifier is string => specifier !== null),
    ]),
  ];
}

function recordSpecifiers(
  context: WorkspaceContext,
  graph: DependencyGraph,
  source: string,
  packageName: string,
  evidence: { owners: Map<string, Set<string>>; sections: Map<string, DependencySection>; sources: Map<string, Set<string>> },
  workspaceNamesSeen: Set<string>,
): void {
  const sourceSection: DependencySection = context.isProductionSource(source) ? "runtime" : "dev";
  const kinds = context.importKinds(source);
  for (const specifier of sourceSpecifiers(context, graph, source)) {
    const name = specifier.startsWith(".") ? undefined : context.packageNameOf(specifier);
    if (!name || name === packageName || isBuiltinModule(name) || name.includes(":")) continue;
    if (graph.workspace.packageNames.has(name)) workspaceNamesSeen.add(name);
    const section = sourceSection === "dev" || kinds.get(specifier)?.typeOnly === true ? "dev" : "runtime";
    noteDependency(evidence, name, section, source, context);
  }
}

function recordUnresolvedWorkspaceEdges(
  context: WorkspaceContext,
  graph: DependencyGraph,
  source: string,
  packageName: string,
  ownerToPackage: ReadonlyMap<string, string>,
  evidence: { owners: Map<string, Set<string>>; sections: Map<string, DependencySection>; sources: Map<string, Set<string>> },
  workspaceNamesSeen: ReadonlySet<string>,
): void {
  const section: DependencySection = context.isProductionSource(source) ? "runtime" : "dev";
  for (const owner of graph.workspaceDependenciesBySource.get(source) ?? []) {
    const name = ownerToPackage.get(owner) ?? owner;
    if (name === packageName || isPackageOwner(context.config, name) || workspaceNamesSeen.has(name)) continue;
    noteDependency(evidence, name, section, source, context);
  }
}

/** Collects package names, provenance, and runtime/dev demand from moved sources. */
export function collectDependencyEvidence(
  context: WorkspaceContext,
  graph: DependencyGraph,
  sources: readonly string[],
  packageName: string,
): DependencyEvidence {
  const evidence = { owners: new Map<string, Set<string>>(), sections: new Map<string, DependencySection>(), sources: new Map<string, Set<string>>() };
  const ownerToPackage = new Map([...graph.workspace.packageNames.entries()].map(([name, owner]) => [owner, name]));
  const workspaceNamesSeen = new Set<string>();
  for (const source of sources) {
    recordSpecifiers(context, graph, source, packageName, evidence, workspaceNamesSeen);
    recordUnresolvedWorkspaceEdges(context, graph, source, packageName, ownerToPackage, evidence, workspaceNamesSeen);
  }
  recordConfiguredTypes(context, packageName, sources, evidence);
  return evidence;
}

/** Ambient compiler types are package inputs even when no source import names them. */
function recordConfiguredTypes(
  context: WorkspaceContext,
  packageName: string,
  sources: readonly string[],
  evidence: { owners: Map<string, Set<string>>; sections: Map<string, DependencySection>; sources: Map<string, Set<string>> },
): void {
  const owners = new Set(sources.map((source) => context.ownerOf(source)));
  for (const application of context.config.applications) {
    if (!owners.has(applicationOwner(application))) continue;
    const configPath = resolve(context.rootDir, application.tsconfig);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const configured = read.error === undefined && Array.isArray(read.config?.compilerOptions?.types) ? read.config.compilerOptions.types : [];
    for (const type of configured) {
      const name = context.packageNameOf(type) ?? type;
      if (name === packageName || isBuiltinModule(name)) continue;
      // Attribute the evidence to a moved source so version resolution uses
      // the donating owner (the tsconfig path itself is not a manifest owner).
      noteDependency(evidence, name, "dev", sources[0] ?? application.sourceRoot, context);
    }
  }
}
