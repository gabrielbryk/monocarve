import { existsSync } from "node:fs";

import { flagBool, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { evacuationReport, formatEvacuationReport, prepareEvacuation } from "../evacuation/index.ts";
import { buildPlanSync, serializeManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { assertPlannableTree, loadGraph, outputPath, print, writeOutput } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

const UNSUPPORTED_FLAGS = ["plan", "apply", "approve", "manifest", "commit-approval", "force"] as const;

async function evacuate(args: ParsedArgs): Promise<void> {
  const unsupported = UNSUPPORTED_FLAGS.find((name) => args.flags.has(name));
  if (unsupported) throw new UsageError(`--${unsupported} is unsupported by evacuate`);
  const application = flagString(args, "app");
  const packageName = flagString(args, "package-name");
  const sources = flagStrings(args, "source");
  const authorizedProtectedRoots = flagStrings(args, "authorize-protected");
  const includedCompositionRoots = flagStrings(args, "include-composition");
  if (application === undefined) throw new UsageError("--app <name> is required");
  if (packageName === undefined) throw new UsageError("--package-name <name> is required; evacuate never infers architectural ownership");
  if (sources.length === 0) throw new UsageError("at least one --source <file|directory|glob> is required");
  const loaded = await loadGraph(args, { allApplications: true });
  const assessed = prepareEvacuation({
    config: loaded.config,
    graph: loaded.graph,
    context: loaded.context,
    application,
    sources,
    packageName,
    authorizedProtectedRoots,
    includedCompositionRoots,
  });
  const report = evacuationReport(assessed, packageName);
  const unresolved = assessed.boundaryCuts.filter((cut) => cut.remedy.kind === "unconfigured");
  const planningRequested = flagBool(args, "write") || args.flags.has("out") || flagBool(args, "verify-lockfile") || args.flags.has("package-root");
  if (!assessed.candidate.eligible || unresolved.length > 0) {
    if (!planningRequested) {
      print(flagBool(args, "json") ? report : formatEvacuationReport(report), args);
      return;
    }
    if (!assessed.candidate.eligible) {
      throw new UsageError(
        `evacuation ${assessed.evacuation.id} is not eligible: ${assessed.candidate.rejectionReasons.map(({ detail }) => detail).join("; ")}; cuts: ${formatCuts(report)}`,
      );
    }
    throw new UsageError(`evacuation ${assessed.evacuation.id} has unconfigured boundary cuts: ${formatCuts({ ...report, boundaryCuts: unresolved })}`);
  }
  const packageRoot = flagString(args, "package-root");
  const manifest = buildPlanSync({
    config: loaded.config,
    rootDir: loaded.rootDir,
    graph: loaded.graph,
    context: loaded.context,
    candidate: assessed.candidate,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    packageName,
    evacuationProvenance: {
      id: assessed.evacuation.id,
      requested: assessed.evacuation.requested,
      retainedComposition: assessed.evacuation.retainedComposition.flatMap((scc) => scc.members).toSorted(),
      authorizedProtectedRoots: assessed.authorizedProtectedRoots,
      includedCompositionRoots: assessed.includedCompositionRoots,
    },
    ...(packageRoot ? { packageRoot } : {}),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  assertPlannableTree(loaded, manifest, out, args);
  const simulation = flagBool(args, "verify-lockfile")
    ? await simulatePlan({ config: loaded.config, rootDir: loaded.rootDir, manifest, verifyLockfile: true, skipGates: true })
    : undefined;
  if (simulation && !simulation.ok) throw new PlanningError(`plan lockfile round-trip failed: ${simulation.failure ?? "unknown failure"}`);
  const written = flagBool(args, "write");
  if (written && existsSync(`${loaded.rootDir}/${out}`)) throw new UsageError(`refusing to overwrite existing plan ${out}; the existing file was not changed`);
  if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
  const review = summarizePlanReview(manifest, {
    baselinePaths: loaded.graph.workspace.owners.includes(manifest.target.packageRoot) ? [`${manifest.target.packageRoot}/package.json`] : [],
    manifestPath: out,
  });
  print(
    flagBool(args, "json")
      ? { ...report, manifest, output: out, written, ...(simulation ? { simulation } : {}) }
      : `${formatEvacuationReport(report)}\n\n${formatPlanReview(review).trimEnd()}\n\nOutput: ${out} (${written ? "written" : "dry run"})`,
    args,
  );
}

function formatCuts(report: {
  readonly boundaryCuts: readonly {
    readonly from: string;
    readonly specifier: string;
    readonly target: string;
    readonly reason: string;
    readonly remedy: { readonly kind: string };
  }[];
}): string {
  return report.boundaryCuts.length === 0
    ? "none"
    : report.boundaryCuts.map((cut) => `${cut.from} -> ${cut.specifier} -> ${cut.target} (${cut.reason}, ${cut.remedy.kind})`).join("; ");
}

export const evacuationCommands: Record<string, CommandSpec> = {
  evacuate: {
    summary: "scope one bounded domain evacuation",
    usage:
      "evacuate --app <name> --source <file|directory|glob> [--source <...>] --package-name <name> [--authorize-protected <configured-root>] [--include-composition <selected-root>] [--package-root <path>] [--verify-lockfile] [--out <path>] [--write] [--json]",
    details:
      "Read-only by default. Selectors are workspace-relative and production-only. --authorize-protected is repeatable, evacuation-only, and must exactly name a configured protected root inside the selected evacuation. --include-composition is repeatable and may include only an exact composition root already selected in the same application; its whole SCC moves. Compiles the ordinary immutable plan only after eligibility passes and every boundary cut names a configured remedy; --write exclusively creates that one manifest and never edits source files.",
    run: evacuate,
  },
};
