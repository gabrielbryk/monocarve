import { flagBool, flagNumber, type ParsedArgs } from "../cli/args.ts";
import { UsageError } from "../errors.ts";
import { projectVisualizationGraph, startVisualizationServer } from "../visualization/index.ts";
import type { CommandSpec } from "./types.ts";
import { loadGraph } from "./shared.ts";

async function visualize(args: ParsedArgs): Promise<void> {
  const port = flagNumber(args, "port", 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError("--port must be an integer from 0 through 65535");
  const scanArgs = withFlag(args, "no-cache");
  const server = await startVisualizationServer({
    loadGraph: async () => projectVisualizationGraph((await loadGraph(scanArgs)).graph),
    port,
    openBrowser: !flagBool(args, "no-open"),
  });
  process.stdout.write(`Interactive dependency graph: ${server.url}\nPress Ctrl-C to stop.\n`);
  await new Promise<void>((resolve) => {
    const stop = (): void => { server.server.stop(); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function withFlag(args: ParsedArgs, name: string): ParsedArgs {
  const flags = new Map(args.flags);
  flags.set(name, true);
  return { ...args, flags };
}

export const visualizationCommands: Record<string, CommandSpec> = {
  visualize: {
    summary: "explore the dependency graph in a local web UI",
    usage: "visualize [--app <name>] [--port <number>] [--no-open] [--no-cache] [--include-extracted]",
    details: "Scans the configured workspace, serves an interactive SCC-level graph on 127.0.0.1, and opens it in the default browser. Search and edge filters run locally; Rescan refreshes the graph without changing the workspace.",
    run: visualize,
  },
};
