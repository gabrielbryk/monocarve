/**
 * The per-workspace cache layer every planning stage shares.
 *
 * Planning asks the same questions thousands of times — "what does this file
 * import", "where does this specifier resolve", "what does this package
 * export" — and each answer costs a parse or a filesystem walk. They are cached
 * here rather than in module globals, because a single process legitimately
 * plans against several workspaces (the test suite does exactly that, and a
 * cache keyed by path alone would silently answer for the wrong tree).
 *
 * A context is therefore scoped to one `rootDir` and is disposable: build a new
 * one — or {@link WorkspaceContext.reset} the old one — whenever the tree
 * changes underneath it.
 */

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, resolve } from "node:path";

import ts from "typescript";

import {
  isTestPath,
  testKindOf,
  type TestKind,
  movableRoots,
  ownerFor,
  packageNameOf,
  type MonocarveConfig,
} from "../config.ts";
import { inventoryModuleReferences, type ModuleReference } from "../codemod/imports.ts";
import {
  evaluationEffectKinds as topLevelEffectKinds,
  type EvaluationEffectKind,
} from "../codemod/side-effects.ts";
import { MonocarveError } from "../errors.ts";
import { fileState, isFile, isSourceModulePath, sourceFiles } from "../util/files.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import type { FileState } from "../util/hash.ts";
import { importKinds, type ImportKind } from "../graph/syntax.ts";
import { packageEntrypoint, readManifest, workspaceInventory, type PackageManifest } from "../graph/workspace.ts";

export class PlanningError extends MonocarveError {
  override readonly name = "PlanningError";
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// Bun's own `node:module` builtinModules list omits some Node built-ins it
// still resolves at runtime (e.g. `node:test`, confirmed missing under Bun
// 1.x even though `bun test`-adjacent code can import it). List them
// explicitly rather than trusting the host runtime's builtinModules to be
// complete.
const RUNTIME_BUILTIN_GAPS = new Set(["node:test", "test"]);

/**
 * Node and Bun builtins, plus runtime-ambient modules with no installable
 * package. `cloudflare:*` (e.g. `cloudflare:workers`, `cloudflare:sockets`)
 * is the Workers runtime's own ambient namespace — never an npm package and
 * never a real cross-package dependency, so it's treated the same as a
 * Node/Bun builtin rather than an uninstalled-package blocker.
 */
export function isBuiltinModule(name: string): boolean {
  return (
    name.startsWith("bun:") ||
    name.startsWith("cloudflare:") ||
    RUNTIME_BUILTIN_GAPS.has(name) ||
    NODE_BUILTINS.has(name) ||
    NODE_BUILTINS.has(name.startsWith("node:") ? name.slice(5) : `node:${name}`)
  );
}

/** `@types/x` name for a package, matching npm's scoped-name mangling. */
export function typesPackageName(name: string): string {
  if (name.startsWith("@types/")) return name;
  return `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
}

/** Which bindings a file takes from a specifier, and whether it takes the namespace. */
export interface BindingSurface {
  star: boolean;
  names: Set<string>;
}

export class WorkspaceContext {
  private readonly referenceCache = new Map<string, ModuleReference[]>();
  private readonly relativeResolutionCache = new Map<string, string | undefined>();
  private readonly importKindCache = new Map<string, Map<string, ImportKind>>();
  private readonly parsedSourceCache = new Map<string, ts.SourceFile | undefined>();
  private readonly reexportCache = new Map<string, Map<string, BindingSurface>>();
  private readonly bindingCache = new Map<string, BindingSurface>();
  private readonly evaluationEffectCache = new Map<string, EvaluationEffectKind[]>();
  private readonly manifestCache = new Map<string, PackageManifest>();
  private readonly installedManifestCache = new Map<string, PackageManifest | undefined>();
  private readonly installedCache = new Map<string, boolean>();
  private workspacePackageRootsCache: Readonly<Record<string, string>> | undefined;
  private sourceListCache: string[] | undefined;
  private consumerIndexCache: Map<string, string[]> | undefined;

  /** Extensions a relative specifier may resolve through, assets included. */
  private readonly resolutionSuffixes: readonly string[];

  constructor(
    readonly config: MonocarveConfig,
    readonly rootDir: string,
  ) {
    this.resolutionSuffixes = [
      "",
      ".d.ts",
      ...config.sourceExtensions,
      ...config.assetExtensions,
    ];
  }

  absolute(path: string): string {
    return workspacePath(this.rootDir, path);
  }

  relative(path: string): string {
    return relativeWorkspacePath(this.rootDir, path);
  }

  exists(path: string): boolean {
    return existsSync(this.absolute(path));
  }

  text(path: string): string {
    return readFileSync(this.absolute(path), "utf8");
  }

  state(path: string): FileState {
    return fileState(this.absolute(path));
  }

  /** Configured workspace package names, including packages with no source files. */
  workspacePackageRoots(): Readonly<Record<string, string>> {
    if (this.workspacePackageRootsCache !== undefined) return this.workspacePackageRootsCache;
    this.workspacePackageRootsCache = Object.fromEntries(workspaceInventory(this.config, this.rootDir).packageNames);
    return this.workspacePackageRootsCache;
  }

  /* ---------------------------------------------------------------------- */
  /* AST-level facts                                                        */
  /* ---------------------------------------------------------------------- */

  moduleReferences(path: string): ModuleReference[] {
    let cached = this.referenceCache.get(path);
    if (!cached) {
      const absolute = this.absolute(path);
      cached = inventoryModuleReferences(
        readFileSync(absolute, "utf8"), absolute, true, this.rootDir, this.config.moduleSpecifierCalls, this.config.assetExtensions, this.config.cssImportExtensions,
      );
      this.referenceCache.set(path, cached);
    }
    return cached;
  }

  /**
   * A computed specifier — `import(\`./${name}\`)` — cannot be rewritten, so any
   * file containing one blocks the plan that would move or repoint it.
   */
  hasUnsupportedReference(path: string): boolean {
    return this.moduleReferences(path).some((reference) => reference.specifier === null);
  }

  /**
   * What this module does when it is evaluated, as a sorted set of kinds.
   *
   * Cached here rather than recomputed per caller because the portfolio asks it
   * of the same file once per candidate whose closure contains it, and closures
   * overlap heavily — the cost should be one parse per file, not one per pair.
   */
  evaluationEffectKinds(path: string): EvaluationEffectKind[] {
    let cached = this.evaluationEffectCache.get(path);
    if (!cached) {
      cached = topLevelEffectKinds(this.text(path), path);
      this.evaluationEffectCache.set(path, cached);
    }
    return cached;
  }

  importKinds(path: string): Map<string, ImportKind> {
    let cached = this.importKindCache.get(path);
    if (!cached) {
      cached = importKinds(this.absolute(path), path);
      this.importKindCache.set(path, cached);
    }
    return cached;
  }

  parsedSource(path: string): ts.SourceFile | undefined {
    if (this.parsedSourceCache.has(path)) return this.parsedSourceCache.get(path);
    const absolute = this.absolute(path);
    const parsed = existsSync(absolute)
      ? ts.createSourceFile(
          path,
          readFileSync(absolute, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
      : undefined;
    this.parsedSourceCache.set(path, parsed);
    return parsed;
  }

  /**
   * Where a relative specifier lands, workspace-relative, or undefined.
   *
   * Resolution is done by candidate probing rather than by the module resolver
   * because the answer must include assets (`./chart.css`), which no TypeScript
   * resolver will return, and because it must keep working for specifiers whose
   * target has already been moved.
   */
  resolveRelative(file: string, specifier: string): string | undefined {
    const key = `${file}\0${specifier}`;
    if (this.relativeResolutionCache.has(key)) return this.relativeResolutionCache.get(key);
    const resolved = this.resolveRelativeUncached(file, specifier);
    this.relativeResolutionCache.set(key, resolved);
    return resolved;
  }

  private resolveRelativeUncached(file: string, specifier: string): string | undefined {
    const base = resolve(dirname(this.absolute(file)), specifier.replace(/[?#].*$/, ""));
    // `./x.js` in TypeScript source means `./x.ts` on disk.
    const stripped = /\.[cm]?jsx?$/.test(base) ? base.slice(0, base.length - extname(base).length) : base;
    const hit = [base, stripped]
      .flatMap((candidate) => [
        ...this.resolutionSuffixes.map((suffix) => candidate + suffix),
        ...this.config.sourceExtensions.map((extension) => `${candidate}/index${extension}`),
      ])
      .find(isFile);
    if (hit === undefined) return undefined;
    try {
      return this.relative(hit);
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Package surfaces                                                       */
  /* ---------------------------------------------------------------------- */

  packageEntrypoint(owner: string): string | undefined {
    return packageEntrypoint(this.rootDir, owner);
  }

  /** What a package's entry file re-exports, per re-exported module. */
  entrypointReexports(entry: string): Map<string, BindingSurface> {
    const cached = this.reexportCache.get(entry);
    if (cached) return cached;
    const surfaces = new Map<string, BindingSurface>();
    for (const statement of this.parsedSource(entry)?.statements ?? []) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = specifier.startsWith(".") ? this.resolveRelative(entry, specifier) : undefined;
      if (target === undefined) continue;
      const surface = surfaces.get(target) ?? { star: false, names: new Set<string>() };
      if (!statement.exportClause) surface.star = true;
      else if (ts.isNamespaceExport(statement.exportClause)) surface.names.add(statement.exportClause.name.text);
      else for (const element of statement.exportClause.elements) surface.names.add(element.name.text);
      surfaces.set(target, surface);
    }
    this.reexportCache.set(entry, surfaces);
    return surfaces;
  }

  /** Which bindings `file` imports from `specifier`. */
  importedBindings(file: string, specifier: string): BindingSurface {
    const key = `${file}\0${specifier}`;
    const cached = this.bindingCache.get(key);
    if (cached) return cached;
    const surface: BindingSurface = { star: false, names: new Set<string>() };
    const parsed = this.parsedSource(file);

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier
      ) {
        const clause = node.importClause;
        if (clause?.name) surface.names.add("default");
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) surface.star = true;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) surface.names.add((element.propertyName ?? element.name).text);
        }
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier
      ) {
        if (!node.exportClause) surface.star = true;
        else if (ts.isNamedExports(node.exportClause)) {
          for (const element of node.exportClause.elements) surface.names.add((element.propertyName ?? element.name).text);
        } else surface.star = true;
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.argument.literal.text === specifier
      ) {
        const qualifier = node.qualifier;
        if (qualifier === undefined) surface.star = true;
        else surface.names.add(ts.isIdentifier(qualifier) ? qualifier.text : (qualifier.getText(parsed).split(".")[0] ?? ""));
      }
      ts.forEachChild(node, visit);
    };

    if (parsed) visit(parsed);
    this.bindingCache.set(key, surface);
    return surface;
  }

  /* ---------------------------------------------------------------------- */
  /* Workspace inventory                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Every first-party source file: applications plus package roots, sorted.
   *
   * {@link sourceFiles} already orders each root, but the roots are walked
   * independently and concatenated, so the join is only sorted per segment. The
   * final sort makes the whole list canonical — the same order the audit's own
   * inventory produces — so nothing downstream can observe a difference between
   * the planning tree and the audited one that is really just walk order.
   */
  repositorySources(): string[] {
    this.sourceListCache ??= [
      ...this.config.applications.flatMap((app) => [app.sourceRoot, ...app.consumerRoots]),
      ...this.config.packageRoots,
      ...this.config.firstPartyRoots,
      ...this.config.firstPartyPackages.map((pkg) => pkg.root),
    ]
      .flatMap((directory) => sourceFiles(resolve(this.rootDir, directory), undefined, [...this.config.sourceExtensions, ...this.config.assetExtensions]))
      .map((file) => this.relative(file))
      .sort();
    return this.sourceListCache;
  }

  /** Absolute resolved target -> files importing it. Built once, read many. */
  consumerIndex(): Map<string, string[]> {
    if (this.consumerIndexCache) return this.consumerIndexCache;
    const index = new Map<string, string[]>();
    for (const file of this.repositorySources()) {
      for (const reference of this.moduleReferences(file)) {
        if (!reference.specifier || !reference.resolved) continue;
        const importers = index.get(reference.resolved) ?? [];
        if (importers.at(-1) !== file) importers.push(file);
        index.set(reference.resolved, importers);
      }
    }
    this.consumerIndexCache = index;
    return index;
  }

  manifest(owner: string): PackageManifest {
    let cached = this.manifestCache.get(owner);
    if (!cached) {
      cached = readManifest(resolve(this.rootDir, owner === "" ? "package.json" : `${owner}/package.json`)) ?? {};
      this.manifestCache.set(owner, cached);
    }
    return cached;
  }

  declaredVersion(owner: string, name: string): string | undefined {
    const manifest = this.manifest(owner);
    return manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  }

  declaresDependency(owner: string, name: string): boolean {
    const manifest = this.manifest(owner);
    return manifest.dependencies?.[name] !== undefined || manifest.devDependencies?.[name] !== undefined;
  }

  /**
   * The installed `package.json` of a third-party package, or undefined when no
   * copy was found.
   *
   * `owners` are the directories whose code reached the package; each is probed
   * for a local `node_modules` before the workspace root, which is the order a
   * package manager itself resolves in. They must arrive sorted — the answer
   * reaches the manifest, so a caller iterating a `Set` in discovery order would
   * make the plan's bytes depend on traversal order.
   *
   * Distinct from {@link manifest}, which normalizes a missing file to `{}`:
   * here "not installed" and "installed and says nothing" are different answers
   * and the caller needs both.
   */
  installedManifest(name: string, owners: readonly string[]): PackageManifest | undefined {
    const key = `${name}\0${owners.join("\0")}`;
    if (this.installedManifestCache.has(key)) return this.installedManifestCache.get(key);
    const found = [...owners, ""]
      .map((owner) => (owner === "" ? `node_modules/${name}` : `${owner}/node_modules/${name}`))
      .map((directory) => readManifest(resolve(this.rootDir, directory, "package.json")))
      .find((manifest) => manifest !== undefined);
    this.installedManifestCache.set(key, found);
    return found;
  }

  /**
   * Whether a bare specifier is installed for `owner`. An import of something
   * that is not installed anywhere is a real escape: the extracted package
   * could not declare a dependency on it even if it wanted to.
   */
  isInstalledPackage(name: string, owner: string): boolean {
    const key = `${owner}\0${name}`;
    let cached = this.installedCache.get(key);
    if (cached === undefined) {
      cached = [name, typesPackageName(name)]
        .flatMap((candidate) => [`${owner}/node_modules/${candidate}`, `node_modules/${candidate}`])
        .some((path) => existsSync(resolve(this.rootDir, path)));
      this.installedCache.set(key, cached);
    }
    return cached;
  }

  isTest(path: string): boolean {
    return isTestPath(this.config, path);
  }

  testKind(path: string): TestKind | undefined {
    return testKindOf(this.config, path);
  }

  isProductionSource(path: string): boolean {
    return isSourceModulePath(path, this.config.sourceExtensions) && !this.isTest(path);
  }

  ownerOf(path: string): string {
    return ownerFor(this.config, path);
  }

  packageNameOf(specifier: string): string {
    return packageNameOf(specifier);
  }

  /** Whether a path lives somewhere a plan is allowed to move it out of. */
  isMovable(path: string): boolean {
    return movableRoots(this.config).some((root) => path.startsWith(root));
  }

  /**
   * Path a moved file takes inside the new package, structure-preserved.
   *
   * The prefix stripped is the application `sourceRoot` it came from, or the
   * `src/` of the package it came from, so `apps/web/src/widgets/chart.ts`
   * becomes `widgets/chart.ts` and lands at `<packageRoot>/src/widgets/chart.ts`.
   * Preserving structure is what makes the move reviewable as a rename.
   */
  targetRelativePath(source: string): string {
    for (const app of this.config.applications) {
      const prefix = app.sourceRoot.endsWith("/") ? app.sourceRoot : `${app.sourceRoot}/`;
      if (source.startsWith(prefix)) return source.slice(prefix.length);
    }
    for (const root of this.config.packageRoots) {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      if (!source.startsWith(prefix)) continue;
      const parts = source.split("/");
      const rootDepth = prefix.split("/").filter(Boolean).length;
      return parts.slice(parts[rootDepth + 1] === "src" ? rootDepth + 2 : rootDepth + 1).join("/");
    }
    throw new PlanningError(`cannot preserve the path of a file outside every configured root: ${source}`);
  }

  reset(): void {
    this.referenceCache.clear();
    this.relativeResolutionCache.clear();
    this.importKindCache.clear();
    this.evaluationEffectCache.clear();
    this.parsedSourceCache.clear();
    this.reexportCache.clear();
    this.bindingCache.clear();
    this.manifestCache.clear();
    this.installedManifestCache.clear();
    this.installedCache.clear();
    this.sourceListCache = undefined;
    this.consumerIndexCache = undefined;
  }
}
