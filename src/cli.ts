#!/usr/bin/env bun
/** Executable boundary: parse, dispatch, and classify failures. */

import { TOOL_NAME, TOOL_VERSION } from "./branding.ts";
import { executableBuildIdentity } from "./build-identity.ts";
import { parseArgs } from "./cli/args.ts";
import { resetCodemodCaches } from "./codemod/imports.ts";
import { COMMANDS, USAGE, commandHelp } from "./commands/index.ts";
import { IoError, NotYetPortedError, MonocarveError, UsageError } from "./errors.ts";

export { parseArgs, type ParsedArgs } from "./cli/args.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("version")) {
    process.stdout.write(args.flags.has("verbose") ? `${JSON.stringify(executableBuildIdentity(), null, 2)}\n` : `${TOOL_NAME} ${TOOL_VERSION}\n`);
    return 0;
  }
  if (args.command === undefined || args.flags.has("help")) {
    const spec = args.command === undefined ? undefined : COMMANDS[args.command];
    process.stdout.write(`${spec ? commandHelp(spec) : USAGE}\n`);
    return 0;
  }
  const spec = COMMANDS[args.command];
  if (!spec) {
    process.stderr.write(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}\n`);
    return 64;
  }
  try {
    resetCodemodCaches();
    await runWithCompleteStdout(() => spec.run(args));
    return process.exitCode === undefined ? 0 : Number(process.exitCode);
  } catch (error) {
    return reportCommandFailure(error, spec.usage, args.command);
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

function reportCommandFailure(error: unknown, usage: string, command: string): number {
  if (error instanceof NotYetPortedError) {
    process.stderr.write(`${error.message}\n`);
    return 3;
  }
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\nusage: ${usage}\n`);
    return 64;
  }
  if (error instanceof MonocarveError) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    return 1;
  }
  return reportInternalFailure(error, command);
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
