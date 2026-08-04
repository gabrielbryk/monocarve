import type { MonocarveConfig } from "../config.ts";
import type { MultiFileSeamPlan } from "../seams/types.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";
import { compilePreparationManifest, type CompilePreparationManifestInput } from "./build.ts";
import { assertPreparationManifestValid, createPreparationManifest } from "./manifest.ts";
import type { PreparationManifest, PreparationReplayOperation } from "./manifest-types.ts";
import { PlanningError } from "../plan/context.ts";

export interface CompileMultiFilePreparationInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly baselineCommit: string;
  readonly graphDigest: Sha256;
  readonly multiSeam: MultiFileSeamPlan;
  readonly candidateId: Sha256;
  /** Independently reviewed per-donor seams which together equal the multi-file SCC. */
  readonly members: readonly Omit<CompilePreparationManifestInput, "rootDir" | "config" | "baselineCommit" | "graphDigest">[];
}

/** Compile several proven donor transforms into one atomic preparation manifest. */
export function compileMultiFilePreparationManifest(input: CompileMultiFilePreparationInput): PreparationManifest {
  const candidate = input.multiSeam.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) throw new PlanningError(`unknown multi-file seam candidate ${input.candidateId}`);
  if (input.multiSeam.blockers.length > 0 || candidate.blockers.some((item) => item.confidence === "exact")) throw new PlanningError("multi-file seam carries unresolved exact blockers");
  if (input.multiSeam.edges.some((edge) => (candidate.groupIds.includes(edge.sourceGroupId) || candidate.groupIds.includes(edge.targetGroupId)) && edge.space !== "type")) throw new PlanningError("multi-file preparation refuses value-space cross-file edges touching the reviewed candidate");
  const manifests = input.members.map((member) => compilePreparationManifest({ ...member, rootDir: input.rootDir, config: input.config, baselineCommit: input.baselineCommit, graphDigest: input.graphDigest }));
  const selected = manifests.flatMap((manifest) => manifest.declarations.map((group) => group.groupId)).sort(byCodeUnit);
  const expected = [...candidate.groupIds].sort(byCodeUnit);
  if (selected.length !== expected.length || selected.some((id, index) => id !== expected[index])) throw new PlanningError("multi-file preparation members must exactly cover the reviewed atomic candidate");
  const sourcePaths = [...new Set(manifests.flatMap((manifest) => manifest.declarations.map((group) => group.sourcePath)))].sort(byCodeUnit);
  if (sourcePaths.length !== candidate.sourcePaths.length || sourcePaths.some((path, index) => path !== candidate.sourcePaths[index])) throw new PlanningError("multi-file preparation members do not cover the candidate source files");
  const operations = manifests.flatMap((item) => item.operations).sort(operationOrder);
  const mutationPaths = operations.flatMap((operation) => operation.kind === "extract-type-declarations" ? [operation.donor.path, operation.target.path] : [operation.file.path]);
  if (new Set(mutationPaths).size !== mutationPaths.length) throw new PlanningError("multi-file preparation operations collide on a donor or target path");
  const commits = manifests.map((item) => item.commits.prepare);
  if (commits.some((commit) => hashJson(commit) !== hashJson(commits[0]))) throw new PlanningError("multi-file preparation members render different commit metadata");
  const union = (values: readonly (readonly string[])[]) => [...new Set(values.flat())].sort(byCodeUnit);
  const first = manifests[0];
  if (!first) throw new PlanningError("multi-file preparation requires at least one reviewed member");
  const manifest = createPreparationManifest({
    schemaVersion: 1, createdAt: first.createdAt, generator: first.generator, baseline: first.baseline, graphDigest: first.graphDigest,
    declarations: manifests.flatMap((item) => item.declarations).sort((a, b) => byCodeUnit(a.sourcePath, b.sourcePath) || a.declarations[0]!.span.start - b.declarations[0]!.span.start || byCodeUnit(a.groupId, b.groupId)),
    operations,
    compatibilityReexports: manifests.flatMap((item) => item.compatibilityReexports).sort((a, b) => byCodeUnit(a.fromPath, b.fromPath)),
    changedFiles: union(manifests.map((item) => item.changedFiles)),
    commits: { prepare: first.commits.prepare },
    gates: { package: union(manifests.map((item) => item.gates.package)), project: union(manifests.map((item) => item.gates.project)), workspace: union(manifests.map((item) => item.gates.workspace)) },
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

function operationOrder(left: PreparationReplayOperation, right: PreparationReplayOperation): number {
  const path = (operation: PreparationReplayOperation) => operation.kind === "extract-type-declarations" ? operation.donor.path : operation.file.path;
  return byCodeUnit(path(left), path(right)) || byCodeUnit(left.kind, right.kind);
}
