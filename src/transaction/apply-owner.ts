/**
 * Owner liveness for a committing apply.
 *
 * A PID alone is not an identity: `kill(pid, 0)` failing with EPERM means the
 * process exists under another user, and a recycled PID can belong to an
 * unrelated process. The transaction therefore records the owner's kernel
 * start time (field 22 of `/proc/<pid>/stat`) next to its PID and compares
 * both. Anything that cannot be determined is treated as alive: a recovery
 * that races a live owner corrupts the checkout, while a refused recovery only
 * costs the operator a retry.
 */
import { readFileSync } from "node:fs";

export type OwnerLiveness = "alive" | "dead" | "uncertain";

/** Seam over the operating system's process table, injectable for tests. */
export interface ProcessProbe {
  /** `exists` includes EPERM; `unknown` is any other probe failure. */
  signal(pid: number): "exists" | "missing" | "unknown";
  /** Kernel start identity, or null when it cannot be read (no procfs, gone, unreadable). */
  startIdentity(pid: number): string | null;
}

export const systemProcessProbe: ProcessProbe = {
  signal(pid) {
    try {
      process.kill(pid, 0);
      return "exists";
    } catch (error) {
      const code = errnoCode(error);
      if (code === "EPERM") return "exists";
      if (code === "ESRCH") return "missing";
      return "unknown";
    }
  },
  startIdentity: procStartIdentity,
};

/** `code` of a Node system error, without asserting the caught value's type. */
export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Message of a caught value, without asserting its type. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function procStartIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces and parentheses; fields resume after the last ")".
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * `dead` only when the PID is provably gone, or provably reused by a process
 * with a different start identity. Legacy state without a recorded start, an
 * unreadable start identity, and probe failures are all `alive`/`uncertain`.
 */
export function ownerLiveness(pid: number, recordedStart: string | null | undefined, probe: ProcessProbe = systemProcessProbe): OwnerLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "uncertain";
  const signal = probe.signal(pid);
  if (signal === "missing") return "dead";
  if (signal === "unknown") return "uncertain";
  if (recordedStart === undefined || recordedStart === null) return "alive";
  const current = probe.startIdentity(pid);
  if (current === null) return "uncertain";
  return current === recordedStart ? "alive" : "dead";
}
