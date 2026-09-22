import { readFileSync } from "node:fs";

import { TOOL_NAME } from "../branding.ts";
import {
  advanceCampaign,
  createCampaignLedger,
  describeCampaignStatus,
  recordCampaignApplication,
  type CampaignAuditEvidence,
  type CampaignChildPlan,
  type GraphMetricSnapshot,
} from "../campaign/index.ts";
import { flagBool, flagNumber, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { domainFor, getApplication, renderPreparationPolicy } from "../config.ts";
import { IoError, UsageError } from "../errors.ts";
import { summarizeGraph } from "../graph/index.ts";
import { parseManifest } from "../plan/build.ts";
import { buildPlanSync, serializeManifest } from "../plan/build.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { formatPlanReview, summarizePlanReview } from "../plan/review.ts";
import { buildPortfolio } from "../portfolio/index.ts";
import { applyPreparation } from "../prepare/apply.ts";
import { auditPreparation } from "../prepare/audit.ts";
import { compilePreparationManifest } from "../prepare/build.ts";
import { assertPreparationManifestValid, scanPreparationManifestBaseline, serializePreparationManifest, type PreparationManifest } from "../prepare/index.ts";
import { compileMultiFilePreparationManifest } from "../prepare/multi-build.ts";
import { planMultiFileSeams, planSeam } from "../seams/index.ts";
import { analyzeWorkspaceSymbols } from "../symbols/index.ts";
import { auditPlan } from "../transaction/audit.ts";
import { headCommit } from "../util/git.ts";
import { hashJson } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { campaignLedgerPath, createCampaignLedgerFile, loadCampaignLedger, persistCampaignLedger } from "./campaign-ledger-file.ts";
import { assertPlannableTree, graphDigest, load, loadGraph, outputPath, print, systemReason, writeOutput, type LoadedGraph } from "./shared.ts";
export { writeCampaignLedgerAtomically } from "./campaign-ledger-file.ts";
import { campaignOptimize } from "./campaign-optimize.ts";
import { boundaryCommandSpec } from "./preparation-boundary.ts";
import { preparationCommandSpecs } from "./preparation-command-specs.ts";
import { parseJsonObject, readWorkspaceText, relativeTypeSpecifier } from "./preparation-io.ts";
export { readWorkspaceText } from "./preparation-io.ts";

async function campaignInit(args: ParsedArgs): Promise<void> {
  if (args.flags.has("graph")) throw new UsageError("campaign init refuses --graph; it must scan the native checkout at a stable HEAD");
  const campaignId = requiredFlag(args, "id");
  const objective = requiredFlag(args, "objective");
  if (!args.flags.has("max-pairs")) throw new UsageError("--max-pairs <count> is required");
  const maximumPairs = flagNumber(args, "max-pairs", 0);
  if (!Number.isSafeInteger(maximumPairs) || maximumPairs < 1 || maximumPairs > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new UsageError("--max-pairs must be a positive integer whose two-child expansion is safe");
  }
  const { config, rootDir } = await load(args);
  const baselineCommit = headCommit(rootDir);
  const scanned = await freshNativeScan(args, rootDir, baselineCommit);
  const ledger = createCampaignLedger({
    campaignId,
    objective,
    stopConditions: [{ kind: "max-children", maximum: maximumPairs * 2 }],
    baselineCommit,
    initialGraph: graphSnapshot(scanned),
  });
  const path = campaignLedgerPath(rootDir, config, requiredFlag(args, "campaign"));
  if (flagBool(args, "write"))
    createCampaignLedgerFile(rootDir, path, ledger, () => {
      const afterPublish = headCommit(rootDir);
      if (afterPublish !== baselineCommit)
        throw new UsageError(
          `checkout changed from ${baselineCommit} to ${afterPublish} during campaign publication; the new ledger was removed; retry from one stable HEAD`,
        );
    });
  print({ schema: "campaign-init", campaign: ledger, campaignPath: path, written: flagBool(args, "write") }, args);
}

async function campaignShowStatus(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const loaded = loadCampaignLedger(rootDir, config, requiredFlag(args, "campaign"));
  print({ schema: "campaign-status", campaignPath: loaded.path, ...describeCampaignStatus(loaded.campaign, headCommit(rootDir)) }, args);
}

interface StableCampaignSpec {
  readonly application: string;
  readonly targets: readonly { readonly path: string; readonly packageName: string; readonly packageRoot?: string }[];
}

/** Re-resolve stable source paths against one fresh HEAD and compile only the first remaining target. */
async function campaignResolve(args: ParsedArgs): Promise<void> {
  if (args.flags.has("graph")) throw new UsageError("campaign resolve refuses --graph; it must rescan the native checkout at a stable HEAD");
  const { rootDir } = await load(args);
  const specPath = relativeWorkspacePath(rootDir, requiredFlag(args, "targets"));
  let spec: StableCampaignSpec;
  try {
    spec = JSON.parse(readWorkspaceText(rootDir, specPath, "campaign target list")) as StableCampaignSpec;
  } catch (error) {
    throw new UsageError(`could not parse campaign target list ${specPath}: ${systemReason(error)}`);
  }
  if (!spec || typeof spec.application !== "string" || !Array.isArray(spec.targets) || spec.targets.length === 0) {
    throw new UsageError("campaign target list requires application and a non-empty targets array");
  }
  const identities = new Set<string>();
  for (const [index, target] of spec.targets.entries()) {
    if (!target || typeof target.path !== "string" || typeof target.packageName !== "string" || !target.path || !target.packageName) {
      throw new UsageError(`campaign target ${index} requires non-empty path and packageName`);
    }
    if (identities.has(target.path)) throw new UsageError(`duplicate campaign target path: ${target.path}`);
    identities.add(target.path);
  }
  const scanArgs: ParsedArgs = { ...args, flags: new Map(args.flags).set("app", spec.application).set("no-cache", true) };
  const loaded = await loadGraph(scanArgs);
  const portfolio = buildPortfolio({ config: loaded.config, graph: loaded.graph, context: loaded.context, application: spec.application });
  const statuses: { path: string; packageName: string; outcome: string; candidateId?: string; detail?: string }[] = [];
  let selected: { target: StableCampaignSpec["targets"][number]; candidate: (typeof portfolio.candidates)[number] } | undefined;
  for (const target of spec.targets) {
    const path = relativeWorkspacePath(rootDir, target.path);
    const matches = portfolio.candidates.filter((candidate) => candidate.seed.members.includes(path));
    if (matches.length === 0) {
      const existsInApplication = loaded.graph.nodes.get(path)?.application === spec.application;
      statuses.push({
        path,
        packageName: target.packageName,
        outcome: existsInApplication ? "unresolved" : "already-extracted",
        detail: existsInApplication ? "no principal candidate currently resolves this path" : "path is no longer application-owned",
      });
      if (existsInApplication) break;
      continue;
    }
    if (matches.length > 1) {
      statuses.push({
        path,
        packageName: target.packageName,
        outcome: "ambiguous",
        detail: matches
          .map(({ id }) => id)
          .sort()
          .join(", "),
      });
      break;
    }
    const candidate = matches[0]!;
    if (!candidate.eligible) {
      statuses.push({
        path,
        packageName: target.packageName,
        outcome: "blocked",
        candidateId: candidate.id,
        detail: candidate.rejectionReasons.map(({ detail }) => detail).join("; "),
      });
      break;
    }
    statuses.push({ path, packageName: target.packageName, outcome: "ready", candidateId: candidate.id });
    selected = { target, candidate };
    break;
  }
  if (!selected) {
    print(
      {
        schema: "target-campaign",
        application: spec.application,
        baselineCommit: loaded.graph.commit,
        targets: statuses,
        outcome: statuses.every(({ outcome }) => outcome === "already-extracted") ? "completed" : "stopped",
      },
      args,
    );
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
  const out = outputPath(rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  assertPlannableTree(loaded, manifest, out, args);
  const written = flagBool(args, "write");
  if (written) writeOutput(rootDir, out, serializeManifest(manifest), { exclusive: true });
  const result = {
    schema: "target-campaign",
    application: spec.application,
    baselineCommit: loaded.graph.commit,
    targets: statuses,
    outcome: "review-required",
    manifest,
    output: out,
    written,
    next: written ? `${TOOL_NAME} apply --plan ${JSON.stringify(out)} --commit` : `${TOOL_NAME} campaign resolve --targets ${JSON.stringify(specPath)} --write`,
  };
  if (flagBool(args, "json")) print(result, args);
  else {
    const review = summarizePlanReview(manifest, {
      baselinePaths: loaded.graph.workspace.owners.includes(manifest.target.packageRoot) ? [`${manifest.target.packageRoot}/package.json`] : [],
      manifestPath: out,
    });
    print(`${formatPlanReview(review).trimEnd()}\n\nNext: ${result.next}`, args);
  }
}

/** Compile a read-only, declaration-SCC seam proposal for one configured source file. */
async function seams(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const candidateId = flagString(args, "candidate");
  if (candidateId === undefined) throw new UsageError("--candidate <id> is required");
  const analysis = workspaceAnalysisFor(args, loaded);
  const targetPath = flagString(args, "target");
  print(
    planSeam({
      analysis,
      sourceText: readWorkspaceText(loaded.rootDir, analysis.source.sourcePath, "seam source"),
      candidateId,
      ...(targetPath === undefined ? {} : { targetPath: relativeWorkspacePath(loaded.rootDir, targetPath) }),
    }),
    args,
  );
}

/** Analyze declaration SCCs spanning an explicit, bounded set of configured files. */
async function multiFileSeams(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const files = flagStrings(args, "file").map((path) => relativeWorkspacePath(loaded.rootDir, path));
  if (files.length < 2) throw new UsageError("at least two --file <path> values are required");
  const applications = files.map((path) => {
    const node = loaded.graph.nodes.get(path);
    if (!node || node.zone !== "application" || node.application === undefined) {
      throw new UsageError(`${path} is not a source file in a configured application`);
    }
    return node.application;
  });
  if (new Set(applications).size !== 1) throw new UsageError("multi-file seam sources must belong to one configured application");
  const application = getApplication(loaded.config, applications[0]!);
  print(
    planMultiFileSeams({
      rootDir: loaded.rootDir,
      tsconfigPath: application.tsconfig,
      sourcePaths: files,
      affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
    }),
    args,
  );
}

async function preparePlan(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const candidateId = requiredFlag(args, "candidate");
  const targetPath = relativeWorkspacePath(loaded.rootDir, requiredFlag(args, "target"));
  const targetModuleSpecifier = requiredFlag(args, "module-specifier");
  const reviewedGroupIds = flagStrings(args, "group");
  if (reviewedGroupIds.length === 0) throw new UsageError("at least one --group <id> is required");
  const analysis = workspaceAnalysisFor(args, loaded);
  const seam = planSeam({ analysis, sourceText: readWorkspaceText(loaded.rootDir, analysis.source.sourcePath, "seam source"), candidateId, targetPath });
  const manifest = compilePreparationManifest({
    rootDir: loaded.rootDir,
    config: loaded.config,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    graphDigest: graphDigest(loaded.graph),
    seam,
    targetPath,
    targetModuleSpecifier,
    reviewedGroupIds,
    rendering: renderPreparationPolicy(loaded.config, { sourcePath: seam.sourcePath, targetPath, targetModuleSpecifier }),
    rewriteRelativeTypeImport: ({ donorPath, targetPath: target, originalSpecifier }) => {
      const resolvedSourcePath = loaded.context.resolveRelative(donorPath, originalSpecifier);
      if (resolvedSourcePath === undefined) {
        throw new UsageError(`could not resolve required relative type import ${originalSpecifier} from ${donorPath}`);
      }
      return { resolvedSourcePath, targetSpecifier: relativeTypeSpecifier(target, resolvedSourcePath, originalSpecifier) };
    },
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializePreparationManifest(manifest), { exclusive: true });
  print({ ...manifest, output: out, written }, args);
}

interface MultiPreparationSpec {
  readonly candidate: string;
  readonly members: readonly { file: string; candidate: string; target: string; moduleSpecifier: string; groups: readonly string[] }[];
}

async function prepareMultiPlan(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const specPath = relativeWorkspacePath(loaded.rootDir, requiredFlag(args, "spec"));
  let spec: MultiPreparationSpec;
  try {
    spec = JSON.parse(readWorkspaceText(loaded.rootDir, specPath, "multi-file preparation spec")) as MultiPreparationSpec;
  } catch (error) {
    throw new UsageError(`could not parse multi-file preparation spec ${specPath}: ${systemReason(error)}`);
  }
  if (!spec || typeof spec.candidate !== "string" || !Array.isArray(spec.members) || spec.members.length < 2)
    throw new UsageError("multi-file preparation spec requires candidate and at least two members");
  const files = spec.members.map((member) => relativeWorkspacePath(loaded.rootDir, member.file));
  const applicationNames = files.map((file) => loaded.graph.nodes.get(file)?.application);
  if (applicationNames.some((name) => name === undefined) || new Set(applicationNames).size !== 1)
    throw new UsageError("multi-file preparation members must belong to one configured application");
  const application = getApplication(loaded.config, applicationNames[0]!);
  const multiSeam = planMultiFileSeams({
    rootDir: loaded.rootDir,
    tsconfigPath: application.tsconfig,
    sourcePaths: files,
    affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
  });
  const members = spec.members.map((member) => {
    const file = relativeWorkspacePath(loaded.rootDir, member.file);
    const targetPath = relativeWorkspacePath(loaded.rootDir, member.target);
    const analysis = analyzeWorkspaceSymbols({
      rootDir: loaded.rootDir,
      tsconfigPath: application.tsconfig,
      sourcePath: file,
      affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
    });
    const seam = planSeam({
      analysis,
      sourceText: readWorkspaceText(loaded.rootDir, file, "multi-file seam source"),
      candidateId: member.candidate,
      targetPath,
    });
    return {
      seam,
      targetPath,
      targetModuleSpecifier: member.moduleSpecifier,
      reviewedGroupIds: member.groups,
      rendering: renderPreparationPolicy(loaded.config, { sourcePath: file, targetPath, targetModuleSpecifier: member.moduleSpecifier }),
      rewriteRelativeTypeImport: ({
        donorPath,
        targetPath: target,
        originalSpecifier,
      }: {
        donorPath: string;
        targetPath: string;
        originalSpecifier: string;
      }) => {
        const resolvedSourcePath = loaded.context.resolveRelative(donorPath, originalSpecifier);
        if (!resolvedSourcePath) throw new UsageError(`could not resolve required relative type import ${originalSpecifier} from ${donorPath}`);
        return { resolvedSourcePath, targetSpecifier: relativeTypeSpecifier(target, resolvedSourcePath, originalSpecifier) };
      },
    };
  });
  const manifest = compileMultiFilePreparationManifest({
    rootDir: loaded.rootDir,
    config: loaded.config,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    graphDigest: graphDigest(loaded.graph),
    multiSeam,
    candidateId: spec.candidate,
    members,
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializePreparationManifest(manifest), { exclusive: true });
  print({ ...manifest, output: out, written }, args);
}

async function prepareAudit(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { path, manifest } = loadPreparationManifest(args, rootDir);
  const freshGraph = await scanPreparationManifestBaseline({ config, rootDir, manifest });
  const report = await auditPreparation({ config, rootDir, manifest, approvedManifestPath: path, freshGraph });
  print(report, args);
  if (!report.passed) process.exitCode = 1;
}

async function prepareApply(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const { path, manifest } = loadPreparationManifest(args, rootDir);
  const result = await applyPreparation({ config, rootDir, manifest, manifestPath: path, ...(flagBool(args, "commit") ? { commit: true } : {}) });
  print(result, args);
  if (!result.ok) process.exitCode = 1;
}

async function campaignAdvance(args: ParsedArgs): Promise<void> {
  if (args.flags.has("graph")) {
    throw new UsageError("campaign advance refuses --graph; it must rescan the native checkout after verifying HEAD");
  }
  const { config, rootDir } = await load(args);
  const campaignPath = requiredFlag(args, "campaign");
  const loadedCampaign = loadCampaignLedger(rootDir, config, campaignPath);
  const { path, campaign } = loadedCampaign;
  const nextPlanPath = flagString(args, "next-plan");
  const next = nextPlanPath === undefined ? undefined : loadCampaignPlan(rootDir, nextPlanPath, requiredFlag(args, "pair")).child;
  let freshScannerDigest: string | undefined;
  const result = await advanceCampaign({
    campaign,
    headCommit: () => headCommit(rootDir),
    rescan: async ({ headCommit: expectedHead }) => {
      const loaded = await freshNativeScan(args, rootDir, expectedHead);
      freshScannerDigest = graphDigest(loaded.graph);
      return graphSnapshot(loaded);
    },
    compileNext: ({ headCommit: baselineCommit }) => {
      if (next === undefined) return undefined;
      if (next.baselineCommit !== baselineCommit) {
        throw new UsageError(`next plan ${next.planId} is based on ${next.baselineCommit}, but campaign HEAD is ${baselineCommit}`);
      }
      if (freshScannerDigest === undefined) throw new UsageError("campaign rescan returned no scanner graph digest");
      if (next.graphDigest !== freshScannerDigest) {
        throw new UsageError(`next plan ${next.planId} was compiled from graph ${next.graphDigest}, but fresh graph is ${freshScannerDigest}`);
      }
      return next;
    },
  });
  const written = flagBool(args, "write");
  if (written) persistCampaignLedger(rootDir, loadedCampaign, result.campaign);
  print({ ...result, campaignPath: path, written }, args);
}

async function campaignRecord(args: ParsedArgs): Promise<void> {
  if (args.flags.has("graph")) {
    throw new UsageError("campaign record refuses --graph; it must audit and rescan the native checkout");
  }
  const { config, rootDir } = await load(args);
  const loadedCampaign = loadCampaignLedger(rootDir, config, requiredFlag(args, "campaign"));
  const { path: campaignPath, campaign } = loadedCampaign;
  const plan = loadCampaignPlan(rootDir, requiredFlag(args, "plan"), requiredFlag(args, "pair"));
  const resultingHead = headCommit(rootDir);
  let audit: CampaignAuditEvidence;
  if (plan.kind === "preparation") {
    const freshGraph = await scanPreparationManifestBaseline({ config, rootDir, manifest: plan.manifest });
    const report = await auditPreparation({ config, rootDir, manifest: plan.manifest, approvedManifestPath: plan.path, freshGraph });
    audit = { kind: "preparation", report, digest: hashJson(report) };
  } else {
    const report = await auditPlan({ config, rootDir, manifest: plan.manifest });
    audit = { kind: "extraction", report, digest: hashJson(report) };
  }
  const auditedHead = headCommit(rootDir);
  const scanned = await freshNativeScan(args, rootDir, resultingHead);
  const scannedHead = headCommit(rootDir);
  const next = recordCampaignApplication({ campaign, plan: plan.child, resultingHead, auditedHead, scannedHead, audit, postScan: graphSnapshot(scanned) });
  const written = flagBool(args, "write");
  if (written) persistCampaignLedger(rootDir, loadedCampaign, next);
  print({ schema: "campaign-record", campaign: next, campaignPath, written }, args);
}

function withoutCachedGraph(args: ParsedArgs): ParsedArgs {
  const flags = new Map(args.flags);
  flags.delete("graph");
  flags.set("no-cache", true);
  const repeated = new Map(args.repeated);
  repeated.delete("graph");
  return { ...args, flags, repeated };
}

async function freshNativeScan(args: ParsedArgs, rootDir: string, expectedHead: string): Promise<LoadedGraph> {
  const loaded = await loadGraph(withoutCachedGraph(args));
  if (loaded.rootDir !== rootDir) throw new UsageError("campaign scan resolved a different workspace root");
  if (loaded.graph.commit !== expectedHead) {
    throw new UsageError(`native scan observed ${loaded.graph.commit ?? "no commit"}, but campaign HEAD is ${expectedHead}`);
  }
  const afterScan = headCommit(rootDir);
  if (afterScan !== expectedHead) {
    throw new UsageError(`checkout changed from ${expectedHead} to ${afterScan} while campaign scanned; retry from one stable HEAD`);
  }
  return loaded;
}

export function loadPreparationManifest(args: ParsedArgs, rootDir: string): { path: string; manifest: PreparationManifest } {
  const input = flagString(args, "plan") ?? args.positionals[0];
  if (input === undefined) throw new UsageError("a preparation plan path is required (--plan <path>)");
  const path = relativeWorkspacePath(rootDir, input);
  let text: string;
  try {
    text = readFileSync(workspacePath(rootDir, path), "utf8");
  } catch (error) {
    throw new IoError(`could not read preparation plan ${path}: ${systemReason(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`could not parse preparation plan ${path}: ${systemReason(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`preparation plan ${path} is not a JSON object`);
  }
  if ("preparer" in parsed && !("operations" in parsed)) {
    throw new UsageError(`preparation plan ${path} is a preparer manifest; use preparer-apply --plan ${path} (then preparer-commit) instead`);
  }
  if (!("operations" in parsed)) {
    throw new UsageError(`preparation plan ${path} is missing its operations array; refusing to interpret an unknown schema as a declaration-preparation plan`);
  }
  const manifest = parsed as PreparationManifest;
  assertPreparationManifestValid(manifest);
  return { path, manifest };
}

function workspaceAnalysisFor(args: ParsedArgs, loaded: LoadedGraph) {
  const file = flagString(args, "file") ?? args.positionals[0];
  if (file === undefined) throw new UsageError("--file <path> is required");
  const sourcePath = relativeWorkspacePath(loaded.rootDir, file);
  const node = loaded.graph.nodes.get(sourcePath);
  if (!node || node.zone !== "application" || node.application === undefined) {
    throw new UsageError(`${sourcePath} is not a source file in a configured application`);
  }
  const application = getApplication(loaded.config, node.application);
  return analyzeWorkspaceSymbols({
    rootDir: loaded.rootDir,
    tsconfigPath: application.tsconfig,
    sourcePath,
    affinityForPath: (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path),
  });
}

export function requiredFlag(args: ParsedArgs, name: string): string {
  const value = flagString(args, name);
  if (value === undefined) throw new UsageError(`--${name} <value> is required`);
  return value;
}

interface PlannedChildWithGraph extends CampaignChildPlan {
  readonly graphDigest: string;
}

interface LoadedPreparationCampaignPlan {
  readonly kind: "preparation";
  readonly path: string;
  readonly child: PlannedChildWithGraph;
  readonly manifest: PreparationManifest;
}

interface LoadedExtractionCampaignPlan {
  readonly kind: "extraction";
  readonly path: string;
  readonly child: PlannedChildWithGraph;
  readonly manifest: ExtractionManifest;
}

type LoadedCampaignPlan = LoadedPreparationCampaignPlan | LoadedExtractionCampaignPlan;

function loadCampaignPlan(rootDir: string, input: string, pairId: string): LoadedCampaignPlan {
  const path = relativeWorkspacePath(rootDir, input);
  const text = readWorkspaceText(rootDir, path, "next plan");
  const parsed = parseJsonObject(text, path, "next plan");
  if ("baseline" in parsed) {
    const manifest = parsed as unknown as PreparationManifest;
    assertPreparationManifestValid(manifest);
    return {
      kind: "preparation",
      path,
      manifest,
      child: {
        id: manifest.planId,
        pairId,
        kind: "preparation",
        planId: manifest.planId,
        baselineCommit: manifest.baseline.commit,
        graphDigest: manifest.graphDigest,
      },
    };
  }
  const manifest = parseManifest(text, path);
  return { kind: "extraction", path, manifest, child: extractionCampaignChild(manifest, pairId) };
}

function extractionCampaignChild(manifest: ExtractionManifest, pairId: string): PlannedChildWithGraph {
  return {
    id: manifest.planId,
    pairId,
    kind: "extraction",
    planId: manifest.planId,
    baselineCommit: manifest.baselineCommit,
    graphDigest: manifest.graphDigest,
  };
}

function graphSnapshot(loaded: LoadedGraph): GraphMetricSnapshot {
  const summary = summarizeGraph(loaded.graph);
  const metrics = {
    moduleCount: summary.moduleCount,
    edgeCount: summary.edgeCount,
    unresolvedCount: summary.unresolvedCount,
    dynamicImportCount: summary.dynamicImportCount,
    applicationModuleCount: summary.byZone.application,
    packageModuleCount: summary.byZone.package,
    repositoryModuleCount: summary.byZone.repo,
    externalModuleCount: summary.byZone.external,
  };
  return { digest: hashJson(metrics), metrics };
}

export const preparationCommands = preparationCommandSpecs({
  seams,
  multiFileSeams,
  preparePlan,
  prepareMultiPlan,
  prepareAudit,
  prepareApply,
  campaignResolve,
  campaignOptimize,
  campaignInit,
  campaignShowStatus,
  campaignAdvance,
  campaignRecord,
  boundary: boundaryCommandSpec,
});
