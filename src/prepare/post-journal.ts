import { spawnSync } from "node:child_process";

import type { MonocarveConfig } from "../config.ts";
import { fileState } from "../util/files.ts";
import { scrubbedGitEnv } from "../util/git.ts";
import { hashJson, MISSING } from "../util/hash.ts";
import type { PreparationManifest } from "./manifest-types.ts";

export interface PreparationPreparerReport {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly failure?: string;
}

export function preparationPostJournalRecords(config: MonocarveConfig, changedPaths: readonly string[]) {
  return config.postJournalPreparers.filter((preparer) =>
    preparer.triggers.length === 0 || changedPaths.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))),
  ).map((preparer) => ({ id: preparer.id, command: preparer.command, outputs: [...preparer.outputs].sort(), ...(preparer.verify === undefined ? {} : { verify: preparer.verify }) }));
}

/** Run exactly the config-bound preparers recorded by the preparation plan. */
export function runPreparationPostJournalPreparers(config: MonocarveConfig, rootDir: string, manifest: PreparationManifest): PreparationPreparerReport {
  const records = manifest.postJournalPreparers ?? [];
  const configured = config.postJournalPreparers.filter((preparer) => records.some((record) => record.id === preparer.id));
  if (records.length !== configured.length) return { ok: false, changed: false, failure: "preparation post-journal preparer is absent from current configuration" };
  let changed = false;
  for (const record of records) {
    const preparer = configured.find((item) => item.id === record.id);
    if (!preparer || hashJson({ command: preparer.command, outputs: [...preparer.outputs].sort(), verify: preparer.verify }) !== hashJson({ command: record.command, outputs: [...record.outputs], verify: record.verify })) {
      return { ok: false, changed, failure: `preparation post-journal preparer ${record.id} differs from current configuration` };
    }
    const before = record.outputs.map((path) => fileState(`${rootDir}/${path}`));
    const result = run(record.command, rootDir, config.generatedArtifacts.timeoutMs);
    if (result.status !== 0) return { ok: false, changed, failure: `preparation post-journal preparer ${record.id} failed (exit ${result.status ?? "signal"})${result.output ? `\n${result.output}` : ""}` };
    if (record.verify !== undefined) {
      const verification = run(record.verify, rootDir, config.generatedArtifacts.timeoutMs);
      if (verification.status !== 0) return { ok: false, changed, failure: `preparation post-journal preparer ${record.id} verification failed (exit ${verification.status ?? "signal"})${verification.output ? `\n${verification.output}` : ""}` };
    }
    record.outputs.forEach((path, index) => {
      const after = fileState(`${rootDir}/${path}`);
      if (after === MISSING) throw new Error(`preparation post-journal preparer ${record.id} produced no declared output: ${path}`);
      if (after !== before[index]) changed = true;
    });
  }
  return { ok: true, changed };
}

function run(command: string, cwd: string, timeout: number): { status: number | null; output: string } {
  const result = spawnSync("bash", ["-lc", command], { cwd, env: scrubbedGitEnv(), encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000) };
}
