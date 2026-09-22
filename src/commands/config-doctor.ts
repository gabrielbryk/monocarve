/** Read-only configuration and workspace diagnosis. */

import { readFileSync } from "node:fs";

import type { ParsedArgs } from "../cli/args.ts";
import { inspectConfig } from "../doctor/config-doctor.ts";
import { load, print } from "./shared.ts";
import type { CommandSpec } from "./types.ts";

async function configDoctor(args: ParsedArgs): Promise<void> {
  const loaded = await load(args);
  const userConfig = loaded.configPath.endsWith(".json") ? readJsonConfig(loaded.configPath) : undefined;
  const report = await inspectConfig({ ...loaded, ...(userConfig === undefined ? {} : { userConfig }) });
  print({ schema: "config-doctor", ...report }, args);
  if (report.semanticIssues.some((issue) => issue.severity === "error")) process.exitCode = 1;
}

function readJsonConfig(path: string): unknown {
  // load() already validated this exact file. Re-reading only recovers which
  // keys the user supplied; it never changes or reinterprets effective values.
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export const configDoctorCommands: Record<string, CommandSpec> = {
  "config-doctor": {
    summary: "diagnose effective configuration and workspace integration",
    usage: "config-doctor",
    details:
      "Reports config provenance, roots, workspace packages, adapter support, compiler profiles, generated and path-keyed artifacts, configured module calls, protected and dirty paths, preparation coverage, and semantic scaffold/public-surface conflicts. Read-only; it runs no gates, generators, installers, or preparers.",
    run: configDoctor,
  },
};
