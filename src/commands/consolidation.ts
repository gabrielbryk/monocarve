/**
 * Consolidation command: merge multiple existing packages into a target domain package.
 *
 * This is the inverse of extraction. Instead of moving code FROM an application
 * TO a package, consolidation moves code FROM multiple packages INTO one package.
 * The result is a domain-oriented library that replaces many technical fragments.
 */

import { flagBool, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { buildConsolidationCandidate, resolveConsolidationPackages, assertNoTargetDonorCollision } from "../consolidation/index.ts";
import { buildConsolidationPlan } from "../consolidation/plan.ts";
import { serializeManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import type { CommandSpec } from "./types.ts";
import { assertPlannableTree, loadGraph, outputPath, print, writeOutput } from "./shared.ts";

async function consolidate(args: ParsedArgs): Promise<void> {
  const targetName = flagString(args, "target");
  const donorNames = flagStrings(args, "donor");

  if (targetName === undefined) {
    throw new UsageError("--target <package-name> is required");
  }
  if (donorNames.length === 0) {
    throw new UsageError("at least one --donor <package-name> is required");
  }

  const loaded = await loadGraph(args, { allApplications: true });

  // Validate packages.
  const packages = resolveConsolidationPackages(loaded.graph, targetName, donorNames);

  // Check for collisions.
  assertNoTargetDonorCollision(loaded.graph, packages.target.root, packages.donors.map((d) => d.root));

  // Build consolidation candidate.
  const candidate = buildConsolidationCandidate({
    config: loaded.config,
    graph: loaded.graph,
    target: packages.target,
    donors: packages.donors,
  });

  if (candidate.files.length === 0) {
    throw new UsageError(`consolidation of ${donorNames.join(", ")} into ${targetName} has no files to move`);
  }

  // Build the consolidation plan.
  const packageRoot = flagString(args, "package-root");
  const manifest = buildConsolidationPlan({
    config: loaded.config,
    rootDir: loaded.rootDir,
    graph: loaded.graph,
    candidate,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    ...(packageRoot ? { packageRoot } : {}),
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
    baselinePaths: loaded.graph.workspace.owners.includes(manifest.target.packageRoot) ? [`${manifest.target.packageRoot}/package.json`] : [],
    manifestPath: out,
  });

  print(flagBool(args, "json")
    ? { schema: "consolidate", candidate, manifest, output: out, written, ...(simulation ? { simulation } : {}) }
    : `${formatPlanReview(review).trimEnd()}\n\nOutput: ${out} (${written ? "written" : "dry run"})`, args);
}

export const consolidationCommands: Record<string, CommandSpec> = {
  consolidate: {
    summary: "merge multiple packages into a target domain package",
    usage: "consolidate --target <package-name> --donor <package-name> [--donor <...>] [--package-root <path>] [--verify-lockfile] [--out <path>] [--write] [--json]",
    details: "Read-only by default. Moves files FROM multiple existing packages INTO one target package. --target is the destination domain package. --donor is repeatable and names each source package. --package-root overrides the target package root. Compiles the ordinary immutable plan; --write exclusively creates that one manifest and never edits source files.",
    run: consolidate,
  },
};
