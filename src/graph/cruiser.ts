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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cruise } from "dependency-cruiser";

import { getApplication, type MonocarveConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import { headCommit } from "../util/git.ts";
import { hashJson } from "../util/hash.ts";
import { buildDependencyGraph, type ScanReport } from "./build.ts";
import { buildApplicationGraph, toSccs } from "./components.ts";
import type { DependencyGraph, Scc } from "./model.ts";
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
  const key = `${rootDir}|${applications.map((app) => app.name).join(",")}|${commit ?? "none"}|${hashJson(config)}`;
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
  const reports: Record<string, ScanReport> = {};
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
    const result = await cruise(
      [app.sourceRoot],
      {
        tsPreCompilationDeps: config.graph.tsPreCompilationDeps,
        doNotFollow: { path: "node_modules" },
        // Only set when the caller asked for it: an `exclude` entry deletes the
        // edges pointing at the excluded module, not just the module.
        ...(config.graph.exclude.length > 0 ? { exclude: { path: config.graph.exclude } } : {}),
        tsConfig: { fileName: app.tsconfig },
        ...(config.graph.cruiserConfig ? { ruleSet: readRuleSet(rootDir, config.graph.cruiserConfig) } : {}),
      } as never,
      undefined,
      undefined,
    );
    const output = result.output;
    if (typeof output === "string") throw new ScanError(`scanner returned formatted output for ${name}`);
    return { modules: output.modules as ScanReport["modules"] };
  });
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
