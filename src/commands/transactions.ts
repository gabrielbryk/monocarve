/** Commands that validate, simulate, apply, or audit existing manifests. */

import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { commitManifestApproval, manifestApprovalEvidence } from "../approval/index.ts";
import { checkImportExtensions, formatExtensionReport } from "../checks/import-extensions.ts";
import { UsageError } from "../errors.ts";
import { TOOL_NAME } from "../branding.ts";
import { headCommit } from "../util/git.ts";
import { buildPortfolio } from "../portfolio/index.ts";
import { serializeManifest } from "../plan/build.ts";
import { refreshExtractionPlan } from "../plan/refresh.ts";
import { validatePlan } from "../plan/validate.ts";
import { applyPlan, hasApprovedManifestHead, preflight } from "../transaction/apply.ts";
import { auditPlanSync } from "../transaction/audit.ts";
import { inspectGateEffects } from "../transaction/gate-inspection.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { applyTransactionStatus, recoverApplyTransaction } from "../transaction/apply-state.ts";
import type { CommandSpec } from "./types.ts";
import { load, loadGraph, loadManifest, print, writeOutput } from "./shared.ts";

async function apply(args: ParsedArgs): Promise<void> {
  if (flagBool(args, "skip-simulation")) {
    throw new UsageError("--skip-simulation is not supported; apply always runs simulation first");
  }
  if (flagBool(args, "refresh-if-baseline-only") && !flagBool(args, "commit")) {
    throw new UsageError("--refresh-if-baseline-only requires --commit because it replaces the reviewed manifest");
  }
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  if (flagBool(args, "refresh-if-baseline-only") && headCommit(rootDir) !== manifest.baselineCommit && !hasApprovedManifestHead({ config, rootDir, manifest, manifestPath: path })) {
    const loaded = await loadGraph(args);
    const portfolio = buildPortfolio({ config, graph: loaded.graph, context: loaded.context, application: manifest.application, includeExtracted: true });
    const refreshed = refreshExtractionPlan({
      manifest, config, rootDir, graph: loaded.graph,
      resolveCandidate: (existing) => portfolio.candidates.find((candidate) => existing.target.profile === undefined
        ? candidate.id === existing.planId : `${candidate.id}--${existing.target.profile.name}` === existing.planId),
    });
    if (refreshed.semanticDiff.length > 0) throw new UsageError("baseline-only refresh found semantic changes; run refresh without replacement and review the diff");
    writeOutput(rootDir, path, serializeManifest(refreshed.manifest));
    print({
      ok: false, refreshed: true, applied: false, planId: refreshed.manifest.planId,
      previousBaselineCommit: refreshed.previousBaselineCommit, currentBaselineCommit: refreshed.currentBaselineCommit,
      semanticDiff: refreshed.semanticDiff, manifestPath: path,
      next: [TOOL_NAME, "approve", "--plan", path, "--commit"],
    }, args);
    process.exitCode = 1;
    return;
  }
  const result = await applyPlan({
    config, rootDir, manifest, manifestPath: path,
    ...(flagBool(args, "commit") ? { commit: true } : {}),
    ...(flagBool(args, "resume") ? { resume: true } : {}),
    ...(flagBool(args, "skip-gates") ? { skipGates: true } : {}),
    ...(flagBool(args, "verify-lockfile") ? { verifyLockfile: true } : {}),
  });
  print(result, args);
  if (!result.ok) process.exitCode = 1;
}

async function applyStatus(args: ParsedArgs): Promise<void> {
  const { rootDir } = await load(args);
  print(applyTransactionStatus(rootDir), args);
}

async function applyRecover(args: ParsedArgs): Promise<void> {
  const { rootDir } = await load(args);
  const { manifest } = await loadManifest(args, rootDir);
  print(recoverApplyTransaction(rootDir, manifest), args);
}

async function approve(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  const options = { config, rootDir, manifest, manifestPath: path };
  print(flagBool(args, "commit") ? commitManifestApproval(options) : manifestApprovalEvidence(options), args);
}

async function inspectGates(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { manifest } = await loadManifest(args, rootDir);
  print(await inspectGateEffects({ config, rootDir, manifest }), args);
}

async function doctor(args: ParsedArgs): Promise<void> {
  if (flagBool(args, "skip-gates")) {
    throw new UsageError("--skip-gates is not supported; doctor always runs the manifest's gates");
  }
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  const validation = validatePlan(manifest, { config, rootDir });
  if (!validation.ok) {
    print({ schema: "doctor", manifest: path, validation, simulation: null }, args);
    process.exitCode = 1;
    return;
  }
  const simulation = await simulatePlan({
    config, rootDir, manifest, runGates: true,
    ...(flagBool(args, "verify-lockfile") ? { verifyLockfile: true } : {}),
  });
  print({ schema: "doctor", manifest: path, validation, simulation }, args);
  if (!simulation.ok) process.exitCode = 1;
}

async function audit(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { manifest } = await loadManifest(args, rootDir);
  const report = auditPlanSync({
    config, rootDir, manifest,
    ...(flagBool(args, "skip-compile-proof") ? { skipCompileProof: true } : {}),
  });
  print(report, args);
  if (!report.passed) process.exitCode = 1;
}

async function verify(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  const validation = validatePlan(manifest, { config, rootDir });
  const blockers = await preflight({ config, rootDir, manifest, manifestPath: path });
  print({ validation, blockers }, args);
  if (!validation.ok || blockers.length > 0) process.exitCode = 1;
}

async function check(args: ParsedArgs): Promise<void> {
  const target = args.positionals[0] ?? flagString(args, "check");
  const { config, rootDir } = await load(args);
  if (target !== "import-extensions") {
    throw new UsageError(`unknown check ${JSON.stringify(target ?? "")}; known checks: import-extensions`);
  }
  const result = checkImportExtensions(config, rootDir);
  print(flagBool(args, "json") ? result : formatExtensionReport(result), args);
  if (result.violations.length > 0) process.exitCode = 1;
}

export const transactionCommands: Record<string, CommandSpec> = {
  "inspect-gates": { summary: "attribute gate-created files in isolation", usage: "inspect-gates --plan <path>", details: "Runs every declared repository gate separately against a landed plan in a disposable worktree, reports exact repository-visible changed and undeclared paths, and suggests generated-artifact declarations without editing the checkout or configuration.", run: inspectGates },
  approve: { summary: "inspect or commit one reviewed plan manifest", usage: "approve --plan <path> [--commit]", details: "Without --commit, validates the exact written bytes and baseline and reports the approval action without mutation. --commit explicitly creates a commit containing only that manifest and refuses guarded branches, wrong HEAD, staged paths, or any unrelated dirt.", run: approve },
  apply: { summary: "simulate, then optionally commit a plan", usage: "apply --plan <path> [--commit] [--resume] [--refresh-if-baseline-only] [--skip-gates] [--verify-lockfile]", details: "Without --commit, the real checkout is unchanged. Committed application always simulates first. --refresh-if-baseline-only may replace a stale plan only when recompilation has no semantic diff; it stops for a new explicit approval and never applies the refreshed file in the same invocation. --resume continues only from a verified transaction boundary; --skip-simulation is refused.", run: apply },
  "apply-status": { summary: "inspect a durable committing-apply marker", usage: "apply-status", details: "Read-only. Reports the exact plan, phase, owner process, and recovery command for an interrupted apply.", run: applyStatus },
  "apply-recover": { summary: "release a stopped apply owner for verified resume", usage: "apply-recover --plan <path>", details: "Refuses a live owner or a different plan. It never changes Git state; it releases only the stopped owner's lock and prints the exact apply or --resume command whose normal preflight proves the repository boundary.", run: applyRecover },
  doctor: { summary: "replay a manifest and its gates in isolation", usage: "doctor --plan <path> [--verify-lockfile]", details: "Validates, journals, audits, and runs configured gates in a disposable worktree without changing the checkout.", run: doctor },
  audit: { summary: "audit the tree produced by an applied plan", usage: "audit --plan <path> [--skip-compile-proof]", details: "Checks declared bytes, boundaries, replay evidence, public surfaces, lockfile state, and generated artifacts. Audit immediately after apply, before another extraction changes owned paths.", run: audit },
  verify: { summary: "validate a plan and run apply preflight", usage: "verify --plan <path>", details: "Read-only validation of manifest semantics, branch/checkout state, journal preconditions, and approved-plan provenance.", run: verify },
  check: { summary: "run repository policy checks", usage: "check import-extensions", details: "Currently supported check: import-extensions.", run: check },
};
