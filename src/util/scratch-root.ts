/**
 * Where the tool puts disposable state that must live outside the repository.
 *
 * A simulation worktree is a full checkout plus a `node_modules` tree; the
 * external-consumer proof, the preparer bootstrap index and the path-migration
 * command directory are smaller but no less real. None of them may live inside
 * the repository, because `apply` refuses to run against a dirty tree — which
 * is why these defaulted to `os.tmpdir()`.
 *
 * `os.tmpdir()` is the wrong choice for that job. On a great many Linux hosts
 * `/tmp` is tmpfs: RAM-backed, sized in inodes as much as bytes, and cleared on
 * reboot. Checkouts land there by the thousand-file, and a host can exhaust
 * `/tmp`'s inodes while `df` still reports it half empty. A cache directory is
 * disk-backed, survives a reboot (so an interrupted run stays inspectable), and
 * is the documented home for exactly this kind of regenerable data.
 *
 * Resolution order, first hit wins:
 *   1. `MONOCARVE_SCRATCH_ROOT` — explicit override, for CI and for hosts whose
 *      cache directory is itself unsuitable.
 *   2. `XDG_CACHE_HOME/<tool>` — honours the freedesktop base-directory spec.
 *   3. `~/.cache/<tool>` — that spec's own default.
 *   4. `os.tmpdir()/<tool>` — last resort when the home directory is unknown,
 *      which is the original behaviour rather than a hard failure.
 */

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { SCRATCH_ROOT_ENV, TOOL_NAME } from "../branding.ts";

/**
 * The parent directory for this tool's disposable state.
 *
 * Read from the environment on every call rather than captured at module load:
 * a Zod schema default is constructed once per process, and a test (or a caller
 * that sets the variable after import) would otherwise silently get the value
 * that happened to be live when the module was first evaluated.
 */
export function scratchRoot(): string {
  const override = process.env[SCRATCH_ROOT_ENV]?.trim();
  // A relative override would resolve against the current working directory,
  // which for this tool changes between the repository and a worktree — the
  // one thing a scratch root must not do.
  if (override && isAbsolute(override)) return override;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, TOOL_NAME);
  const home = homedir();
  if (home && isAbsolute(home)) return join(home, ".cache", TOOL_NAME);
  return join(tmpdir(), TOOL_NAME);
}

/** A named subdirectory of {@link scratchRoot}, e.g. `worktrees`. */
export function scratchPath(...segments: string[]): string {
  return join(scratchRoot(), ...segments);
}

/**
 * A `mkdtemp` template inside the scratch root, with the root created.
 *
 * `os.tmpdir()` always exists, so the callers this replaces could pass a
 * template straight to `mkdtempSync`. A cache directory need not exist yet on a
 * first run, and `mkdtempSync` does not create parents.
 */
export function ensureScratchDir(prefix: string): string {
  const root = scratchRoot();
  mkdirSync(root, { recursive: true });
  return join(root, prefix);
}
