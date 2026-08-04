/** Eligibility checks and advisory warnings for portfolio candidates. */

import { isCompositionRoot, type ComponentReport } from "../graph/layers.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import { scopedPackageName, type MonocarveConfig } from "../config.ts";
import { findConsumers } from "../plan/consumers.ts";
import { inferDependencies } from "../plan/dependencies.ts";
import { WorkspaceContext } from "../plan/context.ts";
import { evaluationClosure } from "../plan/evaluation-closure.ts";
import type { SideEffectsDeclaration } from "../plan/manifest.ts";
import type { PathReferenceIndex } from "../plan/path-references.ts";
import { analyzeContainment, classifyEscapes } from "./containment.ts";
import type { RejectionReason, RewriteEscape } from "./types.ts";

export interface Assessment {
  readonly rejections: RejectionReason[];
  readonly warnings: string[];
  readonly assets: string[];
  readonly rewriteEscapes: RewriteEscape[];
}

export function assessCandidate(
  config: MonocarveConfig,
  context: WorkspaceContext,
  pathReferences: PathReferenceIndex,
  graph: DependencyGraph,
  report: ComponentReport,
  closure: readonly string[],
  closureReports: readonly ComponentReport[],
  owners: readonly string[],
  domains: readonly string[],
  tests: readonly string[],
): Assessment {
  const rejections: RejectionReason[] = [];
  const warnings: string[] = [];
  const closureSet = new Set(closure);

  if (owners.length !== 1) {
    rejections.push({
      code: "multiple-owners",
      detail: `closure spans more than one owner: ${owners.join(", ")}`,
      edges: [],
    });
  }
  if (domains.length !== 1) warnings.push(`closure crosses runtime domains: ${domains.join(", ")}`);

  const unresolved = graph.unresolved.filter((entry) => closureSet.has(entry.source));
  if (unresolved.length > 0) {
    rejections.push({
      code: "unresolved-imports",
      detail: `${unresolved.length} relative import(s) in the closure resolve to nothing`,
      edges: unresolved.map((entry) => `${entry.source} -> ${entry.specifier}`),
    });
  }

  const missingGenerated = closureReports.flatMap((item) =>
    item.generated.filter((entry) => entry.source !== null && !entry.sourceExists).map((entry) => entry.node),
  );
  if (missingGenerated.length > 0) {
    rejections.push({
      code: "generated-source-missing",
      detail: "a generated file in the closure declares a source that no longer exists",
      edges: missingGenerated,
    });
  }

  const compositionRoots = closure.filter((path) => isCompositionRoot(config, path));
  if (compositionRoots.length > 0 || closureReports.some((item) => item.archetype === "composition")) {
    rejections.push({
      code: "composition-root",
      detail: "the closure composes the application at runtime and cannot leave it",
      edges: compositionRoots,
    });
  }

  // A computed reference blocks only a file this candidate would move. An
  // unrelated test/build helper cannot name a known donor through the graph,
  // so rejecting every candidate for its existence turns one local uncertainty
  // into a workspace-wide refusal. Actual retained consumers are checked again
  // by findConsumers once their resolved edges identify them.
  const unsupported = [...closure, ...tests].filter((path) => context.hasUnsupportedReference(path));
  if (unsupported.length > 0) {
    rejections.push({
      code: "unsupported-module-reference",
      detail: "a computed module specifier in first-party source cannot be rewritten deterministically",
      edges: unsupported,
    });
  }

  if (closure.every((path) => path.endsWith(".d.ts"))) {
    rejections.push({ code: "declaration-only", detail: "the closure is declarations only", edges: [] });
  }

  const hasSurface = closure.some((path) => graph.nodes.get(path)?.hasExports === true);
  if (report.inboundNodes.length === 0 && tests.length === 0 && report.testImporterFiles.length === 0 && !hasSurface) {
    rejections.push({
      code: "no-exports",
      detail: "the closure has no exports, no consumers, and no tests",
      edges: [],
    });
  }

  const analysis = analyzeContainment(context, graph, [...closure, ...tests]);
  if (analysis.external.length > 0) {
    rejections.push({
      code: "uninstalled-package",
      detail: `${analysis.external.length} bare specifier(s) resolve to nothing installed`,
      edges: [...analysis.external],
    });
  }
  if (analysis.unmovableAssets.length > 0) {
    rejections.push({
      code: "unmovable-asset",
      detail: `${analysis.unmovableAssets.length} asset(s) live outside every movable root`,
      edges: [...analysis.unmovableAssets],
    });
  }

  const { rewritable, blocking } = classifyEscapes(config, context, graph, analysis.escapes);
  if (blocking.length > 0) {
    rejections.push({
      code: "closure-escapes-app-code",
      detail: `${blocking.length} relative import(s) leave the closure for code no package exports`,
      edges: blocking.map((escape) => `${escape.file} -> ${escape.specifier}`),
    });
  }
  if (rewritable.length > 0) {
    warnings.push(
      `closure escapes rewritable to workspace packages: ${rewritable.length} (first: ${rewritable[0]!.file} -> ${rewritable[0]!.package})`,
    );
  }

  warnings.push(...evaluationWarnings(config, context, graph, closure));
  pathReferenceWarning(warnings, pathReferences, closure, tests, analysis.assets);
  return { rejections, warnings, assets: [...analysis.assets], rewriteEscapes: rewritable };
}

const WARNING_EXAMPLES = 3;
const DECLARATION_RANK: Readonly<Record<SideEffectsDeclaration, number>> = {
  some: 0,
  undeclared: 1,
  unresolved: 2,
  none: 3,
};

function evaluationWarnings(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  closure: readonly string[],
): string[] {
  const evaluation = evaluationClosure({ config, context, graph, seeds: closure });
  const warnings: string[] = [];
  const effectful = evaluation.modules.filter((path) => context.evaluationEffectKinds(path).length > 0);
  const reachedSet = new Set(evaluation.reached);
  const beyond = effectful.filter((path) => reachedSet.has(path));
  if (effectful.length > 0) {
    const detail = beyond.length === 0 ? "" : `, ${beyond.length} of them outside the moved set (first: ${beyond[0]!})`;
    warnings.push(
      `${effectful.length} of ${evaluation.modules.length} module(s) the package entrypoint evaluates do work when ` +
        `evaluated (first: ${effectful[0]!})${detail}; a consumer that deep-imported a subset will evaluate all of it`,
    );
  }
  if (evaluation.packages.length > 0) {
    const ranked = [...evaluation.packages].sort(
      (left, right) => DECLARATION_RANK[left.sideEffects] - DECLARATION_RANK[right.sideEffects] || byCodeUnit(left.name, right.name),
    );
    const shown = ranked.slice(0, WARNING_EXAMPLES);
    const rest = ranked.length - shown.length;
    warnings.push(
      `the evaluation closure reaches ${ranked.length} third-party package(s), which this tool does not read: ` +
        `${shown.map((entry) => `${entry.name} (declares ${entry.sideEffects})`).join(", ")}` +
        `${rest > 0 ? `, +${rest} more` : ""}`,
    );
  }
  if (evaluation.opaqueSpecifiers.length > 0) {
    const shown = evaluation.opaqueSpecifiers.slice(0, WARNING_EXAMPLES);
    const rest = evaluation.opaqueSpecifiers.length - shown.length;
    warnings.push(
      `${evaluation.opaqueSpecifiers.length} workspace-package import(s) in the evaluation closure could not be ` +
        `followed to a file, so what they evaluate is unknown: ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`,
    );
  }
  return warnings;
}

function pathReferenceWarning(
  warnings: string[],
  pathReferences: PathReferenceIndex,
  closure: readonly string[],
  tests: readonly string[],
  assets: readonly string[],
): void {
  const named = pathReferences.referencesTo([...closure, ...tests, ...assets]);
  if (named.length === 0) return;
  const first = named[0]!;
  const files = new Set(named.map((reference) => reference.file)).size;
  warnings.push(
    `${named.length} string literal(s) in ${files} file(s) name a path this closure moves ` +
      `(first: ${first.file}:${first.line} names ${first.target}); ` +
      "a path written as a string is invisible to the import graph, so no plan operation repoints it " +
      "and it stops resolving once the file moves",
  );
}

export function sizeRejections(config: MonocarveConfig, closure: readonly string[]): RejectionReason[] {
  if (closure.length < config.portfolio.minFiles) {
    return [{ code: "too-small", detail: `${closure.length} file(s) is below portfolio.minFiles (${config.portfolio.minFiles})`, edges: [] }];
  }
  if (closure.length > config.portfolio.maxFiles) {
    return [{ code: "too-large", detail: `${closure.length} file(s) is above portfolio.maxFiles (${config.portfolio.maxFiles})`, edges: [] }];
  }
  return [];
}

export function protectedPathRejections(config: MonocarveConfig, movable: readonly string[]): RejectionReason[] {
  const protectedMovable = [...new Set(movable)]
    .filter((path) => config.portfolio.protectedPaths.some((protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`)))
    .sort(byCodeUnit);
  if (protectedMovable.length === 0) return [];
  return [{
    code: "protected-path",
    detail: `${protectedMovable.length} movable path(s) are protected by portfolio.protectedPaths`,
    edges: protectedMovable,
  }];
}

export function planabilityRejections(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  production: readonly string[],
  tests: readonly string[],
  candidateId: string,
): RejectionReason[] {
  const synthetic = scopedPackageName(config, `portfolio-${candidateId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`);
  const reasons: RejectionReason[] = [];
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  try {
    inferDependencies(context, graph, [...production, ...tests], synthetic);
  } catch (error) {
    reasons.push({ code: "unplannable", detail: `dependency inference: ${message(error)}`, edges: [] });
  }
  try {
    findConsumers(context, [...production, ...tests], synthetic);
  } catch (error) {
    reasons.push({ code: "unplannable", detail: `consumer inventory: ${message(error)}`, edges: [] });
  }
  try {
    const targets = [...production, ...tests].map((source) => context.targetRelativePath(source));
    if (new Set(targets).size !== targets.length) {
      reasons.push({ code: "unplannable", detail: "two closure files would land on the same target path", edges: [] });
    }
  } catch (error) {
    reasons.push({ code: "unplannable", detail: message(error), edges: [] });
  }
  return reasons;
}

export function dedupeReasons(reasons: readonly RejectionReason[]): RejectionReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.code}:${reason.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
