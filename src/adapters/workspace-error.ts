import { LockfileError } from "./lockfile-error.ts";

export type WorkspaceDiscoveryFailure = "unsupported-glob" | "unsafe-path" | "duplicate-package" | "malformed-manifest" | "unreadable-input";

/** Typed adapter failure so qualification never derives authority by parsing prose. */
export class WorkspaceDiscoveryError extends LockfileError {
  override readonly name = "WorkspaceDiscoveryError";
  constructor(
    readonly failure: WorkspaceDiscoveryFailure,
    message: string,
    readonly evidence: { readonly patterns?: readonly string[]; readonly paths?: readonly string[] } = {},
  ) { super(message); }
}
