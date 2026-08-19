/**
 * The external-consumer compile proof.
 *
 * This is deliberately a synthetic program outside the workspace package: it
 * proves the public surface the plan promises can actually be imported. The
 * resolution, fixture rendering, and ambient-type setup live in focused
 * helpers so each proof component remains independently reviewable.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ts from "typescript";

import { TOOL_NAME } from "../branding.ts";
import { getApplication, type MonocarveConfig } from "../config.ts";
import { applicationOwner } from "../config/helpers.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { relativePosix } from "../util/paths.ts";

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
  const fixtureRoot = mkdtempSync(join(tmpdir(), `${TOOL_NAME}-external-consumer-`));
  const fixture = writeExternalConsumerFixture(fixtureRoot, manifest.target);
  try {
    const compilerOptions = compilerOptionsFor(config, manifest, rootDir, installedRoot);
    const application = getApplication(config, manifest.application);
    const configured = configuredTypes(rootDir, application.tsconfig);
    const declaredTypes = partitionTypes(
      [...new Set([...application.compilerProfile.types, ...configured])],
      installedRoot,
      compilerOptions,
    );
    const configuredAmbient = configured.flatMap((name) => resolveTypeFile(name, installedRoot, compilerOptions));
    const program = ts.createProgram([fixture, ...declaredTypes.ambient, ...configuredAmbient], {
      ...compilerOptions,
      ...(application.compilerProfile.types.length > 0 ? { types: application.compilerProfile.types } : {}),
    });
    const diagnostics = [
      ...ts.getPreEmitDiagnostics(program).map(formatDiagnostic),
      ...typeOnlyImportDiagnostics(program, fixture),
    ];
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
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly !== true) continue;
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

function compilerOptionsFor(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  rootDir: string,
  installedRoot: string,
): ts.CompilerOptions {
  const application = getApplication(config, manifest.application);
  const profile = application.compilerProfile;
  const entrypoint = resolve(rootDir, manifest.target.packageRoot, manifest.target.entrypoint);
  const configuredLib = configuredCompilerOption(rootDir, application.tsconfig, "lib");
  // The synthetic consumer compiles the extracted package sources directly;
  // it cannot inherit the package tsconfig. A moved TSX module therefore
  // requires JSX support even when the application profile omitted an
  // explicit jsx field and relied on its root tsconfig.
  const jsx = manifest.operations.some((operation) => operation.kind === "move" && operation.target.endsWith(".tsx"))
    ? (profile.jsx || ts.JsxEmit.ReactJSX)
    : profile.jsx;
  return {
    target: ts.ScriptTarget.ES2022,
    lib: [...new Set([
      ...configuredLib.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase()),
      ...profile.lib,
    ])],
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
      ...workspacePaths(config, rootDir),
      [manifest.target.packageName]: [relativePosix(rootDir, entrypoint)],
    },
  };
}

function resolveTypeFile(name: string, installedRoot: string, options: ts.CompilerOptions): string[] {
  const containingFile = resolve(installedRoot, `__${TOOL_NAME}_types__.ts`);
  const host = ts.createCompilerHost(options, true);
  const resolved = ts.resolveTypeReferenceDirective(name, containingFile, options, host).resolvedTypeReferenceDirective?.resolvedFileName;
  return resolved === undefined ? [] : [resolved];
}

function configuredTypes(rootDir: string, tsconfig: string): string[] {
  const types = configuredCompilerOption(rootDir, tsconfig, "types");
  return Array.isArray(types) ? types.filter((type): type is string => typeof type === "string") : [];
}

function configuredCompilerOption(rootDir: string, tsconfig: string, name: string): unknown[] {
  const read = ts.readConfigFile(resolve(rootDir, tsconfig), ts.sys.readFile);
  const value = read.error === undefined ? read.config?.compilerOptions?.[name] : undefined;
  return Array.isArray(value) ? value : [];
}

function moduleOptions(moduleResolution: "nodenext" | "bundler"): Pick<ts.CompilerOptions, "module" | "moduleResolution"> {
  return moduleResolution === "bundler"
    ? { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
}

function typeRootsFor(config: MonocarveConfig, manifest: ExtractionManifest, installedRoot: string): string[] {
  const owners = [
    ...config.applications.map(applicationOwner),
    manifest.target.packageRoot,
    "",
  ];
  return owners
    .map((owner) => resolve(installedRoot, owner, "node_modules/@types"))
    .filter((directory) => existsSync(directory));
}

/** Read a file relative to a tree without throwing when it is absent. */
export function readIfPresent(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}
