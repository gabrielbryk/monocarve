/** Lockfile failure shared by every package-manager adapter. */

import { MonocarveError } from "../errors.ts";

/** A lockfile shape the adapter cannot edit without guessing. */
export class LockfileError extends MonocarveError {
  override readonly name: string = "LockfileError";
}
