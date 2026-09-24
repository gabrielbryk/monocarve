import { flagBool, flagNumber, flagString, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { analyzeCouplingHotspots, buildPortfolio } from "../portfolio/index.ts";
import { loadGraph, outputPath, print, writeOutput } from "./shared.ts";

/** Rank durable campaign targets without applying or planning any candidate. */
export async function campaignOptimize(args: ParsedArgs): Promise<void> {
  const application = flagString(args, "app");
  if (!application) throw new UsageError("--app <name> is required");
  const loaded = await loadGraph({ ...args, flags: new Map(args.flags).set("app", application).set("no-cache", true) });
  const portfolio = buildPortfolio({ config: loaded.config, graph: loaded.graph, context: loaded.context, application });
  const representatives = new Set(portfolio.equivalenceGroups?.map((group) => group.representativeId) ?? portfolio.candidates.map((candidate) => candidate.id));
  const limit = flagNumber(args, "limit", 20);
  const ranked = portfolio.candidates
    .filter(
      (candidate) =>
        representatives.has(candidate.id) &&
        candidate.eligible &&
        candidate.recommendation?.status === "recommended" &&
        candidate.classification !== "preparation",
    )
    .toSorted(
      (left, right) =>
        (right.effort?.locPerReviewUnit ?? 0) - (left.effort?.locPerReviewUnit ?? 0) || right.lineCount - left.lineCount || left.id.localeCompare(right.id),
    );
  const targets = ranked
    .slice(0, limit)
    .map((candidate) => ({
      path: candidate.seed.members[0]!,
      packageName: candidate.recommendation?.targetOptions[0]?.packageName ?? candidate.suggestedPackageName,
      candidateId: candidate.id,
      lineCount: candidate.lineCount,
      effort: candidate.effort,
    }));
  const preparationPriorities = analyzeCouplingHotspots(loaded.graph, portfolio, application).slice(0, limit);
  const report = { schema: "campaign-targets", application, baselineCommit: loaded.graph.commit ?? null, targets, preparationPriorities };
  const out = flagString(args, "out");
  if (flagBool(args, "write")) {
    if (!out) throw new UsageError("campaign optimize --write requires --out <path>");
    writeOutput(loaded.rootDir, outputPath(loaded.rootDir, out), `${JSON.stringify(report, null, 2)}\n`, { exclusive: true });
  }
  print({ ...report, written: flagBool(args, "write"), ...(out ? { output: out } : {}) }, args);
}
