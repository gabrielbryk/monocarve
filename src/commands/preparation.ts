import {
  advanceCampaign,
  createCampaignLedger,
  describeCampaignStatus,
  recordCampaignApplication,
  type CampaignAuditEvidence,
  type CampaignChildPlan,
} from "../campaign/index.ts";
import { flagBool, flagNumber, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { domainFor, getApplication, renderPreparationPolicy } from "../config.ts";
import { UsageError } from "../errors.ts";
import { parseManifest } from "../plan/build.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
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
import { parseJsonObject } from "../util/json.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { campaignLedgerPath, createCampaignLedgerFile, loadCampaignLedger, persistCampaignLedger } from "./campaign-ledger-file.ts";
import { graphDigest, load, loadGraph, outputPath, print, writeOutput, type LoadedGraph } from "./shared.ts";
export { writeCampaignLedgerAtomically } from "./campaign-ledger-file.ts";
import { campaignOptimize } from "./campaign-optimize.ts";
import { campaignResolve } from "./campaign-resolve.ts";
import { boundaryCommandSpec } from "./preparation-boundary.ts";
import { preparationCommandSpecs } from "./preparation-command-specs.ts";
import { graphSnapshot } from "./preparation-graph.ts";
import { loadPreparationManifest, readWorkspaceText, relativeTypeSpecifier, requiredFlag } from "./preparation-io.ts";
import { validateMultiPreparationSpec, type MultiPreparationSpec } from "./preparation-specs.ts";

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
  if (flagBool(args, "write")) createCampaignLedgerFile(rootDir, path, ledger, () => assertHeadUnchangedDuringPublication(rootDir, baselineCommit));
  print({ schema: "campaign-init", campaign: ledger, campaignPath: path, written: flagBool(args, "write") }, args);
}

function assertHeadUnchangedDuringPublication(rootDir: string, baselineCommit: string): void {
  const afterPublish = headCommit(rootDir);
  if (afterPublish === baselineCommit) return;
  throw new UsageError(
    `checkout changed from ${baselineCommit} to ${afterPublish} during campaign publication; the new ledger was removed; retry from one stable HEAD`,
  );
}

async function campaignShowStatus(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  const loaded = loadCampaignLedger(rootDir, config, requiredFlag(args, "campaign"));
  print({ schema: "campaign-status", campaignPath: loaded.path, ...describeCampaignStatus(loaded.campaign, headCommit(rootDir)) }, args);
}

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
  const applications = new Set(files.map((path) => applicationOf(loaded, path)));
  const [name] = applications;
  if (name === undefined || applications.size !== 1) throw new UsageError("multi-file seam sources must belong to one configured application");
  const application = getApplication(loaded.config, name);
  print(planMultiFileSeams({ rootDir: loaded.rootDir, tsconfigPath: application.tsconfig, sourcePaths: files, affinityForPath: affinityFor(loaded) }), args);
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
    rewriteRelativeTypeImport: relativeTypeImportRewriter(loaded),
  });
  printPreparationManifest(args, loaded, manifest);
}

async function prepareMultiPlan(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const specPath = relativeWorkspacePath(loaded.rootDir, requiredFlag(args, "spec"));
  const spec = validateMultiPreparationSpec(
    parseJsonObject(readWorkspaceText(loaded.rootDir, specPath, "multi-file preparation spec"), specPath, "multi-file preparation spec"),
  );
  const files = spec.members.map((member) => relativeWorkspacePath(loaded.rootDir, member.file));
  const applicationNames = new Set(files.map((file) => loaded.graph.nodes.get(file)?.application));
  const [name] = applicationNames;
  if (name === undefined || applicationNames.size !== 1) throw new UsageError("multi-file preparation members must belong to one configured application");
  const application = getApplication(loaded.config, name);
  const multiSeam = planMultiFileSeams({
    rootDir: loaded.rootDir,
    tsconfigPath: application.tsconfig,
    sourcePaths: files,
    affinityForPath: affinityFor(loaded),
  });
  const manifest = compileMultiFilePreparationManifest({
    rootDir: loaded.rootDir,
    config: loaded.config,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    graphDigest: graphDigest(loaded.graph),
    multiSeam,
    candidateId: spec.candidate,
    members: spec.members.map((member) => multiPreparationMember(loaded, application.tsconfig, member)),
  });
  printPreparationManifest(args, loaded, manifest);
}

/** One donor of a multi-file preparation: its seam plus the reviewed target and rendering policy. */
function multiPreparationMember(loaded: LoadedGraph, tsconfigPath: string, member: MultiPreparationSpec["members"][number]) {
  const file = relativeWorkspacePath(loaded.rootDir, member.file);
  const targetPath = relativeWorkspacePath(loaded.rootDir, member.target);
  const analysis = analyzeWorkspaceSymbols({ rootDir: loaded.rootDir, tsconfigPath, sourcePath: file, affinityForPath: affinityFor(loaded) });
  const seam = planSeam({ analysis, sourceText: readWorkspaceText(loaded.rootDir, file, "multi-file seam source"), candidateId: member.candidate, targetPath });
  return {
    seam,
    targetPath,
    targetModuleSpecifier: member.moduleSpecifier,
    reviewedGroupIds: member.groups,
    rendering: renderPreparationPolicy(loaded.config, { sourcePath: file, targetPath, targetModuleSpecifier: member.moduleSpecifier }),
    rewriteRelativeTypeImport: relativeTypeImportRewriter(loaded),
  };
}

/** Domain affinity for a path: the scanned node's domain, else the configured one. */
function affinityFor(loaded: LoadedGraph): (path: string) => string {
  return (path) => loaded.graph.nodes.get(path)?.domain ?? domainFor(loaded.config, path);
}

/** Rewrite a donor's relative type import so it resolves from the preparation target. */
function relativeTypeImportRewriter(loaded: LoadedGraph) {
  return ({ donorPath, targetPath, originalSpecifier }: { readonly donorPath: string; readonly targetPath: string; readonly originalSpecifier: string }) => {
    const resolvedSourcePath = loaded.context.resolveRelative(donorPath, originalSpecifier);
    if (!resolvedSourcePath) throw new UsageError(`could not resolve required relative type import ${originalSpecifier} from ${donorPath}`);
    return { resolvedSourcePath, targetSpecifier: relativeTypeSpecifier(targetPath, resolvedSourcePath, originalSpecifier) };
  };
}

function printPreparationManifest(args: ParsedArgs, loaded: LoadedGraph, manifest: PreparationManifest): void {
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializePreparationManifest(manifest), { exclusive: true });
  print({ ...manifest, output: out, written }, args);
}

function applicationOf(loaded: LoadedGraph, path: string): string {
  const node = loaded.graph.nodes.get(path);
  if (!node || node.zone !== "application" || node.application === undefined) throw new UsageError(`${path} is not a source file in a configured application`);
  return node.application;
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

function workspaceAnalysisFor(args: ParsedArgs, loaded: LoadedGraph) {
  const file = flagString(args, "file") ?? args.positionals[0];
  if (file === undefined) throw new UsageError("--file <path> is required");
  const sourcePath = relativeWorkspacePath(loaded.rootDir, file);
  const application = getApplication(loaded.config, applicationOf(loaded, sourcePath));
  return analyzeWorkspaceSymbols({ rootDir: loaded.rootDir, tsconfigPath: application.tsconfig, sourcePath, affinityForPath: affinityFor(loaded) });
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
