import { flagBool, flagString, flagStrings, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { analyzeEvacuation, formatEvacuationReport } from "../evacuation/index.ts";
import type { CommandSpec } from "./types.ts";
import { loadGraph, print } from "./shared.ts";

const WRITE_FLAGS = ["out", "plan", "apply", "write", "approve", "manifest"] as const;

async function evacuate(args: ParsedArgs): Promise<void> {
  const unsupported = WRITE_FLAGS.find((name) => args.flags.has(name));
  if (unsupported) throw new UsageError(`--${unsupported} is unsupported by read-only evacuate; this command never writes a plan or workspace files`);
  const application = flagString(args, "app");
  const packageName = flagString(args, "package-name");
  const sources = flagStrings(args, "source");
  if (application === undefined) throw new UsageError("--app <name> is required");
  if (packageName === undefined) throw new UsageError("--package-name <name> is required; evacuate never infers architectural ownership");
  if (sources.length === 0) throw new UsageError("at least one --source <file|directory|glob> is required");
  const loaded = await loadGraph(args, { allApplications: true });
  const report = analyzeEvacuation({
    config: loaded.config,
    graph: loaded.graph,
    context: loaded.context,
    application,
    sources,
    packageName,
  });
  print(flagBool(args, "json") ? report : formatEvacuationReport(report), args);
}

export const evacuationCommands: Record<string, CommandSpec> = {
  evacuate: {
    summary: "scope one bounded domain evacuation",
    usage: "evacuate --app <name> --source <file|directory|glob> [--source <...>] --package-name <name> [--json]",
    details: "Read-only. Selectors are workspace-relative and production-only. Reports SCC peers, retained composition, unselected dependencies, boundary cuts, and ordinary planning blockers; it never writes a manifest or edits the workspace.",
    run: evacuate,
  },
};
