/**
 * Error taxonomy. Every failure mode the CLI reports maps to one of these.
 *
 * Hierarchy and the exit code `main()` in src/cli.ts maps each branch to:
 *
 *   Error                          70  internal defect: printed with its stack and `cause` chain.
 *   │                                  Anything outside the taxonomy lands here. Throw a plain
 *   │                                  `Error` only for a broken invariant, and start its message
 *   │                                  with "invariant:" so a report is recognisable as a bug.
 *   └─ MonocarveError               1  expected failure or refusal: bad input, config, repo state,
 *      │                               a refused operation. Printed as `monocarve: <message>`
 *      │                               plus a `hint: <next step>` line whenever `hint` is set.
 *      ├─ UsageError               64  malformed invocation or bad flag value; the owning
 *      │  └─ ArgumentError (cli/args.ts)  command's usage line is printed after the message.
 *      ├─ NotYetPortedError         3  a declared stub seam, message "not yet ported: …".
 *      ├─ ConfigError               1  config missing, unparseable, invalid, or not bindable.
 *      ├─ PlanValidationError       1
 *      ├─ HashMismatchError         1
 *      ├─ PreflightError            1
 *      ├─ IoError                   1
 *      ├─ InputInventoryError       1
 *      └─ domain errors             1  one subclass per stage (PlanningError, ScanError,
 *                                      EvidenceError, PreparerError, …) living next to the stage.
 *
 * Exit code 2 (degraded assessment) is not an error: assessment commands set
 * `process.exitCode` from `AssessmentQualification.exitCode`; see src/cli.ts.
 *
 * Wrapping: when rethrowing across a boundary, pass the original as `cause`
 * (`new XError(msg, { cause })`) so the internal-failure report keeps the chain.
 * `toError` normalises a non-`Error` thrown value without losing it.
 */

export interface MonocarveErrorOptions extends ErrorOptions {
  /** One actionable next step, printed on its own `hint:` line under the message. */
  readonly hint?: string;
}

export class MonocarveError extends Error {
  override readonly name: string = "MonocarveError";
  readonly hint: string | undefined;

  constructor(message?: string, options?: MonocarveErrorOptions) {
    super(message, options);
    this.hint = options?.hint;
  }
}

/**
 * Return `value` if it is an `Error`, else wrap it in an invariant `Error` whose
 * `cause` is the original value. For catch blocks that rethrow what they do not handle.
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(`invariant: a non-Error value was thrown: ${String(value)}`, { cause: value });
}

/**
 * Marker for scaffolded seams where the real engine has not been ported yet.
 *
 * Anything throwing this is a declared stub boundary, not a bug. The message
 * always starts with "not yet ported" so tests and greps can find every seam.
 */
export class NotYetPortedError extends MonocarveError {
  override readonly name = "NotYetPortedError";

  constructor(what: string, options?: MonocarveErrorOptions) {
    super(`not yet ported: ${what}`, options);
  }
}

/**
 * Config file missing, unparseable, or failing schema validation.
 *
 * The assessment config sandbox (config/snapshot-loader.ts, config/loading.ts)
 * prefixes its messages with `ASSESSMENT_CONFIG_UNBOUND:`; see the catalogue on
 * `InputInventoryError` below.
 */
export class ConfigError extends MonocarveError {
  override readonly name = "ConfigError";
}

/** A plan manifest failed structural or semantic validation. */
export class PlanValidationError extends MonocarveError {
  override readonly name = "PlanValidationError";

  constructor(
    message: string,
    readonly issues: readonly string[] = [],
    options?: MonocarveErrorOptions,
  ) {
    super(message, options);
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
    options?: MonocarveErrorOptions,
  ) {
    super(`hash mismatch for ${path}: expected ${expected}, got ${actual}`, options);
  }
}

/** Apply refused to run: guarded branch, dirty tree, wrong baseline commit. */
export class PreflightError extends MonocarveError {
  override readonly name = "PreflightError";
}

/** Bad CLI invocation. The CLI prints usage and exits 64. */
export class UsageError extends MonocarveError {
  override readonly name: string = "UsageError";
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

/**
 * Assessment input inventory drifted, or an input (including a config import) cannot be bound.
 *
 * Stable ASSESSMENT_* diagnostic codes. They appear in `--json` output and in
 * error messages; renaming one is a breaking change. The diagnostic union lives
 * in assessment/qualification.ts (`AssessmentDiagnosticCode`).
 *
 *   ASSESSMENT_INPUT_UNBOUND               an input (e.g. a config import) cannot be inventoried or resolved
 *   ASSESSMENT_INPUT_UNREADABLE            an input, config, or output path could not be read
 *   ASSESSMENT_INPUT_MISSING               an input named by the inventory does not exist
 *   ASSESSMENT_INPUT_DRIFT                 inputs changed between inventory capture and use
 *   ASSESSMENT_REPLAY_PROVENANCE_REQUIRED  --replay bundle lacks readable provenance (inventory, raw reports)
 *   ASSESSMENT_REPLAY_INPUT_MISMATCH       --replay bundle was captured from different inputs
 *   ASSESSMENT_CONFIG_UNBOUND              executable config cannot run in, or escaped, the isolated sandbox
 *                                          (a `ConfigError` message prefix, not a diagnostic union member)
 *   ASSESSMENT_CONFIG_EXEC_START           stderr sentinel the sandboxed config child prints before user code
 *                                          runs; trace reads after it are attributed to the config
 *   CORE_ASSESSMENT_ARTIFACTS              (assessment/bundle.ts) not a code: the artifact paths every bundle must carry
 */
export class InputInventoryError extends MonocarveError {
  override readonly name = "InputInventoryError";
  constructor(
    readonly code: "ASSESSMENT_INPUT_DRIFT" | "ASSESSMENT_INPUT_UNBOUND",
    message: string,
    readonly paths: readonly string[],
    options?: MonocarveErrorOptions,
  ) {
    super(message, options);
  }
}
