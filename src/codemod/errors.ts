/** Errors raised by source codemods when a repository's own text cannot be rewritten safely. */
import { MonocarveError } from "../errors.ts";

/** The importer's existing source text cannot hold the rewritten specifier without changing its meaning. */
export class CodemodRewriteError extends MonocarveError {
  override readonly name = "CodemodRewriteError";
}
