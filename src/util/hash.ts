import { createHash } from "node:crypto";

/** Lowercase hex sha256 digest. */
export type Sha256 = string;

/**
 * State of a file at a point in the journal.
 *
 * Plans record preconditions as `FileState` because "this file must not exist
 * yet" is as much a precondition as "this file must hash to X".
 */
export type FileState = Sha256 | typeof MISSING;

export const MISSING = "missing" as const;

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256(value: string): value is Sha256 {
  return SHA256_RE.test(value);
}

export function isFileState(value: string): value is FileState {
  return value === MISSING || isSha256(value);
}

/** Hash raw bytes. Used for every byte-fidelity assertion in the journal. */
export function hashBytes(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash text as UTF-8.
 *
 * Deliberately does NOT normalize line endings or trailing whitespace: byte
 * fidelity is the whole point of the audit stage. Normalization, where a
 * specific operation kind needs it (lockfile blocks), is that operation's job.
 */
export function hashText(text: string): Sha256 {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Order two strings by UTF-16 code unit — the comparator every array that
 * becomes plan or manifest bytes must be sorted with.
 *
 * `String.prototype.localeCompare` is the more natural thing to reach for and is
 * wrong here, so this exists to be imported instead of it. Locale collation is
 * not code-unit order: it folds case, ignores leading punctuation and treats
 * separators as secondary, so `["_internal", "Alpha", "alpha", "a-b", "ab"]`
 * orders as `Alpha, _internal, a-b, ab, alpha` by code unit and as
 * `_internal, a-b, ab, alpha, Alpha` under the default locale. That ordering
 * comes from the machine's ICU data and its default locale, neither of which is
 * an input to a plan — so a repository holding `Chart` beside `chart`, or
 * `Module-ledger.json` beside `module-ledger.json`, would serialize to different
 * bytes on two machines at the same commit. Determinism is the engine's
 * flagship invariant; do not put `localeCompare` back.
 */
export function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable hash of a JSON-serializable value, with object keys sorted. */
export function hashJson(value: unknown): Sha256 {
  return hashText(stableStringify(value));
}

/**
 * JSON whose bytes depend on a value's content and not on the order its keys
 * were inserted in — every object's keys are sorted recursively, by code unit
 * rather than by locale, so the result cannot vary with the machine's ICU data.
 * Array order is untouched: it carries meaning and is the producer's to fix.
 *
 * `indent` is handed to `JSON.stringify` unchanged, for output meant to be read
 * by a person as well as hashed.
 */
export function stableStringify(value: unknown, indent?: number | string): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(byCodeUnit)) {
    out[key] = sortKeys(source[key]);
  }
  return out;
}
