/**
 * Disposable state must land outside the repository, but `os.tmpdir()` is the
 * wrong outside: on most Linux hosts `/tmp` is tmpfs, and a checkout-sized
 * directory tree there is charged against RAM and against an inode budget that
 * runs out long before the byte budget does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

describe("scratch root", () => {
  test("defaults to the user cache directory, not the system temp directory", () => {
    setEnv(SCRATCH_ROOT_ENV, undefined);
    setEnv("XDG_CACHE_HOME", undefined);

    expect(scratchRoot()).toBe(join(homedir(), ".cache", TOOL_NAME));
    expect(scratchRoot().startsWith(tmpdir())).toBe(false);
  });

  test("honours XDG_CACHE_HOME", () => {
    setEnv(SCRATCH_ROOT_ENV, undefined);
    setEnv("XDG_CACHE_HOME", "/var/cache/example");

    expect(scratchRoot()).toBe(join("/var/cache/example", TOOL_NAME));
  });

  test(`${SCRATCH_ROOT_ENV} takes precedence over XDG_CACHE_HOME`, () => {
    setEnv(SCRATCH_ROOT_ENV, "/mnt/scratch/monocarve");
    setEnv("XDG_CACHE_HOME", "/var/cache/example");

    expect(scratchRoot()).toBe("/mnt/scratch/monocarve");
  });

  test("ignores a relative override rather than resolving it against the cwd", () => {
    // This tool's cwd moves between the repository and a disposable worktree,
    // so a relative scratch root would follow the run around.
    setEnv(SCRATCH_ROOT_ENV, "relative/scratch");
    setEnv("XDG_CACHE_HOME", undefined);

    expect(scratchRoot()).toBe(join(homedir(), ".cache", TOOL_NAME));
  });

  test("is read per call, so a schema default cannot capture a stale value", () => {
    setEnv(SCRATCH_ROOT_ENV, "/mnt/first");
    expect(scratchPath("worktrees")).toBe("/mnt/first/worktrees");

    setEnv(SCRATCH_ROOT_ENV, "/mnt/second");
    expect(scratchPath("worktrees")).toBe("/mnt/second/worktrees");
  });
});
