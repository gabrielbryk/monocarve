// Extracted from core.ts's compilePreparerManifest: this file holds the
// policy-resolution and worktree-execution phases as separate steps so that
// each one carries a small, independently reviewable amount of branching.
// Every function here is a direct, non-semantic lift of code that used to be
// inline in compilePreparerManifest — same computations, same order, same
// short-circuiting and thrown messages.
import type { PreparerConfig } from "../config.ts";
import { configDigest } from "../config/digest.ts";
import type { MoveOperation } from "../plan/manifest.ts";
import { preparationPostJournalRecords, runPreparationPostJournalPreparers } from "../prepare/post-journal.ts";
import type { ResolvedCommit } from "../util/git.ts";
import { resolveCommit, statusEntries } from "../util/git.ts";
import { byCodeUnit, hashJson } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import {
  assertDistinctCreates,
  assertNoDuplicatePaths,
  baselineState,
  expandCreatesPolicy,
  expandDeclaredOutputs,
  expandGeneratedArtifacts,
  expandReplacementsPolicy,
  findMove,
  findPolicy,
  mutation,
  renderCommit,
  state,
  unique,
  validatedPath,
  variables,
} from "./core-support.ts";
import type { CompilePreparerInput } from "./core.ts";
import { applyFileCreates, applyTextReplacements, type FileCreate, type TextReplacement } from "./declarative.ts";
import { PreparerError } from "./error.ts";
import { PREPARER_MANIFEST_SCHEMA_VERSION, type PreparerManifest, type PreparerMutation } from "./manifest.ts";
import { runPreparerCommand } from "./run-command.ts";

/** Everything derived from configuration + the requested move, before any worktree work happens. */
export interface CompiledPolicyPlan {
  readonly policy: PreparerConfig;
  readonly move: MoveOperation;
  readonly resolved: ResolvedCommit;
  readonly vars: Readonly<Record<string, string>>;
  readonly outputs: readonly string[];
  readonly command: string | undefined;
  readonly replacements: readonly TextReplacement[] | undefined;
  readonly creates: readonly FileCreate[] | undefined;
  readonly verify: string | undefined;
}

/** Resolve policy, move and rendered outputs, and validate their declared shape (no filesystem/worktree side effects). */
export function planPreparerCompilation(input: CompilePreparerInput): CompiledPolicyPlan {
  const policy = findPolicy(input.config, input.preparerId);
  const move = findMove(input.extraction, input.sourcePath);
  const resolved = resolveCommit(input.rootDir, input.extraction.baselineCommit);
  const vars = variables(input.extraction, move);
  const declaredOutputs = expandDeclaredOutputs(policy, vars, (path) => validatedPath(input.rootDir, path));
  const command = policy.command === undefined ? undefined : renderTemplate(policy.command, vars);
  const replacements = expandReplacementsPolicy(policy.replacements, vars, (path) => validatedPath(input.rootDir, path));
  const creates = expandCreatesPolicy(input.rootDir, policy.creates, vars);
  const outputs = resolveDeclaredOutputPaths(declaredOutputs, replacements, creates);
  const verify = policy.verify === undefined ? undefined : renderTemplate(policy.verify, vars);
  return { policy, move, resolved, vars, outputs, command, replacements, creates, verify };
}

/** Validate that declared outputs, replacements and creates do not collide, and return their union. */
function resolveDeclaredOutputPaths(
  declaredOutputs: readonly string[],
  replacements: readonly TextReplacement[] | undefined,
  creates: readonly FileCreate[] | undefined,
): string[] {
  assertDistinctCreates(creates);
  const createPaths = creates?.map((create) => create.path) ?? [];
  assertNoDuplicatePaths(declaredOutputs, "duplicate declared preparer output path");
  const declaredCreate = createPaths.find((path) => declaredOutputs.includes(path));
  if (declaredCreate !== undefined) throw new PreparerError(`created path is automatically an output and must not be declared twice: ${declaredCreate}`);
  const overlap = replacements?.find((replacement) => createPaths.includes(replacement.path));
  if (overlap !== undefined) throw new PreparerError(`preparer path cannot be both replaced and created: ${overlap.path}`);
  const outputs = unique([...declaredOutputs, ...createPaths]);
  const undeclaredReplacement = replacements?.find((replacement) => !outputs.includes(replacement.path));
  if (undeclaredReplacement !== undefined) throw new PreparerError(`text replacement path is not a declared output: ${undeclaredReplacement.path}`);
  return outputs;
}

/** Run the plan against a disposable worktree and produce the finished, self-identifying manifest. */
export async function runPreparerCompilation(input: CompilePreparerInput, plan: CompiledPolicyPlan, workspacePath: string): Promise<PreparerManifest> {
  const { policy, move, resolved, vars, outputs, command, replacements, creates, verify } = plan;
  const before = Object.fromEntries(outputs.map((path) => [path, state(workspacePath, path)]));
  if (replacements !== undefined) applyTextReplacements(workspacePath, replacements);
  if (creates !== undefined) applyFileCreates(workspacePath, creates);
  if (command !== undefined) await runPreparerCommand(command, workspacePath, input.config.gates.timeoutMs, "preparer");
  if (verify !== undefined) await runPreparerCommand(verify, workspacePath, input.config.gates.timeoutMs, "preparer verify");
  const initialMutations = outputs.map((path): PreparerMutation => mutation(workspacePath, path, before[path]!));
  // A preparer is also the supported reconciliation path after its source
  // rewrite has already landed. Keep every declared mutation path in trigger
  // scope even when it is at the terminal state, otherwise a stale derived
  // artifact can never be repaired by recompiling the same preparer.
  const triggerPaths = initialMutations.map((item) => item.path).toSorted(byCodeUnit);
  const generatedArtifacts = expandGeneratedArtifacts(input.config, triggerPaths);
  const postJournalPreparers = preparationPostJournalRecords(input.config, triggerPaths);
  const generatedPaths = unique([...generatedArtifacts.map((item) => item.path), ...postJournalPreparers.flatMap((item) => item.outputs)]);
  const overlap = generatedPaths.find((path) => outputs.includes(path));
  if (overlap !== undefined) throw new PreparerError(`preparer output cannot also be a triggered generated output: ${overlap}`);
  // Dependency installation runs before this point and may rewrite generated
  // files (for example pnpm-lock.yaml or Moon's root tsconfig).  Capture the
  // reviewed precondition from the immutable baseline commit, not the
  // disposable worktree after install; otherwise simulation records
  // post-install bytes as pre=result and real apply cannot commit them.
  const generatedBefore = Object.fromEntries(generatedPaths.map((path) => [path, baselineState(input.rootDir, resolved.commit, path)]));
  const generation = runPreparationPostJournalPreparers(input.config, workspacePath, { triggerPaths, generatedArtifacts, postJournalPreparers });
  if (!generation.ok) throw new PreparerError(generation.failure ?? "preparer generation failed");
  const changed = unique(statusEntries(workspacePath).flatMap((entry) => entry.paths)).sort(byCodeUnit);
  const changedFiles = unique([...outputs, ...generatedPaths]);
  const undeclared = changed.filter((path) => !changedFiles.includes(path));
  if (undeclared.length > 0) throw new PreparerError(`preparer wrote undeclared repository-visible path(s): ${undeclared.join(", ")}`);
  const mutations = [...initialMutations, ...generatedPaths.map((path): PreparerMutation => mutation(workspacePath, path, generatedBefore[path]!))].toSorted(
    (left, right) => byCodeUnit(left.path, right.path),
  );
  const draft = {
    schemaVersion: PREPARER_MANIFEST_SCHEMA_VERSION,
    createdAt: resolved.committedAt,
    baseline: { commit: resolved.commit, configDigest: configDigest(input.config) },
    extractionPlanId: input.extraction.planId,
    preparer: {
      id: policy.id,
      phase: policy.phase,
      ...(command === undefined ? {} : { command }),
      ...(replacements === undefined ? {} : { replacements }),
      ...(creates === undefined ? {} : { creates }),
      ...(verify === undefined ? {} : { verify }),
      commit: renderCommit(policy, vars),
    },
    binding: {
      application: input.extraction.application,
      packageName: input.extraction.target.packageName,
      packageRoot: input.extraction.target.packageRoot,
      sourcePath: move.source,
      targetPath: move.target,
    },
    mutations,
    generatedArtifacts,
    postJournalPreparers,
    triggerPaths,
    changedFiles,
  } as const;
  return { ...draft, planId: hashJson(draft) };
}
