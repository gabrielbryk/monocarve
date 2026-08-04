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
    const declaredTypes = partitionTypes(getApplication(config, manifest.application).compilerProfile.types, installedRoot, compilerOptions);
    const program = ts.createProgram([fixture, ...declaredTypes.ambient], {
      ...compilerOptions,
      ...(declaredTypes.types.length > 0 ? { types: declaredTypes.types } : {}),
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    return { passed: diagnostics.length === 0, fixture, diagnostics };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
  const jsx = profile.jsx && manifest.operations.some((operation) => operation.kind === "move" && operation.target.endsWith(".tsx"));
  return {
    target: ts.ScriptTarget.ES2022,
    lib: [...profile.lib],
    ...moduleOptions(profile.moduleResolution),
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
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

function moduleOptions(moduleResolution: "nodenext" | "bundler"): Pick<ts.CompilerOptions, "module" | "moduleResolution"> {
  return moduleResolution === "bundler"
    ? { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }
    : { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
}

function typeRootsFor(config: MonocarveConfig, manifest: ExtractionManifest, installedRoot: string): string[] {
  const owners = [
    ...config.applications.map((app) => ownerOfSourceRoot(app.sourceRoot)),
    manifest.target.packageRoot,
    "",
  ];
  return owners
    .map((owner) => resolve(installedRoot, owner, "node_modules/@types"))
    .filter((directory) => existsSync(directory));
}

function ownerOfSourceRoot(sourceRoot: string): string {
  const parts = sourceRoot.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : sourceRoot;
}

/** Read a file relative to a tree without throwing when it is absent. */
export function readIfPresent(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}
