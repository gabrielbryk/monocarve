/**
 * Flag declarations: what each command accepts, and how each flag is parsed.
 *
 * A command's accepted flags are derived from its registry usage string — the
 * same text `--help` prints — so help and validation cannot drift apart. The
 * registry adds only what a usage string cannot say (see `FlagOverrides`).
 *
 * Kinds:
 *   - `boolean`    a switch. Never consumes the next token, and takes no value:
 *                  `--write=false` and `--write false` are both refused rather
 *                  than silently read as "on".
 *   - `value`      exactly one value, as `--out <path>` or `--out=<path>`.
 *                  Missing value or a second occurrence is a usage error.
 *   - `repeatable` a value flag that may be given more than once, in order.
 *   - `refused`    a flag the command knows and rejects with its own message
 *                  (a retired or mutation-only flag). The parser accepts it so
 *                  the handler can explain the refusal; it takes an optional value.
 */

export type FlagKind = "boolean" | "value" | "repeatable" | "refused";

export interface FlagSpec {
  readonly name: string;
  readonly kind: FlagKind;
  /** Single-letter alias, e.g. `j` for `--json`. Only booleans have one. */
  readonly short?: string;
}

/** What a usage string cannot express about a command's flags. */
export interface FlagOverrides {
  /** Accepted flags the usage string does not show. */
  readonly extra?: readonly FlagSpec[];
  /** Flags shown once in usage whose handler reads every occurrence. */
  readonly repeatable?: readonly string[];
  /** Flags the handler recognizes only to refuse with a specific message. */
  readonly refused?: readonly string[];
}

/** Accepted before or after any command. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "config", kind: "value" },
  { name: "cwd", kind: "value" },
  { name: "graph", kind: "repeatable" },
  { name: "no-cache", kind: "boolean" },
  { name: "json", kind: "boolean", short: "j" },
  { name: "help", kind: "boolean", short: "h" },
  { name: "version", kind: "boolean", short: "v" },
  { name: "verbose", kind: "boolean" },
];

/**
 * `--name`, then optionally a placeholder: `<...>` (possibly with a suffix such
 * as `<n>[m|h|d]`) or a bare lowercase word like `subpaths` or `key=value`.
 */
const USAGE_FLAG = /--([a-z][a-z0-9-]*)(?:[ =](<[^>]*>(?:\[[^\]]*\])?|[a-z][\w=.-]*(?=[\s\]|)]|$)))?(\s+\.\.\.)?/gu;

/** Derive flag specs from one usage string; each line is one invocation form. */
export function flagsFromUsage(usage: string): FlagSpec[] {
  const kinds = new Map<string, FlagKind>();
  for (const line of usage.split("\n")) {
    const seenOnLine = new Set<string>();
    for (const match of line.matchAll(USAGE_FLAG)) {
      const name = match[1] ?? "";
      const takesValue = match[2] !== undefined;
      const repeats = match[3] !== undefined || seenOnLine.has(name);
      seenOnLine.add(name);
      const kind: FlagKind = !takesValue ? "boolean" : repeats ? "repeatable" : "value";
      const previous = kinds.get(name);
      if (previous === undefined || previous === kind) kinds.set(name, kind);
      else if (isValueKind(previous) && isValueKind(kind)) kinds.set(name, "repeatable");
      else throw new Error(`usage declares --${name} both as a switch and as taking a value: ${usage}`);
    }
  }
  return [...kinds].map(([name, kind]) => ({ name, kind }));
}

function isValueKind(kind: FlagKind): boolean {
  return kind === "value" || kind === "repeatable";
}

/** The complete, conflict-checked flag table for one command. */
export function commandFlags(usage: string, overrides: FlagOverrides = {}): FlagSpec[] {
  const table = new Map<string, FlagSpec>();
  const add = (spec: FlagSpec, source: string): void => {
    const existing = table.get(spec.name);
    if (existing && existing.kind !== spec.kind) {
      throw new Error(`--${spec.name} is declared as ${existing.kind} and as ${spec.kind} (${source}) for: ${usage}`);
    }
    table.set(spec.name, spec);
  };
  for (const spec of flagsFromUsage(usage)) add(spec, "usage");
  for (const name of overrides.repeatable ?? []) {
    const existing = table.get(name);
    if (!existing || !isValueKind(existing.kind)) throw new Error(`repeatable override --${name} is not a value flag in: ${usage}`);
    table.set(name, { name, kind: "repeatable" });
  }
  for (const spec of overrides.extra ?? []) add(spec, "extra");
  for (const name of overrides.refused ?? []) {
    if (table.has(name)) throw new Error(`--${name} cannot be both accepted and refused in: ${usage}`);
    table.set(name, { name, kind: "refused" });
  }
  for (const global of GLOBAL_FLAGS) {
    const existing = table.get(global.name);
    if (existing && existing.kind !== global.kind) {
      throw new Error(`--${global.name} is a global ${global.kind} flag but is declared ${existing.kind} in: ${usage}`);
    }
  }
  return [...table.values()];
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/**
 * The closest candidate, or undefined when nothing is plausibly what was meant.
 * A unique candidate the input is a prefix of (`--verify` → `--verify-lockfile`)
 * also counts.
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(2, Math.floor(input.length / 3));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates.toSorted()) {
    const distance = editDistance(input, candidate);
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  if (best) return best.candidate;
  const prefixed = candidates.filter((candidate) => input.length >= 3 && candidate.startsWith(input));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
