/** Error taxonomy. Every failure mode the CLI reports maps to one of these. */

export class MonocarveError extends Error {
  override readonly name: string = "MonocarveError";
}

/**
 * Marker for scaffolded seams where the real engine has not been ported yet.
 *
 * Anything throwing this is a declared stub boundary, not a bug. The message
 * always starts with "not yet ported" so tests and greps can find every seam.
 */
export class NotYetPortedError extends MonocarveError {
  override readonly name = "NotYetPortedError";

  constructor(what: string) {
    super(`not yet ported: ${what}`);
  }
}

/** Config file missing, unparseable, or failing schema validation. */
export class ConfigError extends MonocarveError {
  override readonly name = "ConfigError";
}

/** A plan manifest failed structural or semantic validation. */
export class PlanValidationError extends MonocarveError {
  override readonly name = "PlanValidationError";

  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

/**
 * A hash precondition or result assertion failed during apply/audit.
 * This is always fatal and always triggers rollback — the working tree diverged
 * from what the plan was compiled against.
 */
export class HashMismatchError extends MonocarveError {
  override readonly name = "HashMismatchError";

  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`hash mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
}

/** Apply refused to run: guarded branch, dirty tree, wrong baseline commit. */
export class PreflightError extends MonocarveError {
  override readonly name = "PreflightError";
}

/** Bad CLI invocation. The CLI prints usage and exits non-zero. */
export class UsageError extends MonocarveError {
  override readonly name = "UsageError";
}

/**
 * A path the operator named could not be read or written.
 *
 * Every other class here names the *stage* that could not proceed, and a stage
 * that owns an input owns its failure too: an unreadable manifest is a
 * `PlanningError`, an unreadable scanner report a `ScanError`, an unreadable
 * config a `ConfigError`. This is the residue — a file no stage owns, which
 * today is the report an `--out` asks the CLI to deliver. The tool did its work
 * and the filesystem would not take it.
 *
 * Not a `UsageError`: the usage block answers "how is this command invoked?",
 * and an invocation that named a directory it cannot write to did not raise
 * that question. Not the internal backstop either, since nothing is broken —
 * the operator can fix this by naming a different path.
 */
export class IoError extends MonocarveError {
  override readonly name = "IoError";
}
