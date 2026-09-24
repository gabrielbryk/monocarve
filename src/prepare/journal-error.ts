/** Error reporting shared by preparation journal apply and recovery. */
import { MonocarveError } from "../errors.ts";

export class PreparationJournalError extends MonocarveError {
  override readonly name = "PreparationJournalError";
  constructor(
    message: string,
    readonly residue: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

interface RestoreFailure {
  readonly path: string;
  readonly message: string;
}

export function restorationError(original: unknown, failures: readonly RestoreFailure[]): Error {
  const error = original instanceof Error ? original : new PreparationJournalError(String(original));
  if (failures.length === 0) {
    return new PreparationJournalError(`${error.message} [preparation journal restored]`, [], error);
  }
  const residue = failures.map((failure) => failure.path);
  return new PreparationJournalError(
    `${error.message} [PREPARATION JOURNAL RESTORE INCOMPLETE: ${failures.map((failure) => `${failure.path} (${failure.message})`).join("; ")}]`,
    residue,
    error,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
