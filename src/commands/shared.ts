/** Shared CLI boundaries: config, graph reports, manifests, and output paths. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { getApplication, loadConfig, type LoadedConfig, type MonocarveConfig } from "../config.ts";
import { ConfigError, IoError, MonocarveError, PreflightError, UsageError } from "../errors.ts";
import { ScanError, scanDependencyGraph, type ScanReport } from "../graph/index.ts";
import { graphDigest, parseManifest } from "../plan/build.ts";
import { PlanningError, WorkspaceContext } from "../plan/context.ts";
import { planSensitivePaths, type ExtractionManifest } from "../plan/manifest.ts";
import { disallowedDirtyPaths } from "../util/dirty-tree.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";

export function systemReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function load(
  args: ParsedArgs,
  options: { readonly refuseStaticFilesystemImports?: boolean; readonly executionBoundary?: "snapshot" } = {},
): Promise<LoadedConfig> {
  const configPath = flagString(args, "config");
  const cwd = flagString(args, "cwd");
  try {
    return await loadConfig({
      ...(configPath === undefined ? {} : { configPath }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.refuseStaticFilesystemImports ? { refuseStaticFilesystemImports: true } : {}),
      ...(options.executionBoundary === "snapshot" ? { executionBoundary: "snapshot" as const } : {}),
    });
  } catch (error) {
    if (error instanceof MonocarveError) throw error;
    throw new ConfigError(`could not load the config${configPath === undefined ? "" : ` at ${configPath}`}: ${systemReason(error)}`);
  }
}

export function print(value: unknown, args: ParsedArgs): void {
  process.stdout.write(renderOutput(value, args));
}

function renderOutput(value: unknown, args: ParsedArgs): string {
  return flagBool(args, "json") || typeof value !== "string" ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`;
}

/** Emit one report to stdout and, when requested, the same complete bytes atomically to disk. */
export function printReport(rootDir: string, value: unknown, args: ParsedArgs): void {
  const rendered = renderOutput(value, args);
  const out = flagString(args, "out");
  if (out !== undefined) writeOutput(rootDir, out, rendered);
  process.stdout.write(rendered);
}

function asScanReport(value: unknown, application: string, path: string): ScanReport {
  const reject = (detail: string): never => {
    throw new ScanError(`the scanner report for ${application} at ${path} is not a scanner report: ${detail}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return reject(`expected a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`);
  }
  const modules: unknown = (value as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return reject('no "modules" array');
  for (const [index, module] of modules.entries()) {
    if (typeof module !== "object" || module === null) return reject(`modules[${index}] is not an object`);
    const entry = module as { source?: unknown; dependencies?: unknown };
    if (typeof entry.source !== "string") return reject(`modules[${index}] has no "source" string`);
    if (!Array.isArray(entry.dependencies)) return reject(`modules[${index}] has no "dependencies" array`);
    for (const [at, dependency] of entry.dependencies.entries()) {
      const named = typeof dependency === "object" && dependency !== null && typeof (dependency as { module?: unknown }).module === "string";
      if (!named) return reject(`modules[${index}].dependencies[${at}] has no "module" string`);
    }
  }
  return value as ScanReport;
}

export function suppliedReports(args: ParsedArgs, rootDir: string): Record<string, ScanReport> | undefined {
  const entries = args.repeated.get("graph") ?? [];
  if (entries.length === 0) return undefined;
  const reports: Record<string, ScanReport> = {};
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals < 0) throw new UsageError("--graph expects <application>=<file>");
    const name = entry.slice(0, equals);
    const path = entry.slice(equals + 1);
    let text: string;
    try {
      text = readFileSync(resolve(rootDir, path), "utf8");
    } catch (error) {
      throw new ScanError(`could not read the scanner report for ${name} at ${path}: ${systemReason(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ScanError(`could not parse the scanner report for ${name} at ${path}: ${systemReason(error)}`);
    }
    reports[name] = asScanReport(parsed, name, path);
  }
  return reports;
}

export interface LoadedGraph {
  readonly config: MonocarveConfig;
  readonly configPath: string;
  readonly rootDir: string;
  readonly graph: Awaited<ReturnType<typeof scanDependencyGraph>>;
  readonly context: WorkspaceContext;
}

export async function loadGraph(args: ParsedArgs, options: { readonly allApplications?: boolean } = {}): Promise<LoadedGraph> {
  const { config, configPath, rootDir } = await load(args);
  const application = options.allApplications ? undefined : flagString(args, "app");
  const reports = suppliedReports(args, rootDir);
  const graph = await scanDependencyGraph({
    config,
    rootDir,
    ...(application === undefined ? {} : { application: getApplication(config, application).name }),
    ...(flagBool(args, "no-cache") ? { noCache: true } : {}),
    ...(reports === undefined ? {} : { reports }),
  });
  return { config, configPath, rootDir, graph, context: new WorkspaceContext(config, rootDir) };
}

export async function loadManifest(args: ParsedArgs, rootDir: string): Promise<{ path: string; manifest: ExtractionManifest }> {
  const inputPath = flagString(args, "plan") ?? args.positionals[0];
  if (inputPath === undefined) throw new UsageError("a plan manifest path is required (--plan <path>)");
  const path = relativeWorkspacePath(rootDir, inputPath);
  let text: string;
  try {
    text = readFileSync(workspacePath(rootDir, path), "utf8");
  } catch (error) {
    throw new PlanningError(`could not read the plan manifest ${path}: ${systemReason(error)}`);
  }
  const manifest = parseManifest(text, path);
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    const parsedAs = Array.isArray(manifest) ? "an array" : manifest === null ? "null" : typeof manifest;
    throw new PlanningError(`the plan manifest ${path} is not a JSON object (parsed as ${parsedAs})`);
  }
  return { path, manifest };
}

export function writeOutput(rootDir: string, path: string, contents: string, options: { exclusive?: boolean } = {}): void {
  const absolute = workspacePath(rootDir, path);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    if (options.exclusive) writeFileSync(absolute, contents, { flag: "wx" });
    else {
      writeFileSync(temporary, contents, { flag: "wx" });
      renameSync(temporary, absolute);
    }
  } catch (error) {
    throw new IoError(`could not write ${path}: ${systemReason(error)}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function outputPath(rootDir: string, path: string): string {
  const normalized = relative(resolve(rootDir), resolve(rootDir, path)).replaceAll("\\", "/");
  if (normalized === "" || normalized === ".." || normalized.startsWith("../")) {
    throw new IoError(`output path escapes the workspace: ${path}`);
  }
  const absolute = workspacePath(rootDir, normalized);
  const root = realpathSync(resolve(rootDir));
  const resolved = resolveExistingAncestor(absolute);
  const canonical = relative(root, resolved).replaceAll("\\", "/");
  if (canonical === "" || canonical === ".." || canonical.startsWith("../")) {
    throw new IoError(`output path escapes the workspace through a symlink: ${path}`);
  }
  return canonical;
}

function resolveExistingAncestor(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new IoError(`could not resolve output path ${path}`);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

export function assertPlannableTree(
  loaded: Pick<LoadedConfig, "config" | "rootDir" | "configPath">,
  manifest: ExtractionManifest,
  output: string,
  args: ParsedArgs,
): void {
  if (flagBool(args, "allow-dirty")) {
    throw new UsageError("--allow-dirty is no longer supported; configure transaction.allowDirtyPaths instead");
  }
  const configPath = relative(loaded.rootDir, loaded.configPath).replaceAll("\\", "/");
  const disallowed = disallowedDirtyPaths(loaded.rootDir, loaded.config.transaction.allowDirtyPaths, [...planSensitivePaths(manifest), output, configPath]);
  if (disallowed.length === 0) return;
  throw new PreflightError(
    `refusing to plan from a dirty working tree: ${disallowed.join(", ")}\n` +
      "commit or stash these paths; transaction.allowDirtyPaths may name only unrelated paths " +
      "(plan inputs, outputs, generated artifacts, and baseline-sensitive files are never allowed).",
  );
}

export { graphDigest };
