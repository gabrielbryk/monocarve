/** Commands that compile manifests without mutating the workspace. */

import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { buildPlanSync, serializeManifest } from "../plan/build.ts";
import { explainArtifact, explainDependency, formatPlanExplanation } from "../plan/explain.ts";
import { buildIntegrationTestPlanSync } from "../plan/integration-tests.ts";
import { refreshExtractionPlan } from "../plan/refresh.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { buildPortfolio, pickNext } from "../portfolio/index.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { showBaseline } from "../util/git.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { portfolioFor } from "./discovery.ts";
import {
  approvalGuidance,
  assertEligible,
  candidatePlanId,
  planOutput,
  publicSurfaceOption,
  recordApproval,
  refreshFlags,
  refuseExistingPlan,
  requireWriteForApproval,
  selectPlanCandidate,
  targetMode,
  targetOptions,
  verifyLockfileRoundTrip,
  writeManifestIfRequested,
} from "./planning-support.ts";
import { assertPlannableTree, load, loadGraph, loadManifest, outputPath, print, writeOutput, type LoadedGraph } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

export { approvalGuidance, narrowCandidate } from "./planning-support.ts";

async function plan(args: ParsedArgs): Promise<void> {
  requireWriteForApproval(args);
  const loaded = await loadGraph(args);
  const candidate = selectPlanCandidate(args, loaded, () => portfolioFor(args, loaded).candidates);
  const manifest = buildPlanSync({
    ...planBase(loaded),
    candidate,
    ...targetOptions(args, ["packageName", "packageRoot", "profile", "targetSubpath"]),
    ...publicSurfaceOption(args),
  });
  const out = planOutput(args, loaded, manifest);
  const written = flagBool(args, "write");
  const managedPlan = out === loaded.config.planDir || out.startsWith(`${loaded.config.planDir}/`);
  if (written && managedPlan) refuseExistingPlan(loaded.rootDir, out, manifest.baselineCommit);
  assertPlannableTree(loaded, manifest, out, args);
  const roundTrip = await verifyLockfileRoundTrip(args, loaded, manifest);
  if (written) refuseExistingPlan(loaded.rootDir, out, manifest.baselineCommit);
  writeManifestIfRequested(args, loaded, out, manifest);
  const approval = written ? recordApproval(args, loaded, manifest, out) : undefined;
  renderPlan(args, loaded, manifest, { out, written, roundTrip, approval });
}

/** The bounded operator review on a terminal; the full proof manifest for --json, --verbose, or a pipe. */
function renderPlan(
  args: ParsedArgs,
  loaded: LoadedGraph,
  manifest: ReturnType<typeof buildPlanSync>,
  outcome: {
    readonly out: string;
    readonly written: boolean;
    readonly roundTrip: Awaited<ReturnType<typeof verifyLockfileRoundTrip>>;
    readonly approval: ReturnType<typeof recordApproval> | undefined;
  },
): void {
  const { out, written, roundTrip, approval } = outcome;
  const mode = targetMode(loaded, manifest.target.packageRoot);
  if (flagBool(args, "json") || flagBool(args, "verbose") || !process.stdout.isTTY) {
    print(
      {
        ...manifest,
        targetMode: mode,
        targetPackageRoot: manifest.target.packageRoot,
        output: out,
        written,
        ...(roundTrip?.lockfileVerification === undefined ? {} : { lockfileVerification: roundTrip.lockfileVerification }),
        ...(approval === undefined ? {} : { approval: approvalGuidance(out, approval) }),
      },
      args,
    );
    return;
  }
  const review = summarizePlanReview(manifest, {
    baselinePaths: mode === "existing" ? [`${manifest.target.packageRoot}/package.json`] : [],
    manifestPath: out,
  });
  print(`${formatPlanReview(review).trimEnd()}\n\nOutput: ${out} (${written ? "written" : "dry run"})`, args);
}

/** Inputs every extraction plan is compiled from. */
function planBase(loaded: LoadedGraph) {
  return { config: loaded.config, rootDir: loaded.rootDir, graph: loaded.graph, context: loaded.context, baselineCommit: loaded.graph.commit ?? "HEAD" };
}

async function scope(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const input = flagString(args, "path") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("--path <source> is required");
  const packageName = flagString(args, "package-name");
  if (packageName === undefined) throw new UsageError("--package-name <name> is required; scope never infers architectural ownership");
  const path = relativeWorkspacePath(loaded.rootDir, input);
  const candidates = portfolioFor(args, loaded).candidates.filter((candidate) => candidate.seed.members.includes(path));
  const [candidate] = candidates;
  if (candidate === undefined)
    throw new UsageError(`no current principal candidate has seed path ${path}; it may already be extracted or outside the selected application`);
  if (candidates.length > 1)
    throw new UsageError(
      `seed path ${path} is ambiguous across candidates: ${candidates
        .map(({ id }) => id)
        .toSorted()
        .join(", ")}`,
    );
  assertEligible(args, candidate);
  const manifest = buildPlanSync({ ...planBase(loaded), candidate, packageName, ...targetOptions(args, ["packageRoot", "targetSubpath"]) });
  const out = planOutput(args, loaded, manifest);
  assertPlannableTree(loaded, manifest, out, args);
  const simulation = await verifyLockfileRoundTrip(args, loaded, manifest);
  const written = writeManifestIfRequested(args, loaded, out, manifest);
  const review = summarizePlanReview(manifest, {
    baselinePaths:
      showBaseline(loaded.rootDir, manifest.baselineCommit, `${manifest.target.packageRoot}/package.json`) === null
        ? []
        : [`${manifest.target.packageRoot}/package.json`],
    manifestPath: out,
  });
  // `scope` promises a concise operator review by default. Unlike `plan`, it is
  // commonly consumed through an agent subprocess where stdout is a pipe, so
  // using TTY detection here silently switched the default to the full
  // candidate + manifest payload (hundreds of kilobytes in a real workspace).
  // Machine output is explicit through --json; piping human output must not
  // change the command's semantics.
  print(
    flagBool(args, "json")
      ? { schema: "scope", path, candidate, review, manifest, output: out, written, ...(simulation ? { simulation } : {}) }
      : formatPlanReview(review).trimEnd(),
    args,
  );
}

async function relocateTests(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const suite = flagString(args, "suite") ?? args.positionals[0];
  if (suite === undefined) throw new UsageError("--suite <name> is required");
  const manifest = buildIntegrationTestPlanSync({ ...planBase(loaded), suite });
  const out = planOutput(args, loaded, manifest);
  assertPlannableTree(loaded, manifest, out, args);
  const written = writeManifestIfRequested(args, loaded, out, manifest);
  print({ ...manifest, output: out, written }, args);
}

async function next(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const portfolio = portfolioFor(args, loaded);
  const candidate = pickNext(portfolio, loaded.config.portfolio.extracted);
  if (!candidate) {
    print("no eligible candidates remain", args);
    return;
  }
  const manifest = buildPlanSync({ ...planBase(loaded), candidate, ...targetOptions(args, ["packageName", "profile"]) });
  const out = planOutput(args, loaded, manifest);
  assertPlannableTree(loaded, manifest, out, args);
  const written = writeManifestIfRequested(args, loaded, out, manifest);
  const summary = {
    schema: "next",
    candidate: candidate.id,
    application: candidate.application,
    packageName: manifest.target.packageName,
    packageRoot: manifest.target.packageRoot,
    targetMode: targetMode(loaded, manifest.target.packageRoot),
    targetPackageRoot: manifest.target.packageRoot,
    score: candidate.score,
    lineCount: candidate.lineCount,
    files: manifest.source.files.length,
    tests: manifest.source.tests.length,
    assets: manifest.source.assets?.length ?? 0,
    consumers: manifest.consumers.length,
    operations: manifest.operations.length,
    warnings: [
      ...candidate.warnings,
      ...(manifest.donorDependencyPruning?.candidates.map(
        ({ name, section }) =>
          `possible donor dependency orphan (${section}): ${name}; indexed source references are absent, but review non-source consumers before enabling removal`,
      ) ?? []),
    ],
    output: out,
    written,
  };
  if (flagBool(args, "apply")) {
    const simulation = await simulatePlan({
      config: loaded.config,
      rootDir: loaded.rootDir,
      manifest,
      ...(flagBool(args, "verify-lockfile") ? { verifyLockfile: true } : {}),
    });
    print({ ...summary, simulation }, args);
    if (!simulation.ok) process.exitCode = 1;
    return;
  }
  print(summary, args);
}

async function refresh(args: ParsedArgs): Promise<void> {
  const { outFlag, written } = refreshFlags(args);
  const loaded = await loadGraph(args);
  const { path, manifest } = await loadManifest(args, loaded.rootDir);
  const portfolio = buildPortfolio({
    config: loaded.config,
    graph: loaded.graph,
    context: loaded.context,
    application: manifest.application,
    includeExtracted: true,
  });
  const result = refreshExtractionPlan({
    manifest,
    config: loaded.config,
    rootDir: loaded.rootDir,
    graph: loaded.graph,
    resolveCandidate: (existing) => portfolio.candidates.find((candidate) => candidatePlanId(candidate.id, existing.target.profile) === existing.planId),
  });
  const output = outFlag === undefined ? undefined : outputPath(loaded.rootDir, outFlag);
  if (output === path) throw new UsageError("refresh output must differ from the input manifest path");
  const destination = written ? output : undefined;
  if (destination !== undefined) writeOutput(loaded.rootDir, destination, serializeManifest(result.manifest), { exclusive: true });
  const approval = destination === undefined ? undefined : approvalGuidance(destination, recordApproval(args, loaded, result.manifest, destination));
  print(
    {
      schema: "plan-refresh",
      input: path,
      previousBaselineCommit: result.previousBaselineCommit,
      currentBaselineCommit: result.currentBaselineCommit,
      semanticDiff: result.semanticDiff,
      manifest: result.manifest,
      ...(output === undefined ? {} : { output }),
      written,
      replaced: false,
      ...(approval === undefined ? {} : { approval }),
    },
    args,
  );
}

async function reviewPlan(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { path, manifest } = await loadManifest(args, loaded.rootDir);
  const packageManifest = `${manifest.target.packageRoot}/package.json`;
  const approvalSubject = flagString(args, "approval-subject");
  const summary = summarizePlanReview(manifest, {
    baselinePaths: showBaseline(loaded.rootDir, manifest.baselineCommit, packageManifest) === null ? [] : [packageManifest],
    manifestPath: path,
    ...(approvalSubject === undefined ? {} : { approvalSubject }),
  });
  print(flagBool(args, "json") ? summary : formatPlanReview(summary).trimEnd(), args);
}

async function explainPlan(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const { manifest } = await loadManifest(args, loaded.rootDir);
  const dependency = flagString(args, "dependency");
  const artifact = flagString(args, "artifact");
  if ((dependency === undefined) === (artifact === undefined)) throw new UsageError("exactly one of --dependency <name> or --artifact <path> is required");
  const explanation = dependency !== undefined ? explainDependency(manifest, dependency) : explainArtifact(manifest, artifact ?? "");
  print(flagBool(args, "json") ? explanation : formatPlanExplanation(explanation), args);
}

export const planningCommands: Record<string, CommandSpec> = {
  plan: {
    summary: "compile a hash-journaled extraction plan",
    usage:
      "plan --candidate <id> [--source <path> ...] [--profile <name> | --package-name <name> [--package-root <path>]] [--target-subpath <dir>] [--public-surface subpaths] [--force] [--verify-lockfile] [--out <path>] [--write [--commit-approval]] [--json | --verbose]",
    details:
      "Prints the bounded operator review by default; --json or --verbose emits the full proof manifest. Repeat --source to intentionally narrow a multi-SCC candidate. --package-name resolves a known workspace package root automatically; --package-root is an explicit override. --target-subpath lands every moved file directly in that directory of an existing package, by basename, instead of preserving the path it had below the application source root; it must be src or a directory below it, and colliding basenames are refused. --public-surface subpaths selects deterministic per-module exports when a barrel would have ambiguous bindings. A root containing package.json is extended, otherwise a new package is scaffolded. Low-confidence recommendations require an explicit target. --write reports exact review, approval, and apply actions; --commit-approval explicitly creates only the manifest approval commit.",
    run: plan,
  },
  scope: {
    summary: "resolve a stable source path and review its current plan",
    usage:
      "scope --path <source> --package-name <name> [--app <name>] [--package-root <path>] [--target-subpath <dir>] [--verify-lockfile] [--out <path>] [--write] [--json]",
    details:
      "Resolves the current principal SCC candidate from a stable source path. It requires an intentional target, prints a concise review by default, and never writes unless --write is explicit. --target-subpath names the destination directory inside an existing package, overriding the structure-preserving default.",
    run: scope,
  },
  "plan-review": {
    summary: "render the deterministic operator review for a plan",
    usage: "plan-review --plan <path> [--approval-subject <subject>] [--json]",
    details:
      "Reads the manifest and its Git baseline without changing the workspace. The review exposes exact move targets, wiring and public-surface changes, generated outputs, gates, warnings, and the subject/path inputs used for approval.",
    run: reviewPlan,
  },
  explain: {
    summary: "explain why a plan changes one dependency or artifact",
    usage: "explain --plan <path> (--dependency <name> | --artifact <path>) [--json]",
    details: "Read-only. Reports persisted dependency source/reason evidence or the exact operation chain and projected final hash for an artifact.",
    run: explainPlan,
  },
  "relocate-tests": {
    summary: "compile a configured integration-test package",
    usage: "relocate-tests --suite <name> [--out <path>] [--write]",
    details: "The suite and all target/scaffold policy come from configuration.",
    run: relocateTests,
  },
  next: {
    summary: "pick and plan the highest-scoring candidate",
    usage: "next [--app <name>] [--profile <name>] [--package-name <name>] [--write] [--apply] [--verify-lockfile]",
    details: "--apply runs simulation only; it does not commit. Use plan when you need an explicit candidate or package root.",
    run: next,
  },
  refresh: {
    summary: "safely recompile a stale extraction plan at HEAD",
    usage: "refresh --plan <path> [--out <new-path> --write [--commit-approval]]",
    details:
      "Read-only by default. Refuses dirty workspaces and candidate, application, target/profile, closure, source-byte, or configured execution-policy drift. Written refreshes use a distinct exclusive path and require fresh review; the input manifest is immutable.",
    run: refresh,
  },
};
