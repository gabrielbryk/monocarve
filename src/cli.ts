#!/usr/bin/env bun
/** Executable boundary: parse, dispatch, and classify failures. */

import { TOOL_NAME, TOOL_VERSION } from "./branding.ts";
import { executableBuildIdentity } from "./build-identity.ts";
import { ArgumentError, parseArgs as parseWithSchema, type ParsedArgs } from "./cli/args.ts";
import { resetCodemodCaches } from "./codemod/imports.ts";
import { CLI_SCHEMA, COMMANDS, USAGE, commandHelp } from "./commands/index.ts";
import { IoError, NotYetPortedError, MonocarveError, UsageError } from "./errors.ts";

export type { ParsedArgs } from "./cli/args.ts";

/** Parse `argv` against the command registry; throws a `UsageError` for any malformed invocation. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  return parseWithSchema(argv, CLI_SCHEMA);
}

/**
 * Exit codes (the error classes behind them are documented in src/errors.ts):
 *   0   success (also a bare invocation with no arguments, `--help`, `--version`)
 *   1   an expected failure or refusal (`MonocarveError`), or a command that ran
 *       and reported a negative verdict itself (failed audit, blocked apply)
 *   2   degraded assessment: the evidence was published but the workspace only
 *       partially qualified (e.g. an unmatched workspace pattern). Set solely by
 *       `setQualificationExitCode` in src/commands/assessment-outcome.ts, used by
 *       `assess` and `batch split-candidates`; no error class maps to 2.
 *   3   the command reached a not-yet-ported seam (`NotYetPortedError`)
 *   64  malformed invocation (unknown command/flag, missing or invalid value, no command; `UsageError`)
 *   70  internal defect: an error outside the taxonomy, reported with its stack and cause chain
 *
 * Commands signal 1 or 2 without throwing by setting `process.exitCode`; `main`
 * returns whatever they set once the command resolves.
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
  if (spec === undefined) throw new Error(`invariant: parser accepted unregistered command ${args.command}`);
  if (args.flags.has("help")) {
    process.stdout.write(`${commandHelp(spec)}\n`);
    return 0;
  }
  try {
    resetCodemodCaches();
    // Handlers signal non-error outcomes (e.g. a degraded assessment, exit 2)
    // through process.exitCode; clear any value left by an earlier in-process run.
    process.exitCode = undefined;
    await runWithCompleteStdout(() => spec.run(args));
    return commandExitCode();
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

/** `monocarve: <message>`, plus a `hint:` line whenever the error carries one (every `MonocarveError` may). */
export function renderUserError(error: MonocarveError): string {
  return `${TOOL_NAME}: ${error.message}\n${error.hint === undefined ? "" : `hint: ${error.hint}\n`}`;
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

/** The exit code a handler set, read fresh (the caller's narrowing is stale after awaiting the handler). */
function commandExitCode(): number {
  return process.exitCode === undefined ? 0 : Number(process.exitCode);
}
