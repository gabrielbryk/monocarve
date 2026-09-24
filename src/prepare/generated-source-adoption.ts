import { GENERATOR } from "../branding.ts";
import { configDigest, ownerFor, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { PlanningError } from "../plan/context.ts";
import { git, resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashText, type Sha256 } from "../util/hash.ts";
import { baselineFileMode, declaredGeneratedArtifacts, sortedGates, type PreparationManifestRendering } from "./build-shared.ts";
import type { PreparationManifest, PreparationReplayOperation } from "./manifest-types.ts";
import { createPreparationManifest, assertPreparationManifestValid, preparationOperationPaths } from "./manifest.ts";
import { preparationPostJournalRecords } from "./post-journal.ts";

export interface CompileGeneratedSourceAdoptionInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly baselineCommit: string;
  readonly graphDigest: Sha256;
  readonly adoptionId: string;
  readonly rendering: PreparationManifestRendering;
  readonly policySpecifier: string;
}

export function generatedSourceAdoptionPolicyAnchor(adoption: {
  readonly id: string;
  readonly policyAnchor?: string | undefined;
  readonly artifacts: readonly { readonly path: string }[];
}): { sourcePath: string; targetPath: string; targetModuleSpecifier: string } {
  const sourcePath = adoption.policyAnchor ?? adoption.artifacts[0]!.path;
  return { sourcePath, targetPath: sourcePath, targetModuleSpecifier: `adopt:${adoption.id}` };
}

type GeneratedSourceAdoption = MonocarveConfig["generatedSourceAdoptions"][number];
type AdoptedArtifact = GeneratedSourceAdoption["artifacts"][number];
type GeneratorRetirement = Extract<PreparationReplayOperation, { readonly kind: "delete-generated-source-generator" }>;

export function compileGeneratedSourceAdoption(input: CompileGeneratedSourceAdoptionInput): PreparationManifest {
  const adoption = input.config.generatedSourceAdoptions.find((item) => item.id === input.adoptionId);
  if (!adoption) throw new PlanningError(`unknown generated-source adoption ${JSON.stringify(input.adoptionId)}`);
  const policyAnchor = generatedSourceAdoptionPolicyAnchor(adoption);
  if (policyAnchor.targetModuleSpecifier !== input.policySpecifier)
    throw new PlanningError("generated-source adoption policy specifier does not match its configured identity");
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  if (input.graph.commit !== baseline.commit) throw new PlanningError("generated-source adoption requires a fresh graph at the exact baseline");
  const operations: PreparationReplayOperation[] = adoption.artifacts.map((artifact) => adoptArtifact(input, baseline.commit, artifact));
  if (adoption.retireGenerator !== undefined) operations.push(retireGenerator(input, baseline.commit, adoption, adoption.retireGenerator));
  const ordered = operations.sort(
    (left, right) => byCodeUnit(preparationOperationPaths(left)[0]!, preparationOperationPaths(right)[0]!) || byCodeUnit(left.kind, right.kind),
  );
  const operationPaths = [...new Set(ordered.flatMap(preparationOperationPaths))].toSorted(byCodeUnit);
  const generatedArtifacts = declaredGeneratedArtifacts(input.config, operationPaths);
  const postJournalPreparers = preparationPostJournalRecords(input.config, operationPaths);
  const changedFiles = [
    ...new Set([...operationPaths, ...generatedArtifacts.map((item) => item.path), ...postJournalPreparers.flatMap((item) => item.outputs)]),
  ].toSorted(byCodeUnit);
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: configDigest(input.config) },
    graphDigest: input.graphDigest,
    policyAnchor,
    declarations: [],
    operations: ordered,
    generatedArtifacts,
    postJournalPreparers,
    compatibilityReexports: [],
    changedFiles,
    commits: { prepare: input.rendering.commit },
    gates: sortedGates(input.rendering),
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

/** Strip one artifact's generated-provenance header, refusing unless its declared source is truly gone. */
function adoptArtifact(input: CompileGeneratedSourceAdoptionInput, commit: string, artifact: AdoptedArtifact): PreparationReplayOperation {
  const text = showBaseline(input.rootDir, commit, artifact.path);
  if (text === null) throw new PlanningError(`generated artifact does not exist at baseline: ${artifact.path}`);
  if (showBaseline(input.rootDir, commit, artifact.missingSource) !== null)
    throw new PlanningError(`generated source still exists; adoption refused: ${artifact.missingSource}`);
  const provenance = provenanceOf(input.config, text);
  if (!provenance.generated || provenance.source !== artifact.missingSource)
    throw new PlanningError(`artifact provenance does not declare ${artifact.missingSource}: ${artifact.path}`);
  const removed = leadingLines(text, artifact.removeHeaderLines);
  const remainingHeader = removed.rest.split("\n").slice(0, input.config.generatedArtifacts.provenance.headerLines).join("\n");
  if (new RegExp(input.config.generatedArtifacts.provenance.marker, "i").test(remainingHeader))
    throw new PlanningError(`adoption leaves generated provenance in ${artifact.path}; increase removeHeaderLines explicitly`);
  const mode = baselineFileMode(input.rootDir, commit, artifact.path);
  return {
    kind: "adopt-generated-source",
    declaredSource: artifact.missingSource,
    policySpecifier: input.policySpecifier,
    removedHeader: { lines: artifact.removeHeaderLines, hash: hashText(removed.header) },
    contents: removed.rest,
    file: { path: artifact.path, preconditionHash: hashText(text), preconditionMode: mode, resultHash: hashText(removed.rest), resultMode: mode },
  };
}

/** Delete the generator only when provenance proves every output it still regenerates is being adopted. */
function retireGenerator(
  input: CompileGeneratedSourceAdoptionInput,
  commit: string,
  adoption: GeneratedSourceAdoption,
  generator: string,
): GeneratorRetirement {
  const generatorText = showBaseline(input.rootDir, commit, generator);
  if (generatorText === null) throw new PlanningError(`generator does not exist at baseline: ${generator}`);
  const declared = new Set(adoption.artifacts.map((item) => item.path));
  const generatorNames = new Set([generator, ...adoption.artifacts.map((artifact) => ownerRelativeGenerator(input.config, artifact.path, generator))]);
  const tracked = git({ cwd: input.rootDir }, "ls-tree", "-r", "--name-only", commit, "--").split("\n").filter(Boolean).toSorted(byCodeUnit);
  const surviving = tracked
    .filter((path) => {
      const text = showBaseline(input.rootDir, commit, path);
      const command = text === null ? null : provenanceOf(input.config, text).regenerate;
      return command !== null && [...generatorNames].some((name) => command.includes(name));
    })
    .toSorted(byCodeUnit);
  if (surviving.length === 0 || surviving.some((path) => !declared.has(path)) || declared.size !== surviving.length)
    throw new PlanningError(`generator retirement proof is not exhaustive; provenance names ${surviving.join(", ") || "no outputs"}`);
  return {
    kind: "delete-generated-source-generator",
    adoptedOutputs: surviving,
    file: {
      path: generator,
      preconditionHash: hashText(generatorText),
      preconditionMode: baselineFileMode(input.rootDir, commit, generator),
      resultHash: hashText(""),
      resultMode: 0,
    },
  };
}

/** How a regenerate command run from the artifact's owning project names the generator. */
function ownerRelativeGenerator(config: MonocarveConfig, artifactPath: string, generator: string): string {
  const owner = ownerFor(config, artifactPath);
  return owner === "" || !generator.startsWith(`${owner}/`) ? generator : generator.slice(owner.length + 1);
}

function provenanceOf(config: MonocarveConfig, text: string): { generated: boolean; source: string | null; regenerate: string | null } {
  const settings = config.generatedArtifacts.provenance;
  const header = text.split("\n").slice(0, settings.headerLines);
  const capture = (pattern: string) => header.map((line) => line.match(new RegExp(pattern))?.[1]).find((value) => value !== undefined) ?? null;
  return {
    generated: header.some((line) => new RegExp(settings.marker, "i").test(line)),
    source: capture(settings.source),
    regenerate: capture(settings.regenerate),
  };
}

function leadingLines(text: string, count: number): { header: string; rest: string } {
  let end = 0;
  for (let index = 0; index < count; index += 1) {
    const newline = text.indexOf("\n", end);
    end = newline < 0 ? text.length : newline + 1;
  }
  return { header: text.slice(0, end), rest: text.slice(end) };
}
