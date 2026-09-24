/** Plan-module failures that are not planning refusals in the `PlanningError` sense. */

import { MonocarveError } from "../errors.ts";

/**
 * A configured path-migration command failed, produced no output, or a
 * path-keyed artifact (input or output) was not valid UTF-8 text. Raised at
 * compile, validate, and apply time alike, so it names the migration rather
 * than the stage.
 */
export class PathMigrationError extends MonocarveError {
  override readonly name = "PathMigrationError";
}

/**
 * A reference rewrite was refused because the replacement text cannot be
 * spliced into the literal it must replace without changing its meaning
 * (for example a quote character inside a same-quoted string).
 */
export class ReferenceRewriteError extends MonocarveError {
  override readonly name = "ReferenceRewriteError";
}
