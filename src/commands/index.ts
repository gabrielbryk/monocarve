/** Command registry and executable help text. */

import { TOOL_NAME, TOOL_VERSION } from "../branding.ts";
import type { CliSchema } from "../cli/args.ts";
import { commandFlags, type FlagOverrides, type FlagSpec } from "../cli/flags.ts";
import { assessmentCommands } from "./assessment.ts";
import { configDoctorCommands } from "./config-doctor.ts";
import { consolidationCommands } from "./consolidation.ts";
import { discoveryCommands } from "./discovery.ts";
import { evacuationCommands } from "./evacuation.ts";
import { lifecycleCommands } from "./lifecycle.ts";
import { planningCommands } from "./planning.ts";
import { preparationCommands } from "./preparation.ts";
import { preparerCommands } from "./preparers.ts";
import { reconciliationCommands } from "./reconciliation.ts";
import { transactionCommands } from "./transactions.ts";
import type { CommandSpec } from "./types.ts";
import { visualizationCommands } from "./visualization.ts";

/** A registered command: its spec plus the complete flag table it accepts. */
export interface RegisteredCommand extends CommandSpec {
  /** Every flag this command accepts (globals included), derived from `usage` plus `FLAG_OVERRIDES`. */
  readonly flags: readonly FlagSpec[];
}

/**
 * Handler-owned refusals for `assess`. Mirrors `MUTATION_ONLY_FLAGS` in
 * `assessment.ts`: these flags must reach the handler so it can say *why* they
 * are refused. (`split-candidates` needs no such list: its legacy single-file
 * mode would otherwise ignore them, so the parser rejects them as unknown.)
 */
const MUTATION_ONLY_FLAGS = [
  "plan",
  "apply",
  "approve",
  "simulate",
  "prepare",
  "journal",
  "allow-dirty",
  "write",
  "commit",
  "commit-approval",
  "resume",
  "recover",
  "skip-gates",
  "force",
  "replace",
  "delete",
  "execute",
  "target",
  "package-name",
  "package-root",
  "retire-donors",
] as const;

/**
 * What the usage strings cannot say. Everything else a command accepts is read
 * from its usage string, so a flag added to a handler must be added to its
 * usage (preferred) or here, or the parser rejects it as unknown.
 */
const FLAG_OVERRIDES: Readonly<Record<string, FlagOverrides>> = {
  assess: { refused: [...MUTATION_ONLY_FLAGS, "out"] },
  "split-candidates": {
    // Batch-mode inputs documented in the command details.
    extra: [
      { name: "replay", kind: "value" },
      { name: "allow-empty", kind: "boolean" },
      { name: "replace-generated", kind: "boolean" },
      { name: "max-bytes", kind: "value" },
    ],
  },
  evacuate: { repeatable: ["authorize-protected", "include-composition"], refused: ["plan", "apply", "approve", "manifest", "commit-approval", "force"] },
  // Read through the shared graph/portfolio loaders but absent from the usage lines.
  plan: {
    extra: [
      { name: "app", kind: "value" },
      { name: "include-extracted", kind: "boolean" },
    ],
  },
  scope: { extra: [{ name: "include-extracted", kind: "boolean" }] },
  next: {
    extra: [
      { name: "out", kind: "value" },
      { name: "include-extracted", kind: "boolean" },
    ],
  },
  hotspots: { extra: [{ name: "include-extracted", kind: "boolean" }] },
  "lazy-registry": { extra: [{ name: "include-extracted", kind: "boolean" }] },
  // These load the graph, which reads --app, but their usage lines omit it.
  capabilities: { extra: [{ name: "app", kind: "value" }] },
  "relocate-tests": { extra: [{ name: "app", kind: "value" }] },
  boundary: { extra: [{ name: "app", kind: "value" }] },
  "prepare-plan": { extra: [{ name: "app", kind: "value" }] },
  refresh: { refused: ["replace"], extra: [{ name: "app", kind: "value" }] },
  apply: { refused: ["skip-simulation", "refresh-if-baseline-only"] },
  doctor: { refused: ["skip-gates"] },
  // `check --check <name>` is the legacy spelling of `check <name>`.
  check: { extra: [{ name: "check", kind: "value" }] },
};

/** Flags retired everywhere; the parser explains instead of calling them unknown. */
const RETIRED_FLAGS: Readonly<Record<string, string>> = {
  "allow-dirty": "--allow-dirty is no longer supported; configure transaction.allowDirtyPaths instead",
};

function register(name: string, spec: CommandSpec): RegisteredCommand {
  const usage = `${TOOL_NAME} ${spec.usage}`;
  return { ...spec, usage, flags: commandFlags(usage, FLAG_OVERRIDES[name]) };
}

export const COMMANDS: Record<string, RegisteredCommand> = Object.fromEntries(
  Object.entries({
    ...discoveryCommands,
    ...assessmentCommands,
    ...evacuationCommands,
    ...consolidationCommands,
    ...configDoctorCommands,
    ...planningCommands,
    ...preparationCommands,
    ...preparerCommands,
    ...transactionCommands,
    ...lifecycleCommands,
    ...reconciliationCommands,
    ...visualizationCommands,
  }).map(([name, spec]) => [name, register(name, spec)]),
);

for (const name of Object.keys(FLAG_OVERRIDES)) {
  if (!(name in COMMANDS)) throw new Error(`invariant: flag overrides name an unregistered command: ${name}`);
}

/** The parser's view of the registry. */
export const CLI_SCHEMA: CliSchema = {
  commands: Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags])),
  retired: RETIRED_FLAGS,
};

export const GLOBAL_OPTIONS = `global options:
  --config <path>       config file (default: discovered upward from cwd)
  --cwd <path>          directory discovery starts from
  --graph <app>=<file>  replay a captured scanner report (repeatable)
  --no-cache            rescan instead of reusing the cached dependency graph
  --json, -j            machine-readable output
  --help, -h            show help
  --version, -v         print version (--verbose includes executable identity)`;

/** Width of the command-name column in the top-level listing: the longest name. */
export const COMMAND_NAME_WIDTH = Math.max(...Object.keys(COMMANDS).map((name) => name.length));

const commandLines = Object.entries(COMMANDS)
  .map(([name, spec]) => `  ${name.padEnd(COMMAND_NAME_WIDTH)}  ${spec.summary}`)
  .join("\n");

export const USAGE = `${TOOL_NAME} ${TOOL_VERSION} — deterministic extraction compiler for TypeScript monorepos

usage: ${TOOL_NAME} [global options] <command> [options]

commands:
${commandLines}

${GLOBAL_OPTIONS}

global options work before or after the command; command options follow the command.
run \`${TOOL_NAME} <command> --help\` for command options`;

export function commandHelp(spec: CommandSpec & { readonly flags?: readonly FlagSpec[] }): string {
  return `${spec.summary}\n\nusage: ${spec.usage}${spec.details ? `\n\n${spec.details}` : ""}${hiddenOptions(spec)}\n\n${GLOBAL_OPTIONS}`;
}

/** Accepted flags the usage line does not show (override extras), so help stays complete. */
function hiddenOptions(spec: CommandSpec & { readonly flags?: readonly FlagSpec[] }): string {
  const flags = spec.flags ?? [];
  const shown = new Set([...spec.usage.matchAll(/--([a-z][a-z0-9-]*)/gu)].map((match) => match[1]));
  const global = new Set([...GLOBAL_OPTIONS.matchAll(/--([a-z][a-z0-9-]*)/gu)].map((match) => match[1]));
  const hidden = flags.filter((flag) => flag.kind !== "refused" && !shown.has(flag.name) && !global.has(flag.name));
  if (hidden.length === 0) return "";
  return `\n\nalso accepts: ${hidden.map((flag) => (flag.kind === "boolean" ? `--${flag.name}` : `--${flag.name} <value>`)).join(", ")}`;
}

export type { CommandSpec } from "./types.ts";
