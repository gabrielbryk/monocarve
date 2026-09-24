import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import { applyEscapeRewrites } from "../codemod/imports.ts";
import {
  applicationOwner,
  getApplication,
  triggeredArtifacts,
  triggeredPathMigrations,
  triggeredPostJournalPreparers,
  type MonocarveConfig,
} from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { generatedProvenance } from "../graph/workspace.ts";
import { resolveCommit, type ResolvedCommit } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import type { BuildPlanOptions } from "./build.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { scanEmittedModuleSpecifiers } from "./emitted-module-specifiers.ts";
import type {
  EscapeRewrite,
  ExtractionManifest,
  GeneratedFileRecord,
  MigratePathKeysOperation,
  PathMove,
  PlanOperation,
  RewritePathReferenceOperation,
} from "./manifest.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "./path-migrations.ts";
import { documentKindFor, rewritePathReferenceText, scanPathReferenceRewrites, type PathReferenceRewriteMatch } from "./path-reference-rewrites.ts";
import { scanRuntimeModuleRegistry } from "./runtime-module-registries.ts";

export function baselineOf(options: BuildPlanOptions): ResolvedCommit {
  try {
    return resolveCommit(options.rootDir, options.baselineCommit);
  } catch (error) {
    throw new PlanningError(
      `cannot compile a plan against ${JSON.stringify(options.baselineCommit)}: a plan records the commit its blobs came from, so the revision has to exist — ${(error as Error).message}`,
    );
  }
}

export function moveOperation(context: WorkspaceContext, source: string, target: string, rewrites: readonly EscapeRewrite[]): PlanOperation {
  const preconditionHash = context.state(source);
  if (preconditionHash === "missing") throw new PlanningError(`cannot move a file that does not exist: ${source}`);
  if (rewrites.length === 0) return { kind: "move", source, target, preconditionHash, resultHash: preconditionHash };
  const rewritten = applyEscapeRewrites(
    context.text(source),
    context.absolute(source),
    rewrites,
    context.rootDir,
    context.config.moduleSpecifierCalls,
    context.config.assetExtensions,
    context.config.cssImportExtensions,
  );
  return { kind: "move-with-rewrite", source, target, rewrites: [...rewrites], preconditionHash, resultHash: hashText(rewritten) };
}

export function generatedFilesFor(
  config: MonocarveConfig,
  context: WorkspaceContext,
  production: readonly string[],
  targets: readonly string[],
  documents: readonly string[] = [],
): GeneratedFileRecord[] {
  const declared = production.flatMap((source, index): GeneratedFileRecord[] => {
    const provenance = generatedProvenance(config, context.rootDir, source);
    if (provenance === null) return [];
    if (provenance.source === null) {
      throw new PlanningError(`generated source header is missing source provenance (Source: or Source of truth:): ${source}`);
    }
    if (provenance.regenerate === null) {
      throw new PlanningError(`generated source header is missing regeneration provenance (Regenerate:): ${source}`);
    }
    const state = context.state(source);
    return [{ path: targets[index]!, source: provenance.source, regenerate: provenance.regenerate, ...(state === "missing" ? {} : { expectedHash: state }) }];
  });
  const triggered = triggeredArtifacts(config, production).map((artifact): GeneratedFileRecord => ({
    path: artifact.path,
    source: artifact.source,
    regenerate: artifact.regenerate,
    regenerateOnApply: true,
    exemptReason:
      artifact.exemptReason ?? "declared generated artifact: this extraction changes its inputs, so its post-move content is not knowable at plan time",
  }));
  // A preparer's trigger is a regex over "what changed", and a rewritten
  // document is a change just as much as a moved production file is — a
  // skills catalogue preparer that only watches source paths would never
  // notice that the doc citing those skills was itself edited. `documents`
  // defaults to empty so every existing config (which never passes it) keeps
  // testing triggers against `production` alone, byte-for-byte the old result.
  const triggerPaths = [...production, ...documents];
  const postJournal = triggeredPostJournalPreparers(config, triggerPaths).flatMap((preparer) => {
    const command = preparer.command;
    return command === undefined
      ? []
      : preparer.outputs
          .filter((path) => !(preparer.replacements ?? []).some((replacement) => replacement.path === path))
          .map((path): GeneratedFileRecord => ({
            path,
            source: targets[0] ?? path,
            regenerate: command,
            regenerateOnApply: true,
            exemptReason: "declared post-journal preparer output: result is proven by simulation and immediate audit",
            preparerId: preparer.id,
            ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
          }));
  });
  return [...declared, ...triggered, ...postJournal].toSorted((left, right) => byCodeUnit(left.path, right.path));
}

export function pathMigrationOperations(
  config: MonocarveConfig,
  context: WorkspaceContext,
  operations: readonly PlanOperation[],
  onNoop?: (proof: { path: string; command: string; moves: readonly PathMove[]; artifactHash: Sha256 }) => void,
): MigratePathKeysOperation[] {
  const moves: PathMove[] = operations
    .filter((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite")
    .map((operation) => ({ source: operation.source, target: operation.target }))
    .toSorted((left, right) => byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target));
  return triggeredPathMigrations(
    config,
    moves.map((move) => move.source),
  )
    .flatMap((artifact): MigratePathKeysOperation[] => {
      const preconditionHash = context.state(artifact.path);
      if (preconditionHash === "missing") throw new PlanningError(`path-keyed artifact does not exist: ${artifact.path}`);
      const contents = readUtf8Artifact(context.absolute(artifact.path), artifact.path);
      const shape = { path: artifact.path, command: artifact.command, moves };
      const resultHash = hashText(runPathMigrationCommand(context.rootDir, shape, contents, config.pathMigrations.timeoutMs));
      if (resultHash === preconditionHash) {
        onNoop?.({ ...shape, artifactHash: preconditionHash });
        return [];
      }
      return [{ kind: "migrate-path-keys", ...shape, preconditionHash, resultHash }];
    })
    .toSorted((left, right) => byCodeUnit(left.path, right.path));
}

/**
 * Its own walker, not `sourceFiles()` or `path-references.ts`'s private
 * `textFiles`: this one must skip symlinked directories (`Dirent.isDirectory()`
 * is false for a symlink, so simply not recursing into it keeps the walk
 * inside the workspace) and must not import a sibling module's unexported
 * helper across a file boundary. Same shape, deliberately duplicated.
 */
function pathReferenceRewriteFiles(directory: string, extensions: readonly string[]): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return pathReferenceRewriteFiles(path, extensions);
    return extensions.includes(extname(entry.name)) ? [path] : [];
  });
}

export function pathReferenceRewriteOperations(
  config: MonocarveConfig,
  context: WorkspaceContext,
  operations: readonly PlanOperation[],
): RewritePathReferenceOperation[] {
  const settings = config.pathReferenceRewrites;
  if ((!settings.enabled || settings.roots.length === 0) && config.runtimeModuleRegistries.length === 0) return [];

  const moves: PathMove[] = operations
    .filter((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite")
    .map((operation) => ({ source: operation.source, target: operation.target }))
    .toSorted((left, right) => byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target));
  if (moves.length === 0) return [];

  const scanSettings = { onAmbiguousMatch: settings.onAmbiguousMatch, matchExtensionless: settings.matchExtensionless, minSegments: settings.minSegments };
  const byFile = new Map<string, { readonly text: string; readonly rewrites: PathReferenceRewriteMatch[] }>();
  for (const scanRoot of settings.enabled ? settings.roots : []) {
    for (const absolute of pathReferenceRewriteFiles(resolve(context.rootDir, scanRoot.root), scanRoot.extensions).sort()) {
      if ((statSync(absolute, { throwIfNoEntry: false })?.size ?? 0) > settings.maxBytes) continue;
      const file = context.relative(absolute);
      const preconditionHash = context.state(file);
      if (preconditionHash === "missing") throw new PlanningError(`path-reference document does not exist: ${file}`);
      const text = context.text(file);
      const scan = scanPathReferenceRewrites(text, file, moves, {
        ...scanSettings,
        workspaceRoot: context.rootDir,
        ...(scanRoot.referenceBase === undefined ? {} : { referenceBase: scanRoot.referenceBase }),
      });
      if (scan.rewrites.length === 0) continue;
      byFile.set(file, { text, rewrites: [...(byFile.get(file)?.rewrites ?? []), ...scan.rewrites] });
    }
  }
  for (const registry of config.runtimeModuleRegistries) {
    const text = context.text(registry.file);
    const rewrites = scanRuntimeModuleRegistry(
      text,
      {
        file: registry.file,
        pointer: registry.pointer,
        resolveFrom: registry.resolveFrom,
        ...(registry.stripPrefix === undefined ? {} : { stripPrefix: registry.stripPrefix }),
      },
      moves,
    );
    if (rewrites.length > 0) byFile.set(registry.file, { text, rewrites: [...(byFile.get(registry.file)?.rewrites ?? []), ...rewrites] });
  }
  const changedPaths = [...moves.map((move) => move.source), ...byFile.keys()];
  for (const preparer of triggeredPostJournalPreparers(config, changedPaths)) {
    for (const declaration of preparer.emittedModuleSpecifiers) {
      const text = context.text(declaration.source);
      const rewrites = scanEmittedModuleSpecifiers(text, declaration, moves);
      if (rewrites.length > 0) byFile.set(declaration.source, { text, rewrites: [...(byFile.get(declaration.source)?.rewrites ?? []), ...rewrites] });
    }
  }
  return [...byFile.entries()]
    .map(([file, entry]) => {
      const rewrites = [...entry.rewrites].toSorted(
        (left, right) => left.line - right.line || left.column - right.column || byCodeUnit(left.donor, right.donor),
      );
      const positions = new Set<string>();
      for (const rewrite of rewrites) {
        const position = `${rewrite.line}:${rewrite.column}`;
        if (positions.has(position))
          throw new PlanningError(`ambiguous path reference in ${file}:${position} — multiple configured resolution bases match the same token`);
        positions.add(position);
      }
      const preconditionHash = context.state(file);
      const resultHash = hashText(rewritePathReferenceText(entry.text, rewrites));
      if (resultHash === preconditionHash) throw new PlanningError(`path reference rewrite for ${file} did not change the document`);
      return {
        kind: "rewrite-path-reference" as const,
        file,
        documentKind: documentKindFor(file),
        rewrites: rewrites.map(({ span: _span, ...rewrite }) => rewrite),
        preconditionHash,
        resultHash,
      };
    })
    .toSorted((left, right) => byCodeUnit(left.file, right.file));
}

export function graphDigest(graph: DependencyGraph): Sha256 {
  return hashJson({
    nodes: graph.paths,
    edges: graph.edges.map((edge) => [edge.from, edge.to, edge.specifier, edge.kind]),
    unresolved: graph.unresolved.map((entry) => [entry.source, entry.specifier]),
    testKinds: [...graph.testKinds.entries()].toSorted(([left], [right]) => byCodeUnit(left, right)),
    testImporters: [...graph.testImporters.entries()]
      .map(([target, importers]) => ({ target, importers: [...importers].toSorted(byCodeUnit) }))
      .toSorted((left, right) => byCodeUnit(left.target, right.target)),
  });
}

interface GateVars extends Record<string, unknown> {
  readonly package: string;
  readonly packageRoot: string;
  readonly app: string;
  readonly project: string;
  readonly consumerOwners: readonly string[];
  readonly taskRunner: { projectIdOf(rootDir: string, packageRoot: string): string };
  readonly rootDir: string;
}
export function renderGates(config: MonocarveConfig, gates: MonocarveConfig["gates"], vars: GateVars): ExtractionManifest["gates"] {
  const base = {
    package: vars.package,
    packageRoot: vars.packageRoot,
    app: vars.app,
    owner: applicationOwner(getApplication(config, vars.app)),
    project: vars.project,
  };
  const project = vars.consumerOwners.flatMap((owner) =>
    gates.project.map((template) =>
      renderTemplate(template, { ...base, app: applicationNameForOwner(config, owner), owner, project: vars.taskRunner.projectIdOf(vars.rootDir, owner) }),
    ),
  );
  return {
    package: gates.package.map((template) => renderTemplate(template, base)),
    project: [...new Set(project)],
    workspace: gates.workspace.map((template) => renderTemplate(template, base)),
  };
}
function applicationNameForOwner(config: MonocarveConfig, owner: string): string {
  return config.applications.find((app) => applicationOwner(app) === owner)?.name ?? owner;
}
export function derivePackageRoot(config: MonocarveConfig, graph: DependencyGraph, packageName: string): string {
  const existing = graph.workspace.packageNames.get(packageName);
  if (existing) return existing;
  const bare = config.packageScope && packageName.startsWith(config.packageScope) ? packageName.slice(config.packageScope.length) : packageName;
  return `${config.packageRoots[0]}/${bare}`;
}
