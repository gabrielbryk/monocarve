/**
 * The read-only decomposition report: what the graph looks like before anything
 * is planned.
 *
 * This is the artifact you read when deciding *whether* to decompose at all —
 * which domains are already dependency-closed, which components are cyclic,
 * where the cross-domain edges are, and how much code sits behind each. The
 * portfolio answers "what can move next"; this answers "what shape is this
 * application in".
 */

import { basename } from "node:path";

import { isFirstPartyPackageOwner, isPackageOwner, type MonocarveConfig } from "../config.ts";
import { byCodeUnit } from "../util/hash.ts";
import { buildApplicationGraph, stronglyConnectedComponents, transitive, type ApplicationGraph } from "./components.ts";
import type { DependencyGraph, ModuleEdge } from "./model.ts";
import { generatedProvenance } from "./workspace.ts";

export interface ComponentReport {
  readonly id: number;
  readonly application: string | null;
  readonly layer: number;
  readonly cyclic: boolean;
  readonly nodes: readonly string[];
  readonly lines: number;
  readonly dependencies: readonly number[];
  readonly dependents: readonly number[];
  readonly inboundNodes: readonly string[];
  readonly testImporterFiles: readonly string[];
  readonly transitiveClosure: readonly string[];
  readonly transitiveClosureLines: number;
  readonly domains: readonly string[];
  readonly closedWithinDomain: boolean;
  readonly libraryDependencies: readonly string[];
  readonly externalPackages: readonly string[];
  readonly frameworkDependencies: readonly string[];
  readonly archetype: Archetype;
  readonly generated: readonly { readonly node: string; readonly source: string | null; readonly regenerate: string | null; readonly sourceExists: boolean }[];
  readonly dynamicImports: readonly string[];
  readonly typeOnlyEdges: number;
  readonly flags: readonly string[];
}

/**
 * What a component *is*, inferred from its filenames and its coupling. Used to
 * rank and to explain, never as the sole reason to reject: the composition
 * check is a configured fact, not an inference.
 */
type Archetype = "contract" | "composition" | "runtime-adapter-or-ui" | "policy-candidate" | "module-candidate";

const CONTRACT_NAME = /^(?:schemas?|models?|types?|contracts?|protocol)$/;
const POLICY_NAME = /(?:helper|rule|policy|validation|normalize|format|transform|calculate|compute)/i;

function frameworkDependencies(config: MonocarveConfig, graph: DependencyGraph, component: readonly string[]): string[] {
  const declared = new Set(config.portfolio.frameworkPackages);
  const found = [...new Set(component.flatMap((node) => [...(graph.externalBySource.get(node) ?? [])]))].filter((name) => declared.has(name));
  return found.sort();
}

function archetype(config: MonocarveConfig, component: readonly string[], framework: readonly string[]): Archetype {
  const names = component.map((node) => basename(node).replace(/\.[^.]+$/, ""));
  if (names.every((name) => CONTRACT_NAME.test(name))) return "contract";
  if (component.some((node) => isCompositionRoot(config, node))) return "composition";
  if (framework.length > 0) return "runtime-adapter-or-ui";
  if (names.some((name) => POLICY_NAME.test(name))) return "policy-candidate";
  return "module-candidate";
}

/**
 * A file the application composes itself from. Declared per application, or
 * matched by a configured pattern — never guessed from a hardcoded filename
 * list, because "main.ts is an entrypoint" is a fact about a repository.
 */
export function isCompositionRoot(config: MonocarveConfig, path: string): boolean {
  if (config.applications.some((app) => app.compositionRoots.includes(path))) return true;
  return config.portfolio.compositionRootPatterns.some((pattern) => new RegExp(pattern).test(path));
}

function workspaceDependencies(config: MonocarveConfig, graph: DependencyGraph, component: readonly string[], edges: readonly ModuleEdge[]): string[] {
  return [
    ...new Set([
      ...edges
        .map((edge) => graph.nodes.get(edge.to)?.owner ?? "")
        .filter((owner) => owner !== "" && (isPackageOwner(config, owner) || isFirstPartyPackageOwner(config, owner))),
      ...component.flatMap((node) => [...(graph.workspaceDependenciesBySource.get(node) ?? [])]),
    ]),
  ].toSorted();
}

function flags(
  config: MonocarveConfig,
  component: readonly string[],
  framework: readonly string[],
  kind: Archetype,
  generatedSourceMissing: boolean,
): string[] {
  return [
    component.some((node) => isCompositionRoot(config, node)) ? "composition-or-route" : undefined,
    component.some((node) => basename(node).startsWith("index.")) ? "barrel" : undefined,
    framework.length > 0 ? "framework-coupled" : undefined,
    kind === "composition" ? "composition-root" : undefined,
    generatedSourceMissing ? "generated-source-missing" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
}

export function componentReports(config: MonocarveConfig, graph: DependencyGraph, application: ApplicationGraph): ComponentReport[] {
  const { components, outgoing, incoming, layers } = application.condensed;
  const selfEdges = new Set(graph.edges.filter((edge) => edge.from === edge.to).map((edge) => edge.from));
  const lines = (paths: readonly string[]): number => paths.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0);

  return components.map((component, id) => {
    const closureNodes = [...transitive(id, outgoing)].flatMap((dependency) => components[dependency] ?? []);
    const allNodes = [...component, ...closureNodes];
    const domains = [...new Set(component.map((node) => graph.nodes.get(node)?.domain ?? "unknown"))].toSorted();
    const directEdges = graph.edges.filter((edge) => component.includes(edge.from));
    const framework = frameworkDependencies(config, graph, component);
    const libraries = workspaceDependencies(config, graph, component, directEdges);
    const kind = archetype(config, component, framework);
    const generated = component
      .map((node) => ({ node, provenance: generatedProvenance(config, graph.rootDir, node) }))
      .filter((entry) => entry.provenance !== null)
      .map((entry) => ({
        node: entry.node,
        source: entry.provenance!.source,
        regenerate: entry.provenance!.regenerate,
        sourceExists: entry.provenance!.sourceExists,
      }));
    const generatedSourceMissing = generated.some((entry) => entry.source !== null && !entry.sourceExists);

    return {
      id,
      application: graph.nodes.get(component[0]!)?.application ?? null,
      layer: layers.get(id) ?? 0,
      cyclic: component.length > 1 || component.some((node) => selfEdges.has(node)),
      nodes: component,
      lines: lines(component),
      dependencies: [...(outgoing.get(id) ?? [])].toSorted((left, right) => left - right),
      dependents: [...(incoming.get(id) ?? [])].toSorted((left, right) => left - right),
      inboundNodes: [...(incoming.get(id) ?? [])].flatMap((dependency) => components[dependency] ?? []).toSorted(),
      testImporterFiles: [...new Set(component.flatMap((node) => [...(graph.testImporters.get(node) ?? [])]))].toSorted(),
      transitiveClosure: closureNodes.sort(),
      transitiveClosureLines: lines(allNodes),
      domains,
      closedWithinDomain: domains.length === 1 && allNodes.every((node) => graph.nodes.get(node)?.domain === domains[0]),
      libraryDependencies: libraries,
      externalPackages: [...new Set(component.flatMap((node) => [...(graph.externalBySource.get(node) ?? [])]))].toSorted(),
      frameworkDependencies: framework,
      archetype: kind,
      generated,
      dynamicImports: directEdges
        .filter((edge) => edge.dynamic)
        .map((edge) => edge.specifier)
        .toSorted(),
      typeOnlyEdges: directEdges.filter((edge) => edge.typeOnly).length,
      flags: flags(config, component, framework, kind, generatedSourceMissing),
    };
  });
}

interface DomainReport {
  readonly domain: string;
  readonly files: number;
  readonly lines: number;
  readonly dependencyClosedFiles: number;
  readonly dependencyClosedLines: number;
  readonly dependencyClosedPercent: number;
  readonly dependencyClosedFileList: readonly string[];
  readonly dependencyDomains: readonly string[];
  readonly dependentDomains: readonly string[];
  readonly crossDomainEdges: readonly { readonly from: string; readonly to: string; readonly typeOnly: boolean }[];
  readonly blockedFiles: readonly string[];
}

function domainReports(graph: DependencyGraph, application: ApplicationGraph): DomainReport[] {
  const { components, componentByNode, outgoing } = application.condensed;
  const domainOf = (path: string): string => graph.nodes.get(path)?.domain ?? "unknown";
  const lines = (paths: readonly string[]): number => paths.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0);

  return [...new Set(application.nodes.map(domainOf))].toSorted().map((domain) => {
    const nodes = application.nodes.filter((node) => domainOf(node) === domain);
    const nodeSet = new Set(nodes);
    const closed = nodes.filter((node) => {
      const component = componentByNode.get(node)!;
      return [component, ...transitive(component, outgoing)].every((id) => (components[id] ?? []).every((dependency) => domainOf(dependency) === domain));
    });
    const crossDomainEdges = graph.edges
      .filter((edge) => nodeSet.has(edge.from) && application.nodeSet.has(edge.to) && domainOf(edge.to) !== domain)
      .map((edge) => ({ from: edge.from, to: edge.to, typeOnly: edge.typeOnly }))
      .toSorted((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.to, right.to));

    return {
      domain,
      files: nodes.length,
      lines: lines(nodes),
      dependencyClosedFiles: closed.length,
      dependencyClosedLines: lines(closed),
      dependencyClosedPercent: nodes.length === 0 ? 0 : Math.round((closed.length / nodes.length) * 1000) / 10,
      dependencyClosedFileList: closed,
      dependencyDomains: [...new Set(crossDomainEdges.map((edge) => domainOf(edge.to)))].toSorted(),
      dependentDomains: [
        ...new Set(
          graph.edges
            .filter((edge) => nodeSet.has(edge.to) && application.nodeSet.has(edge.from) && domainOf(edge.from) !== domain)
            .map((edge) => domainOf(edge.from)),
        ),
      ].toSorted(),
      crossDomainEdges,
      blockedFiles: nodes.filter((node) => !closed.includes(node)),
    };
  });
}

interface DomainComponentReport {
  readonly id: number;
  readonly layer: number;
  readonly cyclic: boolean;
  readonly domains: readonly string[];
  readonly files: number;
  readonly lines: number;
  readonly dependencies: readonly number[];
}

/** Condensation of the domain graph: which whole domains are entangled with which. */
function domainComponentReports(domains: readonly DomainReport[], graph: DependencyGraph, application: ApplicationGraph): DomainComponentReport[] {
  const names = domains.map((entry) => entry.domain);
  const domainOf = (path: string): string => graph.nodes.get(path)?.domain ?? "unknown";
  const outgoing = new Map<string, string[]>(names.map((domain) => [domain, []]));
  for (const edge of graph.edges) {
    if (!application.nodeSet.has(edge.from) || !application.nodeSet.has(edge.to)) continue;
    const from = domainOf(edge.from);
    const to = domainOf(edge.to);
    const bucket = outgoing.get(from);
    if (!bucket || from === to || bucket.includes(to)) continue;
    bucket.push(to);
  }

  const components = stronglyConnectedComponents(names, outgoing);
  const byDomain = new Map<string, number>();
  components.forEach((component, id) => component.forEach((domain) => byDomain.set(domain, id)));
  const componentOutgoing = new Map<number, Set<number>>(components.map((_, id) => [id, new Set<number>()]));
  for (const [from, dependencies] of outgoing) {
    for (const to of dependencies) {
      const fromId = byDomain.get(from);
      const toId = byDomain.get(to);
      if (fromId === undefined || toId === undefined || fromId === toId) continue;
      componentOutgoing.get(fromId)!.add(toId);
    }
  }

  const layers = new Map<number, number>();
  const layerFor = (id: number): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    layers.set(id, 0);
    const dependencies = [...(componentOutgoing.get(id) ?? [])];
    const value = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(layerFor));
    layers.set(id, value);
    return value;
  };

  return components
    .map((component, id) => {
      const members = domains.filter((entry) => component.includes(entry.domain));
      return {
        id,
        layer: layerFor(id),
        cyclic: component.length > 1,
        domains: component,
        files: members.reduce((total, entry) => total + entry.files, 0),
        lines: members.reduce((total, entry) => total + entry.lines, 0),
        dependencies: [...(componentOutgoing.get(id) ?? [])].toSorted((left, right) => left - right),
      };
    })
    .toSorted((left, right) => left.layer - right.layer || byCodeUnit(left.domains[0] ?? "", right.domains[0] ?? ""));
}

export interface LayerReport {
  readonly schemaVersion: 1;
  readonly summary: {
    readonly firstPartyFiles: number;
    readonly applicationFiles: number;
    readonly firstPartyEdges: number;
    readonly applicationSccs: number;
    readonly cyclicSccs: number;
    readonly maximumLayer: number;
    readonly dynamicImports: number;
    readonly unresolvedRelativeImports: number;
  };
  readonly ownership: readonly { readonly owner: string; readonly files: number; readonly lines: number }[];
  readonly unresolvedRelativeImports: readonly { readonly source: string; readonly specifier: string }[];
  readonly externalPackages: readonly { readonly name: string; readonly count: number }[];
  readonly domains: readonly DomainReport[];
  readonly domainComponents: readonly DomainComponentReport[];
  readonly components: readonly ComponentReport[];
}

/** The whole read-only report emitted by the layers command. */
export function analyzeLayers(config: MonocarveConfig, graph: DependencyGraph, application?: string): LayerReport {
  const applicationGraph = buildApplicationGraph(graph, application);
  const components = componentReports(config, graph, applicationGraph);
  const domains = domainReports(graph, applicationGraph);
  const owners = [...new Set(graph.paths.map((path) => graph.nodes.get(path)?.owner ?? "unknown"))].toSorted();

  return {
    schemaVersion: 1,
    summary: {
      firstPartyFiles: graph.paths.length,
      applicationFiles: applicationGraph.nodes.length,
      firstPartyEdges: graph.edges.length,
      applicationSccs: applicationGraph.condensed.components.length,
      cyclicSccs: components.filter((component) => component.cyclic).length,
      maximumLayer: Math.max(0, ...components.map((component) => component.layer)),
      dynamicImports: graph.edges.filter((edge) => edge.dynamic).length,
      unresolvedRelativeImports: graph.unresolved.length,
    },
    ownership: owners.map((owner) => {
      const paths = graph.paths.filter((path) => graph.nodes.get(path)?.owner === owner);
      return { owner, files: paths.length, lines: paths.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0) };
    }),
    unresolvedRelativeImports: graph.unresolved,
    externalPackages: [...graph.externalPackages.entries()]
      .map(([name, count]) => ({ name, count }))
      .toSorted((left, right) => right.count - left.count || byCodeUnit(left.name, right.name)),
    domains,
    domainComponents: domainComponentReports(domains, graph, applicationGraph),
    components: components.slice().toSorted((left, right) => left.layer - right.layer || byCodeUnit(left.nodes[0] ?? "", right.nodes[0] ?? "")),
  };
}
