import { rewriteResolvedImportSpecifier } from "../codemod/imports.ts";
import { evaluationEffectKinds, type EvaluationEffectKind } from "../codemod/side-effects.ts";
import { isAssetPath, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { consumerApplications, findConsumers, partitionTests, type Consumer } from "./consumers.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { evaluationClosure } from "./evaluation-closure.ts";
import type {
  EscapeRewrite,
  EvaluationEffectRecord,
  EvaluationModuleRecord,
  EvaluationPackageRecord,
  EvaluationReach,
  FsReferenceRewrite,
  PlanOperation,
  PublicModule,
  SideEffectsDeclaration,
} from "./manifest.ts";
import { renderPublicModulePaths } from "./public-modules.ts";
import { sourceExportsFromFile } from "./public-surface.ts";
import { findStaticFsReferences, relativeFsLiteral, rewriteStaticFsReference } from "./static-fs-references.ts";

export interface SourceSelection {
  readonly production: string[];
  readonly assets: string[];
  readonly tests: string[];
  readonly sources: string[];
  readonly targets: string[];
  readonly assetTargets: string[];
  readonly entrypointPath: string;
  readonly publicModules: PublicModule[];
  readonly publicSpecifierFor: ReadonlyMap<string, string>;
}

export function selectExtractionSources(args: {
  readonly context: WorkspaceContext;
  readonly candidate: PortfolioCandidate;
  readonly packageRoot: string;
  readonly entrypoint: string;
  readonly packageName: string;
  readonly publicSurface: MonocarveConfig["scaffoldTemplates"]["publicSurface"];
  readonly targetModule?: string;
}): SourceSelection {
  const production = withAmbientAugmentations(
    args.context,
    args.candidate.files.filter((path) => args.context.isProductionSource(path)),
  );
  const assets = [...args.candidate.assets].sort();
  const partition = partitionTests(args.context, production, [...args.candidate.tests].sort(), assets);
  const tests = [...partition.travelling];
  const sources = [...production, ...tests];
  const targetOf = (source: string): string => `${args.packageRoot}/src/${args.context.targetRelativePath(source)}`;
  const entrypointPath = `${args.packageRoot}/${args.entrypoint}`;
  const directEntrypointPromotion = args.targetModule === "index" && production.length === 1;
  const targets = sources.map((source, index) => directEntrypointPromotion && index === 0 ? entrypointPath : targetOf(source));
  const assetTargets = assets.map(targetOf);
  const allTargets = [...targets, ...assetTargets];
  if (new Set(allTargets).size !== allTargets.length) {
    throw new PlanningError("two selected files would land on the same target path");
  }
  if (!directEntrypointPromotion && allTargets.includes(entrypointPath)) {
    throw new PlanningError(`barrel self-import: a moved file would land on the generated entrypoint ${entrypointPath}`);
  }
  const moduleSources = [...production, ...assets];
  const moduleTargets = [...targets.slice(0, production.length), ...assetTargets];
  const rendered = renderPublicModulePaths(
    args.publicSurface,
    moduleSources.map((source) => args.context.targetRelativePath(source)),
  );
  const publicModules = rendered.map(({ exportKey, exportTarget }, index) => ({
    source: moduleSources[index]!,
    target: moduleTargets[index]!,
    specifier: `${args.packageName}/${exportKey.slice(2)}`,
    exportKey,
    exportTarget,
    requiredExports: index < production.length ? sourceExportsFromFile(args.context.absolute(moduleSources[index]!), moduleSources[index]!) : [],
  }));
  if (args.targetModule !== undefined) {
    if (production.length !== 1) throw new PlanningError("a module promotion must select exactly one production module");
    const promoted = publicModules.find((item) => item.source === production[0]) ?? {
      source: production[0]!,
      target: targets[0]!,
      specifier: args.packageName,
      exportKey: ".",
      exportTarget: `./${args.entrypoint}`,
      requiredExports: sourceExportsFromFile(args.context.absolute(production[0]!), production[0]!),
    };
    const key = args.targetModule === "index" ? "." : `./${args.targetModule.replace(/^\.\//, "")}`;
    const promotedModule = {
      ...promoted,
      target: args.targetModule === "index" ? entrypointPath : promoted.target,
      specifier: key === "." ? args.packageName : `${args.packageName}/${key.slice(2)}`,
      exportKey: key,
      exportTarget: key === "." ? `./${args.entrypoint}` : promoted.exportTarget,
    };
    const promotedIndex = publicModules.findIndex((item) => item.source === production[0]);
    if (promotedIndex < 0) publicModules.unshift(promotedModule);
    else publicModules[promotedIndex] = promotedModule;
  }
  return {
    production, assets, tests, sources, targets, assetTargets, entrypointPath, publicModules,
    publicSpecifierFor: new Map(publicModules.map((entry) => [entry.source, entry.specifier])),
  };
}

/** Carry repository-owned module augmentations whose declarations are global
 * to an imported third-party package. TypeScript does not expose these as
 * runtime/module edges, but an extracted source can depend on them for its
 * public typecheck contract. */
function withAmbientAugmentations(context: WorkspaceContext, selected: readonly string[]): string[] {
  const packages = new Set(selected.flatMap((source) => context.moduleReferences(source)
    .map((reference) => reference.specifier)
    .filter((specifier): specifier is string => specifier !== null && !specifier.startsWith("."))
    .map((specifier) => context.packageNameOf(specifier))));
  if (packages.size === 0) return [...selected].sort();
  const augmentations = context.repositorySources().filter((path) => {
    if (selected.includes(path) || !context.isProductionSource(path)) return false;
    const text = context.text(path);
    return [...text.matchAll(/declare\s+module\s+["']([^"']+)["']/gu)].some((match) => packages.has(match[1]!));
  });
  return [...new Set([...selected, ...augmentations])].sort();
}

export function escapeRewritesFor(candidate: PortfolioCandidate): Map<string, EscapeRewrite[]> {
  const rewrites = new Map<string, EscapeRewrite[]>();
  for (const escape of candidate.rewriteEscapes) {
    const entries = rewrites.get(escape.file) ?? [];
    entries.push({ donorlessSpecifier: escape.specifier, packageSpecifier: escape.package });
    rewrites.set(escape.file, entries);
  }
  return rewrites;
}

export function appendConsumerOperations(args: {
  readonly context: WorkspaceContext;
  readonly sources: readonly string[];
  readonly packageName: string;
  readonly publicSpecifierFor: ReadonlyMap<string, string>;
  readonly operations: PlanOperation[];
  readonly excludedFiles?: ReadonlySet<string>;
  readonly includeDonorFiles?: boolean;
}): { readonly consumers: Consumer[]; readonly dynamicImportDelta: { readonly added: string[]; readonly removed: string[] } } {
  const consumers = findConsumers(args.context, args.sources, args.packageName, args.publicSpecifierFor, args.includeDonorFiles)
    .filter((consumer) => !args.excludedFiles?.has(consumer.file))
    .map((consumer) => args.context.isTest(consumer.file) ? { ...consumer, dependencySection: "dev" as const } : consumer);
  for (const consumer of consumers) for (const donor of consumer.donors) {
    if (isAssetPath(args.context.config, donor) && !args.publicSpecifierFor.has(donor)) {
      throw new PlanningError(`retained asset consumer ${consumer.file} requires a configured public subpath for ${donor}`);
    }
  }
  const dynamicImportDelta = { added: [] as string[], removed: [] as string[] };
  for (const consumer of consumers) {
    appendDynamicImportDelta(args.context, consumer, args.packageName, args.publicSpecifierFor, dynamicImportDelta);
    const next = rewriteConsumer(args.context, consumer, args.packageName, args.publicSpecifierFor);
    args.operations.push({
      kind: "rewrite-import", file: consumer.file, donors: [...consumer.donors], rewrites: consumer.rewrites,
      preconditionHash: args.context.state(consumer.file), resultHash: hashText(next),
    });
  }
  return { consumers, dynamicImportDelta };
}

export interface StaticFsConsumer {
  readonly file: string;
  readonly rewrites: readonly FsReferenceRewrite[];
}

/**
 * Consumers the import graph cannot see: files that name a moved source by a
 * statically resolvable filesystem literal (see `static-fs-references.ts`)
 * rather than by importing it.
 *
 * Scoped to files outside the moved set, mirroring `findConsumers` — a moved
 * file that itself reads another moved file by static literal is not covered
 * here; its own bytes are `move`d as-is, and no operation revisits them.
 */
export function appendStaticFsReferenceOperations(args: {
  readonly context: WorkspaceContext;
  readonly donorTargets: ReadonlyMap<string, string>;
  readonly operations: PlanOperation[];
  readonly excludedFiles?: ReadonlySet<string>;
}): { readonly consumers: StaticFsConsumer[] } {
  const consumers: StaticFsConsumer[] = [];
  for (const file of args.context.repositorySources()) {
    if (args.donorTargets.has(file)) continue;
    if (args.excludedFiles?.has(file)) continue;
    const rewrites = staticFsRewritesFor(args.context, file, args.donorTargets);
    if (rewrites.length === 0) continue;
    consumers.push({ file, rewrites });
    const current = args.context.text(file);
    const next = rewrites.reduce(
      (text, rewrite) => rewriteStaticFsReference(text, args.context.absolute(file), args.context.absolute(rewrite.donor), rewrite.to),
      current,
    );
    args.operations.push({
      kind: "rewrite-fs-reference",
      file,
      rewrites,
      preconditionHash: args.context.state(file),
      resultHash: hashText(next),
    });
  }
  return { consumers };
}

function staticFsRewritesFor(
  context: WorkspaceContext,
  file: string,
  donorTargets: ReadonlyMap<string, string>,
): FsReferenceRewrite[] {
  const rewrites = new Map<string, FsReferenceRewrite>();
  for (const match of findStaticFsReferences(context.text(file), context.absolute(file))) {
    let donor: string;
    try {
      donor = context.relative(match.resolvedAbsolute);
    } catch {
      continue;
    }
    const target = donorTargets.get(donor);
    if (target === undefined) continue;
    const to = relativeFsLiteral(file, target);
    if (to === match.literal) continue;
    rewrites.set(JSON.stringify([match.literal, donor]), { from: match.literal, to, donor });
  }
  return [...rewrites.values()];
}

function appendDynamicImportDelta(
  context: WorkspaceContext,
  consumer: Consumer,
  packageName: string,
  publicSpecifierFor: ReadonlyMap<string, string>,
  delta: { added: string[]; removed: string[] },
): void {
  const references = context.moduleReferences(consumer.file)
    .filter((reference) => reference.dynamic && reference.specifier !== null && reference.resolved !== null)
    .filter((reference) => consumer.donors.some((donor) => context.absolute(donor) === reference.resolved));
  for (const reference of references) {
    delta.removed.push(reference.specifier!);
    const donor = consumer.donors.find((entry) => context.absolute(entry) === reference.resolved);
    delta.added.push(donor === undefined ? packageName : (publicSpecifierFor.get(donor) ?? packageName));
  }
}

function rewriteConsumer(
  context: WorkspaceContext,
  consumer: Consumer,
  packageName: string,
  publicSpecifierFor: ReadonlyMap<string, string>,
): string {
  const current = context.text(consumer.file);
  const next = consumer.donors.reduce(
    (value, donor) => rewriteResolvedImportSpecifier(
      value, context.absolute(consumer.file), context.absolute(donor), publicSpecifierFor.get(donor) ?? packageName, context.rootDir,
      context.config.moduleSpecifierCalls, context.config.assetExtensions, context.config.cssImportExtensions,
    ), current,
  );
  if (next === current) throw new PlanningError(`consumer ${consumer.file} would not change when repointed at ${packageName}`);
  return next;
}

export function evaluationEffectsFor(args: {
  readonly config: MonocarveConfig;
  readonly context: WorkspaceContext;
  readonly graph: DependencyGraph;
  readonly production: readonly string[];
  readonly targets: readonly string[];
  readonly rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>;
  readonly packageWiring: readonly PlanOperation[];
  readonly entrypointPath: string;
}): EvaluationEffectRecord[] {
  const entrypoint = args.packageWiring.find(
    (operation): operation is Extract<PlanOperation, { kind: "write-file" }> => operation.kind === "write-file" && operation.path === args.entrypointPath,
  );
  const closure = evaluationClosure({ config: args.config, context: args.context, graph: args.graph, seeds: args.production, rewrites: args.rewrites });
  return evaluationInventory([
    ...args.production.map((source, index) => ({ subject: "module" as const, reach: "moved" as const, path: args.targets[index]!, kinds: args.context.evaluationEffectKinds(source) })),
    ...(entrypoint ? [{ subject: "module" as const, reach: "generated" as const, path: entrypoint.path, kinds: evaluationEffectKinds(entrypoint.contents, entrypoint.path) }] : []),
    ...closure.reached.map((path) => ({ subject: "module" as const, reach: "reached" as const, path, kinds: args.context.evaluationEffectKinds(path) })),
    ...closure.packages.map((entry) => ({ subject: "package" as const, name: entry.name, sideEffects: entry.sideEffects })),
  ]);
}

function evaluationInventory(entries: readonly (
  | { readonly subject: "module"; readonly reach: EvaluationReach; readonly path: string; readonly kinds: readonly EvaluationEffectKind[] }
  | { readonly subject: "package"; readonly name: string; readonly sideEffects: SideEffectsDeclaration }
)[]): EvaluationEffectRecord[] {
  const modules = entries.flatMap((entry): EvaluationModuleRecord[] => entry.subject === "module" && entry.kinds.length > 0
    ? [{ subject: "module", reach: entry.reach, path: entry.path, kinds: [...new Set(entry.kinds)].sort(byCodeUnit) }] : [])
    .sort((left, right) => byCodeUnit(left.path, right.path));
  const packages = entries.flatMap((entry): EvaluationPackageRecord[] => entry.subject === "package"
    ? [{ subject: "package", name: entry.name, sideEffects: entry.sideEffects }] : [])
    .sort((left, right) => byCodeUnit(left.name, right.name));
  return [...modules, ...packages];
}

export { consumerApplications };
