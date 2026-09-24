/**
 * dependency-cruiser adapter.
 *
 * The cruiser result is the *base* of the model, not the truth. It is used
 * because it resolves modules the way the repository's own TypeScript
 * configuration does — including, with `tsPreCompilationDeps`, the type-only
 * edges that a runtime-only view would drop, and a type-only escape is still an
 * escape.
 *
 * What the resolver cannot see is recovered later, from the AST: computed
 * specifiers (which make a file unplannable), assets reached by relative import
 * (which travel with a closure), and the difference between "imported for a
 * value" and "imported for a type" (which decides dependency classification).
 * See {@link ../graph/build.ts} and the containment analysis in the portfolio.
 *
 * No cruiser type escapes this module.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compilerBuildIdentity } from "../build-identity.ts";
import { getApplication, type MonocarveConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import { headCommit } from "../util/git.ts";
import { byCodeUnit, hashBytes, hashJson, hashText } from "../util/hash.ts";
import { buildDependencyGraph, type ScanReport } from "./build.ts";
import { buildApplicationGraph, toSccs } from "./components.ts";
import type { DependencyGraph, Scc } from "./model.ts";
import { SCANNER_READ_SYMBOL, scannerReadPlugin } from "./scanner-read-plugin.ts";
import { resetSyntaxCaches } from "./syntax.ts";
import { resetWorkspaceCaches } from "./workspace.ts";

export class ScanError extends MonocarveError {
  override readonly name = "ScanError";
}

export interface ScanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  /** Restrict the scan to one application; omit to scan every configured one. */
  readonly application?: string;
  /** Bypass the in-process scan cache. */
  readonly noCache?: boolean;
  /**
   * Pre-computed scanner reports keyed by application name. Cruising a large
   * application costs tens of seconds, so a caller that already has the report
   * — a test harness, a CI job that cruised once — supplies it here rather than
   * paying again per command.
   */
  readonly reports?: Readonly<Record<string, ScanReport>>;
}

const graphCache = new Map<string, DependencyGraph>();

/** Build the dependency model for the configured applications. */
export async function scanDependencyGraph(options: ScanOptions): Promise<DependencyGraph> {
  const { config, rootDir } = options;
  const applications = options.application ? [getApplication(config, options.application)] : config.applications;

  const commit = safeHead(rootDir);
  const key = `${rootDir}|${applications.map((app) => app.name).join(",")}|${commit ?? "none"}|${hashJson(config)}|${hashJson(compilerBuildIdentity())}`;
  if (config.graph.cache && !options.noCache && options.reports === undefined) {
    const cached = graphCache.get(key);
    if (cached) return cached;
  }

  const reports = await scanDependencyReports(options, applications);

  const graph = buildDependencyGraph({ config, rootDir, reports, ...(commit === undefined ? {} : { commit }) });
  if (config.graph.cache && options.reports === undefined) graphCache.set(key, graph);
  return graph;
}

/** Capture the raw scanner reports used to build a graph for operator replay. */
export async function scanDependencyReports(
  options: ScanOptions,
  applications = options.application ? [getApplication(options.config, options.application)] : options.config.applications,
): Promise<Record<string, ScanReport>> {
  // Application names are schema-valid arbitrary nonempty strings, including
  // legacy object-prototype keys such as "__proto__".  A null-prototype map
  // keeps those names as data instead of invoking an object setter.
  const reports: Record<string, ScanReport> = Object.create(null) as Record<string, ScanReport>;
  for (const app of applications) {
    const supplied = options.reports?.[app.name];
    reports[app.name] = supplied ?? (await cruiseApplication(options.config, options.rootDir, app.name));
  }
  return reports;
}

function safeHead(rootDir: string): string | undefined {
  try {
    return headCommit(rootDir);
  } catch {
    return undefined;
  }
}

/**
 * dependency-cruiser resolves relative to `process.cwd()` and reports paths the
 * same way, so the workspace root is made the working directory for the
 * duration of the cruise and restored afterwards. The alternative — a
 * subprocess — costs a second per application for no added isolation, since the
 * cruise is a pure read.
 */
async function cruiseApplication(config: MonocarveConfig, rootDir: string, name: string): Promise<ScanReport> {
  const app = getApplication(config, name);
  const tsconfig = resolve(rootDir, app.tsconfig);
  if (!existsSync(tsconfig)) throw new ScanError(`application ${name} declares a tsconfig that does not exist: ${app.tsconfig}`);
  if (!existsSync(resolve(rootDir, app.sourceRoot))) {
    throw new ScanError(`application ${name} declares a sourceRoot that does not exist: ${app.sourceRoot}`);
  }

  return withScannerCwd(rootDir, async () => {
    ensureScannerReadPlugin();
    const observed = await observeFilesystemReads(async () => {
      const { cruise } = await import("dependency-cruiser");
      const result = await cruise(
        [app.sourceRoot],
        {
          tsPreCompilationDeps: config.graph.tsPreCompilationDeps,
          doNotFollow: { path: "node_modules" },
          // Only set when the caller asked for it: an `exclude` entry deletes the
          // edges pointing at the excluded module, not just the module.
          ...(config.graph.exclude.length > 0 ? { exclude: { path: config.graph.exclude } } : {}),
          ...(config.graph.cruiserConfig ? { ruleSet: readRuleSet(rootDir, config.graph.cruiserConfig) } : {}),
        } as never,
        { tsConfig: app.tsconfig } as never,
        undefined,
      );
      const output = result.output;
      if (typeof output === "string") throw new ScanError(`scanner returned formatted output for ${name}`);
      return output.modules as ScanReport["modules"];
    });
    return {
      modules: observed.value,
      observedReads: observed.reads.filter((path) => retainObservedRead(rootDir, path)),
      observedFileReads: observed.fileReads.filter(({ path }) => retainObservedRead(rootDir, path)),
    };
  });
}

let scannerPluginInstalled = false;
function ensureScannerReadPlugin(): void {
  if (scannerPluginInstalled) return;
  Bun.plugin(scannerReadPlugin);
  scannerPluginInstalled = true;
}

/** Directory probing above the repository is resolver search bookkeeping, not
 * an analytical input. Existing external files remain authoritative inputs. */
function retainObservedRead(rootDir: string, path: string): boolean {
  if (!isAbsolute(path)) return true;
  const absoluteRoot = resolve(rootDir);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))) return true;
  return !lstatSync(absolutePath, { throwIfNoEntry: false })?.isDirectory();
}

/**
 * dependency-cruiser constructs its own enhanced-resolve filesystem, so its
 * public API cannot be given the inventory's filesystem. Interpose on the Node
 * filesystem for the single serialized cruise to capture paths it probes.
 */
async function observeFilesystemReads<T>(
  action: () => Promise<T>,
): Promise<{ readonly value: T; readonly reads: readonly string[]; readonly fileReads: readonly { readonly path: string; readonly sha256: string }[] }> {
  const names = ["accessSync", "existsSync", "lstatSync", "readFile", "readFileSync", "readlinkSync", "readdirSync", "realpathSync", "statSync"] as const;
  const originals = new Map<string, (...args: any[]) => any>();
  const reads = new Set<string>();
  const fileReads: { path: string; sha256: string }[] = [];
  const record = (value: unknown): void => {
    if (typeof value === "string") reads.add(value);
    else if (value instanceof URL && value.protocol === "file:") reads.add(fileURLToPath(value));
  };
  const globals = globalThis as typeof globalThis & { [SCANNER_READ_SYMBOL]?: (path: unknown, result: unknown) => void };
  const previousReadHook = globals[SCANNER_READ_SYMBOL];
  globals[SCANNER_READ_SYMBOL] = (path, result) => {
    if (typeof path !== "string") return;
    record(path);
    if (typeof result === "string") fileReads.push({ path, sha256: hashText(result) });
    else if (result instanceof Uint8Array) fileReads.push({ path, sha256: hashBytes(result) });
    previousReadHook?.(path, result);
  };
  for (const name of names) {
    const original = fs[name] as unknown as (...args: any[]) => any;
    originals.set(name, original);
    (fs as unknown as Record<string, unknown>)[name] = function observedFilesystemCall(this: unknown, path: unknown, ...args: any[]): unknown {
      record(path);
      if (name === "readFile") {
        const callback = args.at(-1) as (error: Error | null, data?: string | Uint8Array) => void;
        args[args.length - 1] = observedReadCallback(path, callback, globals);
      }
      const result = original.call(this, path, ...args);
      if (name === "readFileSync") globals[SCANNER_READ_SYMBOL]?.(path, result);
      return result;
    };
  }
  syncBuiltinESMExports();
  try {
    return {
      value: await action(),
      reads: [...reads].sort(byCodeUnit),
      fileReads: fileReads.sort((left, right) => byCodeUnit(left.path, right.path) || byCodeUnit(left.sha256, right.sha256)),
    };
  } finally {
    if (previousReadHook === undefined) delete globals[SCANNER_READ_SYMBOL];
    else globals[SCANNER_READ_SYMBOL] = previousReadHook;
    for (const name of names) (fs as unknown as Record<string, unknown>)[name] = originals.get(name);
    syncBuiltinESMExports();
  }
}

function observedReadCallback(
  path: unknown,
  callback: (error: Error | null, data?: string | Uint8Array) => void,
  globals: typeof globalThis & { [SCANNER_READ_SYMBOL]?: (path: unknown, result: unknown) => void },
): typeof callback {
  return (error, data): void => {
    if (error === null && data !== undefined) globals[SCANNER_READ_SYMBOL]?.(path, data);
    callback(error, data);
  };
}

let cwdScanTail: Promise<void> = Promise.resolve();

async function withScannerCwd<T>(rootDir: string, action: () => Promise<T>): Promise<T> {
  const previous = cwdScanTail;
  let release!: () => void;
  cwdScanTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  const cwd = process.cwd();
  process.chdir(rootDir);
  try {
    return await action();
  } finally {
    process.chdir(cwd);
    release();
  }
}

function readRuleSet(rootDir: string, path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), "utf8")) as unknown;
  } catch (error) {
    throw new ScanError(`could not read graph.cruiserConfig ${path}: ${(error as Error).message}`);
  }
}

/** Components of the application subgraph — the seeds the portfolio enumerates. */
export function computeSccs(graph: DependencyGraph, application?: string): Scc[] {
  return toSccs(buildApplicationGraph(graph, application).condensed);
}

/** Drop every cache the scanner and its AST probes keep. Tests call this between fixtures. */
export function resetGraphCaches(): void {
  graphCache.clear();
  resetSyntaxCaches();
  resetWorkspaceCaches();
}
