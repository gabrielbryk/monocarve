/**
 * `compileBoundaryPreparationManifest` and its private helpers, split out of
 * `build.ts` purely to keep that file under the line-count gate: this module
 * owns nothing about the ordinary declaration-seam preparation path — only
 * compiling one declared `compositionBoundaries`/`portPromotions` entry
 * (`resolveBoundaries` output) into a replayable preparation manifest.
 * `build.ts` still owns `compilePreparationManifest`, `PreparationManifestRendering`,
 * and `baselineFileMode`, which this module borrows for boundary compilation.
 */
import { readdirSync, statSync } from "node:fs";
import { extname, posix, relative, resolve } from "node:path";

import ts from "typescript";

import { GENERATOR } from "../branding.ts";
import { triggeredArtifacts, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { PlanningError } from "../plan/context.ts";
import { rewritePathReferenceText, scanPathReferenceRewrites } from "../plan/path-reference-rewrites.ts";
import { resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, type FileState, type Sha256 } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import type { TemplateVars } from "../util/template.ts";
import { planExistingPackageBoundary, type RetainedImporterInput } from "./boundary-imports.ts";
import { planPortBoundary, type PortConsumerInput } from "./boundary-port.ts";
import { resolveBoundaries, type ResolvedBoundary } from "./boundary-resolve.ts";
import { createPreparationManifest, assertPreparationManifestValid, preparationOperationPaths } from "./manifest.ts";
import type { PreparationManifest, PreparationReplayOperation } from "./manifest-types.ts";
import { preparationPostJournalRecords } from "./post-journal.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";
import { baselineFileMode, type PreparationManifestRendering } from "./build.ts";

export interface CompileBoundaryPreparationManifestInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  /** A revision, resolved atomically to the manifest baseline. */
  readonly baselineCommit: string;
  readonly graphDigest: Sha256;
  /** Which declared `compositionBoundaries`/`portPromotions` entry to compile. */
  readonly boundaryId: string;
  /**
   * A dependency graph freshly scanned at `baselineCommit`. Every baseline
   * importer of the retained module is derived from `graph.incoming` — never
   * from a hand-assembled list — because a caller-supplied importer set has
   * no way to prove it is exhaustive. An importer this graph does not report
   * cannot be rewritten, and (for `retire`) cannot be proven gone; both are
   * refusals, not best-effort gaps. The graph's own `commit` must equal
   * `baselineCommit`, or compilation refuses outright: a stale graph is
   * exactly the incomplete evidence this exists to rule out.
   */
  readonly graph: DependencyGraph;
  /** Config/caller-owned rendered values, recorded verbatim in the manifest. */
  readonly rendering: PreparationManifestRendering;
  /** "port" strategy only: explicit, caller-chosen destination for the promoted contract module. */
  readonly contractTargetPath?: string;
  /** "port" strategy only, when the boundary declares an appAdapter: reviewed template body. */
  readonly adapterTemplateText?: string;
  readonly templateVars?: TemplateVars;
  readonly moduleSpecifierCalls?: readonly string[];
  readonly resolutionExtensions?: readonly string[];
  readonly cssImportExtensions?: readonly string[];
}

/** Compile one declared boundary-preparation plan from config and a fresh graph.
 *
 * `compositionBoundaries` and `portPromotions` are normalized once by
 * `resolveBoundaries`, then routed to the matching builder
 * (`planExistingPackageBoundary` / `planPortBoundary`); both builders already
 * discharge their own proofs (`boundary-proofs.ts`) before returning an
 * operation set, so this function's own job is baseline resolution, importer
 * discovery, operation assembly, and the same policy/identity rendering every
 * preparation plan carries.
 */
export function compileBoundaryPreparationManifest(input: CompileBoundaryPreparationManifestInput): PreparationManifest {
  const boundary = resolveBoundaries({
    compositionBoundaries: input.config.compositionBoundaries,
    portPromotions: input.config.portPromotions,
  }).find((item) => item.id === input.boundaryId);
  if (!boundary) throw new PlanningError(`unknown boundary id ${input.boundaryId}`);
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  if (input.graph.commit !== baseline.commit) {
    throw new PlanningError(`boundary ${boundary.id} importer graph was scanned at ${input.graph.commit ?? "an unknown commit"}, but the preparation baseline is ${baseline.commit}; rescan before compiling`);
  }
  const retainedText = showBaseline(input.rootDir, baseline.commit, boundary.retained);
  if (retainedText === null) throw new PlanningError(`boundary retained module is absent from baseline: ${boundary.retained}`);
  const retainedMode = baselineFileMode(input.rootDir, baseline.commit, boundary.retained);
  const compilerOptions = preparationCompilerOptions(input.rootDir, input.config, boundary.retained);
  if (boundary.strategy === "existing-package" && boundary.retire && !input.graph.nodes.has(boundary.retained)) {
    // The graph carries no evidence at all for the retained path (it never
    // resolved a node there), so it cannot prove the shim has zero
    // importers. Retirement fails closed rather than trusting an absence of
    // evidence as evidence of absence.
    throw new PlanningError(`boundary ${boundary.id} declares retire, but the importer graph has no evidence for ${boundary.retained}; refusing to delete without graph proof`);
  }
  const importerPaths = [...new Set([
    ...(input.graph.incoming.get(boundary.retained) ?? []),
    ...(input.graph.testImporters.get(boundary.retained) ?? []),
  ])].sort(byCodeUnit);
  const bindings = importerPaths.map((path) => resolveBoundaryImporter(
    input.rootDir,
    baseline.commit,
    compilerOptions,
    path,
    boundary.retained,
    input.moduleSpecifierCalls ?? input.config.moduleSpecifierCalls,
  ));
  const boundaryOperations = boundary.strategy === "existing-package"
    ? planExistingPackageOperations(input, boundary, retainedText, retainedMode, bindings)
    : planPortOperations(input, boundary, baseline.commit, retainedText, compilerOptions, bindings);
  const referenceOperations = boundary.strategy === "existing-package" && boundary.retire
    ? planRetiredBoundaryPathReferences(input, boundary, baseline.commit, compilerOptions)
    : [];
  const operations = [...boundaryOperations, ...referenceOperations];
  const ordered = [...operations].sort(boundaryOperationOrder);
  const operationPaths = [...new Set(ordered.flatMap(preparationOperationPaths))].sort(byCodeUnit);
  const generatedArtifacts = triggeredArtifacts(input.config, operationPaths)
    .map((artifact) => ({ path: artifact.path, source: artifact.source, regenerate: artifact.regenerate }))
    .sort((left, right) => byCodeUnit(left.path, right.path));
  const postJournalPreparers = preparationPostJournalRecords(input.config, operationPaths);
  const changedFiles = [...new Set([...operationPaths, ...generatedArtifacts.map((item) => item.path), ...postJournalPreparers.flatMap((item) => item.outputs)])].sort(byCodeUnit);
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: hashJson(input.config) },
    graphDigest: input.graphDigest,
    // Neither boundary strategy selects a physical type declaration group:
    // "existing-package" only rewrites specifiers, and "port" copies a
    // declaration's bytes into a write-file contract without touching the
    // donor. There is nothing here for the type-only declarations ledger to
    // own.
    declarations: [],
    operations: ordered,
    generatedArtifacts,
    postJournalPreparers,
    compatibilityReexports: [],
    changedFiles,
    commits: { prepare: input.rendering.commit },
    gates: {
      package: [...input.rendering.gates.package].sort(byCodeUnit),
      project: [...input.rendering.gates.project].sort(byCodeUnit),
      workspace: [...input.rendering.gates.workspace].sort(byCodeUnit),
    },
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

function planRetiredBoundaryPathReferences(
  input: CompileBoundaryPreparationManifestInput,
  boundary: Extract<ResolvedBoundary, { strategy: "existing-package" }>,
  baselineCommit: string,
  compilerOptions: ts.CompilerOptions,
): PreparationReplayOperation[] {
  const settings = input.config.pathReferenceRewrites;
  if (!settings.enabled || settings.roots.length === 0) return [];
  const resolved = ts.resolveModuleName(
    boundary.replacementSpecifier,
    resolve(input.rootDir, boundary.retained),
    compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) throw new PlanningError(`boundary ${boundary.id} replacement ${boundary.replacementSpecifier} does not resolve to a workspace path`);
  const target = relative(input.rootDir, resolved).replaceAll("\\", "/");
  const moves = [{ source: boundary.retained, target }];
  const scanSettings = {
    onAmbiguousMatch: settings.onAmbiguousMatch,
    matchExtensionless: settings.matchExtensionless,
    minSegments: settings.minSegments,
  };
  const operations: PreparationReplayOperation[] = [];
  for (const root of settings.roots) {
    for (const absolute of boundaryReferenceFiles(resolve(input.rootDir, root.root), root.extensions).sort()) {
      if ((statSync(absolute, { throwIfNoEntry: false })?.size ?? 0) > settings.maxBytes) continue;
      const path = relative(input.rootDir, absolute).replaceAll("\\", "/");
      const text = showBaseline(input.rootDir, baselineCommit, path);
      if (text === null) continue;
      const scan = scanPathReferenceRewrites(text, path, moves, scanSettings);
      if (scan.rewrites.length === 0) continue;
      const contents = rewritePathReferenceText(text, scan.rewrites);
      operations.push({
        kind: "write-file",
        purpose: "wiring",
        file: {
          path,
          preconditionHash: hashText(text),
          preconditionMode: baselineFileMode(input.rootDir, baselineCommit, path),
          resultHash: hashText(contents),
          resultMode: baselineFileMode(input.rootDir, baselineCommit, path),
        },
        contents,
      });
    }
  }
  return operations;
}

function boundaryReferenceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return boundaryReferenceFiles(path, extensions);
    return extensions.includes(extname(entry.name)) ? [path] : [];
  });
}

interface BoundaryImporterBinding {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly mode: number;
  readonly text: string;
  readonly specifier: string;
  readonly importedSymbols: readonly string[];
  readonly moduleSpecifierCall?: string;
}

function planExistingPackageOperations(
  input: CompileBoundaryPreparationManifestInput,
  boundary: Extract<ResolvedBoundary, { strategy: "existing-package" }>,
  retainedText: string,
  retainedMode: number,
  bindings: readonly BoundaryImporterBinding[],
): readonly PreparationReplayOperation[] {
  const selectedBindings = boundary.selective
    ? bindings.filter((binding) => binding.importedSymbols.length > 0 && binding.importedSymbols.every((symbol) => boundary.replacementSymbols.includes(symbol)))
    : bindings;
  if (boundary.selective && selectedBindings.length === 0) throw new PlanningError(`selective boundary ${boundary.id} found no fully-covered importers`);
  const importers: RetainedImporterInput[] = selectedBindings.map((binding) => ({
    path: binding.path,
    preconditionHash: binding.preconditionHash,
    mode: binding.mode,
    text: binding.text,
    specifier: binding.specifier,
    importedSymbols: binding.importedSymbols,
    ...(binding.moduleSpecifierCall === undefined ? {} : { moduleSpecifierCall: binding.moduleSpecifierCall }),
  }));
  const result = planExistingPackageBoundary({
    rootDir: input.rootDir,
    boundary,
    retainedPrecondition: hashText(retainedText),
    retainedMode,
    importers,
    moduleSpecifierCalls: input.moduleSpecifierCalls ?? input.config.moduleSpecifierCalls,
    resolutionExtensions: input.resolutionExtensions ?? input.config.assetExtensions,
    cssImportExtensions: input.cssImportExtensions ?? input.config.cssImportExtensions,
  });
  if (result.deletion !== undefined) assertDeletionCoversGraphImporters(boundary, result.deletion, bindings);
  return result.deletion === undefined ? result.rewrites : [...result.rewrites, result.deletion];
}

/**
 * Re-derived proof, independent of `planExistingPackageBoundary`'s own
 * bookkeeping, that the deletion's importer proof is exactly the graph's
 * importer set for the retained module — not a subset of it. This is what
 * turns "the caller says every importer was rewritten" into "the graph, at
 * this exact baseline, agrees no importer was left out."
 */
function assertDeletionCoversGraphImporters(
  boundary: Extract<ResolvedBoundary, { strategy: "existing-package" }>,
  deletion: { readonly importerProof: readonly string[] },
  bindings: readonly BoundaryImporterBinding[],
): void {
  const graphImporters = new Set(bindings.map((binding) => binding.path));
  const proven = new Set(deletion.importerProof);
  if (proven.size !== graphImporters.size || [...graphImporters].some((path) => !proven.has(path))) {
    throw new PlanningError(`boundary ${boundary.id} retirement proof does not cover every graph-reported importer of ${boundary.retained}`);
  }
}

function planPortOperations(
  input: CompileBoundaryPreparationManifestInput,
  boundary: Extract<ResolvedBoundary, { strategy: "port" }>,
  baselineCommit: string,
  retainedText: string,
  compilerOptions: ts.CompilerOptions,
  bindings: readonly BoundaryImporterBinding[],
): readonly PreparationReplayOperation[] {
  if (!input.contractTargetPath) throw new PlanningError(`boundary ${boundary.id} requires an explicit contract target path`);
  if (input.contractTargetPath === boundary.retained) throw new PlanningError(`boundary ${boundary.id} contract target path must differ from the retained module`);
  workspacePath(input.rootDir, input.contractTargetPath);
  const targetPackage = assertExistingPortTargetPackage(input, boundary, baselineCommit, input.contractTargetPath);
  if (showBaseline(input.rootDir, baselineCommit, input.contractTargetPath) !== null) {
    throw new PlanningError(`boundary contract target already exists at baseline: ${input.contractTargetPath}`);
  }
  const consumers: PortConsumerInput[] = bindings.map((binding) => ({
    path: binding.path,
    preconditionHash: binding.preconditionHash,
    mode: binding.mode,
    text: binding.text,
    specifier: binding.specifier,
  }));
  const result = planPortBoundary({
    rootDir: input.rootDir,
    boundary,
    retainedSourceText: retainedText,
    compilerOptions,
    contractTargetPath: input.contractTargetPath,
    consumers,
    ...(input.adapterTemplateText === undefined ? {} : { adapterTemplateText: input.adapterTemplateText }),
    ...(input.templateVars === undefined ? {} : { templateVars: input.templateVars }),
    ...(input.moduleSpecifierCalls === undefined ? {} : { moduleSpecifierCalls: input.moduleSpecifierCalls }),
    ...(input.resolutionExtensions === undefined ? {} : { resolutionExtensions: input.resolutionExtensions }),
    ...(input.cssImportExtensions === undefined ? {} : { cssImportExtensions: input.cssImportExtensions }),
  });
  const packageExport = boundary.source === "portPromotions"
    ? planPortPackageExport(boundary, input.contractTargetPath, targetPackage)
    : undefined;
  return [result.contract, ...(result.adapter ? [result.adapter] : []), ...result.rewrites, ...(packageExport ? [packageExport] : [])];
}

interface ExistingPortTargetPackage {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestText: string;
  readonly manifest: Record<string, unknown>;
  readonly mode: number;
}

function assertExistingPortTargetPackage(
  input: CompileBoundaryPreparationManifestInput,
  boundary: Extract<ResolvedBoundary, { strategy: "port" }>,
  baselineCommit: string,
  contractTargetPath: string,
): ExistingPortTargetPackage {
  const packageRoot = boundaryTargetRoot(input.config, contractTargetPath);
  if (!packageRoot) {
    throw new PlanningError(`boundary ${boundary.id} contract target ${contractTargetPath} is outside configured package roots; scaffold ${boundary.targetPackage} first with the standard package lifecycle`);
  }
  const manifestPath = `${packageRoot}/package.json`;
  const manifestText = showBaseline(input.rootDir, baselineCommit, manifestPath);
  if (manifestText === null) {
    throw new PlanningError(
      `boundary ${boundary.id} target package ${boundary.targetPackage} does not exist at ${packageRoot}; ` +
        "boundary preparation cannot emit a partial package, so scaffold it first with the configured standard package lifecycle",
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new PlanningError(`boundary ${boundary.id} target package manifest is not valid JSON: ${manifestPath}`);
  }
  const name = typeof manifest === "object" && manifest !== null && "name" in manifest ? (manifest as { name?: unknown }).name : undefined;
  if (name !== boundary.targetPackage) {
    throw new PlanningError(`boundary ${boundary.id} target path belongs to package ${JSON.stringify(name)}, not configured targetPackage ${JSON.stringify(boundary.targetPackage)}`);
  }
  return { root: packageRoot, manifestPath, manifestText, manifest: manifest as Record<string, unknown>, mode: baselineFileMode(input.rootDir, baselineCommit, manifestPath) };
}

function planPortPackageExport(
  boundary: Extract<ResolvedBoundary, { strategy: "port" }>,
  contractTargetPath: string,
  target: ExistingPortTargetPackage,
): PreparationReplayOperation | undefined {
  const module = boundary.contractModule.replace(/^\.\//, "").replace(/\.[cm]?[jt]sx?$/, "");
  if (!module || module === "index" || module.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new PlanningError(`boundary ${boundary.id} contractModule must name a package subpath: ${JSON.stringify(boundary.contractModule)}`);
  }
  const expectedImport = `${boundary.targetPackage}/${module}`;
  if (boundary.packageImport !== expectedImport) {
    throw new PlanningError(`boundary ${boundary.id} packageImport ${JSON.stringify(boundary.packageImport)} must equal target package subpath ${JSON.stringify(expectedImport)}`);
  }
  const exportKey = `./${module}`;
  const relativeTarget = posix.relative(target.root, contractTargetPath);
  const exportTarget = `./${relativeTarget}`;
  const exports = packageExportsMap(target.manifest.exports, target.manifestPath);
  const existing = exports[exportKey];
  if (existing !== undefined && !exportTargetMatches(existing, exportTarget)) {
    throw new PlanningError(`${target.manifestPath} export ${exportKey} already targets ${JSON.stringify(existing)}, not ${JSON.stringify(exportTarget)}`);
  }
  if (existing !== undefined) return undefined;
  const nextExports = Object.fromEntries([...Object.entries(exports), [exportKey, exportTarget]].sort(([left], [right]) => byCodeUnit(left, right)));
  const contents = `${JSON.stringify({ ...target.manifest, exports: nextExports }, null, 2)}\n`;
  return {
    kind: "write-file",
    purpose: "port-package-export",
    file: {
      path: target.manifestPath,
      preconditionHash: hashText(target.manifestText),
      preconditionMode: target.mode,
      resultHash: hashText(contents),
      resultMode: target.mode,
    },
    contents,
  };
}

function packageExportsMap(value: unknown, packageFile: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ".": value };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length === 0) return keys.length === 0 ? {} : { ".": record };
  if (subpaths.length === keys.length) return record;
  throw new PlanningError(`${packageFile} exports cannot mix package subpaths and root conditions`);
}

function exportTargetMatches(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const leaves = Object.values(value as Record<string, unknown>);
  return leaves.length > 0 && leaves.every((leaf) => exportTargetMatches(leaf, target));
}

function boundaryTargetRoot(config: MonocarveConfig, targetPath: string): string | undefined {
  const exact = config.firstPartyPackages
    .filter((item) => targetPath === item.root || targetPath.startsWith(`${item.root}/`))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (exact) return exact.root;
  for (const root of [...config.packageRoots].sort((left, right) => right.length - left.length)) {
    if (!targetPath.startsWith(`${root}/`)) continue;
    const child = targetPath.slice(root.length + 1).split("/")[0];
    if (child) return posix.join(root, child);
  }
  return undefined;
}

/** Deterministic operation order: by mutated path, then kind, matching multi-build.ts. */
function boundaryOperationOrder(left: PreparationReplayOperation, right: PreparationReplayOperation): number {
  const path = (operation: PreparationReplayOperation) => operation.kind === "extract-type-declarations" ? operation.donor.path : operation.file.path;
  return byCodeUnit(path(left), path(right)) || byCodeUnit(left.kind, right.kind);
}

/**
 * Find the exact baseline import binding an operator-named importer uses to
 * reach the retained module, and every named symbol it imports through that
 * binding. Resolution is checker-driven (`ts.resolveModuleName`), never
 * string matching, so a specifier that merely looks similar to the retained
 * path can never be mistaken for a real edge.
 */
function resolveBoundaryImporter(
  rootDir: string,
  baselineCommit: string,
  compilerOptions: ts.CompilerOptions,
  importerPath: string,
  retainedPath: string,
  moduleSpecifierCalls: readonly string[],
): BoundaryImporterBinding {
  const text = showBaseline(rootDir, baselineCommit, importerPath);
  if (text === null) throw new PlanningError(`boundary importer is absent from baseline: ${importerPath}`);
  const mode = baselineFileMode(rootDir, baselineCommit, importerPath);
  const source = ts.createSourceFile(importerPath, text, ts.ScriptTarget.Latest, true, importerPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith(".")) continue;
    const specifier = statement.moduleSpecifier.text;
    const resolved = ts.resolveModuleName(specifier, resolve(rootDir, importerPath), compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    if (resolved === undefined || relative(rootDir, resolved).replaceAll("\\", "/") !== retainedPath) continue;
    const importedSymbols: string[] = [];
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) importedSymbols.push((element.propertyName ?? element.name).text);
    }
    return { path: importerPath, preconditionHash: hashText(text), mode, text, specifier, importedSymbols: [...new Set(importedSymbols)].sort(byCodeUnit) };
  }
  const configuredCall = findConfiguredModuleCall(source, rootDir, importerPath, retainedPath, compilerOptions, moduleSpecifierCalls);
  if (configuredCall !== undefined) {
    return {
      path: importerPath,
      preconditionHash: hashText(text),
      mode,
      text,
      specifier: configuredCall.specifier,
      importedSymbols: [],
      moduleSpecifierCall: configuredCall.call,
    };
  }
  throw new PlanningError(`${importerPath} does not import the retained module ${retainedPath} at baseline`);
}

function findConfiguredModuleCall(
  source: ts.SourceFile,
  rootDir: string,
  importerPath: string,
  retainedPath: string,
  compilerOptions: ts.CompilerOptions,
  configuredCalls: readonly string[],
): { readonly call: string; readonly specifier: string } | undefined {
  let found: { call: string; specifier: string } | undefined;
  const qualifiedName = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return node.text;
    if (!ts.isPropertyAccessExpression(node)) return undefined;
    const parent = qualifiedName(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.name.text}`;
  };
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      const call = qualifiedName(node.expression);
      const argument = node.arguments[0];
      if (call !== undefined && configuredCalls.includes(call) && argument !== undefined && ts.isStringLiteralLike(argument)) {
        const specifier = argument.text;
        const resolved = ts.resolveModuleName(specifier, resolve(rootDir, importerPath), compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
        if (resolved !== undefined && relative(rootDir, resolved).replaceAll("\\", "/") === retainedPath) found = { call, specifier };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
