/**
 * Regeneration of the declared generated artifacts.
 *
 * A move invalidates files that nobody edits: a registry keyed on a directory
 * listing, a barrel of every module under a root, a ledger counting sources.
 * The plan records what regenerates each of them; this is where that command is
 * actually run, and running it is what makes the rest of the pipeline honest.
 * Without it the simulation gates run against a tree whose generated files
 * still describe the pre-move workspace — so either a repository's own
 * consistency check fails and the plan can never be applied, or worse, there is
 * no such check and the stale file lands.
 *
 * Ordering, in both trees:
 *
 *  1. the journal is replayed, so the tree is the extraction's final shape;
 *  2. **the artifacts are regenerated here**;
 *  3. the audit and then the gates read the result.
 *
 * The audit is deliberately downstream of this, not upstream: a generated
 * barrel still importing a moved path is a real stale-reference finding *after*
 * regeneration and a meaningless one before it.
 *
 * Two rules keep the executed command trustworthy:
 *
 *  - it comes from the **config**, not from the manifest. A manifest is a JSON
 *    file that travels through review and CI; the repository's own config is
 *    the place a shell command belongs.
 *  - the manifest must nevertheless agree with the config, and the config must
 *    not have grown an artifact this plan predates. Either divergence means the
 *    plan no longer describes what an apply would do, and the run stops instead
 *    of quietly doing something else.
 *
 * The post-journal preparers — the other, identified shape a generator takes —
 * live in `./regenerate-preparers.ts`; the subprocess and working-tree
 * primitives both halves share live in `./regenerate-command.ts`.
 */

import { resolve } from "node:path";

import {
  triggeredArtifacts,
  triggeredPostJournalPreparers,
  type GeneratedArtifactConfig,
  type MonocarveConfig,
} from "../config.ts";
import { fileState } from "../util/files.ts";
import { MISSING, type FileState } from "../util/hash.ts";
import {
  regeneratedArtifacts,
  type ExtractionManifest,
  type GeneratedFileRecord,
} from "../plan/manifest.ts";
import { dirtyPaths, newlyDirtyPaths, run } from "./regenerate-command.ts";
import {
  preparerPolicyDrift,
  replayRecordedPreparer,
  runConfiguredPreparer,
  type PreparerContext,
} from "./regenerate-preparers.ts";

export interface ArtifactRegeneration {
  /** Workspace-relative artifact path. */
  readonly path: string;
  /** The command as configured. */
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** True when the command actually rewrote the file — a stale artifact does. */
  readonly changed: boolean;
  /** State after the command; `"missing"` means it produced nothing. */
  readonly hash: FileState;
  /** Tail of combined output, retained only on failure. */
  readonly output?: string;
}

export interface RegenerationReport {
  readonly ok: boolean;
  /** One entry per artifact attempted, in plan order. Stops at the first failure. */
  readonly artifacts: readonly ArtifactRegeneration[];
  readonly failure?: string;
}

export interface RegenerateOptions {
  readonly config: MonocarveConfig;
  /** Workspace root of the tree to regenerate in: worktree or real checkout. */
  readonly treeRoot: string;
  readonly manifest: ExtractionManifest;
}

/**
 * A configured artifact this extraction triggers that the plan never recorded:
 * the config gained it after the plan was compiled. Applying now would leave it
 * stale, and the plan's `changedFiles` would be wrong about it, so the plan has
 * to be recompiled rather than stretched.
 */
function undeclaredArtifactFailure(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  records: readonly GeneratedFileRecord[],
): string | undefined {
  const declared = new Set(records.map((record) => record.path));
  const missing = triggeredArtifacts(config, manifest.source?.files ?? [])
    .map((artifact) => artifact.path)
    .filter((path) => !declared.has(path));
  if (missing.length === 0) return undefined;
  return (
    `the configured generated artifact(s) ${missing.join(", ")} are triggered by this extraction and the plan ` +
    "does not declare them; recompile the plan against the current config"
  );
}

/** The same staleness check for preparers, which a path rewrite also triggers. */
function undeclaredPreparerFailure(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  records: readonly GeneratedFileRecord[],
): string | undefined {
  const declaredPreparerIds = new Set([...(manifest.postJournalPreparers ?? []).map((record) => record.id), ...records.flatMap((record) => record.preparerId === undefined ? [] : [record.preparerId])]);
  const rewrittenDocuments = manifest.operations
    .filter((operation) => operation.kind === "rewrite-path-reference")
    .map((operation) => operation.file);
  const missingPreparers = triggeredPostJournalPreparers(config, [...(manifest.source?.files ?? []), ...rewrittenDocuments])
    .filter((preparer) => !declaredPreparerIds.has(preparer.id))
    .map((preparer) => preparer.id);
  if (missingPreparers.length === 0) return undefined;
  return `configured post-journal preparer(s) missing from plan: ${missingPreparers.join(", ")}; recompile the plan`;
}

/** The plan's command for this artifact must be the configured one, verbatim. */
function artifactCommandDrift(record: GeneratedFileRecord, artifact: GeneratedArtifactConfig | undefined): string | undefined {
  if (!artifact) {
    return `the plan declares a regeneration for ${record.path}, which the config does not declare as a generated artifact`;
  }
  if (artifact.regenerate !== record.regenerate) {
    return (
      `the plan's regenerate command for ${record.path} is not the configured one: plan ` +
      `${JSON.stringify(record.regenerate)}, config ${JSON.stringify(artifact.regenerate)}`
    );
  }
  return undefined;
}

/**
 * Run one configured artifact's generator. The entry is recorded before any
 * failure is reported, so a caller always sees what was attempted; an
 * undeclared edit outranks the command's own exit code, because a generator
 * that wrote outside its declared path is wrong even when it succeeded.
 */
function regenerateConfiguredArtifact(
  record: GeneratedFileRecord,
  configured: ReadonlyMap<string, GeneratedArtifactConfig>,
  context: PreparerContext,
): string | undefined {
  const { config, treeRoot, artifacts } = context;
  const artifact = configured.get(record.path);
  const drift = artifactCommandDrift(record, artifact);
  if (drift !== undefined || artifact === undefined) return drift;

  const absolute = resolve(treeRoot, record.path);
  const before = fileState(absolute);
  const repositoryBefore = dirtyPaths(treeRoot);
  const result = run(artifact.regenerate, treeRoot, config.generatedArtifacts.timeoutMs);
  const after = fileState(absolute);
  const undeclared = newlyDirtyPaths(treeRoot, repositoryBefore).filter((path) => path !== record.path);
  const entry: ArtifactRegeneration = {
    path: record.path,
    command: artifact.regenerate,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    changed: before !== after,
    hash: after,
    ...(result.exitCode === 0 ? {} : { output: result.output }),
  };
  artifacts.push(entry);

  if (undeclared.length > 0) return `generator for ${record.path} changed undeclared output(s): ${undeclared.join(", ")}; declare each output separately and recompile the plan`;
  if (result.exitCode !== 0) {
    return (
      `regenerating ${record.path} failed (exit ${result.exitCode}): ${artifact.regenerate}` +
      `${result.output === "" ? "" : `\n${result.output}`}`
    );
  }
  if (after === MISSING) return `regenerating ${record.path} succeeded but produced no file: ${artifact.regenerate}`;
  return undefined;
}

/**
 * Run every regeneration the plan declares, in the given tree.
 *
 * Never throws for a failing generator: a non-zero exit is a result, reported
 * the way a failed gate is, so the caller can abort with the command's own
 * output rather than with a stack trace about a subprocess.
 */
export function regenerateArtifacts(options: RegenerateOptions): RegenerationReport {
  const { config, manifest, treeRoot } = options;
  const records = regeneratedArtifacts(manifest);
  const configured = new Map(config.generatedArtifacts.artifacts.map((artifact) => [artifact.path, artifact]));
  const configuredPreparers = new Map(config.postJournalPreparers.map((preparer) => [preparer.id, preparer]));

  const policyDrift = preparerPolicyDrift(manifest.postJournalPreparers ?? [], configuredPreparers);
  if (policyDrift !== undefined) return { ok: false, artifacts: [], failure: policyDrift };

  const artifactGap = undeclaredArtifactFailure(config, manifest, records);
  if (artifactGap !== undefined) return { ok: false, artifacts: [], failure: artifactGap };
  const preparerGap = undeclaredPreparerFailure(config, manifest, records);
  if (preparerGap !== undefined) return { ok: false, artifacts: [], failure: preparerGap };

  const artifacts: ArtifactRegeneration[] = [];
  const context: PreparerContext = { config, treeRoot, artifacts };
  const completedPreparers = new Set<string>();
  for (const record of manifest.postJournalPreparers ?? []) {
    const failure = replayRecordedPreparer(record, records, context);
    if (failure !== undefined) return { ok: false, artifacts, failure };
    completedPreparers.add(record.id);
  }
  for (const record of records) {
    if (record.preparerId !== undefined) {
      if (completedPreparers.has(record.preparerId)) continue;
      const failure = runConfiguredPreparer(record, record.preparerId, records, configuredPreparers, context);
      if (failure !== undefined) return { ok: false, artifacts, failure };
      completedPreparers.add(record.preparerId);
      continue;
    }
    const failure = regenerateConfiguredArtifact(record, configured, context);
    if (failure !== undefined) return { ok: false, artifacts, failure };
  }

  return { ok: true, artifacts };
}
