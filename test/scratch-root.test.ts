/**
 * Disposable state must land outside the repository, but `os.tmpdir()` is the
 * wrong outside: on most Linux hosts `/tmp` is tmpfs, and a checkout-sized
 * directory tree there is charged against RAM and against an inode budget that
 * runs out long before the byte budget does.
 *
 * The default root also carries a checkout-derived suffix, so two checkouts of
 * this repository (a primary checkout plus any linked worktree) running
 * concurrently do not resolve to the same scratch root — see
 * `src/util/scratch-root.ts` for why that matters (`pruneWorktrees` sweeps by
 * age, and a shared root means one checkout's prune can delete another's live
 * simulation worktree).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SCRATCH_ROOT_ENV, TOOL_NAME } from "../src/branding.ts";
import { scratchPath, scratchRoot } from "../src/util/scratch-root.ts";

const saved = { override: process.env[SCRATCH_ROOT_ENV], xdg: process.env.XDG_CACHE_HOME };

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv(SCRATCH_ROOT_ENV, saved.override);
  setEnv("XDG_CACHE_HOME", saved.xdg);
});

/**
 * Computed independently of `src/util/scratch-root.ts`'s own implementation,
 * from the same public facts (the git toplevel containing this test process's
 * cwd), so this test proves the real contract rather than echoing the
 * production code back at itself.
 */
function expectedCheckoutSuffix(): string {
  const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  const identity = realpathSync(toplevel);
  const name = basename(identity).replace(/[^a-zA-Z0-9._-]+/g, "-") || TOOL_NAME;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${name}-${hash}`;
}

describe("scratch root", () => {
  test("defaults to a checkout-derived directory under the user cache directory, not the system temp directory", () => {
    setEnv(SCRATCH_ROOT_ENV, undefined);
    setEnv("XDG_CACHE_HOME", undefined);

    expect(scratchRoot()).toBe(join(homedir(), ".cache", TOOL_NAME, expectedCheckoutSuffix()));
    expect(scratchRoot().startsWith(tmpdir())).toBe(false);
  });

  test("honours XDG_CACHE_HOME, still suffixed with the checkout", () => {
    setEnv(SCRATCH_ROOT_ENV, undefined);
    setEnv("XDG_CACHE_HOME", "/var/cache/example");

    expect(scratchRoot()).toBe(join("/var/cache/example", TOOL_NAME, expectedCheckoutSuffix()));
  });

  test(`${SCRATCH_ROOT_ENV} takes precedence over XDG_CACHE_HOME, and is used exactly as given (no checkout suffix)`, () => {
    setEnv(SCRATCH_ROOT_ENV, "/mnt/scratch/monocarve");
    setEnv("XDG_CACHE_HOME", "/var/cache/example");

    expect(scratchRoot()).toBe("/mnt/scratch/monocarve");
  });

  test("ignores a relative override rather than resolving it against the cwd", () => {
    // This tool's cwd moves between the repository and a disposable worktree,
    // so a relative scratch root would follow the run around.
    setEnv(SCRATCH_ROOT_ENV, "relative/scratch");
    setEnv("XDG_CACHE_HOME", undefined);

    expect(scratchRoot()).toBe(join(homedir(), ".cache", TOOL_NAME, expectedCheckoutSuffix()));
  });

  test("is read per call, so a schema default cannot capture a stale value", () => {
    setEnv(SCRATCH_ROOT_ENV, "/mnt/first");
    expect(scratchPath("worktrees")).toBe("/mnt/first/worktrees");

    setEnv(SCRATCH_ROOT_ENV, "/mnt/second");
    expect(scratchPath("worktrees")).toBe("/mnt/second/worktrees");
  });

  test("the checkout suffix is a human-recognizable name plus a stable 12-hex-character hash", () => {
    setEnv(SCRATCH_ROOT_ENV, undefined);
    setEnv("XDG_CACHE_HOME", undefined);

    const suffix = expectedCheckoutSuffix();
    expect(suffix).toMatch(/^[a-zA-Z0-9._-]+-[0-9a-f]{12}$/);
    // Same checkout, resolved twice: identical suffix both times.
    expect(scratchRoot()).toBe(scratchRoot());
  });
});

describe("ensureScratchDir", () => {
  // The fallback behavior (when root is unwritable) cannot be reliably tested without
  // root privileges or platform-specific tricks: genuinely making a directory unwritable
  // is destructive to the test environment (leaves permissions in a bad state) or requires
  // mocking mkdirSync, which proves nothing about real behavior. A vacuous test is worse
  // than none — this test is skipped rather than faked.
});
