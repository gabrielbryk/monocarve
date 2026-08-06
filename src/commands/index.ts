/** Command registry and executable help text. */

import { TOOL_NAME, TOOL_VERSION } from "../branding.ts";
import { discoveryCommands } from "./discovery.ts";
import { configDoctorCommands } from "./config-doctor.ts";
import { planningCommands } from "./planning.ts";
import { preparationCommands } from "./preparation.ts";
import { preparerCommands } from "./preparers.ts";
import { transactionCommands } from "./transactions.ts";
import { lifecycleCommands } from "./lifecycle.ts";
import { reconciliationCommands } from "./reconciliation.ts";
import type { CommandSpec } from "./types.ts";

function qualify(spec: CommandSpec): CommandSpec {
  return { ...spec, usage: `${TOOL_NAME} ${spec.usage}` };
}

export const COMMANDS: Record<string, CommandSpec> = Object.fromEntries(
  Object.entries({ ...discoveryCommands, ...configDoctorCommands, ...planningCommands, ...preparationCommands, ...preparerCommands, ...transactionCommands, ...lifecycleCommands, ...reconciliationCommands })
    .map(([name, spec]) => [name, qualify(spec)]),
);

export const GLOBAL_OPTIONS = `global options:
  --config <path>       config file (default: discovered upward from cwd)
  --cwd <path>          directory discovery starts from
  --graph <app>=<file>  replay a captured scanner report (repeatable)
  --json, -j            machine-readable output
  --help, -h            show help
  --version, -v         print version`;

const commandLines = Object.entries(COMMANDS)
  .map(([name, spec]) => `  ${name.padEnd(16)} ${spec.summary}`)
  .join("\n");

export const USAGE = `${TOOL_NAME} ${TOOL_VERSION} — deterministic extraction compiler for TypeScript monorepos

usage: ${TOOL_NAME} <command> [options]

commands:
${commandLines}

${GLOBAL_OPTIONS}

run \`${TOOL_NAME} <command> --help\` for command options`;

export function commandHelp(spec: CommandSpec): string {
  return `${spec.summary}\n\nusage: ${spec.usage}${spec.details ? `\n\n${spec.details}` : ""}\n\n${GLOBAL_OPTIONS}`;
}

export type { CommandSpec } from "./types.ts";
