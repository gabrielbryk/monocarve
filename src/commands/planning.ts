/** Commands that compile manifests without mutating the workspace. */

import { existsSync, readFileSync } from "node:fs";

import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { commitManifestApproval, manifestApprovalEvidence } from "../approval/index.ts";
import type { ManifestApprovalCommit, ManifestApprovalEvidence } from "../approval/index.ts";
import { TOOL_NAME } from "../branding.ts";
import { UsageError } from "../errors.ts";
import { buildPortfolio, pickNext } from "../portfolio/index.ts";
import { buildPlanSync, serializeManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import { buildIntegrationTestPlanSync } from "../plan/integration-tests.ts";
import { refreshExtractionPlan } from "../plan/refresh.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { explainArtifact, explainDependency, formatPlanExplanation } from "../plan/explain.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { showBaseline } from "../util/git.ts";
import type { CommandSpec } from "./types.ts";
import { assertPlannableTree, load, loadGraph, loadManifest, outputPath, print, writeOutput, type LoadedGraph } from "./shared.ts";
import { portfolioFor } from "./discovery.ts";
import { relativeWorkspacePath } from "../util/paths.ts";

async function plan(args: ParsedArgs): Promise<void> {
  if (flagBool(args, "commit-approval") && !flagBool(args, "write")) {
    throw new UsageError("--commit-approval requires --write");
  }
  const loaded = await loadGraph(args);
  const candidateId = flagString(args, "candidate") ?? args.positionals[0];
  if (candidateId === undefined) throw new UsageError("--candidate <id> is required");
  const portfolio = portfolioFor(args, loaded);
  const candidate = portfolio.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) throw new UsageError(`no candidate with id ${candidateId}`);
  const sourceFlags = args.repeated.get("source") ?? [];
  const selectedSources = sourceFlags.map((source) => relativeWorkspacePath(loaded.rootDir, source));
  const narrowed = selectedSources.length === 0 ? candidate : narrowCandidate(candidate, selectedSources, loaded.graph);
  if (!narrowed.eligible && !flagBool(args, "force")) {
    throw new UsageError(`candidate ${candidateId} is not eligible: ${narrowed.rejectionReasons.map((reason) => reason.detail).join("; ")}`);
  }
  const packageName = flagString(args, "package-name");
  if (candidate.recommendation?.requiresExplicitPackageName && packageName === undefined && flagString(args, "profile") === undefined) {
    throw new UsageError(`candidate ${candidate.id} requires an explicit --package-name because its architectural recommendation is ${candidate.recommendation.status}`);
  }
  const packageRoot = flagString(args, "package-root");
  const profile = flagString(args, "profile");
  const targetSubpath = flagString(args, "target-subpath");
  const publicSurface = flagString(args, "public-surface");
  if (publicSurface !== undefined && publicSurface !== "subpaths") throw new UsageError("--public-surface currently supports only subpaths");
  const manifest = buildPlanSync({
    config: loaded.config, rootDir: loaded.rootDir, graph: loaded.graph, context: loaded.context,
    candidate: narrowed, baselineCommit: loaded.graph.commit ?? "HEAD",
    ...(packageName === undefined ? {} : { packageName }),
    ...(packageRoot === undefined ? {} : { packageRoot }),
    ...(profile === undefined ? {} : { profile }),
    ...(targetSubpath === undefined ? {} : { targetSubpath }),
    ...(publicSurface === undefined ? {} : { publicSurface: { mode: "subpaths" as const, keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" } }),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  const written = flagBool(args, "write");
  const managedPlan = out === loaded.config.planDir || out.startsWith(`${loaded.config.planDir}/`);
  if (written && managedPlan && existsSync(`${loaded.rootDir}/${out}`)) {
    throw existingPlanError(loaded.rootDir, out, manifest.baselineCommit);
  }
  assertPlannableTree(loaded, manifest, out, args);
  const roundTrip = flagBool(args, "verify-lockfile")
    ? await simulatePlan({ config: loaded.config, rootDir: loaded.rootDir, manifest, verifyLockfile: true, skipGates: true })
    : undefined;
  if (roundTrip && !roundTrip.ok) throw new PlanningError(`plan lockfile round-trip failed: ${roundTrip.failure ?? "unknown failure"}`);
  if (written && existsSync(`${loaded.rootDir}/${out}`)) {
    throw existingPlanError(loaded.rootDir, out, manifest.baselineCommit);
  }
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
  const approval = written
    ? flagBool(args, "commit-approval")
      ? commitManifestApproval({ config: loaded.config, rootDir: loaded.rootDir, manifest, manifestPath: out })
      : manifestApprovalEvidence({ config: loaded.config, rootDir: loaded.rootDir, manifest, manifestPath: out })
    : undefined;
  const full = {
    ...manifest,
    targetMode: targetMode(loaded, manifest.target.packageRoot), targetPackageRoot: manifest.target.packageRoot,
    output: out, written,
    ...(roundTrip?.lockfileVerification === undefined ? {} : { lockfileVerification: roundTrip.lockfileVerification }),
    ...(approval === undefined ? {} : { approval: approvalGuidance(out, approval) }),
  };
  if (flagBool(args, "json") || flagBool(args, "verbose") || !process.stdout.isTTY) {
    print(full, args);
  } else {
    const review = summarizePlanReview(manifest, {
      baselinePaths: targetMode(loaded, manifest.target.packageRoot) === "existing"
        ? [`${manifest.target.packageRoot}/package.json`] : [],
      manifestPath: out,
    });
    print(`${formatPlanReview(review).trimEnd()}\n\nOutput: ${out} (${written ? "written" : "dry run"})`, args);
  }
}

export function narrowCandidate(candidate: Awaited<ReturnType<typeof portfolioFor>>["candidates"][number], sources: readonly string[], graph: LoadedGraph["graph"]) {
  const wanted = new Set(sources);
  const files = candidate.files.filter((file) => wanted.has(file));
  if (files.length !== sources.length) throw new UsageError(`--source must name candidate production files; requested ${sources.join(", ")}`);
  const missing = [...new Set(files.flatMap((file) => (graph.outgoing.get(file) ?? []).filter((target) => candidate.files.includes(target) && !wanted.has(target))))].sort();
  if (missing.length > 0) throw new UsageError(`--source selection is not closed; also select required candidate files: ${missing.join(", ")}`);
  const tests = candidate.tests.filter((test) => test.startsWith(`${files[0]?.replace(/\.tsx?$/, "") ?? ""}`) || files.some((file) => test.startsWith(file.replace(/\.tsx?$/, ""))));
  const selected = new Set([...files, ...tests]);
  const reachableAssets = new Set<string>();
  const pending = [...files];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const source = pending.pop()!;
    if (visited.has(source)) continue;
    visited.add(source);
    for (const target of graph.outgoing.get(source) ?? []) {
      if (candidate.assets.includes(target)) reachableAssets.add(target);
      else if (wanted.has(target)) pending.push(target);
    }
  }
  const sccs = candidate.sccs.filter((scc) => scc.members.some((member) => wanted.has(member)));
  return {
    ...candidate,
    files,
    tests,
    assets: candidate.assets.filter((asset) => reachableAssets.has(asset)),
    rewriteEscapes: candidate.rewriteEscapes.filter((escape) => selected.has(escape.file)),
    sccs,
  };
}

async function scope(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const input = flagString(args, "path") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("--path <source> is required");
  const packageName = flagString(args, "package-name");
  if (packageName === undefined) throw new UsageError("--package-name <name> is required; scope never infers architectural ownership");
  const path = relativeWorkspacePath(loaded.rootDir, input);
  const candidates = portfolioFor(args, loaded).candidates.filter((candidate) => candidate.seed.members.includes(path));
  if (candidates.length === 0) throw new UsageError(`no current principal candidate has seed path ${path}; it may already be extracted or outside the selected application`);
  if (candidates.length > 1) throw new UsageError(`seed path ${path} is ambiguous across candidates: ${candidates.map(({ id }) => id).sort().join(", ")}`);
  const candidate = candidates[0]!;
  if (!candidate.eligible && !flagBool(args, "force")) {
    throw new UsageError(`candidate ${candidate.id} is not eligible: ${candidate.rejectionReasons.map(({ detail }) => detail).join("; ")}`);
  }
  const packageRoot = flagString(args, "package-root");
  const targetSubpath = flagString(args, "target-subpath");
  const manifest = buildPlanSync({
    config: loaded.config, rootDir: loaded.rootDir, graph: loaded.graph, context: loaded.context,
    candidate, baselineCommit: loaded.graph.commit ?? "HEAD", packageName,
    ...(packageRoot === undefined ? {} : { packageRoot }),
    ...(targetSubpath === undefined ? {} : { targetSubpath }),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  assertPlannableTree(loaded, manifest, out, args);
  const simulation = flagBool(args, "verify-lockfile")
    ? await simulatePlan({ config: loaded.config, rootDir: loaded.rootDir, manifest, verifyLockfile: true, skipGates: true })
    : undefined;
  if (simulation && !simulation.ok) throw new PlanningError(`plan lockfile round-trip failed: ${simulation.failure ?? "unknown failure"}`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
  const review = summarizePlanReview(manifest, {
    baselinePaths: showBaseline(loaded.rootDir, manifest.baselineCommit, `${manifest.target.packageRoot}/package.json`) === null
      ? [] : [`${manifest.target.packageRoot}/package.json`],
    manifestPath: out,
  });
  // `scope` promises a concise operator review by default. Unlike `plan`, it is
  // commonly consumed through an agent subprocess where stdout is a pipe, so
  // using TTY detection here silently switched the default to the full
  // candidate + manifest payload (hundreds of kilobytes in a real workspace).
  // Machine output is explicit through --json; piping human output must not
  // change the command's semantics.
  print(flagBool(args, "json")
    ? { schema: "scope", path, candidate, review, manifest, output: out, written, ...(simulation ? { simulation } : {}) }
    : formatPlanReview(review).trimEnd(), args);
}

function existingPlanError(rootDir: string, path: string, currentBaseline: string): UsageError {
  let existingBaseline = "unknown";
  try {
    const parsed = JSON.parse(readFileSync(`${rootDir}/${path}`, "utf8")) as { baselineCommit?: unknown };
    if (typeof parsed.baselineCommit === "string") existingBaseline = parsed.baselineCommit;
  } catch {
    // A malformed existing file is still operator-owned and must not be overwritten.
  }
  return new UsageError(
    `refusing to overwrite existing plan ${path}; existing baseline ${existingBaseline}, current baseline ${currentBaseline}. `
    + `The existing file was not changed. Refresh it explicitly with ${TOOL_NAME} refresh --plan ${JSON.stringify(path)} --out <new-path> --write`,
  );
}

async function relocateTests(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const suite = flagString(args, "suite") ?? args.positionals[0];
  if (suite === undefined) throw new UsageError("--suite <name> is required");
  const manifest = buildIntegrationTestPlanSync({
    config: loaded.config, rootDir: loaded.rootDir, graph: loaded.graph, context: loaded.context,
    suite, baselineCommit: loaded.graph.commit ?? "HEAD",
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  assertPlannableTree(loaded, manifest, out, args);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
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
  const packageName = flagString(args, "package-name");
  const profile = flagString(args, "profile");
  const manifest = buildPlanSync({
    config: loaded.config, rootDir: loaded.rootDir, graph: loaded.graph, context: loaded.context,
    candidate, baselineCommit: loaded.graph.commit ?? "HEAD",
    ...(packageName === undefined ? {} : { packageName }),
    ...(profile === undefined ? {} : { profile }),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  assertPlannableTree(loaded, manifest, out, args);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
  const summary = {
    schema: "next", candidate: candidate.id, application: candidate.application,
    packageName: manifest.target.packageName, packageRoot: manifest.target.packageRoot,
    targetMode: targetMode(loaded, manifest.target.packageRoot), targetPackageRoot: manifest.target.packageRoot,
    score: candidate.score, lineCount: candidate.lineCount, files: manifest.source.files.length,
    tests: manifest.source.tests.length, assets: manifest.source.assets?.length ?? 0,
    consumers: manifest.consumers.length, operations: manifest.operations.length,
    warnings: [...candidate.warnings, ...(manifest.donorDependencyPruning?.candidates.map(({ name, section }) =>
      `possible donor dependency orphan (${section}): ${name}; indexed source references are absent, but review non-source consumers before enabling removal`
    ) ?? [])], output: out, written,
  };
  if (flagBool(args, "apply")) {
    const simulation = await simulatePlan({
      config: loaded.config, rootDir: loaded.rootDir, manifest,
      ...(flagBool(args, "verify-lockfile") ? { verifyLockfile: true } : {}),
    });
    print({ ...summary, simulation }, args);
    if (!simulation.ok) process.exitCode = 1;
    return;
  }
  print(summary, args);
}

async function refresh(args: ParsedArgs): Promise<void> {
  const outFlag = flagString(args, "out");
  const written = flagBool(args, "write");
  if (flagBool(args, "commit-approval") && !written) throw new UsageError("--commit-approval requires --write");
  if (flagBool(args, "replace")) throw new UsageError("--replace is no longer supported; refresh always writes a distinct manifest for review");
  if (written && outFlag === undefined) {
    throw new UsageError("--write requires an explicit --out <path>; refresh never overwrites its input implicitly");
  }
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
    resolveCandidate: (existing) => portfolio.candidates.find((candidate) =>
      existing.target.profile === undefined
        ? candidate.id === existing.planId
        : `${candidate.id}--${existing.target.profile.name}` === existing.planId),
  });
  const output = outFlag === undefined ? undefined : outputPath(loaded.rootDir, outFlag);
  if (output === path) throw new UsageError("refresh output must differ from the input manifest path");
  if (written && output !== undefined) writeOutput(loaded.rootDir, output, serializeManifest(result.manifest), { exclusive: true });
  const approval = written && output !== undefined
    ? flagBool(args, "commit-approval")
      ? commitManifestApproval({ config: loaded.config, rootDir: loaded.rootDir, manifest: result.manifest, manifestPath: output })
      : manifestApprovalEvidence({ config: loaded.config, rootDir: loaded.rootDir, manifest: result.manifest, manifestPath: output })
    : undefined;
  print({
    schema: "plan-refresh",
    input: path,
    previousBaselineCommit: result.previousBaselineCommit,
    currentBaselineCommit: result.currentBaselineCommit,
    semanticDiff: result.semanticDiff,
    manifest: result.manifest,
    ...(output === undefined ? {} : { output }),
    written,
    replaced: false,
    ...(approval === undefined ? {} : { approval: approvalGuidance(output!, approval) }),
  }, args);
}

/** Classify against the scanned baseline inventory, not files created by this plan. */
function targetMode(loaded: Awaited<ReturnType<typeof loadGraph>>, packageRoot: string): "existing" | "new" {
  return loaded.graph.workspace.owners.includes(packageRoot) ? "existing" : "new";
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
  const explanation = dependency === undefined ? explainArtifact(manifest, artifact!) : explainDependency(manifest, dependency);
  print(flagBool(args, "json") ? explanation : formatPlanExplanation(explanation), args);
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

export const planningCommands: Record<string, CommandSpec> = {
  plan: { summary: "compile a hash-journaled extraction plan", usage: "plan --candidate <id> [--source <path> ...] [--profile <name> | --package-name <name> [--package-root <path>]] [--target-subpath <dir>] [--public-surface subpaths] [--force] [--verify-lockfile] [--out <path>] [--write [--commit-approval]] [--json | --verbose]", details: "Prints the bounded operator review by default; --json or --verbose emits the full proof manifest. Repeat --source to intentionally narrow a multi-SCC candidate. --package-name resolves a known workspace package root automatically; --package-root is an explicit override. --target-subpath lands every moved file directly in that directory of an existing package, by basename, instead of preserving the path it had below the application source root; it must be src or a directory below it, and colliding basenames are refused. --public-surface subpaths selects deterministic per-module exports when a barrel would have ambiguous bindings. A root containing package.json is extended, otherwise a new package is scaffolded. Low-confidence recommendations require an explicit target. --write reports exact review, approval, and apply actions; --commit-approval explicitly creates only the manifest approval commit.", run: plan },
  scope: { summary: "resolve a stable source path and review its current plan", usage: "scope --path <source> --package-name <name> [--app <name>] [--package-root <path>] [--target-subpath <dir>] [--verify-lockfile] [--out <path>] [--write] [--json]", details: "Resolves the current principal SCC candidate from a stable source path. It requires an intentional target, prints a concise review by default, and never writes unless --write is explicit. --target-subpath names the destination directory inside an existing package, overriding the structure-preserving default.", run: scope },
  "plan-review": { summary: "render the deterministic operator review for a plan", usage: "plan-review --plan <path> [--approval-subject <subject>] [--json]", details: "Reads the manifest and its Git baseline without changing the workspace. The review exposes exact move targets, wiring and public-surface changes, generated outputs, gates, warnings, and the subject/path inputs used for approval.", run: reviewPlan },
  explain: { summary: "explain why a plan changes one dependency or artifact", usage: "explain --plan <path> (--dependency <name> | --artifact <path>) [--json]", details: "Read-only. Reports persisted dependency source/reason evidence or the exact operation chain and projected final hash for an artifact.", run: explainPlan },
  "relocate-tests": { summary: "compile a configured integration-test package", usage: "relocate-tests --suite <name> [--out <path>] [--write]", details: "The suite and all target/scaffold policy come from configuration.", run: relocateTests },
  next: { summary: "pick and plan the highest-scoring candidate", usage: "next [--app <name>] [--profile <name>] [--package-name <name>] [--write] [--apply] [--verify-lockfile]", details: "--apply runs simulation only; it does not commit. Use plan when you need an explicit candidate or package root.", run: next },
  refresh: { summary: "safely recompile a stale extraction plan at HEAD", usage: "refresh --plan <path> [--out <new-path> --write [--commit-approval]]", details: "Read-only by default. Refuses dirty workspaces and candidate, application, target/profile, closure, source-byte, or configured execution-policy drift. Written refreshes use a distinct exclusive path and require fresh review; the input manifest is immutable.", run: refresh },
};
