import { spawnSync } from "node:child_process";

import { triggeredArtifacts, triggeredPostJournalPreparers, type MonocarveConfig, type PostJournalPreparerConfig } from "../config.ts";
import { applyFileCreates, applyTextReplacements } from "../preparer/declarative.ts";
import { failedGateOutput } from "../transaction/gate-diagnostics.ts";
import { fileState } from "../util/files.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { hashJson, MISSING, type FileState } from "../util/hash.ts";
import { PreparationApplyError } from "./apply-error.ts";
import type { PreparationManifest } from "./manifest-types.ts";
import { preparationOperationPaths } from "./manifest.ts";

export interface PreparationPreparerReport {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly hashes: Readonly<Record<string, FileState>>;
  readonly failure?: string;
}

export function preparationPostJournalRecords(config: MonocarveConfig, changedPaths: readonly string[]) {
  return config.postJournalPreparers
    .filter((preparer) => preparer.triggers.length === 0 || changedPaths.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))))
    .map((preparer) => ({
      id: preparer.id,
      ...(preparer.command === undefined ? {} : { command: preparer.command }),
      outputs: [...new Set([...preparer.outputs, ...(preparer.creates?.map((item) => item.path) ?? [])])].toSorted(),
      ...(preparer.replacements === undefined
        ? {}
        : {
            replacements: preparer.replacements.map((item) => ({
              path: item.path,
              before: item.before,
              after: item.after,
              ...(item.prefix === undefined ? {} : { prefix: item.prefix }),
              ...(item.suffix === undefined ? {} : { suffix: item.suffix }),
            })),
          }),
      ...(preparer.creates === undefined ? {} : { creates: preparer.creates.map((item) => ({ ...item, mode: item.mode ?? 0o644 })) }),
      emittedModuleSpecifiers: [...preparer.emittedModuleSpecifiers]
        .map((item) => ({ ...item }))
        .toSorted((left, right) => left.source.localeCompare(right.source) || left.resolutionBase.localeCompare(right.resolutionBase)),
      ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
    }));
}

/** Run exactly the config-bound preparers recorded by the preparation plan. */
type GenerationManifest = Pick<PreparationManifest, "generatedArtifacts" | "postJournalPreparers"> & {
  readonly operations?: PreparationManifest["operations"];
  readonly triggerPaths?: readonly string[];
};

type GeneratedArtifactRecord = NonNullable<GenerationManifest["generatedArtifacts"]>[number];
type PostJournalPreparerRecord = NonNullable<GenerationManifest["postJournalPreparers"]>[number];

/** Failure message when the manifest's recorded artifact set no longer matches what config would trigger, or `undefined` when they still agree. */
function triggeredArtifactSetMismatch(
  config: MonocarveConfig,
  artifacts: readonly GeneratedArtifactRecord[],
  triggerPaths: readonly string[],
): string | undefined {
  const expectedArtifactPaths = triggeredArtifacts(config, triggerPaths)
    .map((item) => item.path)
    .toSorted();
  if (
    artifacts
      .map((item) => item.path)
      .toSorted()
      .join("\n") !== expectedArtifactPaths.join("\n")
  ) {
    return "preparation generated artifact set differs from current triggered configuration; recompile the plan";
  }
  return undefined;
}

type ArtifactRegenerationResult =
  | { readonly ok: true; readonly hashes: Record<string, FileState>; readonly changed: boolean }
  | { readonly ok: false; readonly hashes: Record<string, FileState>; readonly changed: boolean; readonly failure: string };

/** Regenerate every config-bound generated artifact recorded by the plan, verifying it still matches configuration before running it. */
function regenerateConfiguredArtifacts(config: MonocarveConfig, rootDir: string, artifacts: readonly GeneratedArtifactRecord[]): ArtifactRegenerationResult {
  const configuredArtifacts = new Map(config.generatedArtifacts.artifacts.map((artifact) => [artifact.path, artifact]));
  const hashes: Record<string, FileState> = {};
  let changed = false;
  for (const record of artifacts) {
    const configured = configuredArtifacts.get(record.path);
    const expected =
      configured === undefined
        ? undefined
        : {
            path: configured.path,
            source: configured.source,
            regenerate: configured.regenerate,
            regenerateOnApply: true as const,
            ...(configured.exemptReason === undefined ? {} : { exemptReason: configured.exemptReason }),
          };
    if (!configured || hashJson(expected) !== hashJson(record)) {
      return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} differs from current configuration` };
    }
    const before = fileState(`${rootDir}/${record.path}`);
    const result = run(record.regenerate, rootDir, config.generatedArtifacts.timeoutMs);
    if (result.status !== 0)
      return {
        ok: false,
        changed,
        hashes,
        failure: `preparation generated artifact ${record.path} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}`,
      };
    const after = fileState(`${rootDir}/${record.path}`);
    if (after === MISSING) return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} produced no declared output` };
    if (after === before && record.exemptReason === undefined)
      return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} was not refreshed by its generator` };
    hashes[record.path] = after;
    changed = true;
  }
  return { ok: true, hashes, changed };
}

/** Failure message when the manifest's recorded preparer set no longer matches what config would trigger, or `undefined` when they still agree. */
function triggeredPreparerSetMismatch(
  config: MonocarveConfig,
  records: readonly PostJournalPreparerRecord[],
  triggerPaths: readonly string[],
): string | undefined {
  const expectedPreparerIds = triggeredPostJournalPreparers(config, triggerPaths)
    .map((item) => item.id)
    .toSorted();
  if (
    records
      .map((item) => item.id)
      .toSorted()
      .join("\n") !== expectedPreparerIds.join("\n")
  ) {
    return "preparation post-journal preparer set differs from current triggered configuration; recompile the plan";
  }
  return undefined;
}

type PreparerRecordOutcome =
  | { readonly ok: true; readonly hashes: Record<string, FileState>; readonly changed: boolean }
  | { readonly ok: false; readonly failure: string };

/**
 * Failure message when the recorded preparer's policy (command, outputs,
 * replacements, creates, verify, emitted module specifiers) no longer
 * matches the currently configured preparer of the same id, or `undefined`
 * when they still agree. The comparison is by normalized-object hash so
 * that key order and omitted-vs-undefined fields never cause a false
 * mismatch.
 */
function preparerPolicyMismatch(record: PostJournalPreparerRecord, configured: readonly PostJournalPreparerConfig[]): string | undefined {
  const preparer = configured.find((item) => item.id === record.id);
  const emittedModuleSpecifiers = preparer?.emittedModuleSpecifiers
    .map((item) => ({ ...item }))
    .toSorted((left, right) => left.source.localeCompare(right.source) || left.resolutionBase.localeCompare(right.resolutionBase));
  const policy =
    preparer === undefined
      ? undefined
      : {
          ...(preparer.command === undefined ? {} : { command: preparer.command }),
          outputs: [...new Set([...preparer.outputs, ...(preparer.creates?.map((item) => item.path) ?? [])])].toSorted(),
          ...(preparer.replacements === undefined
            ? {}
            : {
                replacements: preparer.replacements.map((item) => ({
                  path: item.path,
                  before: item.before,
                  after: item.after,
                  ...(item.prefix === undefined ? {} : { prefix: item.prefix }),
                  ...(item.suffix === undefined ? {} : { suffix: item.suffix }),
                })),
              }),
          ...(preparer.creates === undefined ? {} : { creates: preparer.creates.map((item) => ({ ...item, mode: item.mode ?? 0o644 })) }),
          verify: preparer.verify,
          emittedModuleSpecifiers,
        };
  if (
    !preparer ||
    hashJson(policy) !==
      hashJson({
        ...(record.command === undefined ? {} : { command: record.command }),
        outputs: [...record.outputs],
        ...(record.replacements === undefined ? {} : { replacements: record.replacements }),
        ...(record.creates === undefined ? {} : { creates: record.creates }),
        verify: record.verify,
        emittedModuleSpecifiers: record.emittedModuleSpecifiers,
      })
  ) {
    return `preparation post-journal preparer ${record.id} differs from current configuration`;
  }
  return undefined;
}

/** Failure message when the record's declarative replacements/creates throw, or `undefined` on success. */
function applyPreparerDeclarativeEdits(record: PostJournalPreparerRecord, rootDir: string): string | undefined {
  try {
    if (record.replacements !== undefined) applyTextReplacements(rootDir, record.replacements);
    if (record.creates !== undefined)
      applyFileCreates(
        rootDir,
        record.creates.map((item) => ({ ...item, mode: item.mode as 0o644 | 0o755 })),
      );
    return undefined;
  } catch (error) {
    return `preparation post-journal preparer ${record.id} declarative edit failed: ${(error as Error).message}`;
  }
}

/**
 * Run the preparer's command unless every one of its outputs is already
 * wholly covered by an artifact regenerated with that same command. Returns
 * a failure message on a configuration conflict or a non-zero exit, or
 * `undefined` on success (including when the command was skipped).
 */
function runPreparerCommandIfNeeded(
  record: PostJournalPreparerRecord,
  artifacts: readonly GeneratedArtifactRecord[],
  rootDir: string,
  config: MonocarveConfig,
): string | undefined {
  const overlappingArtifacts = artifacts.filter((artifact) => record.outputs.includes(artifact.path));
  const whollyCoveredBySameCommand =
    overlappingArtifacts.length === record.outputs.length && overlappingArtifacts.every((artifact) => artifact.regenerate === record.command);
  if (whollyCoveredBySameCommand) return undefined;
  const conflicting = overlappingArtifacts.find((artifact) => artifact.regenerate !== record.command);
  if (conflicting !== undefined) return `generated output ${conflicting.path} has conflicting configured commands`;
  if (record.command === undefined) return undefined;
  const result = run(record.command, rootDir, config.generatedArtifacts.timeoutMs);
  if (result.status !== 0)
    return `preparation post-journal preparer ${record.id} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}`;
  return undefined;
}

/** Failure message when the record's verify command exits non-zero, or `undefined` when there is no verify command or it passes. */
function verifyPreparerRecord(record: PostJournalPreparerRecord, rootDir: string, config: MonocarveConfig): string | undefined {
  if (record.verify === undefined) return undefined;
  const verification = run(record.verify, rootDir, config.generatedArtifacts.timeoutMs);
  if (verification.status !== 0)
    return `preparation post-journal preparer ${record.id} verification failed (exit ${verification.status ?? "signal"})${verification.output ? `\n${verification.output}` : ""}`;
  return undefined;
}

/**
 * Collect the post-run hash of every declared output. Throws (does not
 * return a failure) when an output is missing, matching the original
 * inline `forEach` behavior exactly. The thrown `PreparationApplyError`
 * is the same apply-stage class `apply.ts` raises for the rest of this
 * pipeline; it lives in `./apply-error.ts` so this module can use it
 * without importing `apply.ts`, which already imports this module.
 */
function collectPreparerOutputs(
  record: PostJournalPreparerRecord,
  before: readonly FileState[],
  rootDir: string,
): { hashes: Record<string, FileState>; changed: boolean } {
  const hashes: Record<string, FileState> = {};
  let changed = false;
  record.outputs.forEach((path, index) => {
    const after = fileState(`${rootDir}/${path}`);
    if (after === MISSING) throw new PreparationApplyError(`preparation post-journal preparer ${record.id} produced no declared output: ${path}`);
    if (after !== before[index]) changed = true;
    hashes[path] = after;
  });
  return { hashes, changed };
}

/**
 * Apply one recorded post-journal preparer: verify it still matches the
 * current configuration, run its declarative edits, run its command unless
 * every output is already wholly covered by an artifact regenerated with the
 * same command, run its verification, and collect its output hashes.
 */
function applyPostJournalPreparerRecord(
  record: PostJournalPreparerRecord,
  configured: readonly PostJournalPreparerConfig[],
  artifacts: readonly GeneratedArtifactRecord[],
  rootDir: string,
  config: MonocarveConfig,
): PreparerRecordOutcome {
  const policyMismatch = preparerPolicyMismatch(record, configured);
  if (policyMismatch !== undefined) return { ok: false, failure: policyMismatch };
  const before = record.outputs.map((path) => fileState(`${rootDir}/${path}`));
  const declarativeEditFailure = applyPreparerDeclarativeEdits(record, rootDir);
  if (declarativeEditFailure !== undefined) return { ok: false, failure: declarativeEditFailure };
  const commandFailure = runPreparerCommandIfNeeded(record, artifacts, rootDir, config);
  if (commandFailure !== undefined) return { ok: false, failure: commandFailure };
  const verifyFailure = verifyPreparerRecord(record, rootDir, config);
  if (verifyFailure !== undefined) return { ok: false, failure: verifyFailure };
  const { hashes, changed } = collectPreparerOutputs(record, before, rootDir);
  return { ok: true, hashes, changed };
}

export function runPreparationPostJournalPreparers(config: MonocarveConfig, rootDir: string, manifest: GenerationManifest): PreparationPreparerReport {
  const artifacts = manifest.generatedArtifacts ?? [];
  const triggerPaths = manifest.triggerPaths ?? manifest.operations?.flatMap(preparationOperationPaths) ?? [];
  const artifactSetMismatch = triggeredArtifactSetMismatch(config, artifacts, triggerPaths);
  if (artifactSetMismatch !== undefined) return { ok: false, changed: false, hashes: {}, failure: artifactSetMismatch };
  const artifactResult = regenerateConfiguredArtifacts(config, rootDir, artifacts);
  if (!artifactResult.ok) return { ok: false, changed: artifactResult.changed, hashes: artifactResult.hashes, failure: artifactResult.failure };
  const hashes: Record<string, FileState> = artifactResult.hashes;
  let changed = artifactResult.changed;
  const records = manifest.postJournalPreparers ?? [];
  const preparerSetMismatch = triggeredPreparerSetMismatch(config, records, triggerPaths);
  if (preparerSetMismatch !== undefined) return { ok: false, changed, hashes, failure: preparerSetMismatch };
  const configured = config.postJournalPreparers.filter((preparer) => records.some((record) => record.id === preparer.id));
  if (records.length !== configured.length)
    return { ok: false, changed, hashes, failure: "preparation post-journal preparer is absent from current configuration" };
  for (const record of records) {
    const outcome = applyPostJournalPreparerRecord(record, configured, artifacts, rootDir, config);
    if (!outcome.ok) return { ok: false, changed, hashes, failure: outcome.failure };
    changed = changed || outcome.changed;
    Object.assign(hashes, outcome.hashes);
  }
  return { ok: true, changed, hashes };
}

function run(command: string, cwd: string, timeout: number): { status: number | null; output: string } {
  const result = spawnSync("bash", ["-lc", command], { cwd, env: scrubbedGitEnv(), encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status, output: failedGateOutput({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" }).trimEnd() };
}
