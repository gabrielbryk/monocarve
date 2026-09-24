import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import { PlanningError, typesPackageName, type WorkspaceContext } from "./context.ts";
import type { InferredDependencies } from "./dependencies.ts";
import type { DependencyEvidence, DependencySection } from "./dependency-evidence.ts";

function declaredVersions(context: WorkspaceContext, owners: ReadonlySet<string> | undefined, candidate: string): Set<string> {
  const found = new Set<string>();
  for (const owner of owners ?? []) {
    const version = context.declaredVersion(owner, candidate);
    if (version) found.add(version);
  }
  if (found.size === 0) {
    const rootVersion = context.declaredVersion("", candidate);
    if (rootVersion) found.add(rootVersion);
  }
  return found;
}

function declaredVersionOrTypesAlias(context: WorkspaceContext, name: string, owners: ReadonlySet<string> | undefined): { name: string; version: string } {
  const versions = declaredVersions(context, owners, name);
  if (versions.size === 1) return { name, version: [...versions][0]! };
  if (versions.size > 1) throw inconsistentVersion(name);
  const alias = typesPackageName(name);
  const aliasVersions = alias === name ? new Set<string>() : declaredVersions(context, owners, alias);
  if (aliasVersions.size === 1) return { name: alias, version: [...aliasVersions][0]! };
  throw inconsistentVersion(name);
}

function inconsistentVersion(name: string): PlanningError {
  return new PlanningError(`dependency version is not declared consistently by the donating owners or the workspace root: ${name}`);
}

function setDependency(target: Record<string, string>, name: string, version: string): void {
  target[name] = version;
}

function resolveDependency(
  context: WorkspaceContext,
  graph: DependencyGraph,
  evidence: DependencyEvidence,
  name: string,
  section: DependencySection,
  result: InferredDependencies,
  packageReferences: Set<string>,
): void {
  const workspaceOwner = graph.workspace.packageNames.get(name);
  const target = section === "runtime" ? result.runtime : result.dev;
  if (workspaceOwner) {
    packageReferences.add(workspaceOwner);
    setDependency(target, name, "workspace:*");
    return;
  }
  const resolved = declaredVersionOrTypesAlias(context, name, evidence.owners.get(name));
  setDependency(resolved.name === name ? target : result.dev, resolved.name, resolved.version);
}

/** Resolves collected package evidence to declarations needed by the generated package. */
export function resolveDependencies(context: WorkspaceContext, graph: DependencyGraph, evidence: DependencyEvidence): InferredDependencies {
  const resolutionRoots: Record<string, readonly string[]> = {};
  const result: InferredDependencies = { runtime: {}, dev: {}, packageReferences: [], resolutionRoots };
  const packageReferences = new Set<string>();
  for (const [name, section] of [...evidence.sections].sort(([left], [right]) => byCodeUnit(left, right))) {
    resolveDependency(context, graph, evidence, name, section, result, packageReferences);
    const owners = [...(evidence.owners.get(name) ?? [])].sort(byCodeUnit);
    if (owners.length > 0) resolutionRoots[name] = owners;
    else if (context.declaredVersion("", name) !== undefined) resolutionRoots[name] = ["."];
  }
  result.packageReferences = [...packageReferences].sort();
  return result;
}
