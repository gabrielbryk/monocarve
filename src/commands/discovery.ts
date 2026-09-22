/** Read-only discovery, portfolio, and campaign commands. */

import { readFileSync } from "node:fs";

import { analyzePlanConflicts, type CampaignPlan } from "../campaign/index.ts";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../cli/args.ts";
import { domainFor, getApplication } from "../config.ts";
import { IoError, UsageError } from "../errors.ts";
import { scanDependencyReports } from "../graph/cruiser.ts";
import { analyzeLayers, summarizeGraph } from "../graph/index.ts";
import { analyzePreparationImpact } from "../impact/index.ts";
import { parseManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import {
  analyzeCommunities,
  blockedCandidates,
  blockingHints,
  buildPortfolio,
  eligibleCandidates,
  formatCandidateTable,
  analyzeCouplingHotspots,
  analyzeLazyRegistry,
  marginalBlockers,
  queryCandidates,
  serializeCandidateDetails,
  type CandidateEligibility,
} from "../portfolio/index.ts";
import { analyzeCapabilityPartitions, analyzeTypeScriptSource, analyzeWorkspaceSymbols } from "../symbols/index.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { loadPreparationManifest } from "./preparation.ts";
import { graphDigest, load, loadGraph, print, printReport, systemReason, writeOutput, type LoadedGraph } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

function portfolioFor(args: ParsedArgs, loaded: LoadedGraph) {
  const application = flagString(args, "app");
  return buildPortfolio({
    config: loaded.config,
    graph: loaded.graph,
    context: loaded.context,
    ...(application === undefined ? {} : { application }),
    ...(flagBool(args, "include-extracted") ? { includeExtracted: true } : {}),
  });
}

function portfolioTotals(portfolio: { readonly candidates: readonly { readonly eligible: boolean }[] }): {
  readonly candidates: number;
  readonly eligible: number;
  readonly blocked: number;
} {
  const eligible = portfolio.candidates.filter((candidate) => candidate.eligible).length;
  return { candidates: portfolio.candidates.length, eligible, blocked: portfolio.candidates.length - eligible };
}

function portfolioView(result: ReturnType<typeof portfolioFor>, args: ParsedArgs) {
  const requested = flagString(args, "recommendation") ?? "recommended";
  if (!["all", "recommended", "review-required", "discouraged"].includes(requested)) {
    throw new UsageError("--recommendation must be one of all, recommended, review-required, or discouraged");
  }
  const eligible = eligibleCandidates(result).filter((candidate) => requested === "all" || candidate.recommendation?.status === requested);
  const byId = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  const grouped = (result.equivalenceGroups ?? []).flatMap((group) => {
    const representative = byId.get(group.representativeId) ?? group.candidateIds.map((id) => byId.get(id)).find(Boolean);
    return representative ? [{ ...representative, equivalenceGroup: group }] : [];
  });
  const strategy = flagString(args, "strategy") ?? "cohesive";
  if (!["cohesive", "max-loc", "low-risk", "campaign", "preparation"].includes(strategy)) {
    throw new UsageError("--strategy must be one of cohesive, max-loc, low-risk, campaign, or preparation");
  }
  return grouped.sort((left, right) => {
    if (strategy === "cohesive") {
      const order = { high: 0, medium: 1, low: 2 } as const;
      const delta = order[left.recommendation?.cohesion ?? "low"] - order[right.recommendation?.cohesion ?? "low"];
      if (delta !== 0) return delta;
    }
    if (strategy === "campaign") {
      const delta = (right.effort?.locPerReviewUnit ?? 0) - (left.effort?.locPerReviewUnit ?? 0);
      if (delta !== 0) return delta;
    }
    if (strategy === "preparation") {
      const delta = Number(right.classification === "preparation") - Number(left.classification === "preparation");
      if (delta !== 0) return delta;
    }
    if (strategy === "low-risk") return left.lineCount - right.lineCount || left.id.localeCompare(right.id);
    return right.score - left.score || left.id.localeCompare(right.id);
  });
}

async function scan(args: ParsedArgs): Promise<void> {
  const { graph, rootDir } = await loadGraph(args);
  const summary = { ...summarizeGraph(graph), digest: graphDigest(graph), commit: graph.commit ?? null };
  const out = flagString(args, "out");
  if (out) writeOutput(rootDir, out, `${JSON.stringify(summary, null, 2)}\n`);
  const reportOut = flagString(args, "report-out");
  if (reportOut !== undefined) {
    const application = flagString(args, "app");
    if (application === undefined) throw new UsageError("--report-out requires --app <name>");
    const reports = await scanDependencyReports({
      config: (await load(args)).config,
      rootDir,
      application,
      ...(flagBool(args, "no-cache") ? { noCache: true } : {}),
    });
    writeOutput(rootDir, reportOut, `${JSON.stringify(reports[application], null, 2)}\n`);
  }
  print(summary, args);
}

async function layers(args: ParsedArgs): Promise<void> {
  const { config, graph, rootDir } = await loadGraph(args);
  const report = analyzeLayers(config, graph, flagString(args, "app"));
  const out = flagString(args, "out");
  if (out) writeOutput(rootDir, out, `${JSON.stringify(report, null, 2)}\n`);
  print(report, args);
}

async function symbols(args: ParsedArgs): Promise<void> {
  const { rootDir } = await load(args);
  const input = flagString(args, "file") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("--file <path> is required");
  const sourcePath = relativeWorkspacePath(rootDir, input);
  let sourceText: string;
  try {
    sourceText = readFileSync(workspacePath(rootDir, sourcePath), "utf8");
  } catch (error) {
    throw new IoError(`could not read symbol source ${sourcePath}: ${systemReason(error)}`);
  }
  const report = analyzeTypeScriptSource({ sourcePath, sourceText });
  const out = flagString(args, "out");
  if (out) writeOutput(rootDir, out, `${JSON.stringify(report, null, 2)}\n`);
  print(report, args);
}

async function splitCandidates(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const input = flagString(args, "file") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("--file <path> is required");
  const sourcePath = relativeWorkspacePath(loaded.rootDir, input);
  const node = loaded.graph.nodes.get(sourcePath);
  if (!node || node.zone !== "application" || node.application === undefined) {
    throw new UsageError(`${sourcePath} is not a source file in a configured application`);
  }
  const application = getApplication(loaded.config, node.application);
  const report = analyzeWorkspaceSymbols({
    rootDir: loaded.rootDir,
    tsconfigPath: application.tsconfig,
    sourcePath,
    affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
  });
  const out = flagString(args, "out");
  if (out) writeOutput(loaded.rootDir, out, `${JSON.stringify(report, null, 2)}\n`);
  print(report, args);
}

async function portfolio(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  if (flagBool(args, "communities")) {
    const application = flagString(args, "app");
    printReport(
      loaded.rootDir,
      analyzeCommunities(loaded.graph, {
        ...(application === undefined ? {} : { application }),
        ...(args.flags.has("hub-inbound-threshold") ? { hubInboundThreshold: flagNumber(args, "hub-inbound-threshold", 12) } : {}),
      }),
      args,
    );
    return;
  }
  const result = portfolioFor(args, loaded);
  const eligible = portfolioView(result, args);
  const limit = flagNumber(args, "limit", 20);
  printReport(
    loaded.rootDir,
    {
      schema: "portfolio",
      totals: { ...portfolioTotals(result), equivalenceGroups: result.equivalenceGroups?.length ?? 0 },
      limit,
      truncated: eligible.length > limit,
      top: eligible.slice(0, limit),
      selected: result.selected,
    },
    args,
  );
}

async function candidates(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const result = portfolioFor(args, loaded);
  const eligibility = flagString(args, "eligibility") ?? "all";
  if (!isCandidateEligibility(eligibility)) {
    throw new UsageError("--eligibility must be one of all, eligible, or blocked");
  }
  const candidate = flagString(args, "candidate");
  const equivalenceGroup = flagString(args, "equivalence-group");
  if (candidate !== undefined && equivalenceGroup !== undefined) throw new UsageError("--candidate and --equivalence-group are mutually exclusive");
  const path = flagString(args, "path");
  const group =
    equivalenceGroup === undefined
      ? undefined
      : result.equivalenceGroups?.find((entry) => entry.id === equivalenceGroup || entry.representativeId === equivalenceGroup);
  if (equivalenceGroup !== undefined && group === undefined) throw new UsageError(`equivalence group not found: ${equivalenceGroup}`);
  const query = { ...(candidate === undefined ? {} : { id: candidate }), ...(path === undefined ? {} : { path }), eligibility };
  const details =
    group === undefined
      ? queryCandidates(result, loaded.config, query)
      : group.candidateIds.flatMap((id) => queryCandidates(result, loaded.config, { ...query, id }));
  const rendered = flagBool(args, "json") ? serializeCandidateDetails(details) : formatCandidateTable(details);
  const out = flagString(args, "out");
  if (out !== undefined) writeOutput(loaded.rootDir, out, rendered);
  process.stdout.write(rendered);
}

function isCandidateEligibility(value: string): value is CandidateEligibility {
  return value === "all" || value === "eligible" || value === "blocked";
}

async function conflicts(args: ParsedArgs): Promise<void> {
  const { rootDir } = await load(args);
  const entries = args.repeated.get("plan") ?? [];
  if (entries.length < 2) throw new UsageError("at least two --plan <candidate>=<manifest> entries are required");
  const plans: CampaignPlan[] = entries.map((entry) => {
    const equals = entry.indexOf("=");
    if (equals <= 0 || equals === entry.length - 1) throw new UsageError("--plan expects <candidate>=<manifest>");
    const candidateId = entry.slice(0, equals);
    const path = relativeWorkspacePath(rootDir, entry.slice(equals + 1));
    let text: string;
    try {
      text = readFileSync(workspacePath(rootDir, path), "utf8");
    } catch (error) {
      throw new PlanningError(`could not read the plan manifest ${path}: ${systemReason(error)}`);
    }
    const manifest = parseManifest(text, path);
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new PlanningError(`the plan manifest ${path} is not a JSON object`);
    }
    return { candidateId, manifest };
  });
  print({ schema: "campaign-conflicts", ...analyzePlanConflicts(plans) }, args);
}

async function backlog(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const result = portfolioFor(args, loaded);
  const blocked = blockedCandidates(result);
  const limit = flagNumber(args, "limit", 20);
  if (flagBool(args, "marginal")) {
    const blockers = marginalBlockers(blocked);
    printReport(
      loaded.rootDir,
      {
        schema: "backlog-marginal",
        scope:
          "one-change lower bound: counts only candidates with exactly one rejection and, for edge-level reasons, exactly one edge; multi-blocker candidates are occurrences only",
        totals: portfolioTotals(result),
        limit,
        truncated: blockers.length > limit,
        top: blockers.slice(0, limit),
      },
      args,
    );
    return;
  }
  printReport(
    loaded.rootDir,
    {
      schema: "backlog",
      totals: portfolioTotals(result),
      limit,
      truncated: blocked.length > limit,
      top: blocked
        .slice(0, limit)
        .map((candidate) => ({
          id: candidate.id,
          application: candidate.application,
          lineCount: candidate.lineCount,
          files: candidate.files.length,
          tests: candidate.tests.length,
          blocking: candidate.rejectionReasons,
          unblock: blockingHints(candidate),
          warnings: candidate.warnings,
        })),
    },
    args,
  );
}

async function hotspots(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const application = flagString(args, "app");
  const ranked = analyzeCouplingHotspots(loaded.graph, portfolioFor(args, loaded), application);
  const limit = flagNumber(args, "limit", 20);
  printReport(
    loaded.rootDir,
    { schema: "coupling-hotspots", application: application ?? null, limit, truncated: ranked.length > limit, top: ranked.slice(0, limit) },
    args,
  );
}

async function capabilities(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const input = flagString(args, "file") ?? args.positionals[0];
  const interfaceName = flagString(args, "type");
  if (input === undefined || interfaceName === undefined) throw new UsageError("--file <path> and --type <interface> are required");
  const sourcePath = relativeWorkspacePath(loaded.rootDir, input);
  const node = loaded.graph.nodes.get(sourcePath);
  if (!node?.application) throw new UsageError(`${sourcePath} is not in a configured application`);
  const application = getApplication(loaded.config, node.application);
  printReport(
    loaded.rootDir,
    analyzeCapabilityPartitions({
      rootDir: loaded.rootDir,
      tsconfigPath: application.tsconfig,
      sourcePath,
      interfaceName,
      affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
    }),
    args,
  );
}

async function lazyRegistry(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const input = flagString(args, "file") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("--file <path> is required");
  const sourcePath = relativeWorkspacePath(loaded.rootDir, input);
  const targets = analyzeLazyRegistry(loaded.graph, portfolioFor(args, loaded), sourcePath);
  printReport(loaded.rootDir, { schema: "lazy-registry", sourcePath, targets }, args);
}

async function impact(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { manifest } = loadPreparationManifest(args, rootDir);
  const application = flagString(args, "app");
  printReport(rootDir, await analyzePreparationImpact({ config, rootDir, manifest, ...(application ? { application } : {}) }), args);
}

export const discoveryCommands: Record<string, CommandSpec> = {
  scan: {
    summary: "build the dependency model",
    usage: "scan [--app <name>] [--no-cache] [--include-extracted] [--out <path>] [--report-out <path>]",
    details:
      "Reads configured applications without changing the workspace. --include-extracted keeps already-extracted paths in the model. --report-out writes the raw scanner report for the selected --app so it can be replayed with --graph.",
    run: scan,
  },
  layers: {
    summary: "report domains, components, and dependency layers",
    usage: "layers [--app <name>] [--out <path>]",
    details: "Read-only architecture report derived from the current or captured graph.",
    run: layers,
  },
  symbols: {
    summary: "analyze one file's declaration and symbol graph",
    usage: "symbols --file <path> [--out <path>]",
    details: "Reports declarations, type/value spaces, exact references, merged groups, and SCCs; never edits the file.",
    run: symbols,
  },
  "split-candidates": {
    summary: "rank symbol split suggestions for one file",
    usage: "split-candidates --file <path> [--app <name>] [--out <path>]",
    details: "Ranks declaration SCCs using cross-file consumers and configured domain affinity.",
    run: splitCandidates,
  },
  portfolio: {
    summary: "rank eligible extraction candidates",
    usage:
      "portfolio [--app <name>] [--limit <n>] [--recommendation <status>] [--strategy <cohesive|max-loc|low-risk|campaign|preparation>] [--include-extracted] [--communities] [--hub-inbound-threshold <n>] [--out <path>]",
    details:
      "Shows one representative per near-equivalent group. Recommended, cohesive candidates are the default; --recommendation all exposes the complete mechanically eligible set.",
    run: portfolio,
  },
  candidates: {
    summary: "inspect and filter extraction candidates",
    usage:
      "candidates [--candidate <id> | --equivalence-group <id>] [--path <path>] [--eligibility <all|eligible|blocked>] [--app <name>] [--include-extracted] [--out <path>]",
    details:
      "Shows a compact table by default. --equivalence-group accepts either a group id or its representative candidate id and expands every variant. --json emits stable full details including the closure, SCCs, blockers, recommendation, shims, and target options.",
    run: candidates,
  },
  conflicts: {
    summary: "compare same-baseline plan conflicts",
    usage: "conflicts --plan <candidate>=<manifest> [--plan <candidate>=<manifest> ...]",
    details: "Classifies hard and replan-mergeable path conflicts. Reported waves still require rescan and replan between applied children.",
    run: conflicts,
  },
  backlog: {
    summary: "explain blocked candidates and edges",
    usage: "backlog [--app <name>] [--limit <n>] [--include-extracted] [--marginal] [--out <path>]",
    details: "--marginal reports a conservative one-blocker lower bound; it does not claim a full unlock simulation.",
    run: backlog,
  },
  hotspots: {
    summary: "rank modules that inflate extraction closures",
    usage: "hotspots [--app <name>] [--limit <n>] [--out <path>]",
    details:
      "Ranks high-inbound, high-fan-out, and cross-domain modules by the candidate LOC pressure they propagate. Suggested actions are diagnostic, never mutation authority.",
    run: hotspots,
  },
  capabilities: {
    summary: "suggest context capability partitions",
    usage: "capabilities --file <path> --type <interface> [--out <path>]",
    details:
      "Groups interface properties by the configured domain affinity of their real TypeScript consumers; read-only guidance for narrowing broad runtime contexts.",
    run: capabilities,
  },
  "lazy-registry": {
    summary: "map lazy feature entries to extraction targets",
    usage: "lazy-registry --file <path> [--app <name>] [--out <path>]",
    details: "Maps compiler-resolved dynamic imports to their current domains and eligible candidate closures without rewriting registry behavior.",
    run: lazyRegistry,
  },
  impact: {
    summary: "measure a preparation plan's exact extraction unlock",
    usage: "impact --plan <preparation-manifest> [--app <name>] [--out <path>]",
    details:
      "Runs the reviewed preparation and configured gates in isolation, rescans its disposable result, and compares before/after candidate and application-LOC metrics.",
    run: impact,
  },
};

export { portfolioFor };
