/** Command-line parsing shared by the executable and command modules. */

import { UsageError } from "../errors.ts";

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  /** Repeated flags, in order. `--graph a=1 --graph b=2` yields both. */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

const SHORT_FLAGS: Record<string, string> = { h: "help", v: "version", j: "json" };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  let command: string | undefined;

  const record = (name: string, value: string | true): void => {
    flags.set(name, value);
    if (typeof value !== "string") return;
    const bucket = repeated.get(name) ?? [];
    bucket.push(value);
    repeated.set(name, bucket);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1).filter((value): value is string => value !== undefined));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        record(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        record(body, next);
        index += 1;
      } else record(body, true);
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const short = token.slice(1);
      record(SHORT_FLAGS[short] ?? short, true);
      continue;
    }
    if (command === undefined) command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags, repeated };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new UsageError(`--${name} requires a value`);
  return value;
}

/** Repeated string flags in command-line order, rejecting a value-less occurrence. */
export function flagStrings(args: ParsedArgs, name: string): readonly string[] {
  if (args.flags.get(name) === true) throw new UsageError(`--${name} requires a value`);
  return args.repeated.get(name) ?? [];
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) !== undefined;
}

export function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const raw = flagString(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number`);
  return value;
}
