#!/usr/bin/env bun
/** Executable boundary: parse, dispatch, and classify failures. */

import { TOOL_NAME, TOOL_VERSION } from "./branding.ts";
import { executableBuildIdentity } from "./build-identity.ts";
import { ArgumentError, parseArgs as parseWithSchema, type ParsedArgs } from "./cli/args.ts";
import { resetCodemodCaches } from "./codemod/imports.ts";
import { CLI_SCHEMA, COMMANDS, USAGE, commandHelp } from "./commands/index.ts";
import { ConfigError, IoError, NotYetPortedError, MonocarveError, UsageError } from "./errors.ts";

export type { ParsedArgs } from "./cli/args.ts";

/** Parse `argv` against the command registry; throws a `UsageError` for any malformed invocation. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  return parseWithSchema(argv, CLI_SCHEMA);
}

/**
 * Exit codes:
 *   0   success (also a bare invocation with no arguments, `--help`, `--version`)
 *   1   an expected failure or refusal (`MonocarveError`)
 *   2   degraded result (set by the assessment commands)
 *   3   the command reached a not-yet-ported seam
 *   64  malformed invocation (unknown command/flag, missing value, no command)
 *   70  internal defect: an error outside the taxonomy, reported with its stack
 */
export async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    // Every flag is validated here, before any command loads config.
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) return reportInternalFailure(error, argv[0] ?? "");
    return reportUsageFailure(error, error instanceof ArgumentError ? error.command : undefined);
  }
  if (args.flags.has("version")) {
    process.stdout.write(args.flags.has("verbose") ? `${JSON.stringify(executableBuildIdentity(), null, 2)}\n` : `${TOOL_NAME} ${TOOL_VERSION}\n`);
    return 0;
  }
  if (args.command === undefined) {
    if (argv.length === 0 || args.flags.has("help")) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    process.stderr.write(`${TOOL_NAME}: no command given\n\n${USAGE}\n`);
    return 64;
  }
  const spec = COMMANDS[args.command];
  // Unreachable: the parser rejects unregistered commands.
  if (spec === undefined) throw new Error(`parser accepted unregistered command ${args.command}`);
  if (args.flags.has("help")) {
    process.stdout.write(`${commandHelp(spec)}\n`);
    return 0;
  }
  try {
    resetCodemodCaches();
    await runWithCompleteStdout(() => spec.run(args));
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  } catch (error) {
    return reportCommandFailure(error, args.command);
  }
}

/**
 * Bun may buffer a large pipe write. An immediate `process.exit(...)` used to
 * terminate the executable before those bytes reached the reader, producing a
 * successful but truncated JSON document. Keep an error listener installed for
 * the whole command and enqueue an empty sentinel write before returning; its
 * callback runs only after every earlier stdout write has completed.
 */
async function runWithCompleteStdout(run: () => Promise<void>): Promise<void> {
  let failure: Error | undefined;
  const capture = (error: Error): void => {
    failure ??= error;
  };
  process.stdout.on("error", capture);
  try {
    await run();
    await new Promise<void>((resolve) => {
      process.stdout.write("", () => resolve());
    });
    if (failure !== undefined) throw new IoError(`could not write stdout: ${failure.message}`);
  } finally {
    process.stdout.off("error", capture);
  }
}

function reportCommandFailure(error: unknown, command: string): number {
  if (error instanceof UsageError) return reportUsageFailure(error, command);
  if (error instanceof NotYetPortedError) {
    process.stderr.write(renderUserError(error));
    return 3;
  }
  if (error instanceof MonocarveError) {
    process.stderr.write(renderUserError(error));
    return 1;
  }
  return reportInternalFailure(error, command);
}

/** A usage error, followed by the usage of the command it was aimed at, if any. */
function reportUsageFailure(error: UsageError, command: string | undefined): number {
  const spec = command === undefined ? undefined : COMMANDS[command];
  process.stderr.write(`${renderUserError(error)}${spec ? `\nusage: ${spec.usage}\n` : ""}`);
  return 64;
}

/** `monocarve: <message>`, plus a `hint:` line when there is a next step to suggest. */
export function renderUserError(error: MonocarveError): string {
  const hint = error.hint ?? fallbackHint(error);
  return `${TOOL_NAME}: ${error.message}\n${hint === undefined ? "" : `hint: ${hint}\n`}`;
}

/** Hints for errors raised by modules that predate `MonocarveError#hint`. */
function fallbackHint(error: MonocarveError): string | undefined {
  if (error instanceof ConfigError && error.message.startsWith("no config found")) {
    return `create monocarve.config.ts exporting \`defineConfig({ ... })\` from "${TOOL_NAME}/config" (or pass --config <path>), then run \`${TOOL_NAME} config-doctor\``;
  }
  return undefined;
}

function reportInternalFailure(error: unknown, command: string): number {
  const detail = error instanceof Error && error.stack ? error.stack : String(error);
  process.stderr.write(
    `internal error: \`${TOOL_NAME} ${command}\` failed in a way it does not account for.\n` +
      `This is a defect in ${TOOL_NAME}, or in the environment it ran in — not a mistake in the command\n` +
      `you typed: an expected failure names the input it could not use and stops. Please report the\n` +
      `following, which is printed in full so it stays diagnosable:\n\n${detail}\n${causeChain(error)}`,
  );
  return 70;
}

function causeChain(error: unknown): string {
  let chain = "";
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) break;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined) break;
    chain += `\ncaused by: ${cause instanceof Error && cause.stack ? cause.stack : String(cause)}\n`;
    current = cause;
  }
  return chain;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
