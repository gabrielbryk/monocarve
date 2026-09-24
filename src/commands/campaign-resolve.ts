/**
 * `campaign resolve`: re-resolve stable source paths against one fresh HEAD and
 * compile only the first remaining target.
 *
 * Target resolution is campaign logic that would ideally live in src/campaign;
 * it stays here, beside its only caller, because src/campaign is owned separately.
 */

import { TOOL_NAME } from "../branding.ts";
import { flagBool, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import type { DependencyGraph } from "../graph/index.ts";
import { buildPlanSync } from "../plan/build.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { buildPortfolio, type PortfolioCandidate } from "../portfolio/index.ts";
import { parseJsonObject } from "../util/json.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { planOutput, targetMode, writeManifestIfRequested } from "./planning-support.ts";
import { readWorkspaceText, requiredFlag } from "./preparation-io.ts";
import { validateStableCampaignSpec, type StableCampaignSpec } from "./preparation-specs.ts";
import { assertPlannableTree, load, loadGraph, print, type LoadedGraph } from "./shared.ts";

type CampaignTarget = StableCampaignSpec["targets"][number];

interface TargetStatus {
  readonly path: string;
  readonly packageName: string;
  readonly outcome: "unresolved" | "already-extracted" | "ambiguous" | "blocked" | "ready";
  readonly candidateId?: string;
  readonly detail?: string;
}

interface TargetResolution {
  readonly statuses: readonly TargetStatus[];
  readonly selected?: { readonly target: CampaignTarget; readonly candidate: PortfolioCandidate };
}

export async function campaignResolve(args: ParsedArgs): Promise<void> {
  if (args.flags.has("graph")) throw new UsageError("campaign resolve refuses --graph; it must rescan the native checkout at a stable HEAD");
  const { rootDir } = await load(args);
  const specPath = relativeWorkspacePath(rootDir, requiredFlag(args, "targets"));
  const spec = validateStableCampaignSpec(parseJsonObject(readWorkspaceText(rootDir, specPath, "campaign target list"), specPath, "campaign target list"));
  const scanArgs: ParsedArgs = { ...args, flags: new Map(args.flags).set("app", spec.application).set("no-cache", true) };
  const loaded = await loadGraph(scanArgs);
  const portfolio = buildPortfolio({ config: loaded.config, graph: loaded.graph, context: loaded.context, application: spec.application });
  const { statuses, selected } = resolveCampaignTargets(spec, rootDir, portfolio.candidates, loaded.graph);
  const header = { schema: "target-campaign", application: spec.application, baselineCommit: loaded.graph.commit, targets: statuses };
  if (!selected) {
    print({ ...header, outcome: statuses.every(({ outcome }) => outcome === "already-extracted") ? "completed" : "stopped" }, args);
    return;
  }
  const manifest = buildPlanSync({
    config: loaded.config,
    rootDir,
    graph: loaded.graph,
    context: loaded.context,
    candidate: selected.candidate,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    packageName: selected.target.packageName,
    ...(selected.target.packageRoot === undefined ? {} : { packageRoot: selected.target.packageRoot }),
  });
  const out = planOutput(args, loaded, manifest);
  assertPlannableTree(loaded, manifest, out, args);
  const written = writeManifestIfRequested(args, loaded, out, manifest);
  const next = written
    ? `${TOOL_NAME} apply --plan ${JSON.stringify(out)} --commit`
    : `${TOOL_NAME} campaign resolve --targets ${JSON.stringify(specPath)} --write`;
  if (flagBool(args, "json")) print({ ...header, outcome: "review-required", manifest, output: out, written, next }, args);
  else print(`${reviewText(loaded, manifest, out)}\n\nNext: ${next}`, args);
}

function reviewText(loaded: LoadedGraph, manifest: ExtractionManifest, out: string): string {
  const review = summarizePlanReview(manifest, {
    baselinePaths: targetMode(loaded, manifest.target.packageRoot) === "existing" ? [`${manifest.target.packageRoot}/package.json`] : [],
    manifestPath: out,
  });
  return formatPlanReview(review).trimEnd();
}

/** Walk targets in order, skipping extracted ones, and stop at the first that is ready or cannot proceed. */
function resolveCampaignTargets(
  spec: StableCampaignSpec,
  rootDir: string,
  candidates: readonly PortfolioCandidate[],
  graph: DependencyGraph,
): TargetResolution {
  const statuses: TargetStatus[] = [];
  for (const target of spec.targets) {
    const path = relativeWorkspacePath(rootDir, target.path);
    const resolution = resolveTarget(target, path, candidates, graph.nodes.get(path)?.application === spec.application);
    statuses.push(resolution.status);
    if (resolution.candidate) return { statuses, selected: { target, candidate: resolution.candidate } };
    if (resolution.status.outcome !== "already-extracted") break;
  }
  return { statuses };
}

function resolveTarget(
  target: CampaignTarget,
  path: string,
  candidates: readonly PortfolioCandidate[],
  existsInApplication: boolean,
): { readonly status: TargetStatus; readonly candidate?: PortfolioCandidate } {
  const base = { path, packageName: target.packageName };
  const matches = candidates.filter((candidate) => candidate.seed.members.includes(path));
  const [candidate] = matches;
  if (candidate === undefined) {
    return existsInApplication
      ? { status: { ...base, outcome: "unresolved", detail: "no principal candidate currently resolves this path" } }
      : { status: { ...base, outcome: "already-extracted", detail: "path is no longer application-owned" } };
  }
  if (matches.length > 1) {
    const ids = matches.map(({ id }) => id).toSorted();
    return { status: { ...base, outcome: "ambiguous", detail: ids.join(", ") } };
  }
  if (!candidate.eligible) {
    const detail = candidate.rejectionReasons.map((reason) => reason.detail).join("; ");
    return { status: { ...base, outcome: "blocked", candidateId: candidate.id, detail } };
  }
  return { status: { ...base, outcome: "ready", candidateId: candidate.id }, candidate };
}
