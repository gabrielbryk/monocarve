/**
 * Helpers shared by the plan-compiling command handlers in planning.ts.
 *
 * Candidate narrowing and lockfile round-trip checks are extraction-planning
 * logic that would ideally live in src/plan; they stay here, beside their only
 * callers, because src/plan is owned separately. Everything else is flag
 * parsing and output plumbing.
 */

import { existsSync, readFileSync } from "node:fs";

import type { ManifestApprovalCommit, ManifestApprovalEvidence } from "../approval/index.ts";
import { recordManifestApproval } from "../approval/index.ts";
import { TOOL_NAME } from "../branding.ts";
import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { serializeManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import type { PortfolioCandidate } from "../portfolio/index.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { outputPath, writeOutput, type LoadedGraph } from "./shared.ts";

const TARGET_FLAGS = { packageName: "package-name", packageRoot: "package-root", profile: "profile", targetSubpath: "target-subpath" } as const;
type TargetOption = keyof typeof TARGET_FLAGS;

/** The named target flags that were given, as `buildPlanSync` options. */
export function targetOptions(args: ParsedArgs, names: readonly TargetOption[]): { [K in TargetOption]?: string } {
  const options: { [K in TargetOption]?: string } = {};
  for (const name of names) {
    const value = flagString(args, TARGET_FLAGS[name]);
    if (value !== undefined) options[name] = value;
  }
  return options;
}

export function requireWriteForApproval(args: ParsedArgs): void {
  if (flagBool(args, "commit-approval") && !flagBool(args, "write")) throw new UsageError("--commit-approval requires --write");
}

/** Validate `refresh`'s output flags: it writes only to an explicit, distinct `--out`. */
export function refreshFlags(args: ParsedArgs): { readonly outFlag: string | undefined; readonly written: boolean } {
  const outFlag = flagString(args, "out");
  const written = flagBool(args, "write");
  requireWriteForApproval(args);
  if (flagBool(args, "replace")) throw new UsageError("--replace is no longer supported; refresh always writes a distinct manifest for review");
  if (written && outFlag === undefined) throw new UsageError("--write requires an explicit --out <path>; refresh never overwrites its input implicitly");
  return { outFlag, written };
}

/** The plan id a candidate compiles to: its id, suffixed with the profile name when a profile targets it. */
export function candidatePlanId(candidateId: string, profile: { readonly name: string } | undefined): string {
  return profile === undefined ? candidateId : `${candidateId}--${profile.name}`;
}

/** `--out`, or the managed plan path `<planDir>/<planId>.json`. */
export function planOutput(args: ParsedArgs, loaded: LoadedGraph, manifest: { readonly planId: string }): string {
  return outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
}

/** Write the manifest when `--write` is set; returns whether it was written. */
export function writeManifestIfRequested(args: ParsedArgs, loaded: LoadedGraph, out: string, manifest: ExtractionManifest): boolean {
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
  return written;
}

/** Run a gate-less simulation to prove the lockfile round-trips, when `--verify-lockfile` asks for it. */
export async function verifyLockfileRoundTrip(args: ParsedArgs, loaded: LoadedGraph, manifest: ExtractionManifest) {
  if (!flagBool(args, "verify-lockfile")) return undefined;
  const simulation = await simulatePlan({ config: loaded.config, rootDir: loaded.rootDir, manifest, verifyLockfile: true, skipGates: true });
  if (!simulation.ok) throw new PlanningError(`plan lockfile round-trip failed: ${simulation.failure ?? "unknown failure"}`);
  return simulation;
}

export function recordApproval(args: ParsedArgs, loaded: LoadedGraph, manifest: ExtractionManifest, manifestPath: string) {
  return recordManifestApproval({ config: loaded.config, rootDir: loaded.rootDir, manifest, manifestPath }, flagBool(args, "commit-approval"));
}

/** Refuse to replace a plan already on disk; the error names both baselines and the refresh command. */
export function refuseExistingPlan(rootDir: string, path: string, currentBaseline: string): void {
  if (existsSync(`${rootDir}/${path}`)) throw existingPlanError(rootDir, path, currentBaseline);
}

function existingPlanError(rootDir: string, path: string, currentBaseline: string): UsageError {
  let existingBaseline = "unknown";
  try {
    const parsed: unknown = JSON.parse(readFileSync(`${rootDir}/${path}`, "utf8"));
    const baseline: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "baselineCommit") : undefined;
    if (typeof baseline === "string") existingBaseline = baseline;
  } catch {
    // A malformed existing file is still operator-owned and must not be overwritten.
  }
  return new UsageError(
    `refusing to overwrite existing plan ${path}; existing baseline ${existingBaseline}, current baseline ${currentBaseline}. ` +
      `The existing file was not changed. Refresh it explicitly with ${TOOL_NAME} refresh --plan ${JSON.stringify(path)} --out <new-path> --write`,
  );
}

/** Classify against the scanned baseline inventory, not files created by this plan. */
export function targetMode(loaded: LoadedGraph, packageRoot: string): "existing" | "new" {
  return loaded.graph.workspace.owners.includes(packageRoot) ? "existing" : "new";
}

/** Refuse an ineligible candidate unless `--force`. */
export function assertEligible(args: ParsedArgs, candidate: Pick<PortfolioCandidate, "id" | "eligible" | "rejectionReasons">): void {
  if (candidate.eligible || flagBool(args, "force")) return;
  throw new UsageError(`candidate ${candidate.id} is not eligible: ${candidate.rejectionReasons.map(({ detail }) => detail).join("; ")}`);
}

/** Resolve `plan`'s candidate: look it up, narrow it to `--source` files, and check eligibility and target intent. */
export function selectPlanCandidate(args: ParsedArgs, loaded: LoadedGraph, candidates: () => readonly PortfolioCandidate[]): PortfolioCandidate {
  const candidateId = flagString(args, "candidate") ?? args.positionals[0];
  if (candidateId === undefined) throw new UsageError("--candidate <id> is required");
  const candidate = candidates().find((entry) => entry.id === candidateId);
  if (!candidate) throw new UsageError(`no candidate with id ${candidateId}`);
  const selectedSources = (args.repeated.get("source") ?? []).map((source) => relativeWorkspacePath(loaded.rootDir, source));
  const narrowed = selectedSources.length === 0 ? candidate : narrowCandidate(candidate, selectedSources, loaded.graph);
  assertEligible(args, narrowed);
  if (candidate.recommendation?.requiresExplicitPackageName && flagString(args, "package-name") === undefined && flagString(args, "profile") === undefined) {
    throw new UsageError(
      `candidate ${candidate.id} requires an explicit --package-name because its architectural recommendation is ${candidate.recommendation.status}`,
    );
  }
  return narrowed;
}

/** `--public-surface subpaths`, as a `buildPlanSync` option. */
export function publicSurfaceOption(args: ParsedArgs) {
  const publicSurface = flagString(args, "public-surface");
  if (publicSurface === undefined) return {};
  if (publicSurface !== "subpaths") throw new UsageError("--public-surface currently supports only subpaths");
  return { publicSurface: { mode: "subpaths" as const, keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" } };
}

/** Narrow a candidate to a closed `--source` selection, keeping only the tests, assets, escapes, and SCCs it reaches. */
export function narrowCandidate<C extends PortfolioCandidate>(candidate: C, sources: readonly string[], graph: LoadedGraph["graph"]): C {
  const wanted = new Set(sources);
  const files = candidate.files.filter((file) => wanted.has(file));
  if (files.length !== sources.length) throw new UsageError(`--source must name candidate production files; requested ${sources.join(", ")}`);
  const missing = [
    ...new Set(files.flatMap((file) => (graph.outgoing.get(file) ?? []).filter((target) => candidate.files.includes(target) && !wanted.has(target)))),
  ].toSorted();
  if (missing.length > 0) throw new UsageError(`--source selection is not closed; also select required candidate files: ${missing.join(", ")}`);
  const tests = candidate.tests.filter(
    (test) => test.startsWith(files[0]?.replace(/\.tsx?$/, "") ?? "") || files.some((file) => test.startsWith(file.replace(/\.tsx?$/, ""))),
  );
  const selected = new Set([...files, ...tests]);
  const reachableAssets = assetsReachableFrom(files, wanted, candidate.assets, graph);
  return {
    ...candidate,
    files,
    tests,
    assets: candidate.assets.filter((asset) => reachableAssets.has(asset)),
    rewriteEscapes: candidate.rewriteEscapes.filter((escape) => selected.has(escape.file)),
    sccs: candidate.sccs.filter((scc) => scc.members.some((member) => wanted.has(member))),
  };
}

function assetsReachableFrom(files: readonly string[], wanted: ReadonlySet<string>, assets: readonly string[], graph: LoadedGraph["graph"]): Set<string> {
  const reachable = new Set<string>();
  const pending = [...files];
  const visited = new Set<string>();
  for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
    if (visited.has(source)) continue;
    visited.add(source);
    const targets = graph.outgoing.get(source) ?? [];
    for (const asset of targets.filter((target) => assets.includes(target))) reachable.add(asset);
    pending.push(...targets.filter((target) => !assets.includes(target) && wanted.has(target)));
  }
  return reachable;
}

export function approvalGuidance(out: string, evidence: ManifestApprovalEvidence | ManifestApprovalCommit) {
  const approve = [TOOL_NAME, "approve", "--plan", out, "--commit"] as const;
  const apply = [TOOL_NAME, "apply", "--plan", out, "--commit"] as const;
  return {
    manifestPath: evidence.manifestPath,
    subject: evidence.subject,
    gitAdd: evidence.gitAdd,
    ...("commit" in evidence ? {} : { approve }),
    apply,
    workflow: { failFast: true, steps: "commit" in evidence ? [apply] : [approve, apply] },
    ...("commit" in evidence ? { commit: evidence.commit } : {}),
  };
}
