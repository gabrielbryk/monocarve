import { MonocarveError } from "../errors.ts";

/** A journal cannot establish or restore one of its transactional invariants. */
export class JournalError extends MonocarveError {
  override readonly name = "JournalError";
}
