/**
 * The post-journal preparer half of regeneration.
 *
 * A preparer is a generator with a name: an identified command (or a set of
 * declarative edits) whose declared outputs the plan records, rather than a
 * single artifact with a single regenerate command. Two shapes reach this
 * module, and they are not interchangeable:
 *
 *  - a **recorded** preparer, replayed from `manifest.postJournalPreparers`.
 *    The manifest carries the mutations it made when the plan was compiled, so
 *    the replay can insist the tree is in the state those mutations expect,
 *    apply the declarative edits, and then insist the result is the recorded
 *    one. Nothing here is allowed to drift.
 *  - a **configured** preparer reached through a generated-file record's
 *    `preparerId`, for a plan that predates the recorded form. There is no
 *    mutation journal to check, so the command is re-run and only the
 *    configuration/plan agreement and the declared output set are enforced.
 *
 * Both paths share the same discipline: the command runs, and any file it
 * dirtied that the preparer did not declare is a failure rather than a silent
 * extra edit, because an undeclared output is one the plan's `changedFiles`
 * does not know about.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { MonocarveConfig, PostJournalPreparerConfig } from "../config.ts";
import type { GeneratedFileRecord, PostJournalPreparerRecord } from "../plan/manifest.ts";
import { applyFileCreates, applyTextReplacements } from "../preparer/declarative.ts";
import { fileState } from "../util/files.ts";
import { hashJson, MISSING } from "../util/hash.ts";
import { dirtyPaths, newlyDirtyPaths, run } from "./regenerate-command.ts";
import type { ArtifactRegeneration } from "./regenerate.ts";

/** What every preparer path needs: the tree, the config, and where results go. */
export interface PreparerContext {
  readonly config: MonocarveConfig;
  /** Workspace root of the tree to regenerate in: worktree or real checkout. */
  readonly treeRoot: string;
  /** Appended in completion order; reported by the caller even on failure. */
  readonly artifacts: ArtifactRegeneration[];
}

/**
 * The configured preparer, reduced to exactly the fields the manifest records,
 * with the same defaults the recording applied — so the two can be hashed
 * against each other without a field the config merely omits counting as drift.
 */
function normalizedPreparerPolicy(preparer: PostJournalPreparerConfig) {
  return {
    id: preparer.id,
    ...(preparer.command === undefined ? {} : { command: preparer.command }),
    outputs: [...new Set([...preparer.outputs, ...(preparer.creates?.map((item) => item.path) ?? [])])].sort(),
    ...(preparer.replacements === undefined ? {} : { replacements: preparer.replacements.map((item) => ({ ...item })) }),
    ...(preparer.creates === undefined ? {} : { creates: preparer.creates.map((item) => ({ ...item, mode: item.mode ?? 0o644 })) }),
    emittedModuleSpecifiers: preparer.emittedModuleSpecifiers.map((item) => ({ ...item })),
    ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
  };
}

/**
 * Every recorded preparer must still describe what the config says it does.
 * Returns the failure message for the first one that does not.
 */
export function preparerPolicyDrift(
  records: readonly PostJournalPreparerRecord[],
  configuredPreparers: ReadonlyMap<string, PostJournalPreparerConfig>,
): string | undefined {
  for (const record of records) {
    const preparer = configuredPreparers.get(record.id);
    const configuredPolicy = preparer === undefined ? undefined : normalizedPreparerPolicy(preparer);
    const { mutations: _mutations, ...recordPolicy } = record;
    if (configuredPolicy === undefined || hashJson(configuredPolicy) !== hashJson(recordPolicy))
      return `post-journal preparer ${record.id} differs from current configuration`;
  }
  return undefined;
}

/**
 * The tree must be either where the recorded mutation expects to start or
 * already where it ends — a replay onto an already-prepared tree is fine, a
 * replay onto a third state is not. Mode is checked against whichever of the
 * two the content matched.
 */
function mutationPreconditionDrift(record: PostJournalPreparerRecord, treeRoot: string): string | undefined {
  for (const mutation of record.mutations) {
    const current = fileState(resolve(treeRoot, mutation.path));
    if (current !== mutation.preconditionHash && current !== mutation.resultHash)
      return `post-journal preparer ${record.id} precondition differs from manifest: ${mutation.path}`;
    const rawMode = current === MISSING ? "missing" : statSync(resolve(treeRoot, mutation.path)).mode;
    const mode = rawMode === "missing" ? "missing" : rawMode & 0o111 ? 0o755 : 0o644;
    const expectedMode = current === mutation.resultHash ? mutation.resultMode : mutation.preconditionMode;
    if (mode !== expectedMode) return `post-journal preparer ${record.id} precondition mode differs from manifest: ${mutation.path}`;
  }
  return undefined;
}

/** Apply the recorded declarative edits, then insist on the recorded result. */
function declarativeEditDrift(record: PostJournalPreparerRecord, treeRoot: string): string | undefined {
  try {
    if (record.replacements !== undefined) applyTextReplacements(treeRoot, record.replacements);
    if (record.creates !== undefined)
      applyFileCreates(
        treeRoot,
        record.creates.map((item) => ({ ...item, mode: item.mode as 0o644 | 0o755 })),
      );
  } catch (error) {
    return `post-journal preparer ${record.id} declarative edit failed: ${(error as Error).message}`;
  }
  for (const mutation of record.mutations) {
    const current = fileState(resolve(treeRoot, mutation.path));
    if (current !== mutation.resultHash) return `post-journal preparer ${record.id} declarative result differs from manifest: ${mutation.path}`;
  }
  return undefined;
}

/** The recorded preparer's own command, then its verification, in that order. */
function recordedCommandFailure(record: PostJournalPreparerRecord, context: PreparerContext): string | undefined {
  const { config, treeRoot } = context;
  if (record.command !== undefined) {
    const result = run(record.command, treeRoot, config.generatedArtifacts.timeoutMs);
    if (result.exitCode !== 0) return `post-journal preparer ${record.id} failed (exit ${result.exitCode})${result.output ? `\n${result.output}` : ""}`;
  }
  if (record.verify !== undefined) {
    const verification = run(record.verify, treeRoot, config.generatedArtifacts.timeoutMs);
    if (verification.exitCode !== 0)
      return `post-journal preparer ${record.id} verification failed (exit ${verification.exitCode})${verification.output ? `\n${verification.output}` : ""}`;
  }
  return undefined;
}

/**
 * Replay one recorded preparer. Returns the failure message, or `undefined`
 * when the preparer completed and its declared outputs all exist.
 */
export function replayRecordedPreparer(
  record: PostJournalPreparerRecord,
  records: readonly GeneratedFileRecord[],
  context: PreparerContext,
): string | undefined {
  const { treeRoot, artifacts } = context;
  const before = new Map(record.outputs.map((path) => [path, fileState(resolve(treeRoot, path))]));
  const beforeDirty = dirtyPaths(treeRoot);
  const preconditionDrift = mutationPreconditionDrift(record, treeRoot);
  if (preconditionDrift !== undefined) return preconditionDrift;
  const declarativeDrift = declarativeEditDrift(record, treeRoot);
  if (declarativeDrift !== undefined) return declarativeDrift;
  const started = Date.now();
  const commandFailure = recordedCommandFailure(record, context);
  if (commandFailure !== undefined) return commandFailure;
  const undeclared = newlyDirtyPaths(treeRoot, beforeDirty).filter((path) => !record.outputs.includes(path));
  if (undeclared.length > 0) return `post-journal preparer ${record.id} changed undeclared output(s): ${undeclared.join(", ")}`;
  for (const generated of records.filter((item) => item.preparerId === record.id)) {
    const after = fileState(resolve(treeRoot, generated.path));
    artifacts.push({
      path: generated.path,
      command: record.command ?? "declarative edits",
      exitCode: 0,
      durationMs: Date.now() - started,
      changed: before.get(generated.path) !== after,
      hash: after,
    });
    if (after === MISSING) return `post-journal preparer ${record.id} produced no declared output: ${generated.path}`;
  }
  return undefined;
}

/**
 * Run one preparer reached through a generated-file record's `preparerId`, for
 * a plan compiled before preparers were recorded in the manifest. The plan and
 * the config must still agree on the command, the verification and the exact
 * output set; nothing else about the preparer is known here.
 */
export function runConfiguredPreparer(
  record: GeneratedFileRecord,
  preparerId: string,
  records: readonly GeneratedFileRecord[],
  configuredPreparers: ReadonlyMap<string, PostJournalPreparerConfig>,
  context: PreparerContext,
): string | undefined {
  const { config, treeRoot, artifacts } = context;
  const preparer = configuredPreparers.get(preparerId);
  if (!preparer || preparer.command !== record.regenerate || preparer.verify !== record.verify) {
    return `post-journal preparer ${preparerId} differs from current configuration`;
  }
  const declared = records
    .filter((item) => item.preparerId === preparerId)
    .map((item) => item.path)
    .sort();
  if (declared.join("\n") !== [...preparer.outputs].sort().join("\n")) {
    return `post-journal preparer ${preparerId} output set differs from current configuration`;
  }
  const before = new Map(declared.map((path) => [path, fileState(resolve(treeRoot, path))]));
  const repositoryBefore = dirtyPaths(treeRoot);
  const result = run(preparer.command, treeRoot, config.generatedArtifacts.timeoutMs);
  if (result.exitCode !== 0) return `post-journal preparer ${preparer.id} failed (exit ${result.exitCode})${result.output ? `\n${result.output}` : ""}`;
  const undeclared = newlyDirtyPaths(treeRoot, repositoryBefore).filter((path) => !declared.includes(path));
  if (undeclared.length > 0)
    return `post-journal preparer ${preparer.id} changed undeclared output(s): ${undeclared.join(", ")}; add every generated output to the preparer configuration and recompile the plan`;
  if (preparer.verify !== undefined) {
    const verification = run(preparer.verify, treeRoot, config.generatedArtifacts.timeoutMs);
    if (verification.exitCode !== 0)
      return `post-journal preparer ${preparer.id} verification failed (exit ${verification.exitCode})${verification.output ? `\n${verification.output}` : ""}`;
  }
  for (const path of declared) {
    const after = fileState(resolve(treeRoot, path));
    artifacts.push({ path, command: preparer.command, exitCode: 0, durationMs: result.durationMs, changed: before.get(path) !== after, hash: after });
    if (after === MISSING) return `post-journal preparer ${preparer.id} produced no declared output: ${path}`;
  }
  return undefined;
}
