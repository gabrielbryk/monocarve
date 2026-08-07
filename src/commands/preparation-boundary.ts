/**
 * The `boundary review|compile|simulate|apply` command group, split out of
 * `preparation.ts` purely to keep that file under the line-count gate: this
 * half owns nothing about seams, campaigns, or plain declaration-preparation
 * plans — only resolving a declared composition/port boundary, compiling it
 * into a replayable preparation manifest, and simulating or applying that
 * manifest. `preparation.ts` still owns `loadPreparationManifest` and
 * `readWorkspaceText`, which this module borrows for its own manifest and
 * template loading.
 */

import { flagBool, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { renderPreparationPolicy } from "../config.ts";
import { UsageError } from "../errors.ts";
import { buildApplicationGraph } from "../graph/components.ts";
import { applyPreparation } from "../prepare/apply.ts";
import { compileModulePromotion } from "../plan/module-promotion.ts";
import { serializeManifest } from "../plan/build.ts";
import { applyPlan } from "../transaction/apply.ts";
import { simulatePlan } from "../transaction/simulate.ts";
import { compileBoundaryPreparationManifest } from "../prepare/build.ts";
import { compileGeneratedSourceAdoption, generatedSourceAdoptionPolicyAnchor } from "../prepare/generated-source-adoption.ts";
import { resolveBoundaries } from "../prepare/boundary-resolve.ts";
import { simulatePreparation } from "../prepare/simulate.ts";
import { serializePreparationManifest } from "../prepare/index.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import type { CommandSpec } from "./types.ts";
import { graphDigest, load, loadGraph, loadManifest, outputPath, print, writeOutput, type LoadedGraph } from "./shared.ts";
import { loadPreparationManifest, readWorkspaceText, requiredFlag } from "./preparation.ts";

/** Read-only: resolve one declared boundary and its baseline importer candidates. */
async function boundaryReview(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const id = requiredFlag(args, "id");
  const promotion = loaded.config.modulePromotions.find((item) => item.id === id);
  if (promotion) {
    const candidateImporters = [...new Set([...(loaded.graph.incoming.get(promotion.source) ?? []), ...(loaded.graph.testImporters.get(promotion.source) ?? [])])].sort();
    const application = loaded.graph.nodes.get(promotion.source)?.application;
    const appGraph = buildApplicationGraph(loaded.graph, application);
    const componentId = appGraph.condensed.componentByNode.get(promotion.source);
    const candidateScc = componentId === undefined ? [] : appGraph.condensed.components[componentId] ?? [];
    print({ schema: "boundary-review", kind: "module-promotion", promotion, candidateImporters, candidateScc }, args);
    return;
  }
  const adoption = loaded.config.generatedSourceAdoptions.find((item) => item.id === id);
  if (adoption) {
    print({ schema: "boundary-review", kind: "generated-source-adoption", adoption }, args);
    return;
  }
  const boundary = findBoundary(loaded, id);
  const candidateImporters = [...(loaded.graph.incoming.get(boundary.retained) ?? [])];
  print({ schema: "boundary-review", boundary, candidateImporters }, args);
}

/** Compile a declared boundary into a replayable preparation manifest. */
async function boundaryCompile(args: ParsedArgs): Promise<void> {
  const loaded = await loadGraph(args);
  const id = requiredFlag(args, "id");
  const promotion = loaded.config.modulePromotions.find((item) => item.id === id);
  if (promotion) {
    const manifest = compileModulePromotion({ rootDir: loaded.rootDir, config: loaded.config, graph: loaded.graph, context: loaded.context, baselineCommit: loaded.graph.commit ?? "HEAD", promotionId: id });
    const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
    const written = flagBool(args, "write");
    if (written) writeOutput(loaded.rootDir, out, serializeManifest(manifest), { exclusive: true });
    print({ ...manifest, output: out, written }, args);
    return;
  }
  const adoption = loaded.config.generatedSourceAdoptions.find((item) => item.id === id);
  if (adoption) {
    const policyAnchor = generatedSourceAdoptionPolicyAnchor(adoption);
    const policySpecifier = policyAnchor.targetModuleSpecifier;
    const rendering = renderPreparationPolicy(loaded.config, policyAnchor);
    const manifest = compileGeneratedSourceAdoption({ rootDir: loaded.rootDir, config: loaded.config, graph: loaded.graph, baselineCommit: loaded.graph.commit ?? "HEAD", graphDigest: graphDigest(loaded.graph), adoptionId: id, rendering, policySpecifier });
    const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
    const written = flagBool(args, "write");
    if (written) writeOutput(loaded.rootDir, out, serializePreparationManifest(manifest), { exclusive: true });
    print({ ...manifest, output: out, written }, args);
    return;
  }
  const boundary = findBoundary(loaded, id);
  const targetFlag = flagString(args, "target");
  const contractTargetPath = targetFlag === undefined ? undefined : relativeWorkspacePath(loaded.rootDir, targetFlag);
  if (boundary.strategy === "port" && contractTargetPath === undefined) {
    throw new UsageError(`boundary ${boundary.id} uses strategy "port" and requires --target <path> for the promoted contract module`);
  }
  const templateId = flagString(args, "template");
  const adapterTemplateText = templateId === undefined ? undefined : resolveAdapterTemplateText(loaded, templateId);
  const templateVars = parseTemplateVars(args);
  const targetModuleSpecifier = boundary.strategy === "existing-package" ? boundary.replacementSpecifier : boundary.packageImport;
  const rendering = renderPreparationPolicy(loaded.config, {
    sourcePath: boundary.retained,
    targetPath: contractTargetPath ?? boundary.retained,
    targetModuleSpecifier,
  });
  const manifest = compileBoundaryPreparationManifest({
    rootDir: loaded.rootDir,
    config: loaded.config,
    baselineCommit: loaded.graph.commit ?? "HEAD",
    graphDigest: graphDigest(loaded.graph),
    boundaryId: boundary.id,
    graph: loaded.graph,
    rendering,
    ...(contractTargetPath === undefined ? {} : { contractTargetPath }),
    ...(adapterTemplateText === undefined ? {} : { adapterTemplateText }),
    ...(Object.keys(templateVars).length === 0 ? {} : { templateVars }),
  });
  const out = outputPath(loaded.rootDir, flagString(args, "out") ?? `${loaded.config.planDir}/${manifest.planId}.json`);
  const written = flagBool(args, "write");
  if (written) writeOutput(loaded.rootDir, out, serializePreparationManifest(manifest), { exclusive: true });
  print({ ...manifest, output: out, written }, args);
}

/** Replay a compiled boundary (or any) preparation manifest in a disposable worktree without applying it. */
async function boundarySimulate(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  if (isExtractionPlan(args, rootDir)) {
    const { manifest } = await loadManifest(args, rootDir);
    const result = await simulatePlan({ config, rootDir, manifest });
    print(result, args);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const { manifest } = loadPreparationManifest(args, rootDir);
  const result = await simulatePreparation({ config, rootDir, manifest });
  print(result, args);
  if (!result.ok) process.exitCode = 1;
}

/** Simulate (without --commit) or apply (--commit) a reviewed boundary preparation manifest. */
async function boundaryApply(args: ParsedArgs): Promise<void> {
  const { config, rootDir } = await load(args);
  if (isExtractionPlan(args, rootDir)) {
    const { path, manifest } = await loadManifest(args, rootDir);
    const result = await applyPlan({ config, rootDir, manifest, manifestPath: path, ...(flagBool(args, "commit") ? { commit: true } : {}) });
    print(result, args);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const { path, manifest } = loadPreparationManifest(args, rootDir);
  const result = await applyPreparation({
    config,
    rootDir,
    manifest,
    manifestPath: path,
    ...(flagBool(args, "commit") ? { commit: true } : {}),
  });
  print(result, args);
  if (!result.ok) process.exitCode = 1;
}

function isExtractionPlan(args: ParsedArgs, rootDir: string): boolean {
  const path = flagString(args, "plan");
  if (path === undefined) return false;
  try {
    const parsed = JSON.parse(readWorkspaceText(rootDir, relativeWorkspacePath(rootDir, path), "boundary plan")) as { schemaVersion?: unknown };
    return parsed.schemaVersion === 2;
  } catch {
    return false;
  }
}

function findBoundary(loaded: LoadedGraph, boundaryId: string) {
  const boundary = resolveBoundaries({
    compositionBoundaries: loaded.config.compositionBoundaries,
    portPromotions: loaded.config.portPromotions,
  }).find((item) => item.id === boundaryId);
  if (!boundary) throw new UsageError(`unknown boundary id ${JSON.stringify(boundaryId)}`);
  return boundary;
}

/** Resolve a reviewed adapter-template id (see `scaffoldTemplates.extraFiles`) to its literal body. */
function resolveAdapterTemplateText(loaded: LoadedGraph, templateId: string): string {
  const source = loaded.config.scaffoldTemplates.extraFiles[templateId];
  if (!source) throw new UsageError(`no scaffoldTemplates.extraFiles entry named ${JSON.stringify(templateId)}; a boundary's reviewed template must be declared there`);
  if ("contents" in source) return source.contents;
  return readWorkspaceText(loaded.rootDir, relativeWorkspacePath(loaded.rootDir, source.file), "boundary adapter template");
}

function parseTemplateVars(args: ParsedArgs): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entry of flagStrings(args, "var")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) throw new UsageError(`--var must be key=value, got ${JSON.stringify(entry)}`);
    vars[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return vars;
}

export const boundaryCommandSpec: CommandSpec = {
  summary: "compile, review, simulate, or apply a declared architectural boundary",
  usage: "boundary review --id <boundaryId>\n       boundary compile --id <boundaryId> [--target <path>] [--template <id>] [--var key=value ...] [--out <path>] [--write]\n       boundary simulate --plan <manifest>\n       boundary apply --plan <manifest> [--commit]",
  details: "review reports a declared composition boundary, port promotion, module promotion, or generated-source adoption and its graph-derived evidence. compile derives importer sets itself, records SCC-cut or provenance proofs where applicable, and never accepts a hand-typed importer list. simulate replays the compiled manifest in a disposable worktree; apply simulates and, with --commit, lands it.",
  run: async (args) => {
    const action = args.positionals[0];
    const nested = { ...args, positionals: args.positionals.slice(1) };
    if (action === "review") return boundaryReview(nested);
    if (action === "compile") return boundaryCompile(nested);
    if (action === "simulate") return boundarySimulate(nested);
    if (action === "apply") return boundaryApply(nested);
    throw new UsageError(`unknown boundary action ${JSON.stringify(action ?? "")}; expected review, compile, simulate, or apply`);
  },
};
