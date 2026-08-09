import { spawnSync } from "node:child_process";

import { triggeredArtifacts, triggeredPostJournalPreparers, type MonocarveConfig } from "../config.ts";
import { failedGateOutput } from "../transaction/gate-diagnostics.ts";
import { fileState } from "../util/files.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { hashJson, MISSING, type FileState } from "../util/hash.ts";
import type { PreparationManifest } from "./manifest-types.ts";
import { preparationOperationPaths } from "./manifest.ts";

export interface PreparationPreparerReport {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly hashes: Readonly<Record<string, FileState>>;
  readonly failure?: string;
}

export function preparationPostJournalRecords(config: MonocarveConfig, changedPaths: readonly string[]) {
  return config.postJournalPreparers.filter((preparer) =>
    preparer.triggers.length === 0 || changedPaths.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))),
  ).map((preparer) => ({ id: preparer.id, command: preparer.command, outputs: [...preparer.outputs].sort(), ...(preparer.verify === undefined ? {} : { verify: preparer.verify }) }));
}

/** Run exactly the config-bound preparers recorded by the preparation plan. */
export function runPreparationPostJournalPreparers(config: MonocarveConfig, rootDir: string, manifest: PreparationManifest): PreparationPreparerReport {
  const artifacts = manifest.generatedArtifacts ?? [];
  const triggerPaths = manifest.operations.flatMap(preparationOperationPaths);
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
    if (!preparer || hashJson({ command: preparer.command, outputs: [...preparer.outputs].sort(), verify: preparer.verify }) !== hashJson({ command: record.command, outputs: [...record.outputs], verify: record.verify })) {
      return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} differs from current configuration` };
    }
    const before = record.outputs.map((path) => fileState(`${rootDir}/${path}`));
    const result = run(record.command, rootDir, config.generatedArtifacts.timeoutMs);
    if (result.status !== 0) return { ok: false, changed, hashes, failure: `preparation post-journal preparer ${record.id} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}` };
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
