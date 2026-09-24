/** Command-line parsing shared by the executable and command modules. */

import { TOOL_NAME } from "../branding.ts";
import { UsageError } from "../errors.ts";
import { closestMatch, GLOBAL_FLAGS, type FlagSpec } from "./flags.ts";

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  /** Repeated flags, in order. `--graph a=1 --graph b=2` yields both. */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
}

/** Everything the parser needs to know: which commands exist and what each accepts. */
export interface CliSchema {
  /** Command name → every flag it accepts, including the global ones. */
  readonly commands: Readonly<Record<string, readonly FlagSpec[]>>;
  /** Flags retired everywhere, with the message explaining what replaced them. */
  readonly retired?: Readonly<Record<string, string>>;
}

/**
 * A malformed invocation, carrying the command it was aimed at (when one was
 * recognized) so the executable can print that command's usage.
 */
export class ArgumentError extends UsageError {
  constructor(
    message: string,
    readonly command: string | undefined,
    hint?: string,
  ) {
    super(message, hint === undefined ? undefined : { hint });
  }
}

const BOOLEAN_WORDS = new Set(["true", "false", "yes", "no", "on", "off"]);

/**
 * Parse `argv` strictly against `schema`.
 *
 * The first bare token is the command. Global flags may appear before or after
 * it; command flags only after it. Unknown flags, unknown commands, value flags
 * without a value, and switches given a value are all `ArgumentError`s — they
 * are detected here, before any command loads config or touches the workspace.
 */
export function parseArgs(argv: readonly string[], schema: CliSchema): ParsedArgs {
  return new ArgvParser(argv, schema).parse();
}

class ArgvParser {
  private readonly positionals: string[] = [];
  private readonly flags = new Map<string, string | true>();
  private readonly repeated = new Map<string, string[]>();
  private command: string | undefined;
  private table = indexFlags(GLOBAL_FLAGS);

  constructor(
    private readonly argv: readonly string[],
    private readonly schema: CliSchema,
  ) {}

  parse(): ParsedArgs {
    let index = 0;
    while (index < this.argv.length) {
      const token = this.argv[index] ?? "";
      if (token === "--") {
        this.positionals.push(...this.argv.slice(index + 1));
        break;
      }
      index += 1 + this.consume(token, index);
    }
    return { command: this.command, positionals: this.positionals, flags: this.flags, repeated: this.repeated };
  }

  /** Handle one token; returns how many following tokens it consumed as a value. */
  private consume(token: string, index: number): number {
    if (token.startsWith("--")) return this.longFlag(token.slice(2), index);
    if (token.startsWith("-") && token.length > 1 && !/^-\d/u.test(token)) {
      const spec = this.table.byShort.get(token.slice(1)) ?? this.unknown(token, index);
      this.record(spec, true, token);
      return 0;
    }
    if (this.command !== undefined) this.positionals.push(token);
    else this.selectCommand(token);
    return 0;
  }

  private selectCommand(token: string): void {
    const accepted = this.schema.commands[token];
    if (accepted === undefined) throw unknownCommand(token, this.schema);
    this.command = token;
    this.table = indexFlags(accepted);
  }

  private longFlag(body: string, index: number): number {
    const equals = body.indexOf("=");
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined;
    const spelled = `--${name}`;
    const spec = this.table.byName.get(name) ?? this.unknown(spelled, index);
    const next = this.argv[index + 1];
    if (spec.kind === "boolean") {
      const value = inline ?? (next !== undefined && BOOLEAN_WORDS.has(next.toLowerCase()) ? next : undefined);
      if (value !== undefined) throw switchWithValue(name, value, this.command);
      this.record(spec, true, spelled);
      return 0;
    }
    if (inline !== undefined) {
      this.record(spec, inline, spelled);
      return 0;
    }
    // A refused flag keeps the historical optional-value shape; its handler owns the message.
    const takesNext = next !== undefined && (spec.kind === "refused" ? !next.startsWith("-") : !looksLikeFlag(next, this.table));
    if (takesNext) {
      this.record(spec, next, spelled);
      return 1;
    }
    if (spec.kind !== "refused") throw new ArgumentError(`${spelled} requires a value`, this.command);
    this.record(spec, true, spelled);
    return 0;
  }

  private record(spec: FlagSpec, value: string | true, spelled: string): void {
    if (spec.kind === "value" && this.flags.has(spec.name)) {
      throw new ArgumentError(`${spelled} accepts one value; pass --${spec.name} only once`, this.command);
    }
    this.flags.set(spec.name, value);
    if (typeof value !== "string") return;
    const bucket = this.repeated.get(spec.name) ?? [];
    bucket.push(value);
    this.repeated.set(spec.name, bucket);
  }

  private unknown(spelled: string, index: number): never {
    return unknownFlag(spelled, this.command, this.table, this.schema, this.argv.slice(index + 1));
  }
}

interface FlagTable {
  readonly byName: ReadonlyMap<string, FlagSpec>;
  readonly byShort: ReadonlyMap<string, FlagSpec>;
}

function indexFlags(specs: readonly FlagSpec[]): FlagTable {
  const byName = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const spec of [...GLOBAL_FLAGS, ...specs]) {
    byName.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }
  return { byName, byShort };
}

/** A value may start with `-` (`-1`), but not look like an option this parser knows. */
function looksLikeFlag(token: string, table: FlagTable): boolean {
  if (token.startsWith("--")) return true;
  return token.length === 2 && token.startsWith("-") && table.byShort.has(token.slice(1));
}

function switchWithValue(name: string, value: string, command: string | undefined): ArgumentError {
  return new ArgumentError(
    `--${name} is a switch and takes no value (got ${JSON.stringify(value)})`,
    command,
    `pass --${name} to turn it on, or leave it out to keep it off`,
  );
}

function unknownFlag(spelled: string, command: string | undefined, table: FlagTable, schema: CliSchema, rest: readonly string[]): never {
  const name = spelled.replace(/^-+/u, "");
  const retired = spelled.startsWith("--") ? schema.retired?.[name] : undefined;
  if (retired !== undefined) throw new ArgumentError(retired, command);
  if (command === undefined) {
    // A command option placed before the command: name the command it belongs after.
    const accepts = (owner: string): boolean => schema.commands[owner]?.some((spec) => spec.name === name && spec.kind !== "refused") ?? false;
    const later = rest.find((token) => !token.startsWith("-") && schema.commands[token] !== undefined);
    const owner = later !== undefined && accepts(later) ? later : later === undefined ? Object.keys(schema.commands).find(accepts) : undefined;
    if (owner !== undefined) {
      throw new ArgumentError(`${spelled} is a command option and must follow the command name`, undefined, `write \`${TOOL_NAME} ${owner} ${spelled} ...\``);
    }
  }
  const accepted = [...table.byName.values()].filter((spec) => spec.kind !== "refused").map((spec) => spec.name);
  const suggestion = closestMatch(name, accepted);
  const where = command === undefined ? "" : ` for \`${TOOL_NAME} ${command}\``;
  const help = command === undefined ? `run \`${TOOL_NAME} --help\` for global options` : `run \`${TOOL_NAME} ${command} --help\` for its options`;
  throw new ArgumentError(`unknown option ${spelled}${where}`, command, suggestion === undefined ? help : `did you mean --${suggestion}? ${help}`);
}

function unknownCommand(token: string, schema: CliSchema): ArgumentError {
  const suggestion = closestMatch(token, Object.keys(schema.commands));
  const list = `run \`${TOOL_NAME} --help\` for the command list`;
  return new ArgumentError(
    `unknown command ${JSON.stringify(token)}`,
    undefined,
    suggestion === undefined ? list : `did you mean \`${TOOL_NAME} ${suggestion}\`? ${list}`,
  );
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
