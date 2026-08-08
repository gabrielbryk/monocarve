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
 */

import { resolve } from "node:path";

import { triggeredArtifacts, triggeredPostJournalPreparers, type MonocarveConfig } from "../config.ts";
import { fileState } from "../util/files.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { MISSING, type FileState } from "../util/hash.ts";
import { regeneratedArtifacts, type ExtractionManifest } from "../plan/manifest.ts";

/** Enough of a generator's output to act on, never its whole log. */
const OUTPUT_TAIL = 4000;

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

  // A configured artifact this extraction triggers that the plan never
  // recorded: the config gained it after the plan was compiled. Applying now
  // would leave it stale, and the plan's `changedFiles` would be wrong about
  // it, so the plan has to be recompiled rather than stretched.
  const declared = new Set(records.map((record) => record.path));
  const missing = triggeredArtifacts(config, manifest.source?.files ?? [])
    .map((artifact) => artifact.path)
    .filter((path) => !declared.has(path));
  if (missing.length > 0) {
    return {
      ok: false,
      artifacts: [],
      failure:
        `the configured generated artifact(s) ${missing.join(", ")} are triggered by this extraction and the plan ` +
        "does not declare them; recompile the plan against the current config",
    };
  }
  const declaredPreparerIds = new Set(records.flatMap((record) => record.preparerId === undefined ? [] : [record.preparerId]));
  const rewrittenDocuments = manifest.operations
    .filter((operation) => operation.kind === "rewrite-path-reference")
    .map((operation) => operation.file);
  const missingPreparers = triggeredPostJournalPreparers(config, [...manifest.source.files, ...rewrittenDocuments])
    .filter((preparer) => !declaredPreparerIds.has(preparer.id))
    .map((preparer) => preparer.id);
  if (missingPreparers.length > 0) return { ok: false, artifacts: [], failure: `configured post-journal preparer(s) missing from plan: ${missingPreparers.join(", ")}; recompile the plan` };

  const artifacts: ArtifactRegeneration[] = [];
  const completedPreparers = new Set<string>();
  for (const record of records) {
    if (record.preparerId !== undefined) {
      if (completedPreparers.has(record.preparerId)) continue;
      const preparer = configuredPreparers.get(record.preparerId);
      if (!preparer || preparer.command !== record.regenerate || preparer.verify !== record.verify) {
        return { ok: false, artifacts, failure: `post-journal preparer ${record.preparerId} differs from current configuration` };
      }
      const declared = records.filter((item) => item.preparerId === record.preparerId).map((item) => item.path).sort();
      if (declared.join("\n") !== [...preparer.outputs].sort().join("\n")) {
        return { ok: false, artifacts, failure: `post-journal preparer ${record.preparerId} output set differs from current configuration` };
      }
      const before = new Map(declared.map((path) => [path, fileState(resolve(treeRoot, path))]));
      const result = run(preparer.command, treeRoot, config.generatedArtifacts.timeoutMs);
      if (result.exitCode !== 0) return { ok: false, artifacts, failure: `post-journal preparer ${preparer.id} failed (exit ${result.exitCode})${result.output ? `\n${result.output}` : ""}` };
      if (preparer.verify !== undefined) {
        const verification = run(preparer.verify, treeRoot, config.generatedArtifacts.timeoutMs);
        if (verification.exitCode !== 0) return { ok: false, artifacts, failure: `post-journal preparer ${preparer.id} verification failed (exit ${verification.exitCode})${verification.output ? `\n${verification.output}` : ""}` };
      }
      for (const path of declared) {
        const after = fileState(resolve(treeRoot, path));
        artifacts.push({ path, command: preparer.command, exitCode: 0, durationMs: result.durationMs, changed: before.get(path) !== after, hash: after });
        if (after === MISSING) return { ok: false, artifacts, failure: `post-journal preparer ${preparer.id} produced no declared output: ${path}` };
      }
      completedPreparers.add(record.preparerId);
      continue;
    }
    const artifact = configured.get(record.path);
    if (!artifact) {
      return {
        ok: false,
        artifacts,
        failure: `the plan declares a regeneration for ${record.path}, which the config does not declare as a generated artifact`,
      };
    }
    if (artifact.regenerate !== record.regenerate) {
      return {
        ok: false,
        artifacts,
        failure:
          `the plan's regenerate command for ${record.path} is not the configured one: plan ` +
          `${JSON.stringify(record.regenerate)}, config ${JSON.stringify(artifact.regenerate)}`,
      };
    }

    const absolute = resolve(treeRoot, record.path);
    const before = fileState(absolute);
    const result = run(artifact.regenerate, treeRoot, config.generatedArtifacts.timeoutMs);
    const after = fileState(absolute);
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

    if (result.exitCode !== 0) {
      return {
        ok: false,
        artifacts,
        failure:
          `regenerating ${record.path} failed (exit ${result.exitCode}): ${artifact.regenerate}` +
          `${result.output === "" ? "" : `\n${result.output}`}`,
      };
    }
    if (after === MISSING) {
      return {
        ok: false,
        artifacts,
        failure: `regenerating ${record.path} succeeded but produced no file: ${artifact.regenerate}`,
      };
    }
  }

  return { ok: true, artifacts };
}

interface CommandResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
}

/**
 * The command, from the workspace root, under the same environment discipline
 * as every other subprocess here: `GIT_INDEX_FILE`, `GIT_DIR` and friends are
 * stripped, because a generator that shells out to git would otherwise write
 * into whatever repository those variables name — which during a simulation is
 * emphatically not the tree it was asked to regenerate.
 */
function run(command: string, cwd: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  const result = Bun.spawnSync(["sh", "-c", command], {
    cwd,
    env: scrubbedGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  // Truthiness, not `!== null`: a process that exited normally reports the
  // signal as `null` on some paths and `undefined` on others, and a note
  // reading "killed by undefined" is worse than no note at all.
  const signal = result.signalCode ? `killed by ${result.signalCode} after ${timeoutMs}ms\n` : "";
  const exitCode = result.exitCode ?? 1;
  const output = `${signal}${result.stdout.toString()}${result.stderr.toString()}`.trimEnd().slice(-OUTPUT_TAIL);
  return { exitCode, durationMs: Date.now() - started, output };
}
