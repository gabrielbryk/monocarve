/** Read-only discovery, portfolio, and campaign commands. */

import { readFileSync } from "node:fs";

import { flagBool, flagNumber, flagString, type ParsedArgs } from "../cli/args.ts";
import { domainFor, getApplication } from "../config.ts";
import { IoError, UsageError } from "../errors.ts";
import { analyzeLayers, summarizeGraph } from "../graph/index.ts";
import {
  analyzeCommunities,
  blockedCandidates,
  blockingHints,
  buildPortfolio,
  eligibleCandidates,
  formatCandidateTable,
  marginalBlockers,
  queryCandidates,
  serializeCandidateDetails,
  type CandidateEligibility,
} from "../portfolio/index.ts";
import { parseManifest } from "../plan/build.ts";
import { PlanningError } from "../plan/context.ts";
import { analyzePlanConflicts, type CampaignPlan } from "../campaign/index.ts";
import { analyzeTypeScriptSource, analyzeWorkspaceSymbols } from "../symbols/index.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import type { CommandSpec } from "./types.ts";
import { graphDigest, load, loadGraph, print, systemReason, writeOutput, type LoadedGraph } from "./shared.ts";

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

async function scan(args: ParsedArgs): Promise<void> {
  const { graph, rootDir } = await loadGraph(args);
  const summary = { ...summarizeGraph(graph), digest: graphDigest(graph), commit: graph.commit ?? null };
  const out = flagString(args, "out");
  if (out) writeOutput(rootDir, out, `${JSON.stringify(summary, null, 2)}\n`);
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
    print(analyzeCommunities(loaded.graph, {
      ...(application === undefined ? {} : { application }),
      ...(args.flags.has("hub-inbound-threshold") ? { hubInboundThreshold: flagNumber(args, "hub-inbound-threshold", 12) } : {}),
    }), args);
    return;
  }
  const result = portfolioFor(args, loaded);
  const eligible = eligibleCandidates(result);
  const limit = flagNumber(args, "limit", 20);
  print({
    schema: "portfolio", totals: portfolioTotals(result), limit, truncated: eligible.length > limit,
    top: eligible.slice(0, limit), selected: result.selected,
  }, args);
}

async function candidates(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const eligibility = flagString(args, "eligibility") ?? "all";
  if (!isCandidateEligibility(eligibility)) {
    throw new UsageError("--eligibility must be one of all, eligible, or blocked");
  }
  const candidate = flagString(args, "candidate");
  const path = flagString(args, "path");
  const details = queryCandidates(portfolioFor(args, loaded), loaded.config, {
    ...(candidate === undefined ? {} : { id: candidate }),
    ...(path === undefined ? {} : { path }),
    eligibility,
  });
  process.stdout.write(flagBool(args, "json") ? serializeCandidateDetails(details) : formatCandidateTable(details));
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
    print({
      schema: "backlog-marginal",
      scope: "one-change lower bound: counts only candidates with exactly one rejection and, for edge-level reasons, exactly one edge; multi-blocker candidates are occurrences only",
      totals: portfolioTotals(result), limit, truncated: blockers.length > limit, top: blockers.slice(0, limit),
    }, args);
    return;
  }
  print({
    schema: "backlog", totals: portfolioTotals(result), limit, truncated: blocked.length > limit,
    top: blocked.slice(0, limit).map((candidate) => ({
      id: candidate.id, application: candidate.application, lineCount: candidate.lineCount,
      files: candidate.files.length, tests: candidate.tests.length, blocking: candidate.rejectionReasons,
      unblock: blockingHints(candidate), warnings: candidate.warnings,
    })),
  }, args);
}

export const discoveryCommands: Record<string, CommandSpec> = {
  scan: { summary: "build the dependency model", usage: "scan [--app <name>] [--no-cache] [--include-extracted] [--out <path>]", details: "Reads configured applications without changing the workspace. --include-extracted keeps already-extracted paths in the model.", run: scan },
  layers: { summary: "report domains, components, and dependency layers", usage: "layers [--app <name>] [--out <path>]", details: "Read-only architecture report derived from the current or captured graph.", run: layers },
  symbols: { summary: "analyze one file's declaration and symbol graph", usage: "symbols --file <path> [--out <path>]", details: "Reports declarations, type/value spaces, exact references, merged groups, and SCCs; never edits the file.", run: symbols },
  "split-candidates": { summary: "rank symbol split suggestions for one file", usage: "split-candidates --file <path> [--app <name>] [--out <path>]", details: "Ranks declaration SCCs using cross-file consumers and configured domain affinity.", run: splitCandidates },
  portfolio: { summary: "rank eligible extraction candidates", usage: "portfolio [--app <name>] [--limit <n>] [--include-extracted] [--communities] [--hub-inbound-threshold <n>]", details: "Shows eligible candidates, selected same-baseline candidates, warnings, and whole-portfolio totals. --communities adds the diagnostic community report.", run: portfolio },
  candidates: { summary: "inspect and filter extraction candidates", usage: "candidates [--candidate <id>] [--path <path>] [--eligibility <all|eligible|blocked>] [--app <name>] [--include-extracted]", details: "Shows a compact table by default. --json emits stable full details including the claimed closure, SCCs, blockers and concrete edges, warnings, and target suggestion. Paths are workspace-relative or absolute paths inside the workspace.", run: candidates },
  conflicts: { summary: "compare same-baseline plan conflicts", usage: "conflicts --plan <candidate>=<manifest> [--plan <candidate>=<manifest> ...]", details: "Classifies hard and replan-mergeable path conflicts. Reported waves still require rescan and replan between applied children.", run: conflicts },
  backlog: { summary: "explain blocked candidates and edges", usage: "backlog [--app <name>] [--limit <n>] [--include-extracted] [--marginal]", details: "--marginal reports a conservative one-blocker lower bound; it does not claim a full unlock simulation.", run: backlog },
};

export { portfolioFor };
