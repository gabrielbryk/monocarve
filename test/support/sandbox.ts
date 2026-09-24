/**
 * Whether the executable-config sandbox (`bwrap` + `strace` syscall tracing,
 * inside a user namespace) is usable on this host.
 *
 * Positive-path executable-config tests need a real sandbox run to prove
 * anything; without one, `loadSnapshotConfig` fails closed on the missing
 * binaries before it ever reaches the behavior under test
 * (`src/config/snapshot-loader.ts` throws `ASSESSMENT_CONFIG_UNBOUND:
 * executable config requires bwrap` / `...requires syscall read tracing`).
 * That is indistinguishable, from the outside, from a passing negative test —
 * so a host without the sandbox must SKIP the positive tests rather than let
 * them fail (some containers, restricted CI runners, and hosts with
 * unprivileged user namespaces disabled cannot run `bwrap`).
 *
 * The negative (fail-closed) tests still pass on such a host, for the same
 * reason: they expect `ASSESSMENT_CONFIG_UNBOUND`, and the missing-binary
 * guard throws exactly that. They are deliberately NOT gated by this helper.
 */

import { existsSync } from "node:fs";

let cached: boolean | undefined;

export function sandboxAvailable(): boolean {
  if (cached !== undefined) return cached;
  cached = probeSandbox();
  return cached;
}

function probeSandbox(): boolean {
  if (!existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/strace")) return false;
  try {
    const result = Bun.spawnSync(["/usr/bin/bwrap", "--unshare-all", "--ro-bind", "/", "/", "true"], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** A visible reason to fold into a `test.skipIf` name, e.g. `` `sandbox positive path (${sandboxSkipReason()})` ``. */
export function sandboxSkipReason(): string {
  return sandboxAvailable() ? "sandbox available" : "sandbox unavailable: needs bwrap, strace, and working user namespaces";
}
