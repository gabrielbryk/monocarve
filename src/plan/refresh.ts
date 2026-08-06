/** Safe recompilation of a stale extraction plan against the current HEAD. */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { headCommit, statusShort } from "../util/git.ts";
import { stableStringify } from "../util/hash.ts";
import { buildPlanSync, parseManifest } from "./build.ts";
import { PlanningError } from "./context.ts";
import type { ExtractionManifest } from "./manifest.ts";

export interface RefreshPlanOptions {
  readonly manifest: ExtractionManifest | string;
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  /** Resolve from the current portfolio; returning a replacement candidate is unsafe. */
  readonly resolveCandidate: (existing: ExtractionManifest) => PortfolioCandidate | undefined;
}

export interface ManifestChange {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface RefreshPlanResult {
  readonly manifest: ExtractionManifest;
  readonly previousBaselineCommit: string;
  readonly currentBaselineCommit: string;
  /** Changes requiring review, excluding commit/date/graph provenance advancement. */
  readonly semanticDiff: readonly ManifestChange[];
}

const PROVENANCE_FIELDS = new Set(["baselineCommit", "createdAt", "graphDigest"]);

/**
 * Recompile without writing. A refusal means the old approval no longer identifies
 * the extraction being planned, so the operator must create and review a new plan.
 */
export function refreshExtractionPlan(options: RefreshPlanOptions): RefreshPlanResult {
  const existing = loadManifest(options.rootDir, options.manifest);
  const currentHead = headCommit(options.rootDir);
  if (statusShort(options.rootDir) !== "") {
    throw new PlanningError("cannot refresh from a dirty workspace; commit or restore changes so the graph and files describe HEAD");
  }
  if (options.graph.commit !== currentHead) {
    throw new PlanningError(`cannot refresh with a stale graph: graph is ${options.graph.commit ?? "uncommitted"}, HEAD is ${currentHead}`);
  }

  const candidate = options.resolveCandidate(existing);
  if (candidate === undefined) throw new PlanningError(`cannot refresh plan ${existing.planId}: candidate no longer resolves; compile a new plan`);
  if (candidate.application !== existing.application) {
    throw new PlanningError(`cannot refresh plan ${existing.planId}: application changed from ${existing.application} to ${candidate.application}; compile a new plan`);
  }

  const profile = existing.target.profile?.name;
  const refreshed = buildPlanSync({
    config: options.config,
    rootDir: options.rootDir,
    graph: options.graph,
    candidate,
    baselineCommit: currentHead,
    ...(profile === undefined
      ? { packageName: existing.target.packageName, packageRoot: existing.target.packageRoot }
      : { profile }),
  });

  assertSame("candidate identity", existing.planId, refreshed.planId);
  assertSame("application", existing.application, refreshed.application);
  assertSame("target identity", targetIdentity(existing), targetIdentity(refreshed));
  assertSame("source closure", existing.source, refreshed.source);
  assertSame("source blobs", existing.sourceBlobs, refreshed.sourceBlobs);
  // These values encode configuration that controls execution. If they drift,
  // a refresh could otherwise bless different gates or commit policy as though
  // only HEAD had advanced.
  assertSame("configured gates", existing.gates, refreshed.gates);
  assertSame("configured commits", existing.commits, refreshed.commits);
  if (existing.provenance !== undefined) {
    assertSame("configuration provenance", existing.provenance.configDigest, refreshed.provenance?.configDigest);
    assertSame("planning policy provenance", existing.provenance.policyDigest, refreshed.provenance?.policyDigest);
    assertSame("adapter provenance", existing.provenance.adapters, refreshed.provenance?.adapters);
  }

  return {
    manifest: refreshed,
    previousBaselineCommit: existing.baselineCommit,
    currentBaselineCommit: currentHead,
    semanticDiff: manifestDiff(existing, refreshed),
  };
}

function loadManifest(rootDir: string, input: ExtractionManifest | string): ExtractionManifest {
  if (typeof input !== "string") return input;
  const path = isAbsolute(input) ? input : resolve(rootDir, input);
  return parseManifest(readFileSync(path, "utf8"), path);
}

function targetIdentity(manifest: ExtractionManifest): unknown {
  const { packageName, packageRoot, entrypoint, projectId, profile } = manifest.target;
  return { packageName, packageRoot, entrypoint, projectId, profile };
}

function assertSame(label: string, before: unknown, after: unknown): void {
  if (stableStringify(before) !== stableStringify(after)) {
    throw new PlanningError(`cannot refresh plan: ${label} changed; compile a new plan`);
  }
}

export function manifestDiff(before: ExtractionManifest, after: ExtractionManifest): ManifestChange[] {
  const changes: ManifestChange[] = [];
  diffValue(before, after, "", changes);
  return changes;
}

function diffValue(before: unknown, after: unknown, path: string, changes: ManifestChange[]): void {
  if (stableStringify(before) === stableStringify(after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      if (path === "" && PROVENANCE_FIELDS.has(key)) continue;
      diffValue(before[key], after[key], path === "" ? key : `${path}.${key}`, changes);
    }
    return;
  }
  changes.push({ path, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
