import { spawnSync } from "node:child_process";

import { triggeredArtifacts, triggeredPostJournalPreparers, type MonocarveConfig } from "../config.ts";
import { failedGateOutput } from "../transaction/gate-diagnostics.ts";
import { fileState } from "../util/files.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { hashJson, MISSING, type FileState } from "../util/hash.ts";
import type { PreparationManifest } from "./manifest-types.ts";
import { preparationOperationPaths } from "./manifest.ts";
import { applyFileCreates, applyTextReplacements } from "../preparer/declarative.ts";

export interface PreparationPreparerReport {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly hashes: Readonly<Record<string, FileState>>;
  readonly failure?: string;
}

export function preparationPostJournalRecords(config: MonocarveConfig, changedPaths: readonly string[]) {
  return config.postJournalPreparers.filter((preparer) =>
    preparer.triggers.length === 0 || changedPaths.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))),
  ).map((preparer) => ({
    id: preparer.id,
    ...(preparer.command === undefined ? {} : { command: preparer.command }),
    outputs: [...new Set([...preparer.outputs, ...(preparer.creates?.map((item) => item.path) ?? [])])].sort(),
    ...(preparer.replacements === undefined ? {} : { replacements: preparer.replacements.map((item) => ({ path: item.path, before: item.before, after: item.after, ...(item.prefix === undefined ? {} : { prefix: item.prefix }), ...(item.suffix === undefined ? {} : { suffix: item.suffix }) })) }),
    ...(preparer.creates === undefined ? {} : { creates: preparer.creates.map((item) => ({ ...item, mode: item.mode ?? 0o644 })) }),
    emittedModuleSpecifiers: [...preparer.emittedModuleSpecifiers]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.resolutionBase.localeCompare(right.resolutionBase)),
    ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
  }));
}

/** Run exactly the config-bound preparers recorded by the preparation plan. */
type GenerationManifest = Pick<PreparationManifest, "generatedArtifacts" | "postJournalPreparers"> & {
  readonly operations?: PreparationManifest["operations"];
  readonly triggerPaths?: readonly string[];
};

export function runPreparationPostJournalPreparers(config: MonocarveConfig, rootDir: string, manifest: GenerationManifest): PreparationPreparerReport {
  const artifacts = manifest.generatedArtifacts ?? [];
  const triggerPaths = manifest.triggerPaths ?? manifest.operations?.flatMap(preparationOperationPaths) ?? [];
  const expectedArtifactPaths = triggeredArtifacts(config, triggerPaths).map((item) => item.path).sort();
  if (artifacts.map((item) => item.path).sort().join("\n") !== expectedArtifactPaths.join("\n")) {
    return { ok: false, changed: false, hashes: {}, failure: "preparation generated artifact set differs from current triggered configuration; recompile the plan" };
  }
  const configuredArtifacts = new Map(config.generatedArtifacts.artifacts.map((artifact) => [artifact.path, artifact]));
  const hashes: Record<string, FileState> = {};
  let changed = false;
  for (const record of artifacts) {
    const configured = configuredArtifacts.get(record.path);
    const expected = configured === undefined ? undefined : {
      path: configured.path, source: configured.source, regenerate: configured.regenerate, regenerateOnApply: true as const,
      ...(configured.exemptReason === undefined ? {} : { exemptReason: configured.exemptReason }),
    };
    if (!configured || hashJson(expected) !== hashJson(record)) {
      return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} differs from current configuration` };
    }
    const before = fileState(`${rootDir}/${record.path}`);
    const result = run(record.regenerate, rootDir, config.generatedArtifacts.timeoutMs);
    if (result.status !== 0) return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}` };
    const after = fileState(`${rootDir}/${record.path}`);
    if (after === MISSING) return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} produced no declared output` };
    if (after === before && record.exemptReason === undefined) return { ok: false, changed, hashes, failure: `preparation generated artifact ${record.path} was not refreshed by its generator` };
    hashes[record.path] = after;
    changed = true;
  }
  const records = manifest.postJournalPreparers ?? [];
  const expectedPreparerIds = triggeredPostJournalPreparers(config, triggerPaths).map((item) => item.id).sort();
  if (records.map((item) => item.id).sort().join("\n") !== expectedPreparerIds.join("\n")) {
    return { ok: false, changed, hashes, failure: "preparation post-journal preparer set differs from current triggered configuration; recompile the plan" };
  }
  const configured = config.postJournalPreparers.filter((preparer) => records.some((record) => record.id === preparer.id));
  if (records.length !== configured.length) return { ok: false, changed, hashes, failure: "preparation post-journal preparer is absent from current configuration" };
  for (const record of records) {
    const preparer = configured.find((item) => item.id === record.id);
    const emittedModuleSpecifiers = preparer?.emittedModuleSpecifiers
      .map((item) => ({ ...item }))
      .sort((left, right) => left.source.localeCompare(right.source) || left.resolutionBase.localeCompare(right.resolutionBase));
    const policy = preparer === undefined ? undefined : { ...(preparer.command === undefined ? {} : { command: preparer.command }), outputs: [...new Set([...preparer.outputs, ...(preparer.creates?.map((item) => item.path) ?? [])])].sort(), ...(preparer.replacements === undefined ? {} : { replacements: preparer.replacements.map((item) => ({ path: item.path, before: item.before, after: item.after, ...(item.prefix === undefined ? {} : { prefix: item.prefix }), ...(item.suffix === undefined ? {} : { suffix: item.suffix }) })) }), ...(preparer.creates === undefined ? {} : { creates: preparer.creates.map((item) => ({ ...item, mode: item.mode ?? 0o644 })) }), verify: preparer.verify, emittedModuleSpecifiers };
    if (!preparer || hashJson(policy) !== hashJson({ ...(record.command === undefined ? {} : { command: record.command }), outputs: [...record.outputs], ...(record.replacements === undefined ? {} : { replacements: record.replacements }), ...(record.creates === undefined ? {} : { creates: record.creates }), verify: record.verify, emittedModuleSpecifiers: record.emittedModuleSpecifiers })) {
      return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} differs from current configuration` };
    }
    const before = record.outputs.map((path) => fileState(`${rootDir}/${path}`));
    try {
      if (record.replacements !== undefined) applyTextReplacements(rootDir, record.replacements);
      if (record.creates !== undefined) applyFileCreates(rootDir, record.creates.map((item) => ({ ...item, mode: item.mode as 0o644 | 0o755 })));
    } catch (error) { return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} declarative edit failed: ${(error as Error).message}` }; }
    const overlappingArtifacts = artifacts.filter((artifact) => record.outputs.includes(artifact.path));
    const whollyCoveredBySameCommand = overlappingArtifacts.length === record.outputs.length
      && overlappingArtifacts.every((artifact) => artifact.regenerate === record.command);
    if (!whollyCoveredBySameCommand) {
      const conflicting = overlappingArtifacts.find((artifact) => artifact.regenerate !== record.command);
      if (conflicting !== undefined) return { ok: false, changed, hashes, failure: `generated output ${conflicting.path} has conflicting configured commands` };
      if (record.command !== undefined) {
        const result = run(record.command, rootDir, config.generatedArtifacts.timeoutMs);
        if (result.status !== 0) return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}` };
      }
    }
    if (record.verify !== undefined) {
      const verification = run(record.verify, rootDir, config.generatedArtifacts.timeoutMs);
      if (verification.status !== 0) return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} verification failed (exit ${verification.status ?? "signal"})${verification.output ? `\n${verification.output}` : ""}` };
    }
    record.outputs.forEach((path, index) => {
      const after = fileState(`${rootDir}/${path}`);
      if (after === MISSING) throw new Error(`preparation post-journal preparer ${record.id} produced no declared output: ${path}`);
      if (after !== before[index]) changed = true;
      hashes[path] = after;
    });
  }
  return { ok: true, changed, hashes };
}

function run(command: string, cwd: string, timeout: number): { status: number | null; output: string } {
  const result = spawnSync("bash", ["-lc", command], { cwd, env: scrubbedGitEnv(), encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status, output: failedGateOutput({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" }).trimEnd() };
}
