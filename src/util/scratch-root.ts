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
 * A single machine-wide cache directory is itself unsafe, though: this tool is
 * routinely run from several checkouts of the same repository at once (a
 * primary checkout plus one or more linked worktrees), and `pruneWorktrees`
 * sweeps its root by age, not by owner. Two checkouts sharing one scratch root
 * means a prune triggered from checkout A can delete checkout B's live
 * simulation worktree — a real, reproducible failure, not a hypothetical one.
 * So every *default* root additionally carries a checkout-derived suffix; see
 * {@link checkoutSuffix}.
 *
 * Resolution order, first hit wins:
 *   1. `MONOCARVE_SCRATCH_ROOT` — explicit override, for CI and for hosts whose
 *      cache directory is itself unsuitable. Used exactly as given, with no
 *      checkout suffix appended: an operator who set this by hand gets the
 *      literal path they asked for, and CI relies on that.
 *   2. `XDG_CACHE_HOME/<tool>/<checkout>` — honours the freedesktop
 *      base-directory spec.
 *   3. `~/.cache/<tool>/<checkout>` — that spec's own default.
 *   4. `os.tmpdir()/<tool>/<checkout>` — last resort when the home directory is
 *      unknown, which is the original behaviour rather than a hard failure.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { SCRATCH_ROOT_ENV, TOOL_NAME } from "../branding.ts";
import { hashText } from "./hash.ts";

/**
 * The parent directory for this tool's disposable state.
 *
 * Read from the environment on every call rather than captured at module load:
 * a Zod schema default is constructed once per process, and a test (or a caller
 * that sets the variable after import) would otherwise silently get the value
 * that happened to be live when the module was first evaluated.
 *
 * The checkout-derived suffix (see {@link checkoutSuffix}) is NOT re-resolved
 * on every call in the same sense — it is cached after the first subprocess
 * call, because a process's checkout identity cannot change mid-run the way an
 * environment variable can. That caching is what keeps this function cheap to
 * call repeatedly, which it is.
 */
export function scratchRoot(): string {
  const override = process.env[SCRATCH_ROOT_ENV]?.trim();
  // A relative override would resolve against the current working directory,
  // which for this tool changes between the repository and a worktree — the
  // one thing a scratch root must not do.
  if (override && isAbsolute(override)) return override;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, TOOL_NAME, checkoutSuffix());
  const home = homedir();
  if (home && isAbsolute(home)) return join(home, ".cache", TOOL_NAME, checkoutSuffix());
  return join(tmpdir(), TOOL_NAME, checkoutSuffix());
}

/** A named subdirectory of {@link scratchRoot}, e.g. `worktrees`. */
export function scratchPath(...segments: string[]): string {
  return join(scratchRoot(), ...segments);
}

let cachedCheckoutSuffix: string | undefined;

/**
 * A short, greppable, checkout-unique path segment: `<name>-<hash12>`, where
 * `name` is the basename of the enclosing checkout's toplevel (human-readable,
 * so listing the cache directory names its owners at a glance) and `hash12` is
 * the first 12 hex characters of a sha256 of that toplevel's realpath (so two
 * checkouts named identically, e.g. two worktrees of the same repository, do
 * not collide).
 *
 * `realpath` of the git toplevel is the identity, not the process's cwd, a
 * PID, or a timestamp: it is stable across repeated runs from the same
 * checkout (so the cache is actually reused and an interrupted run's leftovers
 * stay inspectable under the path a later run would look in) while still being
 * unique per checkout *and* per linked worktree, since each worktree has its
 * own toplevel.
 *
 * Resolving that toplevel costs a `git` subprocess, and this function backs a
 * hot path (`scratchRoot()`, called on every scratch-path resolution in a
 * run). A process's checkout does not change while it runs, so the result is
 * computed once per process and cached — this is a different kind of caching
 * than the one `scratchRoot()`'s own doc comment warns against: that one
 * guards against a value (the env var) that legitimately changes across the
 * process's life; this one exploits a value that provably cannot.
 *
 * Exported (not just used internally by {@link scratchRoot}) so any other
 * scratch directory that needs the same checkout-uniqueness — the test
 * suite's fixture root, for instance — derives it from here instead of
 * re-implementing the same hash-of-toplevel logic a second time and drifting
 * from it.
 */
export function checkoutSuffix(): string {
  if (cachedCheckoutSuffix !== undefined) return cachedCheckoutSuffix;
  const identity = checkoutIdentity();
  const name = basename(identity).replace(/[^a-zA-Z0-9._-]+/g, "-") || TOOL_NAME;
  const hash = hashText(identity).slice(0, 12);
  cachedCheckoutSuffix = `${name}-${hash}`;
  return cachedCheckoutSuffix;
}

/**
 * Realpath of the current checkout: the git toplevel containing `cwd`, or
 * (when `cwd` is not inside a git checkout at all — a fresh `git init`-less
 * directory, an extracted tarball, whatever) `cwd` itself. Resolving the
 * toplevel must never throw here: an unusual environment should get a working,
 * if less precisely scoped, scratch root rather than a hard failure over a
 * directory name.
 */
function checkoutIdentity(): string {
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (toplevel) return realpathSync(toplevel);
  } catch {
    // Not a git checkout, or git itself is unavailable. Fall through.
  }
  try {
    return realpathSync(process.cwd());
  } catch {
    return resolve(process.cwd());
  }
}

/**
 * A `mkdtemp` template inside the scratch root, with the root created.
 *
 * `os.tmpdir()` always exists, so the callers this replaces could pass a
 * template straight to `mkdtempSync`. A cache directory need not exist yet on a
 * first run, and `mkdtempSync` does not create parents.
 *
 * Robustness: if the resolved root cannot be created (read-only HOME, container
 * with no writable cache directory, permissions problem), falls back to tmpdir
 * unless the override was explicit. An explicit `${SCRATCH_ROOT_ENV}` that
 * cannot be created is an error: the operator needs to know they set an
 * unreachable path, not silently scatter state to tmpdir instead.
 */
export function ensureScratchDir(prefix: string): string {
  const override = process.env[SCRATCH_ROOT_ENV]?.trim();
  const root = scratchRoot();

  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    // Explicit override that failed: report it loudly.
    if (override && isAbsolute(override)) {
      throw new Error(`Failed to create ${SCRATCH_ROOT_ENV} directory at ${root}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    // No explicit override: fall back to tmpdir, still checkout-scoped so this
    // fallback cannot reintroduce the cross-checkout collision the default was
    // fixed to avoid.
    const fallback = join(tmpdir(), TOOL_NAME, checkoutSuffix());
    mkdirSync(fallback, { recursive: true });
    return join(fallback, prefix);
  }

  return join(root, prefix);
}
