/** Commands that validate, simulate, apply, or audit existing manifests. */

import { commitManifestApproval, manifestApprovalEvidence } from "../approval/index.ts";
import { checkImportExtensions, formatExtensionReport } from "../checks/import-extensions.ts";
import { flagBool, flagString, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { validatePlan } from "../plan/validate.ts";
import { assertPreparerManifest } from "../preparer/core-validate.ts";
import type { PreparerManifest } from "../preparer/manifest.ts";
import { applyTransactionStatus, DISCARD_CHANGES_FLAG, FORCE_CORRUPT_LOCK_FLAG, recoverApplyTransaction } from "../transaction/apply-state.ts";
import { applyPlan, preflight } from "../transaction/apply.ts";
import { auditPlanSync } from "../transaction/audit.ts";
import { inspectGateEffects } from "../transaction/gate-inspection.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { verifyAppliedPlan } from "../transaction/verify.ts";
import { pruneWorktrees } from "../transaction/worktree.ts";
import { load, loadManifest, print } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

async function apply(args: ParsedArgs): Promise<void> {
  if (flagBool(args, "skip-simulation")) {
    throw new UsageError("--skip-simulation is not supported; apply always runs simulation first");
  }
  if (flagBool(args, "refresh-if-baseline-only")) {
    throw new UsageError(
      "--refresh-if-baseline-only is no longer supported; run refresh --plan <path> --out <new-path> --write, then approve the new manifest",
    );
  }
  const { config, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  const result = await applyPlan({
    config,
    rootDir,
    manifest,
    manifestPath: path,
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
  print(
    recoverApplyTransaction(rootDir, manifest, {
      ...(flagBool(args, FORCE_CORRUPT_LOCK_FLAG) ? { forceCorruptLock: true } : {}),
      ...(flagBool(args, DISCARD_CHANGES_FLAG) ? { discardChanges: true } : {}),
    }),
    args,
  );
}

async function approve(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  let path: string;
  let manifest;
  try {
    ({ path, manifest } = await loadManifest(args, rootDir));
  } catch (error) {
    const requested = flagString(args, "plan");
    if (requested === undefined) throw error;
    path = requested;
    const parsed = JSON.parse(await Bun.file(`${rootDir}/${requested}`).text()) as PreparerManifest;
    assertPreparerManifest(config, parsed);
    manifest = parsed;
  }
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
  const simulation = await simulatePlan({ config, rootDir, manifest, runGates: true, ...(flagBool(args, "verify-lockfile") ? { verifyLockfile: true } : {}) });
  print({ schema: "doctor", manifest: path, validation, simulation }, args);
  if (!simulation.ok) process.exitCode = 1;
}

async function audit(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { manifest } = await loadManifest(args, rootDir);
  const report = auditPlanSync({ config, rootDir, manifest, ...(flagBool(args, "skip-compile-proof") ? { skipCompileProof: true } : {}) });
  print(report, args);
  if (!report.passed) process.exitCode = 1;
}

async function verify(args: ParsedArgs): Promise<void> {
  const { config, configPath, rootDir } = await load(args);
  const { path, manifest } = await loadManifest(args, rootDir);
  const applied = await verifyAppliedPlan({ config, configPath, rootDir, manifest, manifestPath: path });
  if (applied !== undefined) {
    print(applied, args);
    if (applied.blockers.length > 0) process.exitCode = 1;
    return;
  }
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

/**
 * Durations accepted by `--older-than`: a bare number of hours, or an explicit
 * `<n>(m|h|d)`. Deliberately small — this guards a destructive sweep, so the
 * spelling should be obvious at a glance in shell history.
 */
function ageMilliseconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(m|h|d)?$/u.exec(value.trim());
  if (!match?.[1]) throw new UsageError(`--older-than expects <n>[m|h|d], got ${JSON.stringify(value)}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "h"];
  return Number(match[1]) * (unit ?? 3_600_000);
}

async function pruneWorktreesCommand(args: ParsedArgs): Promise<void> {
  const worktreeRootOverride = flagString(args, "worktree-root");
  const { config, rootDir } = worktreeRootOverride === undefined ? await load(args) : { config: undefined, rootDir: process.cwd() };
  // A shared worktree root may hold a simulation running in another terminal
  // right now, so the sweep is age-bounded unless --all is explicit.
  const olderThan = flagString(args, "older-than");
  if (olderThan !== undefined && flagBool(args, "all")) {
    throw new UsageError("--all and --older-than are mutually exclusive");
  }
  const minimumAgeMs = flagBool(args, "all") ? 0 : ageMilliseconds(olderThan ?? "1h");
  const worktreeRoot = worktreeRootOverride ?? config!.transaction.worktreeRoot;
  const result = await pruneWorktrees(rootDir, worktreeRoot, { minimumAgeMs });
  print({ worktreeRoot, ...result }, args);
}

export const transactionCommands: Record<string, CommandSpec> = {
  "inspect-gates": {
    summary: "attribute gate-created files in isolation",
    category: "Extraction execution",
    usage: "inspect-gates --plan <path>",
    details:
      "Runs every declared repository gate separately against a landed plan in a disposable worktree, reports exact repository-visible changed and undeclared paths, and suggests generated-artifact declarations without editing the checkout or configuration.",
    run: inspectGates,
  },
  approve: {
    summary: "inspect or commit one reviewed plan manifest",
    category: "Extraction execution",
    usage: "approve --plan <path> [--commit]",
    details:
      "Without --commit, validates the exact written bytes and baseline and reports the approval action without mutation. --commit explicitly creates a commit containing only that manifest and refuses guarded branches, wrong HEAD, staged paths, or any unrelated dirt.",
    run: approve,
  },
  apply: {
    summary: "land a plan with one mandatory simulation",
    category: "Extraction execution",
    usage: "apply --plan <path> [--commit] [--resume] [--skip-gates] [--verify-lockfile]",
    details:
      "Use --commit as the default landing path: it simulates once, then immediately applies the identical verified journal. Without --commit, apply is a standalone feasibility or review run; do not run it immediately before a committed apply because --commit must simulate again and no simulation evidence is cached. Refresh is a separate command that writes a distinct manifest for review; apply never replaces approved bytes. --resume continues only from a verified transaction boundary; --skip-simulation is refused.",
    run: apply,
  },
  "apply-status": {
    summary: "inspect a durable committing-apply marker",
    category: "Extraction execution",
    usage: "apply-status",
    details: "Read-only. Reports the exact plan, phase, owner process, and recovery command for an interrupted apply.",
    run: applyStatus,
  },
  "apply-recover": {
    summary: "release a stopped apply owner for verified resume",
    category: "Extraction execution",
    usage: "apply-recover --plan <path> [--force-corrupt-lock] [--discard-changes]",
    details:
      "Refuses a live or unverifiable owner or a different plan. An owner stopped mid-journal (phase applying) is first rolled back from its durable checkpoint: HEAD, index, and every journal path are restored and verified, and nothing is released if verification fails. Otherwise it never changes Git state; it releases only the stopped owner's lock and prints the exact apply or --resume command whose normal preflight proves the repository boundary. --force-corrupt-lock is accepted only when the lock is unparseable: it asserts no apply is running, moves the unreadable lock/state aside, and restores this plan's checkpoint if one exists. Before restoring, every journal path and index entry must match its pre-apply bytes or a state this apply produced; a path edited or staged after the interruption makes recovery refuse and list it, and --discard-changes restores anyway, reporting what it overwrote.",
    run: applyRecover,
  },
  doctor: {
    summary: "replay a manifest and its gates in isolation",
    category: "Extraction execution",
    usage: "doctor --plan <path> [--verify-lockfile]",
    details: "Validates, journals, audits, and runs configured gates in a disposable worktree without changing the checkout.",
    run: doctor,
  },
  audit: {
    summary: "audit the tree produced by an applied plan",
    category: "Extraction execution",
    usage: "audit --plan <path> [--skip-compile-proof]",
    details:
      "Checks declared bytes, boundaries, replay evidence, public surfaces, lockfile state, and generated artifacts. Audit immediately after apply, before another extraction changes owned paths.",
    run: audit,
  },
  verify: {
    summary: "validate a plan and run apply preflight",
    category: "Extraction execution",
    usage: "verify --plan <path>",
    details: "Read-only validation of manifest semantics, branch/checkout state, journal preconditions, and approved-plan provenance.",
    run: verify,
  },
  "prune-worktrees": {
    summary: "reclaim simulation worktrees left by interrupted runs",
    category: "Extraction execution",
    usage: "prune-worktrees [--worktree-root <path>] [--older-than <n>[m|h|d]] [--all]",
    details:
      "A run disposes its own worktree, including on failure; nothing survives SIGKILL or a closed terminal, and those leftovers accumulate in transaction.worktreeRoot. The default worktreeRoot is checkout-derived, so two checkouts no longer share one root, but concurrent simulations FROM THIS CHECKOUT still do (and an explicit MONOCARVE_SCRATCH_ROOT or worktreeRoot override is shared with whatever else points at it). Defaults to --older-than 1h for that reason; --all removes every one regardless of age. --worktree-root <path> sweeps that directory instead and does not require a config.",
    run: pruneWorktreesCommand,
  },
  check: {
    summary: "run repository policy checks",
    category: "Discovery and diagnosis",
    usage: "check import-extensions",
    details: "Currently supported check: import-extensions.",
    run: check,
  },
};
