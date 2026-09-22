/** Error reporting shared by preparation apply and its post-journal preparers. */
import { MonocarveError } from "../errors.ts";

export class PreparationApplyError extends MonocarveError {
  override readonly name = "PreparationApplyError";
  constructor(message: string, readonly residue: readonly string[] = []) {
    super(message);
  }
}
