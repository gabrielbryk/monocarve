/**
 * The external-consumer compile proof.
 *
 * This is deliberately a synthetic program outside the workspace package: it
 * proves the public surface the plan promises can actually be imported. The
 * resolution, fixture rendering, and ambient-type setup live in focused
 * helpers so each proof component remains independently reviewable.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";

import { TOOL_NAME } from "../branding.ts";
import { getApplication, type MonocarveConfig } from "../config.ts";
import { applicationOwner } from "../config/helpers.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { relativePosix } from "../util/paths.ts";

import { ensureScratchDir } from "../util/scratch-root.ts";
import { partitionTypes } from "./external-consumer/ambient-types.ts";
import { externalDependencyPaths } from "./external-consumer/dependency-paths.ts";
import { writeExternalConsumerFixture } from "./external-consumer/fixture.ts";
import { workspacePaths } from "./external-consumer/workspace-paths.ts";

export interface ExternalConsumerProof {
  readonly passed: boolean;
  readonly fixture: string;
  readonly diagnostics: readonly string[];
}

export interface CompileExternalConsumerOptions {
  readonly config: MonocarveConfig;
  readonly manifest: ExtractionManifest;
  /** Tree the package lives in — the simulation worktree or the real checkout. */
  readonly rootDir: string;
  /** Tree whose `node_modules` are populated. Usually the primary checkout. */
  readonly installedRoot?: string;
}

export function compileExternalConsumer(options: CompileExternalConsumerOptions): ExternalConsumerProof {
  const { config, manifest, rootDir } = options;
  const installedRoot = options.installedRoot ?? rootDir;
  const fixtureRoot = mkdtempSync(ensureScratchDir("external-consumer-"));
  const fixture = writeExternalConsumerFixture(fixtureRoot, manifest.target);
  try {
    const compilerOptions = compilerOptionsFor(config, manifest, rootDir, installedRoot);
    const application = getApplication(config, manifest.application);
    // TypeScript resolves `compilerOptions.types` from the tsconfig owner's
    // node_modules. The synthetic consumer lives outside the workspace, so
    // resolving from installedRoot would skip a direct application dependency.
    const configured = configuredTypes(rootDir, application.tsconfig);
    const configuredAmbientFiles = configuredAmbientDeclarationFiles(rootDir, application.tsconfig);
    const owners = ownerRootsFor(config, manifest);
    // This is one flat program: every workspace package the fixture reaches
    // transitively (via `workspacePaths`' direct-to-source aliases) is
    // compiled under the *application's* single set of global `types`, not
    // each package's own tsconfig. A package whose production source needs
    // an ambient global the application itself has no reason to declare (a
    // package.json-scanning module using `@types/bun`'s `import.meta.dir`,
    // reached only because a target this plan is extracting happens to
    // depend on it) is invisible to a real per-package moon build — which
    // typechecks that package against its own tsconfig via project
    // references — but not to this flat program, which misreports it as a
    // proof failure the moon gate would never raise. Union in every
    // workspace package's own declared `types` so the same globals a real
    // build would see are available here too.
    const workspaceTypes = workspacePackageTypes(config, rootDir);
    const requestedTypes = [...new Set([...application.compilerProfile.types, ...configured, ...workspaceTypes])];
    const declaredTypes = partitionTypes(requestedTypes, installedRoot, compilerOptions, owners);
    const resolvedTypesByName = new Map(declaredTypes.types.map((name) => [name, resolveTypeFile(name, installedRoot, compilerOptions, owners)] as const));
    const ownerResolvedTypes = [...resolvedTypesByName.values()].flat();
    const unresolvedTypes = declaredTypes.types.filter((name) => resolvedTypesByName.get(name)?.length === 0);
    const configuredAmbient = configured.flatMap((name) => resolveTypeFile(name, installedRoot, compilerOptions, owners));
    const program = ts.createProgram([fixture, ...declaredTypes.ambient, ...ownerResolvedTypes, ...configuredAmbient, ...configuredAmbientFiles], {
      ...compilerOptions,
      // Only the names partitionTypes could not resolve as a real ambient
      // module belong here — an entry it already resolved (declaredTypes.
      // ambient) is a root file above, and re-requesting it as a `types`
      // entry sends it back through plain typeRoots resolution, which is
      // exactly the lookup that just failed for it.
      ...(requestedTypes.length > 0 ? { types: unresolvedTypes } : {}),
    });
    const diagnostics = [...ts.getPreEmitDiagnostics(program).map(formatDiagnostic), ...typeOnlyImportDiagnostics(program, fixture)];
    return { passed: diagnostics.length === 0, fixture, diagnostics };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

/**
 * A type-only import is enough to prove a generic type can be resolved, but
 * TypeScript also permits `import type` to name a value when that binding is
 * never used. Inspect the resolved aliases so the fixture can remain generic-
 * arity agnostic without weakening the type-vs-value surface proof.
 */
function typeOnlyImportDiagnostics(program: ts.Program, fixture: string): string[] {
  const source = program.getSourceFile(fixture);
  if (source === undefined) return [];
  const checker = program.getTypeChecker();
  const diagnostics: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) continue;
    const bindings = statement.importClause.namedBindings;
    const names = [
      ...(statement.importClause.name === undefined ? [] : [statement.importClause.name]),
      ...(bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name) : []),
    ];
    for (const name of names) {
      const alias = checker.getSymbolAtLocation(name);
      if (alias === undefined) continue;
      const target = alias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias;
      if ((target.flags & ts.SymbolFlags.Type) !== 0) continue;
      const position = source.getLineAndCharacterOfPosition(name.getStart(source));
      diagnostics.push(
        `${fixture}(${position.line + 1},${position.character + 1}): TS2749: '${name.text}' refers to a value, but is being used as a type here.`,
      );
    }
  }
  return diagnostics;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${diagnostic.code}: ${message}`;
  }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}(${position.line + 1},${position.character + 1}): TS${diagnostic.code}: ${message}`;
}

function compilerOptionsFor(config: MonocarveConfig, manifest: ExtractionManifest, rootDir: string, installedRoot: string): ts.CompilerOptions {
  const application = getApplication(config, manifest.application);
  const profile = application.compilerProfile;
  const entrypoint = resolve(rootDir, manifest.target.packageRoot, manifest.target.entrypoint);
  const configuredLib = configuredCompilerOption(rootDir, application.tsconfig, "lib");
  // The synthetic consumer compiles the extracted package sources directly;
  // it cannot inherit the package tsconfig. A moved TSX module therefore
  // requires JSX support even when the application profile omitted an
  // explicit jsx field and relied on its root tsconfig.
  const jsx = manifest.operations.some((operation) => operation.kind === "move" && operation.target.endsWith(".tsx"))
    ? profile.jsx || ts.JsxEmit.ReactJSX
    : profile.jsx;
  return {
    target: ts.ScriptTarget.ES2022,
    lib: [
      ...new Set([
        ...configuredLib
          .filter((value): value is string => typeof value === "string")
          .map((value) => (value.toLowerCase().startsWith("lib.") ? value.toLowerCase() : `lib.${value.toLowerCase()}.d.ts`)),
        ...profile.lib,
      ]),
    ],
    ...moduleOptions(profile.moduleResolution),
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    esModuleInterop: profile.esModuleInterop,
    allowSyntheticDefaultImports: jsx ? true : profile.allowSyntheticDefaultImports,
    baseUrl: rootDir,
    typeRoots: typeRootsFor(config, manifest, installedRoot),
    allowJs: false,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    paths: {
      ...externalDependencyPaths(config, installedRoot),
      ...workspacePaths(config, rootDir, installedRoot),
      [manifest.target.packageName]: [relativePosix(rootDir, entrypoint)],
    },
  };
}

// A `types` entry that names a package rather than an @types shim (e.g. an
// application's own `vite/client` or `@cloudflare/workers-types`) only
// resolves via node module resolution from a containing file whose ancestor
// `node_modules` actually holds that package. This workspace's pnpm install
// is strict/isolated, not hoisted, so such a package usually exists only
// under the owning application's own `node_modules`, never the workspace
// root's. Resolving purely from `installedRoot` therefore silently drops any
// such type and the synthetic consumer program re-requests it anyway (the
// `types` override in `compilerOptionsFor`'s caller), producing a bogus
// TS2688 "Cannot find type definition file" for a type the real application
// resolves without issue. Try every application/package owner directory —
// the same candidate list `typeRootsFor` already walks for `@types` — before
// giving up.
function resolveTypeFile(name: string, installedRoot: string, options: ts.CompilerOptions, owners: readonly string[]): string[] {
  const host = ts.createCompilerHost(options, true);
  for (const owner of owners) {
    const containingFile = resolve(installedRoot, owner, `__${TOOL_NAME}_types__.ts`);
    const resolved = ts.resolveTypeReferenceDirective(name, containingFile, options, host).resolvedTypeReferenceDirective?.resolvedFileName;
    if (resolved !== undefined) return [resolved];
  }
  return [];
}

/** The union of every `types` compilerOption entry any workspace package's own tsconfig declares. */
function workspacePackageTypes(config: MonocarveConfig, rootDir: string): string[] {
  const names = new Set<string>();
  for (const root of config.packageRoots) {
    const absolute = resolve(rootDir, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of packageOwnTypes(join(absolute, entry.name))) names.add(name);
    }
  }
  for (const pkg of config.firstPartyPackages) {
    for (const name of packageOwnTypes(resolve(rootDir, pkg.root))) names.add(name);
  }
  return [...names];
}

/** A single package's own declared `types`, preferring `tsconfig.lib.json` over a bare `tsconfig.json`. */
function packageOwnTypes(packageRoot: string): string[] {
  for (const file of ["tsconfig.lib.json", "tsconfig.json"]) {
    const types = configuredCompilerOption(packageRoot, file, "types");
    if (types.length > 0) return types.filter((type): type is string => typeof type === "string");
  }
  return [];
}

function configuredTypes(rootDir: string, tsconfig: string): string[] {
  const types = configuredCompilerOption(rootDir, tsconfig, "types");
  return Array.isArray(types) ? types.filter((type): type is string => typeof type === "string") : [];
}

/**
 * Preserve repository-owned ambient declarations discovered by the app
 * tsconfig. Vite-style projects commonly expose asset-query modules through
 * an included `vite-env.d.ts`, which is not represented by compilerOptions
 * `types` and therefore cannot be inferred from the package alone.
 */
function configuredAmbientDeclarationFiles(rootDir: string, tsconfig: string): string[] {
  const configPath = resolve(rootDir, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  return parsed?.fileNames.filter((file) => file.endsWith(".d.ts")) ?? [];
}

function configuredCompilerOption(rootDir: string, tsconfig: string, name: string): unknown[] {
  const read = ts.readConfigFile(resolve(rootDir, tsconfig), (path) => ts.sys.readFile(path));
  const value = read.error === undefined ? read.config?.compilerOptions?.[name] : undefined;
  return Array.isArray(value) ? value : [];
}

function moduleOptions(moduleResolution: "nodenext" | "bundler"): Pick<ts.CompilerOptions, "module" | "moduleResolution"> {
  return moduleResolution === "bundler"
    ? { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
}

function typeRootsFor(config: MonocarveConfig, manifest: ExtractionManifest, installedRoot: string): string[] {
  return ownerRootsFor(config, manifest)
    .map((owner) => resolve(installedRoot, owner, "node_modules/@types"))
    .filter((directory) => existsSync(directory));
}

/** Every directory a `node_modules` lookup for this extraction could plausibly start from. */
function ownerRootsFor(config: MonocarveConfig, manifest: ExtractionManifest): string[] {
  return [...config.applications.map(applicationOwner), manifest.target.packageRoot, ""];
}
