/**
 * The lockfile error, re-exported at the name pnpm-side modules import it by.
 *
 * The class itself is shared: `instanceof LockfileError` has to hold for a
 * refusal from any adapter, so there is exactly one class and this module is a
 * re-export rather than a second declaration.
 */

export { LockfileError } from "./lockfile-error.ts";
